// ============================================================
// SQLite kalıcılık — işlem geçmişi, eşit eğrisi, ayarlar
// Not: Bu katman PAPER modu için muhasebe tutar; LIVE modda
// bakiye bilgisi API'den alınır ama geçmiş burada saklanır.
// ============================================================

import { Database } from 'bun:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type { BotSettings, Trade, EquityPoint, BotMode, Side, ExitReason, Candle, ScanMode } from './types'

const DB_DIR = join(import.meta.dir, '..', 'db')
mkdirSync(DB_DIR, { recursive: true })
const db = new Database(join(DB_DIR, 'katlabot.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entryPrice REAL NOT NULL,
  exitPrice REAL NOT NULL,
  entryTime INTEGER NOT NULL,
  exitTime INTEGER NOT NULL,
  holdSec REAL NOT NULL,
  grossPnl REAL NOT NULL,
  fees REAL NOT NULL,
  netPnl REAL NOT NULL,
  pnlPct REAL NOT NULL,
  movePct REAL NOT NULL,
  balanceAfter REAL NOT NULL,
  reason TEXT NOT NULL,
  entrySignal TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equity (
  t INTEGER PRIMARY KEY,
  balance REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(exitTime DESC);
`)

// ---------- KV ----------
const kvGet = db.query('SELECT v FROM kv WHERE k = ?')
const kvSet = db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')

export function kvGetString(key: string, fallback: string): string {
  const row = kvGet.get(key) as { v: string } | null
  return row ? row.v : fallback
}
export function kvGetNumber(key: string, fallback: number): number {
  const row = kvGet.get(key) as { v: string } | null
  return row ? Number(row.v) : fallback
}
export function kvSetNumber(key: string, value: number) {
  kvSet.run(key, String(value))
}
export function kvSetString(key: string, value: string) {
  kvSet.run(key, value)
}

// günün işlem sayısı (günlük işlem tavanı sayacı) — exitTime gün başına göre
const countTradesSinceStmt = db.query('SELECT COUNT(*) AS n FROM trades WHERE exitTime >= ?')
export function countTradesSince(ts: number): number {
  const r = countTradesSinceStmt.get(ts) as { n: number | null } | null
  return r ? Number(r.n ?? 0) : 0
}

// ---------- Trades ----------
// NOT: Bun SQLite'ta isimli parametreler anahtar öneki gerektirir;
// güvenilirlik için pozisyonel (?) parametreler kullanılır.
const insertTrade = db.prepare(`
INSERT OR REPLACE INTO trades (id, symbol, side, qty, entryPrice, exitPrice, entryTime, exitTime, holdSec, grossPnl, fees, netPnl, pnlPct, movePct, balanceAfter, reason, entrySignal)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export function saveTrade(t: Trade) {
  insertTrade.run(
    t.id, t.symbol, t.side, t.qty, t.entryPrice, t.exitPrice,
    t.entryTime, t.exitTime, t.holdSec, t.grossPnl, t.fees, t.netPnl,
    t.pnlPct, t.movePct, t.balanceAfter, t.reason, t.entrySignal,
  )
}

const selectTrades = db.query('SELECT * FROM trades ORDER BY exitTime DESC LIMIT ?')
export function loadTrades(limit = 200): Trade[] {
  return selectTrades.all(limit) as unknown as Trade[]
}

export function deleteAllTrades() {
  db.exec('DELETE FROM trades')
}

// ---------- Equity ----------
const insertEquity = db.prepare('INSERT OR REPLACE INTO equity (t, balance) VALUES (?, ?)')
export function saveEquity(t: number, balance: number) {
  insertEquity.run(t, balance)
}
const selectEquity = db.query('SELECT t, balance FROM equity ORDER BY t ASC')
export function loadEquity(): EquityPoint[] {
  return selectEquity.all() as unknown as EquityPoint[]
}
export function deleteAllEquity() {
  db.exec('DELETE FROM equity')
}

// ---------- Settings ----------
const DEFAULT_SETTINGS: BotSettings = {
  symbol: 'BTCUSDT',
  mode: 'PAPER' as BotMode,
  leverage: 10,
  allocationPct: 25,
  takeProfitPct: 0.90,      // A-paketi (5 Kasım): av 3× büyüdü — ücret başabaşı %0.10'un altındaki hareketler avlanmıyor
  stopLossPct: 0.90,        // A-paketi: R:R korunur; momentum-ölüm hasar eşiği de genişler (gürültü çıkışı biter)
  maxHoldSec: 600,          // A-paketi: geniş TP'ye nefes payı (sert tavan yine 15dk)
  cooldownSec: 90,          // A-paketi: zarar yazan coin 1.5dk elenir — LINK short zinciri gibi tekrarlama kesildi
  takerFeePct: 0.05,
  minEdgePct: 0.06,
  startBalance: 100,       // kullanıcı isteği (5 Kasım): her taze DB (deploy/restart/uyku-uyanma) 100 USDT'den açılır
  scanMode: 'MULTI' as ScanMode,
  watchlist: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT'],
  regimeFilter: true,      // rejim skoreri varsayılan AÇIK — kullanıcı onayı aldı
  regimeMinScore: 1.05,    // P1 (6 Kasım akşam, onaylı): kira filtresi — 46 işlemde brüt +5.75 komisyon −5.81 yiyordu; yalnız hareketi komisyonu ÖDEDEN coin işlem yapar
  regimeTopN: 3,           // yalnız en değerli 3 coin işlem yapabilir
  // ---- Aşama 1: uyarlanabilir risk (onaylı) ----
  atrAdaptive: true,       // TP/SL coinin gerçek oynaklığından hesaplanır
  atrTpMult: 1.2,          // TP = 1dk ATR% × 1.2 (feeAwareTp tabanı korunur)
  atrSlRatio: 1.8,         // SL = TP × 1.8 (R:R korunur)
  riskParity: true,        // sabit marj yerine sabit risk (%1)
  riskPct: 1.0,            // P2 (6 Kasım akşam, onaylı): 1.75 terfisi geri alındı — 20/30 işlem net −2.87; kenar kanıtlanana kadar güvenli boyut. SL vuruşu −1.0, kilit +0.5
  // ---- Aşama 2: maker ekonomisi (onaylı) ----
  makerEntry: true,        // giriş defter fiyatından (post-only)
  makerFeePct: 0.018,      // Binance futures maker ücreti
  makerWaitSec: 3,         // hızlı yakala: 3sn'de dolmazsa piyasa emriyle yakla (8sn bekleyince sinyallerin %62'si kaçıyordu)
  takerMinScore: 1.5,      // A-paketi: sıradan sinyaller maker girer (ücret %32 düşer); yalnız istisna sinyal taker
  // ---- Aşama 3: sinyal filtreleri (onaylı) ----
  flowFilter: true,        // bid/ask boyut dengesizliği yön onayı
  flowThreshold: 0.08,     // 0.5 ± 0.08 = belirgin baskı
  htfFilter: true,         // 15dk trend yön onayı
  minScore: 0.15,          // skor tabanı — zayıf sinyal komisyon deliğidir (0.10'luk sinyaller hep zarar yazıyordu)
  // ---- Keskin çıkış motoru (onaylı — 83sa gerçek-veri turnuvası) ----
  sharpExit: true,         // trailing kilit + momentum ölümü + geniş TP (saat derdi yok)
  trailArmPct: 0.35,       // A-paketi v2: kilit +%0.35'te kurulur → taban net +0.15 KORUNUR, kilitleme bir nefes sonra
  trailPct: 0.20,          // A-paketi v2: zirveden %0.20 geri çekilme toleransı (trendin nefes payı %33 genişledi)
  momentumExit: true,      // 1sn momentum 2sn ters → erken çıkış (saat beklemez)
  momPersistSec: 10,       // gürültü paketi: momentum 10sn AYNI yönde kalmadan giriş yok — RSI 63-72 tepelerindeki taze dönmüş sahte sinyaller kesildi
  mtf5mFilter: true,       // 5dk EMA yön onayı (1dk tetik + 5dk onay + 15dk trend)
  dailyLossPct: 2,         // gün −%2 → bot günü bitirir (kanama tavanı)
  maxTradesPerDay: 100,    // günlük işlem tavanı — hedef bant 50-100 (0 = sınırsız)
  // ---- kanama kesme devreleri (kullanıcı onayı: "bakiyeyi eritmesin") ----
  totalFloorPct: 10,       // toplam −%10 tabanı → bot KALICI durur (elle sıfırlanır)
  lossStreakLimit: 3,      // 3 üst üste net zarar → giriş molası
  lossStreakPauseSec: 900, // mola süresi: 15 dk (piyasa/bot uyumsuzluğunu keser)
}

export function loadSettings(): BotSettings {
  try {
    const raw = kvGetString('settings', '')
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<BotSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: BotSettings) {
  kvSet.run('settings', JSON.stringify(s))
}

// ---------- Candle önbelleği ----------
// Yeniden başlatmalarda REST kline çekimini (ve hız limiti riskini) tamamen
// ortadan kaldırmak için son mum dizileri kalıcı olarak saklanır.
export function loadCandleCache(symbol: string): Candle[] {
  return loadCandlesByKey(`candles:${symbol}`)
}

export function saveCandleCache(symbol: string, candles: Candle[]) {
  saveCandlesByKey(`candles:${symbol}`, candles.slice(-200))
}

/** Genel amaçlı mum önbelleği (1s / 15m serileri için) */
export function loadCandlesByKey(key: string): Candle[] {
  try {
    const raw = kvGetString(key, '')
    if (!raw) return []
    const arr = JSON.parse(raw) as Candle[]
    return Array.isArray(arr) ? arr.filter(c => c && typeof c.t === 'number') : []
  } catch {
    return []
  }
}

export function saveCandlesByKey(key: string, candles: Candle[]) {
  try {
    kvSet.run(key, JSON.stringify(candles))
  } catch { /* yoksay */ }
}

// ---------- Dönüşümler ----------
export function rowToTrade(r: Record<string, unknown>): Trade {
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    side: r.side as Side,
    qty: r.qty as number,
    entryPrice: r.entryPrice as number,
    exitPrice: r.exitPrice as number,
    entryTime: r.entryTime as number,
    exitTime: r.exitTime as number,
    holdSec: r.holdSec as number,
    grossPnl: r.grossPnl as number,
    fees: r.fees as number,
    netPnl: r.netPnl as number,
    pnlPct: r.pnlPct as number,
    movePct: r.movePct as number,
    balanceAfter: r.balanceAfter as number,
    reason: r.reason as ExitReason,
    entrySignal: (r.entrySignal as string) ?? '',
  }
}

export { db }
