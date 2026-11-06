// ============================================================
// KatlaBot — Motor tiplerinin frontend kopyası
// (mini-services/trade-engine/src/types.ts ile senkron)
// ============================================================

export type Side = 'LONG' | 'SHORT'
export type BotMode = 'PAPER' | 'LIVE'
export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL_FLIP' | 'TIMEOUT' | 'MANUAL' | 'RECON' | 'TRAIL' | 'MOMENTUM' | 'DAILY_STOP'
export type ScanMode = 'SINGLE' | 'MULTI'

export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface BotSettings {
  symbol: string
  mode: BotMode
  leverage: number
  allocationPct: number
  takeProfitPct: number
  stopLossPct: number
  maxHoldSec: number
  cooldownSec: number
  takerFeePct: number
  minEdgePct: number
  startBalance: number
  scanMode: ScanMode
  watchlist: string[]
  regimeFilter: boolean
  regimeMinScore: number
  regimeTopN: number
  // Aşama 1/2/3
  atrAdaptive: boolean
  atrTpMult: number
  atrSlRatio: number
  riskParity: boolean
  riskPct: number
  makerEntry: boolean
  makerFeePct: number
  makerWaitSec: number
  takerMinScore: number   // hızlı yakala: bu skor+ sinyal direkt taker (0 = kapalı)
  flowFilter: boolean
  flowThreshold: number
  htfFilter: boolean
  minScore: number        // giriş skor tabanı — altı reddedilir (0 = kapalı)
  // keskin çıkış motoru
  sharpExit: boolean
  trailArmPct: number
  trailPct: number
  momentumExit: boolean
  momPersistSec?: number    // giriş için momentum süreklilik şartı (sn; 0 = kapalı) — gürültü paketi
  mtf5mFilter: boolean
  dailyLossPct: number
  maxTradesPerDay: number
  // ---- kanama kesme devreleri ----
  totalFloorPct: number
  lossStreakLimit: number
  lossStreakPauseSec: number
}

/** Giriş kapısı tek koşulun canlı durumu — "neden bekliyor" matrisinin hücresi */
export interface GateCheck {
  key: 'DATA' | 'TREND' | 'MOMENTUM' | 'RSI' | 'FLOW' | 'MTF5M' | 'HTF15M' | 'SPIKE' | 'REGIME'
  label: string     // TR kısa etiket (satır adı)
  ok: boolean | null  // true = geçti · false = ENGEL · null = filtre kapalı / yön yok
  value: string     // canlı değer ("BOĞA", "55", "%61 alış"…)
}

/** Bir sembolün saniyelik giriş kapısı durumu — "Anlık Değerlendirme" paneli */
export interface GateStatus {
  symbol: string
  side: Side | null     // trendin baktığı yön (FLAT → null)
  checks: GateCheck[]
  blockKey: string | null // ilk başarısız koşul (null = hepsi geçti)
  blockLabel: string     // insan cümlesi: bekleme nedeni / "Sinyal hazır"
  passed: number
  active: number
}

/** Motoru girişten alıkoyan GLOBAL durumlar (sembolden bağımsız) */
export interface EntryLock {
  running: boolean
  busySymbol: string | null
  busySide: Side | null
  pendingSymbol: string | null
  pendingSide: Side | null
  cooldownRemainSec: number
  dayStopped: boolean
  dayLossPct: number
  dayLossLimitPct: number
  lossStreak: number
  lossPauseRemainSec: number
  lossStreakLimit: number
  tradesToday: number
  maxTradesPerDay: number
  hardStopped: boolean
  floorUsedPct: number
  floorLimitPct: number
}

/** Tarayıcıdaki tek sembolün özeti (radar satırı) */
export interface WatchItem {
  symbol: string
  price: number
  change24hPct: number
  spreadPct: number
  trend1m: 'BULL' | 'BEAR' | 'FLAT'
  momentum1s: 'UP' | 'DOWN' | 'FLAT'
  rsi1m: number
  score: number
  ready: boolean
  readySide: Side | null
  readyData: boolean
  regimeScore: number
  regimeRank: number
  regimeEligible: boolean
  flow: number | null
  htfTrend: 'BULL' | 'BEAR' | 'FLAT' | 'NA'
  gate: {
    side: Side | null
    blockKey: string | null
    blockLabel: string
  }
}

export interface OpenPositionView {
  symbol: string
  side: Side
  qty: number
  entryPrice: number
  entryTime: number
  markPrice: number
  movePct: number
  grossPnl: number
  fees: number
  netPnl: number
  pnlPct: number
  takeProfitPrice: number
  stopLossPrice: number
  trailStop: number | null      // kâr kilidi fiyatı (kurulmadıysa null) — pistte amber çentik
  holdSec: number
  maxHoldSec: number
  reason: string
}

export interface Trade {
  id: string
  symbol: string
  side: Side
  qty: number
  entryPrice: number
  exitPrice: number
  entryTime: number
  exitTime: number
  holdSec: number
  grossPnl: number
  fees: number
  netPnl: number
  pnlPct: number
  movePct: number
  balanceAfter: number
  reason: ExitReason
  entrySignal: string
}

export interface Indicators {
  emaFast1m: number
  emaSlow1m: number
  emaFast1s: number
  emaSlow1s: number
  rsi1m: number
  trend1m: 'BULL' | 'BEAR' | 'FLAT'
  momentum1s: 'UP' | 'DOWN' | 'FLAT'
  lastSignal: string
}

export interface EngineStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  netPnl: number
  grossPnl: number
  totalFees: number
  avgNet: number
  bestTrade: number
  worstTrade: number
  profitFactor: number | null // null = ∞ (hiç kayıp yok; JSON Infinity'yi null'a düşürür)
  maxDrawdownPct: number
  avgHoldSec: number
  tradesPerHour: number
}

export interface EquityPoint {
  t: number
  balance: number
}

export interface EngineSnapshot {
  connected: boolean
  wsStatus: string
  streamMode: 'FUTURES' | 'SPOT'
  streamSource: string
  running: boolean
  settings: BotSettings
  scanMode: ScanMode
  displaySymbol: string
  trackedSymbols: string[]
  scanner: {
    tickRate: number
    watch: WatchItem[]
    regime: {
      filterOn: boolean
      minScore: number
      topN: number
      eligible: string[]
      status: string
    }
  }
  price: number
  bid: number
  ask: number
  spread: number
  spreadPct: number
  priceChange24hPct: number
  markPrice: number
  serverTime: number
  account: {
    balance: number
    startBalance: number
    growthPct: number
    equity: number
  }
  position: OpenPositionView | null
  pending?: PendingOrderView | null
  indicators: Indicators
  gateDetail?: GateStatus | null
  entryLock?: EntryLock
  stats: EngineStats
  candles1m: Candle[]
  candles1s: Candle[]
  equity: EquityPoint[]
  trades: Trade[]
  feeBreakevenPct: number
  logs: LogLine[]
  recon?: ReconInfo
  api?: ApiWeightView | null
}

export interface LogLine {
  t: number
  level: 'info' | 'trade' | 'warn' | 'error'
  msg: string
}

/** Güvenlik ağı A — borsa ↔ bot pozisyon mutabakatı (opsiyonel: eski motor uyumu) */
export interface ReconInfo {
  lastCheck: number
  status: 'OFF' | 'OK' | 'MISMATCH' | 'ERROR'
  issues: string[]
  autoClosed: number
}

/** Güvenlik ağı B — API hız limiti göstergesi (opsiyonel: veri yoksa null) */
export interface ApiWeightView {
  weightUsed1m: number
  weightLimit1m: number
  updatedAt: number
}

export interface ControlAction {
  action: 'start' | 'stop' | 'close' | 'reset' | 'updateSettings' | 'resetBalance' | 'setBalance' | 'clearFloor'
  settings?: Partial<BotSettings>
  apiKey?: string
  apiSecret?: string
  balance?: number
}

// Not: Backtest/optimizasyon modülü kullanıcı kararıyla KALDIRILDI.
// Motor yalnız canlı değerlendirme yapar; parametreler ayarlar panelinden.

export interface PendingOrderView {
  symbol: string
  side: Side
  qty: number
  limitPrice: number
  placedSec: number
  expiresSec: number
}

export interface TickData {
  sym?: string
  p: number
  t: number
  m: number
  b?: number
  a?: number
  pos: OpenPositionView | null
}

export interface ControlResult {
  ok: boolean
  msg: string
}
