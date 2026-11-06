// ============================================================
// KatlaBot — Binance Futures Scalping Engine
// Paylaşılan tip tanımları
// ============================================================

export type Side = 'LONG' | 'SHORT'
export type BotMode = 'PAPER' | 'LIVE'
export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'SIGNAL_FLIP' | 'TIMEOUT' | 'MANUAL' | 'RECON' | 'TRAIL' | 'MOMENTUM' | 'DAILY_STOP' | 'TOTAL_FLOOR'
/** Tarama modu: tek sembol mü, çoklu sembol radarı mı */
export type ScanMode = 'SINGLE' | 'MULTI'

export interface Candle {
  t: number      // açılış zamanı (ms)
  o: number
  h: number
  l: number
  c: number
  v: number      // hacim (base asset)
}

export interface BotSettings {
  symbol: string
  mode: BotMode
  leverage: number          // 1..10 (kullanıcı tavanı)
  allocationPct: number     // bakiyenin yüzde kaçı marj olarak girsin (1..100)
  takeProfitPct: number     // fiyat hareketi % (net, ücret sonrası kâr garantili)
  stopLossPct: number       // fiyat hareketi %
  maxHoldSec: number        // pozisyon süre tavanı
  cooldownSec: number       // işlemler arası bekleme
  takerFeePct: number       // Binance futures taker ücreti % (taraflı)
  minEdgePct: number        // gidiş-dönüş ücreti üstü minimum net marj %
  startBalance: number      // PAPER başlangıç bakiyesi (USDT)
  scanMode: ScanMode        // SINGLE: yalnız settings.symbol · MULTI: watchlist taranır
  watchlist: string[]       // MULTI modda taranacak semboller
  regimeFilter: boolean     // rejim filtresi: düşük skorlu coinden giriş yasak
  regimeMinScore: number    // minimum "hareket/maliyet" skoru (örn. 0.9)
  regimeTopN: number        // yalnız ilk N coin işlem yapabilir (örn. 3)
  // ---- Aşama 1: uyarlanabilir risk ----
  atrAdaptive: boolean      // TP/SL coinin gerçek oynaklığından (ATR) hesaplansın
  atrTpMult: number         // TP = 1dk ATR% × bu çarpan (feeAwareTp tabanı korunur)
  atrSlRatio: number        // SL = TP × bu oran (R:R korunur)
  riskParity: boolean       // pozisyon boyutu sabit marj yerine sabit RİSK
  riskPct: number           // her işlemin SL'de riske atacağı bakiye %
  // ---- Aşama 2: maker ekonomisi ----
  makerEntry: boolean       // giriş piyasa yerine defter fiyatından (post-only limit)
  makerFeePct: number       // maker ücreti % (taker'ın ~1/3'ü)
  makerWaitSec: number      // maker emrinin dolmak için bekleyeceği süre (hızlı yakala: dolmazsa taker'a düşülür)
  takerMinScore: number     // hızlı yakala: bu skor+ sinyal maker beklemez — direkt piyasa emri (0 = kapalı)
  // ---- Aşama 3: sinyal filtreleri ----
  flowFilter: boolean       // emir defteri dengesizliği (bid/ask boyutu) yön onayı
  flowThreshold: number     // 0.5'den sapma eşiği (0.08 = belirgin baskı)
  htfFilter: boolean        // 15dk üst zaman dilimi trend yön onayı
  minScore: number          // giriş skor tabanı — altındaki sinyal reddedilir (0 = kapalı)
  // ---- Keskin çıkış motoru (83sa gerçek-veri turnuvasının bulgusu) ----
  sharpExit: boolean        // trailing kilit + momentum ölümü + geniş TP tavanı (saat yok)
  trailArmPct: number       // kâr kilidi eşiği: fiyat %bu kadar lehte gidince iz başlar
  trailPct: number          // zirveden geri çekilme toleransı (stop = zirve − %bu)
  momentumExit: boolean     // 1sn momentum 2sn üst üste ters dönerse erken çıkış
  momPersistSec: number     // giriş için momentumun aynı yönde kesintisiz kalması gereken süre (sn; 0 = kapalı)
  mtf5mFilter: boolean      // 5dk EMA trend yön onayı (MTF katmanı)
  dailyLossPct: number      // günlük zarar tavanı % — aşılırsa bot günü bitirir
  maxTradesPerDay: number   // günlük işlem tavanı — frekans disiplini (hedef bant 50-100; 0 = sınırsız)
  // ---- kanama kesme devreleri (bakiye erozyonu koruması) ----
  totalFloorPct: number     // TOPLAM bakiye tabanı % — başlangıçtan bu kadar düşerse bot kalıcı durur (0 = kapalı)
  lossStreakLimit: number   // üst üste kaç net zarar → giriş molası (0 = kapalı)
  lossStreakPauseSec: number // zarar serisi sonrası giriş molası süresi (sn)
}

export interface Position {
  id: string
  symbol: string            // pozisyonun açıldığı sembol (çoklu tarama)
  side: Side
  qty: number               // base asset miktarı
  entryPrice: number
  notional: number          // giriş anındaki pozisyon büyüklüğü (USDT)
  margin: number            // ayrılan marj (USDT)
  leverage: number
  entryTime: number
  entryFee: number          // giriş ücreti (USDT)
  feeBreakevenPct: number   // bu pozisyon için başabaş fiyat hareketi %
  takeProfitPct: number
  stopLossPct: number
  reason: string            // giriş sinyali açıklaması (TR)
  makerEntry: boolean       // giriş maker (defter fiyatı) ile mi açıldı
  // ---- keskin çıkış motoru durumu ----
  bestPrice: number         // pozisyon lehine en iyi fiyat (zirve/dip)
  trailStop: number | null  // sıkışan trailing stop (null = kilit henüz yok)
  adverseStreak: number     // üst üste ters 1sn momentum saniyesi
  momEvalSec: number        // momentum ölümünün son değerlendirme saniyesi (tick başına 1 kez)
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
  grossPnl: number          // ücret öncesi
  fees: number              // toplam ücret (giriş+çıkış)
  netPnl: number            // kesin net kâr/zarar
  pnlPct: number            // marj yüzdesi (kaldıraçlı getiri)
  movePct: number           // fiyat yüzdesel hareketi
  balanceAfter: number
  reason: ExitReason
  entrySignal: string
}

export interface Indicators {
  emaFast1m: number         // 1m EMA9
  emaSlow1m: number         // 1m EMA21
  emaFast1s: number         // 1s EMA5
  emaSlow1s: number         // 1s EMA20
  rsi1m: number             // 1m RSI14
  trend1m: 'BULL' | 'BEAR' | 'FLAT'
  momentum1s: 'UP' | 'DOWN' | 'FLAT'
  lastSignal: string        // son değerlendirme özeti (TR)
}

/** Giriş kapısı tek koşulun canlı durumu — "neden bekliyor" matrisinin hücresi */
export interface GateCheck {
  key: 'DATA' | 'TREND' | 'MOMENTUM' | 'RSI' | 'FLOW' | 'MTF5M' | 'HTF15M' | 'SPIKE' | 'REGIME'
  label: string     // TR kısa etiket (satır adı)
  ok: boolean | null  // true = geçti · false = ENGEL · null = filtre kapalı / yön yok (işlevsel değil)
  value: string     // canlı değer ("BOĞA", "55", "%61 alış"…)
}

/** Bir sembolün saniyelik giriş kapısı durumu — dashboard "Anlık Değerlendirme" */
export interface GateStatus {
  symbol: string
  side: Side | null     // trendin baktığı yön (FLAT → null)
  checks: GateCheck[]   // sırayla değerlendirilen koşullar
  blockKey: string | null // ilk başarısız koşul (null = hepsi geçti)
  blockLabel: string   // insan cümlesi: bekleme nedeni / "Sinyal hazır"
  passed: number       // geçen işlevsel koşul sayısı
  active: number       // toplam işlevsel koşul sayısı
}

/** Motoru girişten alıkoyan GLOBAL durumlar (sembolden bağımsız) */
export interface EntryLock {
  running: boolean            // bot çalışıyor mu
  busySymbol: string | null   // açık pozisyonun sembolü (yoksa null)
  busySide: Side | null
  pendingSymbol: string | null // bekleyen maker emri sembolü
  pendingSide: Side | null
  cooldownRemainSec: number   // işlemler arası beklemeden kalan saniye
  dayStopped: boolean         // günlük zarar tavanı vurdu mu
  dayLossPct: number          // bugünkü bakiye değişimi % (− = zarar)
  dayLossLimitPct: number    // tavan %
  lossStreak: number          // mevcut ardışık net zarar sayısı
  lossPauseRemainSec: number  // zarar serisi molasından kalan saniye (0 = mola yok)
  lossStreakLimit: number     // kaçıncı zararda mola başlar
  tradesToday: number         // bugün kapanan işlem sayısı
  maxTradesPerDay: number     // günlük işlem tavanı (0 = sınırsız)
  hardStopped: boolean        // TOPLAM bakiye tabanı vurdu mu (kalıcı — elle sıfırlanır)
  floorUsedPct: number        // taban referansından bugüne bakiye değişimi % (− = aşağı)
  floorLimitPct: number       // taban % (0 = koruma kapalı)
}

/** Tarayıcıdaki tek sembolün özeti (dashboard radar satırı) */
export interface WatchItem {
  symbol: string
  price: number
  change24hPct: number
  spreadPct: number
  trend1m: 'BULL' | 'BEAR' | 'FLAT'
  momentum1s: 'UP' | 'DOWN' | 'FLAT'
  rsi1m: number
  score: number             // sinyal gücü (giriş koşulu geçenler sıralanır)
  ready: boolean            // tüm giriş koşulları şu an geçiyor mu
  readySide: Side | null    // geçiyorsa yön
  readyData: boolean        // yeterli mum verisi toplandı mı
  regimeScore: number       // rejim skoru: ort. 1m hareket / işlem maliyeti
  regimeRank: number        // skor sıralaması (1 = en değerli av sahası)
  regimeEligible: boolean   // rejim filtresi gereği işlem yapmaya uygun mu
  flow: number | null       // emir defteri dengesizliği EMA'sı (0..1; null = veri yok)
  htfTrend: 'BULL' | 'BEAR' | 'FLAT' | 'NA'   // 15dk üst zaman dilimi trendi (NA = veri yetersiz)
  gate: {                    // saniyelik giriş kapısı özeti (neden bekliyor)
    side: Side | null
    blockKey: string | null
    blockLabel: string
  }
}

export interface EngineStats {
  totalTrades: number
  wins: number
  losses: number
  winRate: number           // 0..100
  netPnl: number            // toplam net (USDT)
  grossPnl: number
  totalFees: number
  avgNet: number
  bestTrade: number
  worstTrade: number
  profitFactor: number | null // toplam kâr / |toplam zarar|; null = ∞ (kayıp yok — JSON-güvenli)
  maxDrawdownPct: number
  avgHoldSec: number
  tradesPerHour: number
}

export interface EquityPoint {
  t: number
  balance: number
}

export interface EngineSnapshot {
  connected: boolean        // Binance WS bağlı mı
  wsStatus: string          // TR durum metni
  streamMode: 'FUTURES' | 'SPOT'   // birincil akış: futures bookTicker mi, spot yedek mi
  streamSource: string      // TR kaynak açıklaması
  running: boolean
  settings: BotSettings
  scanMode: ScanMode        // tarama modu (ayarlardan aynen)
  displaySymbol: string     // grafikte gösterilen sembol (pozisyon varsa pozisyonun sembolü)
  trackedSymbols: string[]  // motorun izlediği tüm semboller
  scanner: {                // çoklu tarama radarı
    tickRate: number        // toplam WS mesaj/sn (performans kanıtı)
    watch: WatchItem[]
    regime: {               // rejim skoreri — "hangi coin şu an avlanmaya değer"
      filterOn: boolean
      minScore: number
      topN: number
      eligible: string[]    // şu an uygun semboller
      status: string        // TR durum metni (neden işlem yok dahil)
    }
  }
  price: number             // takip fiyatı (displaySymbol)
  bid: number               // en iyi alış (0 = spot yedek modda)
  ask: number               // en iyi satış (0 = spot yedek modda)
  spread: number            // mutlak spread
  spreadPct: number         // spread %
  priceChange24hPct: number
  markPrice: number
  serverTime: number
  account: {
    balance: number
    startBalance: number
    growthPct: number
    equity: number          // bakiye + açık pozisyon net K/Z
  }
  position: OpenPositionView | null
  pending: PendingOrderView | null   // bekleyen maker giriş emri (yoksa null)
  indicators: Indicators
  gateDetail: GateStatus | null   // displaySymbol'in tam koşul matrisi (null = veri hiç yok)
  entryLock: EntryLock            // girişi kilitleyen global durumlar
  stats: EngineStats
  candles1m: Candle[]       // son ~120 (displaySymbol)
  candles1s: Candle[]       // son ~90 (displaySymbol)
  equity: EquityPoint[]     // son ~200
  trades: Trade[]           // son ~50 (yeniden eskiye)
  feeBreakevenPct: number   // güncel ayarlarla başabaş hareket %
  logs: LogLine[]           // son ~40 motor günlüğü
  recon: ReconInfo           // mutabakat durumu (güvenlik ağı A)
  api: ApiWeightView | null  // hız limiti göstergesi (güvenlik ağı B) — veri yoksa null
}

/** Bekleyen maker giriş emri — dolumu defter fiyatından bekleniyor */
export interface PendingOrderView {
  symbol: string
  side: Side
  qty: number
  limitPrice: number
  placedSec: number         // kaç saniyedir bekliyor
  expiresSec: number        // kaç saniye sonra iptal olacak
}

export interface OpenPositionView {
  symbol: string            // çoklu taramada hangi coinde işlem açık
  side: Side
  qty: number
  entryPrice: number
  entryTime: number
  markPrice: number
  movePct: number           // fiyattaki yön-ağırlıklı hareket %
  grossPnl: number
  fees: number              // gerçekleşen + tahmini çıkış ücreti
  netPnl: number            // net (giriş ücreti + tahmini çıkış ücreti düşülmüş)
  pnlPct: number            // marj yüzdesi
  takeProfitPrice: number
  stopLossPrice: number
  trailStop: number | null      // kâr kilidi fiyatı (kurulmadıysa null) — panel pistinde çentik
  holdSec: number
  maxHoldSec: number
  reason: string
}

export interface LogLine {
  t: number
  level: 'info' | 'trade' | 'warn' | 'error'
  msg: string
}

/**
 * Güvenlik ağı A — borsa ↔ bot pozisyon mutabakatı.
 * LIVE modda 60sn'de bir /fapi/v2/positionRisk ile borsanın gerçeği
 * karşılaştırılır: yetim pozisyon kapatılır, botun bildiği ama borsada
 * olmayan pozisyonun defteri düzeltilir. PAPER modda kapalıdır (OFF).
 */
export interface ReconInfo {
  lastCheck: number                     // 0 = hiç kontrol yapılmadı
  status: 'OFF' | 'OK' | 'MISMATCH' | 'ERROR'
  issues: string[]                      // TR açıklamalı uyumsuzluk listesi
  autoClosed: number                    // bugüne kadar otomatik kapatılan yetim pozisyon
}

/** Güvenlik ağı B — API hız limiti göstergesi (IP ağırlığı, son 1 dk) */
export interface ApiWeightView {
  weightUsed1m: number
  weightLimit1m: number                  // ~2400 (Binance fapi varsayılan tavan)
  updatedAt: number
}

export interface ControlAction {
  action: 'start' | 'stop' | 'close' | 'reset' | 'updateSettings' | 'resetBalance' | 'setBalance' | 'clearFloor'
  settings?: Partial<BotSettings>
  apiKey?: string
  apiSecret?: string
  balance?: number                    // 'setBalance': PAPER bakiyeyi elle ayarla (USDT)
}

// Not: Backtest/optimizasyon modülü kullanıcı kararıyla KALDIRILDI (2026-11).
// Motor yalnız canlı değerlendirme yapar; parametre ayarı ayarlar panelinden.
