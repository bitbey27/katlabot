// ============================================================
// KatlaBot — Scalping Strateji Motoru (ÇOKLU SEMBOL TARAYICI)
//
// Kullanıcı gereksinimleri:
//  1) Saniyelik gerçek zamanlı izleme (futures bookTicker — ~800 vuruş/sn)
//  2) Yüksek frekanslı sürekli işlem — sinyal geldiğinde anında giriş
//  3) "Kar görünce kapat" — küçük kâr hedefi, hızlı çıkış
//  4) Çift yönlü — LONG ve SHORT
//  5) Kaldıraç tavanı 10x
//  6) Ücret farkındalığı — net kâr, gidiş-dönüş taker ücretini geçmeli
//  7) Bileşik büyüme — pozisyon boyutu güncel bakiyeden türetilir
//  8) ÇOKLU TARAMA — 9 coin TEK WebSocket soketinde izlenir;
//     sinyal üreten coinler skorlanır, EN GÜÇLÜ fırsata girilir.
//     Hız garantisi: tek soket ~800 mesaj/sn (tekli modun 2 katı),
//     vuruş başına iş O(1), indikatörler yalnız saniye kapanışında.
//
// Veri kaynağı: Binance USDT-M FUTURES bookTicker combined stream
// (gerçek emir defteri bid/ask). PAPER dolumları bid/ask'ten yapılır
// (gerçek taker ekonomisi); LIVE emirler futures REST üzerinden
// gerçekleşir. Futures akışı bu ağda filtrelenirse spot akışına
// otomatik yedek geçilir.
// Strateji: 1m EMA(9/21) trend yönü + 1s EMA(3/8) momentum tetikleyicisi
//           + RSI(14) filtresi. Giriş piyasa emri; çıkışlar TP / SL /
//           süre tavanı / sinyal ters dönüş / manuel.
// ============================================================

import type {
  BotSettings, Candle, EngineSnapshot, EngineStats, EquityPoint,
  Indicators, LogLine, OpenPositionView, Position, Side, Trade, ExitReason, BotMode, ScanMode, WatchItem,
  ReconInfo, GateStatus, GateCheck, EntryLock,
} from './types'
import { ema, closes, rsi, roundStep, atr } from './indicators'
import {
  BinanceStream, fetchKlinesRetry, fetchFiltersForSymbols, fetch24hChange,
  fetch24hChangeViaKlines,
  setApiCreds, hasApiCreds, setLeverage, setMarginType, marketOrder, fetchBalance, newId,
  fetchPositionRisk, getApiWeight, limitMakerOrder, cancelOrder, getOrder,
} from './binance'
import type { TickPayload, StreamMode } from './binance'
import {
  loadSettings, saveSettings, saveTrade, loadTrades, deleteAllTrades,
  saveEquity, loadEquity, deleteAllEquity, kvGetNumber, kvSetNumber,
  kvGetString, kvSetString, countTradesSince,
  loadCandleCache, saveCandleCache, loadCandlesByKey, saveCandlesByKey,
} from './store'

const MAX_LEVERAGE = 25          // KULLANICI TAVANI — asla aşılamaz (kullanıcı talebi: maks 25x)
const SLIPPAGE_PCT = 0.01        // bid/ask yoksa (spot yedek) uygulanan kayma %
const CHART_1S_KEEP = 90
const CHART_1M_KEEP = 150
const PERSIST_1S_KEEP = 1800     // 1s mum önbelleği — 30dk sürekli kalıcı veri
const HTF_15M_KEEP = 60           // 15dk mum sayısı (EMA21 + ısınma)
const FLOW_EMA_ALPHA = 0.02       // order-flow EMA yumuşatması (~2-3sn pencere, ~100 vuruş)
const FLOW_MIN_SAMPLES = 60       // bu kadar vuruş toplanmadan filtre kararı vermez
const EQUITY_KEEP = 400
const BOOT_CONCURRENCY = 3       // geçmiş mum çekerken paralel REST sayısı (hız limiti dostu)

/** Sembol başına canlı durum — motorun kalbi */
interface SymState {
  symbol: string
  candles1m: Candle[]
  candles1s: Candle[]
  cur1m: Candle | null
  cur1s: Candle | null
  synth1m: Candle | null
  price: number
  markPrice: number
  bid: number
  ask: number
  spread: number
  spreadPct: number
  spreadEma: number          // yumuşatılmış spread % (rejim skoru maliyeti için)
  lastTradeTs: number
  change24hPct: number
  filter: { stepSize: number; minQty: number; minNotional: number; tickSize: number }
  signal: Indicators
  score: number
  readySide: Side | null
  candlesDirty: boolean
  historyLoaded: boolean
  regimeScore: number        // rejim skoru: ort. 1m hareket / işlem maliyeti
  regimeRank: number         // 1 = en değerli av sahası
  regimeStreak: number       // histerezis: üst üste kaç değerlendirmede uygun
  regimeEligible: boolean    // streak ≥ 2 → işlem yapmaya uygun
  // ---- Aşama 1/3: uyarlanabilir risk + sinyal filtreleri ----
  atrPct: number             // 1dk ATR14 % (oynaklık — uyarlanabilir TP/SL girdisi)
  flowEma: number            // order-flow dengesizliği EMA'sı (0..1; 0.5 = dengeli)
  flowSamples: number        // kaç vuruş örnekledi (az ise filtre devre dışı)
  momDirSince: number        // momentumun son yön değiştirme anı (ms) — giriş süreklilik şartının saati
  candles15m: Candle[]       // 15dk mumları (üst zaman dilimi trendi)
  cur15m: Candle | null      // cari (kısmi) 15dk mumu
  htfTrend: 'BULL' | 'BEAR' | 'FLAT' | 'NA'   // NA = yeterli 15dk veri yok
  // ---- keskin çıkış: 5dk MTF katmanı ----
  candles5m: Candle[]        // 5dk mumları (orta zaman dilimi onayı)
  cur5m: Candle | null       // cari (kısmi) 5dk mumu
  trend5m: 'BULL' | 'BEAR' | 'FLAT' | 'NA'    // NA = yeterli 5dk veri yok
}

/** Bekleyen maker giriş emri (Aşama 2) */
interface PendingEntry {
  symbol: string
  side: Side
  qty: number
  limitPrice: number
  placedTs: number
  expiresTs: number
  why: string
  effTpPct: number           // dolumda pozisyona yazılacak uyarlanabilir TP
  effSlPct: number
  leverage: number
  margin: number
  liveOrderId: number | null // LIVE: borsadaki emir kimliği
}

function blankSignal(): Indicators {
  return {
    emaFast1m: 0, emaSlow1m: 0, emaFast1s: 0, emaSlow1s: 0, rsi1m: 50,
    trend1m: 'FLAT', momentum1s: 'FLAT', lastSignal: 'Veri bekleniyor…',
  }
}

function blankState(symbol: string): SymState {
  return {
    symbol,
    candles1m: [], candles1s: [], cur1m: null, cur1s: null, synth1m: null,
    price: 0, markPrice: 0, bid: 0, ask: 0, spread: 0, spreadPct: 0, spreadEma: 0,
    lastTradeTs: 0, change24hPct: 0,
    filter: { stepSize: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.1 },
    signal: blankSignal(),
    score: 0, readySide: null,
    candlesDirty: false, historyLoaded: false,
    regimeScore: 0, regimeRank: 0, regimeStreak: 0, regimeEligible: false,
    atrPct: 0, flowEma: 0.5, flowSamples: 0, momDirSince: 0,
    candles15m: [], cur15m: null, htfTrend: 'NA',
    candles5m: [], cur5m: null, trend5m: 'NA',
  }
}

export class TradeEngine {
  settings: BotSettings
  running = false
  connected = false
  wsStatus = 'Bağlanıyor…'

  balance: number
  position: Position | null = null
  trades: Trade[] = []
  equity: EquityPoint[] = []
  logs: LogLine[] = []

  /** İzlenen tüm sembollerin durumu */
  private sym = new Map<string, SymState>()
  streamMode: StreamMode = 'FUTURES'
  lastTradeTs = 0

  /** Bekleyen maker giriş emri (Aşama 2) — dolarsa pozisyona dönüşür */
  private pending: PendingEntry | null = null
  private pendingPollTimer: ReturnType<typeof setInterval> | null = null

  /** Sinyal/girişler için motor-geneli durum */
  private engineSignal: Indicators = blankSignal()
  private stream: BinanceStream
  private lastEntryTs = 0
  private statsCache: EngineStats | null = null
  private lastStatsTrades = -1
  private lastEquitySave = 0
  private startedAt = Date.now()
  private leverageSetFor = new Set<string>()   // LIVE: kaldıraç + ISOLATED marj ayarlanmış semboller

  // ---- günlük zarar tavanı (kanama koruması) ----
  private dayKey = ''            // YYYY-AA-GG — gün değişince referans sıfırlanır
  private dayStartBalance = 0    // günün ilk bakiyesi (tavan karşılaştırması)
  private dayStopped = false     // bugün tavan yüzünden durduruldu mu (çift kayıt koruması)

  // ---- kanama kesme devreleri ----
  private lossStreak = 0
  private lossPauseUntil = 0

  // ---- günlük işlem tavanı + sembol soğuması (frekans disiplini) ----
  private tradesToday = 0                                // bugün kapanan işlem (tavan sayacı)
  private symCooldownUntil = new Map<string, number>()   // MOMENTUM/SL sonrası sembol soğuması
  private floorRefBalance = 0
  private hardStopped = false

  // ---- güvenlik ağı: borsa ↔ bot mutabakat durumu ----
  private recon: ReconInfo = { lastCheck: 0, status: 'OFF', issues: [], autoClosed: 0 }
  // 24s değişim kaynağının sağlık durumu (null=henüz denemedi; true=son tazeleme OK)
  // — yalnız durum DEĞİŞİNCE loglanır (spam yok)
  private change24hOk: boolean | null = null
  private reconTimer: ReturnType<typeof setInterval> | null = null
  private reconPrevStatus: ReconInfo['status'] = 'OFF'
  private reconLoggedIssues = new Set<string>()   // aynı uyarıyı 60sn'de bir tekrar yazmamak için

  /**
   * LIVE risk yönetimi: sembolü ISOLATED marja çevir + kaldıracı ayarla.
   * ISOLATED olmadan Binance pozisyonu CROSS hesaplarda TÜM cüzdan bakiyesiyle
   * teminatlar (likidasyon tüm bakiyeyi baz alır). ISOLATED'da risk sadece
   * pozisyona ayrılan marjla sınırlıdır — %25 tahsis = en kötü durumda bakiyenin
   * yalnız %25'inin riske girmesi.
   */
  private async ensureIsolatedAndLeveraged(symbol: string, leverage: number) {
    try {
      await setMarginType(symbol, 'ISOLATED')
    } catch (e) {
      // -4048: açık pozisyon varken tip değişmez → mevcut pozisyon kapanınca sonraki girişte tekrar denenir
      this.log('warn', `${symbol} ISOLATED marja çevrilemedi (açık pozisyon olabilir): ${String(e)}`)
    }
    await setLeverage(symbol, leverage)
    this.leverageSetFor.add(symbol)
  }

  // ---------------- Güvenlik ağı A: pozisyon mutabakatı ----------------

  /** Mutabakat döngüsünü başlat (idempotent — LIVE + API anahtarı varken yaşar) */
  private startReconLoop() {
    if (this.reconTimer) return
    this.reconTimer = setInterval(() => { void this.reconcile() }, 60_000)
    this.log('info', 'Güvenlik ağı aktif: borsa ↔ bot mutabakatı 60sn\u0027de bir çalışacak')
    void this.reconcile() // ilk kontrol hemen
  }

  /** Aynı uyarıyı defalarca loglamamak için — dashboard listesinde yine görünür */
  private reconLogOnce(key: string, level: LogLine['level'], msg: string) {
    if (this.reconLoggedIssues.has(key)) return
    this.reconLoggedIssues.add(key)
    this.log(level, msg)
  }

  /**
   * Borsa gerçeği (positionRisk) ↔ bot defteri karşılaştırması.
   * Kapatığı sorunlar:
   *   1) YETİM  : borsada pozisyon var, bot bilmiyor (ağ timeout, restart
   *               sonrası, dış müdahale) → reduceOnly ile kapatılır.
   *               Bot durdurulmuşken bile izlenen sembollerde taranır.
   *   2) HAYALENİ: bot pozisyon biliyor, borsada yok (çıkış emri aslında
   *               gerçekleşmiş ama yanıt kaybolmuş) → defter mevcut referans
   *               fiyatıyla RECON nedeniyle kapatılır.
   *   3) UYUMSUZLUK: yön/miktar sapması → kayda geçer, dashboard'da uyarı.
   *   Botun İZLEMEDİĞİ sembollerdeki pozisyonlar kullanıcının kendi manuel
   *   işlemleridir → asla dokunulmaz, yalnızca bilgi verilir.
   */
  private async reconcile() {
    if (this.settings.mode !== 'LIVE' || !hasApiCreds()) {
      if (this.recon.status !== 'OFF') {
        this.recon = { lastCheck: this.recon.lastCheck, status: 'OFF', issues: [], autoClosed: this.recon.autoClosed }
      }
      return
    }
    // taze pozisyon: giriş emri henüz gerçekleşiyor olabilir — yanlış alarmı önle
    if (this.position && Date.now() - this.position.entryTime < 15_000) return

    try {
      const rows = await fetchPositionRisk()
      const open = rows.filter(r => Math.abs(r.positionAmt) > 0)
      const tracked = new Set(this.activeSymbols())
      const issues: string[] = []

      // --- 1) yetim / izlenmeyen pozisyonlar ---
      for (const r of open) {
        if (this.position && this.position.symbol === r.symbol) continue // aşağıda karşılaştırılır
        if (!tracked.has(r.symbol)) {
          issues.push(`${r.symbol}: botun izlemediği sembolde pozisyon var (${r.positionAmt}) — manuel işleminiz olabilir, DOKUNULMADI`)
          this.reconLogOnce(`untracked:${r.symbol}`, 'warn', `MUTABAKAT: ${r.symbol} borsada pozisyon var ama bot bu sembolü izlemiyor — dokunulmadı (manuel işlem olabilir)`)
          continue
        }
        const side = r.positionAmt > 0 ? 'LONG' : 'SHORT'
        try {
          await marketOrder(r.symbol, side === 'LONG' ? 'SELL' : 'BUY', Math.abs(r.positionAmt), true)
          this.recon.autoClosed++
          issues.push(`${r.symbol}: yetim ${side} pozisyonu reduceOnly ile kapatıldı (${Math.abs(r.positionAmt)})`)
          this.log('error', `MUTABAKAT: ${r.symbol} sembolünde botun bilmediği ${side} pozisyonu bulundu → reduceOnly ile kapatıldı`)
        } catch (e) {
          issues.push(`${r.symbol}: yetim pozisyon KAPATILAMADI — elle kontrol et! (${String(e)})`)
          this.log('error', `MUTABAKAT: ${r.symbol} yetim pozisyonu kapatılamadı: ${String(e)}`)
        }
      }

      // --- 2) botun bildiği pozisyon borsada var mı / uyumlu mı? ---
      const p = this.position
      if (p) {
        const row = open.find(r => r.symbol === p.symbol)
        if (!row) {
          const s = this.sym.get(p.symbol)
          const ref = s ? this.exitRefPriceFor(s, p.side) : p.entryPrice
          issues.push(`${p.symbol}: bot pozisyon biliyor ama borsada yok — defter ${ref.toFixed(this.priceDigitsFor(ref))} ile düzeltildi`)
          this.log('error', `MUTABAKAT: ${p.symbol} bot defterinde var, borsada yok → çıkış gerçekleşmiş, defter düzeltildi`)
          this.settleClose(p, ref, 'RECON')
        } else {
          const sameSide = (row.positionAmt > 0) === (p.side === 'LONG')
          const qtyDiffPct = Math.abs(Math.abs(row.positionAmt) - p.qty) / p.qty
          if (!sameSide) {
            issues.push(`${p.symbol}: YÖN uyumsuzluğu — borsa ${row.positionAmt > 0 ? 'LONG' : 'SHORT'}, bot ${p.side}`)
          } else if (qtyDiffPct > 0.05) {
            issues.push(`${p.symbol}: miktar sapması %${(qtyDiffPct * 100).toFixed(1)} (borsa ${Math.abs(row.positionAmt)}, bot ${p.qty})`)
          }
        }
      }

      const status: ReconInfo['status'] = issues.length ? 'MISMATCH' : 'OK'
      this.recon = { lastCheck: Date.now(), status, issues, autoClosed: this.recon.autoClosed }
      // durum geçişlerini logla (her 60sn spam yerine)
      if (status !== this.reconPrevStatus) {
        if (status === 'OK') this.log('info', 'MUTABAKAT TAMAM: borsa ve bot defteri uyumlu')
        else this.log('warn', `MUTABAKAT UYUŞMAZLIĞI (${issues.length} sorun): ${issues.join(' | ')}`)
        this.reconPrevStatus = status
      }
    } catch (e) {
      this.recon = { lastCheck: Date.now(), status: 'ERROR', issues: [`positionRisk alınamadı: ${String(e)}`], autoClosed: this.recon.autoClosed }
      if (this.reconPrevStatus !== 'ERROR') {
        this.log('warn', `MUTABAKAT: borsadan pozisyon bilgisi alınamadı: ${String(e)}`)
        this.reconPrevStatus = 'ERROR'
      }
    }
  }

  // ---- performans ölçümü (hız kanıtı dashboard'a akar) ----
  private tickCount = 0
  private tickRate = 0
  private tickWindowStart = Date.now()
  private lastPerfLog = 0
  private scanDurationMs = 0

  constructor() {
    this.settings = loadSettings()
    this.settings.leverage = Math.min(this.settings.leverage, MAX_LEVERAGE) // tavanı zorla uygula
    if (!this.settings.watchlist || this.settings.watchlist.length === 0) {
      this.settings.watchlist = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT']
    }
    this.balance = kvGetNumber('balance', this.settings.startBalance)
    this.trades = loadTrades(200)
    this.equity = loadEquity()
    if (this.equity.length === 0) {
      this.equity.push({ t: Date.now(), balance: this.balance })
      saveEquity(Date.now(), this.balance)
    }
    // toplam bakiye tabanı — kalıcı referans + kalıcı dur durumu
    this.floorRefBalance = kvGetNumber('floor_ref_balance', 0)
    this.hardStopped = kvGetNumber('hard_stopped', 0) === 1
    if (this.hardStopped) {
      this.log('error', `🛑 TOPLAM BAKİYE TABANI hâlâ kilitli — bot start edemez (panelden "Tabanı Sıfırla" gerekir)`)
    }
    this.log('info', `Motor hazır — kalıcılık yüklendi, bakiye ${this.balance.toFixed(2)} USDT`)

    this.stream = new BinanceStream({
      onOpen: () => {
        this.connected = true
        this.log('info', `Binance WS bağlandı (${this.activeSymbols().length} sembol, tek soket)`)
      },
      onClose: () => {
        this.connected = false
        this.wsStatus = 'Bağlantı koptu — yeniden deniyor'
        this.log('warn', 'Binance WS bağlantısı koptu, otomatik yeniden bağlanılıyor')
      },
      onError: () => {
        this.connected = false
        this.wsStatus = 'Bağlantı hatası'
      },
      onMode: (mode, status) => {
        this.streamMode = mode
        this.wsStatus = status
        this.log(mode === 'FUTURES' ? 'info' : 'warn', `Veri kaynağı: ${status}`)
      },
      onTicker24h: (symbol, pct) => {
        const s = this.sym.get(symbol)
        if (s) s.change24hPct = pct
      },
      onTick: (t) => this.onTick(t),
      onKline1m: (symbol, c, closed) => this.onKline1m(symbol, c, closed),
    })
  }

  // ---------------- Görünüm erişimcileri (displaySymbol odaklı) ----------------

  /** Motorun izlediği semboller (moda göre) */
  activeSymbols(): string[] {
    if (this.settings.scanMode === 'MULTI') return [...this.settings.watchlist]
    return [this.settings.symbol]
  }

  /** Grafikte gösterilen sembol: pozisyon varsa pozisyonun sembolü, yoksa odak */
  displaySymbol(): string {
    if (this.position) return this.position.symbol
    const active = this.activeSymbols()
    return active.includes(this.settings.symbol) ? this.settings.symbol : active[0] ?? this.settings.symbol
  }

  private st(symbol?: string): SymState | null {
    const sym = symbol ?? this.displaySymbol()
    return this.sym.get(sym) ?? null
  }

  get price(): number { return this.st()?.price ?? 0 }
  get markPrice(): number { return this.st()?.markPrice ?? 0 }
  get bid(): number { return this.st()?.bid ?? 0 }
  get ask(): number { return this.st()?.ask ?? 0 }
  get spread(): number { return this.st()?.spread ?? 0 }
  get spreadPct(): number { return this.st()?.spreadPct ?? 0 }
  get priceChange24hPct(): number { return this.st()?.change24hPct ?? 0 }
  get candles1m(): Candle[] { return this.st()?.candles1m ?? [] }
  get candles1s(): Candle[] { return this.st()?.candles1s ?? [] }
  get cur1m(): Candle | null { return this.st()?.cur1m ?? null }
  get cur1s(): Candle | null { return this.st()?.cur1s ?? null }

  // ---------------- Yaşam döngüsü ----------------

  /**
   * Odak sembol değişimi.
   *  - SINGLE mod: tam sıfırla + yeniden başlat (eski davranış)
   *  - MULTI mod: yalnız grafik odağı değişir — pozisyon ve izleme etkilenmez
   */
  async switchSymbol(symbol: string) {
    this.settings.symbol = symbol
    saveSettings(this.settings)
    if (this.settings.scanMode === 'MULTI') {
      if (!this.sym.has(symbol)) {
        // odak, izleme listesinde yoksa state'i hazırla (veri akışıyla dolar)
        this.sym.set(symbol, blankState(symbol))
      }
      this.log('info', `Grafik odağı → ${symbol} (çoklu tarama sürüyor)`)
      return
    }
    // TEK sembol modu: eski sembolün durumunu bırakma, pozisyonu geçersiz kıl
    this.sym.clear()
    this.position = null // açık pozisyon yeni sembolde geçersiz — kapatılmış sayılır
    this.log('warn', `Sembol değişti → ${symbol}. Açık pozisyon iptal edildi, geçmiş veriler yeniden yükleniyor.`)
    await this.bootstrapMarkets([symbol])
    this.stream.connect([symbol])
  }

  /** Tarama modu değişti — sembol setini kur, akışı yeniden bağla */
  async switchScanMode() {
    const symbols = this.activeSymbols()
    // mod kapalı → açıldı: tüm watchlist state'lerini hazırla
    for (const s of symbols) if (!this.sym.has(s)) this.sym.set(s, blankState(s))
    if (this.position && !symbols.includes(this.position.symbol)) {
      // tekli moda dönerken pozisyon listede değilse kapat
      this.closePosition('MANUAL')
    }
    this.log('info', `Tarama modu: ${this.settings.scanMode} — ${symbols.length} sembol izleniyor`)
    await this.bootstrapMarkets(symbols)
    this.stream.connect(symbols)
  }

  /**
   * Geçmiş + filtre yükleme (çoklu sembol).
   * Önce odak sembol (grafik hızlı dolsun), kalanı arka planda
   * küçük paralellikle (hız limiti dostu).
   */
  async bootstrapMarkets(symbols: string[]) {
    const focus = this.displaySymbol()
    const ordered = [focus, ...symbols.filter(s => s !== focus)]
    // 1) TÜM filtreler TEK exchangeInfo çağrısında
    let filters: Map<string, SymState['filter']>
    try {
      filters = await fetchFiltersForSymbols(ordered)
    } catch {
      filters = new Map()
    }

    // 2) her sembol için state hazırla (filtreleri hemen koy)
    for (const s of ordered) {
      if (!this.sym.has(s)) this.sym.set(s, blankState(s))
      const f = filters.get(s)
      if (f) this.sym.get(s)!.filter = f
    }

    // 3) kline geçmişleri — odak önce, sonra paralel 3'lü gruplar
    const groups: string[][] = []
    const rest = ordered.slice(1)
    for (let i = 0; i < rest.length; i += BOOT_CONCURRENCY) groups.push(rest.slice(i, i + BOOT_CONCURRENCY))
    await this.loadHistory(focus)
    for (const g of groups) await Promise.all(g.map(s => this.loadHistory(s)))

    // 4) 24s değişimler — TEK toplu istek
    void this.refresh24h(ordered)
  }

  private async loadHistory(symbol: string): Promise<void> {
    const s = this.sym.get(symbol)
    if (!s || s.historyLoaded) return
    // Aşama 3c/3b: 1sn ve 15dk serileri önbellekten yükle (sıcak başlangıç + HTF)
    s.candles1s = loadCandlesByKey(`candles1s:${symbol}`).slice(-PERSIST_1S_KEEP)
    s.candles15m = loadCandlesByKey(`candles15m:${symbol}`).slice(-HTF_15M_KEEP)
    if (s.candles15m.length < 30) {
      // hız limiti dostu TEK deneme — yasak/hata durumunda boot'u bloklamaz
      try {
        const c15 = await fetchKlinesRetry(symbol, '15m', 60, undefined, 1)
        if (c15.length > s.candles15m.length) {
          s.candles15m = c15.slice(-HTF_15M_KEEP)
          saveCandlesByKey(`candles15m:${symbol}`, s.candles15m)
        }
      } catch { /* HTF verisi WS akışından da birikir */ }
    }
    this.updateHtfTrend(s)
    // ÖNCE önbellek — tazeyse REST'e hiç dokunulmaz
    const cached = loadCandleCache(symbol)
    const cacheFresh = cached.length >= 30 && Date.now() - cached[cached.length - 1].t < 300000
    if (cacheFresh) {
      s.candles1m = cached
      s.historyLoaded = true
      this.seed5mFrom1m(s)
      this.log('info', `${symbol}: ${cached.length} adet 1m mum önbellekten yüklendi (REST atlandı)`)
      const lastC = s.candles1m.at(-1)
      if (lastC) { s.price = lastC.c; s.synth1m = null }
      this.updateRegimeScores(true) // önbellekten gelince de skorlar anında hazır
      return
    }
    try {
      const candles = await fetchKlinesRetry(symbol, '1m', CHART_1M_KEEP)
      s.candles1m = candles
      s.historyLoaded = true
      this.seed5mFrom1m(s)
      this.log('info', `${symbol}: ${candles.length} adet 1m mum yüklendi (REST)`)
      saveCandleCache(symbol, candles)
      const lastC = candles.at(-1)
      if (lastC) { s.price = lastC.c; s.synth1m = null }
      this.updateRegimeScores(true) // geçmiş gelince skorlar anında hesaplanır
    } catch {
      if (cached.length > 0) {
        s.candles1m = cached
        s.historyLoaded = true
        this.log('warn', `${symbol}: REST mumlar alınamadı — eski önbellek kullanılıyor (${cached.length} mum)`)
      } else {
        this.log('warn', `${symbol}: geçmiş mumlar alınamadı — WS akışından dolacak`)
      }
    }
  }

  /** Eksik geçmişi 90 saniyede bir arka plandan dene */
  private historyRetryTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleHistoryRetry() {
    if (this.historyRetryTimer) return
    this.historyRetryTimer = setTimeout(async () => {
      this.historyRetryTimer = null
      const pending = this.activeSymbols().filter(s => {
        const st = this.sym.get(s)
        return st && st.candles1m.length < 30
      })
      for (const s of pending) {
        try {
          const st = this.sym.get(s)!
          st.historyLoaded = false
          await this.loadHistory(s)
        } catch { /* tekrar denenecek */ }
      }
      const still = this.activeSymbols().filter(s => (this.sym.get(s)?.candles1m.length ?? 0) < 30)
      if (still.length > 0) this.scheduleHistoryRetry()
    }, 90000)
  }

  private async refresh24h(symbols: string[]) {
    // 5 Kasım: ticker endpoint'i (/fapi/v1/ticker/24hr) bazı bulut IP'lerinde tıkanıyor —
    // Render'da tüm semboller 0.00% kalıyordu. Klines ailesi (boot'ta kanıtlanmış) birincil
    // kaynak: 1h×25 mum ≈ 24 saatlik pencere (ilk açılış → son kapanış). Yedek: ticker.
    const results = await Promise.all(symbols.map(async (sym) => {
      const viaK = await fetch24hChangeViaKlines(sym)
      if (viaK !== null) return viaK
      return await fetch24hChange(sym)   // yedek: klasik ticker (ağırlık 1)
    }))
    let ok = 0
    for (let i = 0; i < symbols.length; i++) {
      const s = this.sym.get(symbols[i])
      if (s && results[i] !== null) { s.change24hPct = results[i] as number; ok++ }
    }
    if (ok > 0 && this.change24hOk !== true) {
      this.log('info', `24s değişimler güncellendi (${ok}/${symbols.length} sembol — 1h klines kaynağı)`)
      this.change24hOk = true
    } else if (ok === 0 && this.change24hOk !== false) {
      this.log('warn', '24s değişim alınamadı (klines + ticker tıkanmış olabilir) — sonraki periyotta tekrar')
      this.change24hOk = false
    }
  }

  start() {
    if (this.running) return { ok: false, msg: 'Bot zaten çalışıyor' }
    if (this.settings.mode === 'LIVE' && !hasApiCreds()) {
      return { ok: false, msg: 'LIVE mod için önce Ayarlar\'dan API anahtarı girin' }
    }
    // bakiye koruması — minimum pozisyon açılamıyorsa başlatma
    const anyFilter = this.st()?.filter ?? { minNotional: 5 }
    const minNotional = Math.max(anyFilter.minNotional, 5)
    if (this.balance * (this.settings.allocationPct / 100) * this.settings.leverage < minNotional) {
      return { ok: false, msg: `Bakiye yetersiz (${this.balance.toFixed(2)} USDT) — minimum emir büyüklüğü ${minNotional} USDT` }
    }
    if (this.settings.mode === 'LIVE') {
      // risk yönetimi: ISOLATED marj + kaldıraç (best-effort) — izlenen tüm semboller için
      for (const s of this.activeSymbols()) {
        this.ensureIsolatedAndLeveraged(s, this.settings.leverage)
          .catch(e => this.log('error', `${s} kaldıraç/marj ayarlanamadı: ${String(e)}`))
      }
      fetchBalance().then(b => {
        if (b !== null && b > 0) {
          this.balance = b
          this.log('info', `LIVE bakiye API'den alındı: ${b.toFixed(2)} USDT`)
        }
      }).catch(() => {})
      // güvenlik ağı: borsa ↔ bot mutabakatı (bot durdurulsa bile yaşar)
      this.startReconLoop()
    }
    this.running = true
    this.startedAt = Date.now()
    // TOPLAM bakiye tabanı — kalıcı kilit: yalnız "Tabanı Sıfırla" ile açılır
    if (this.hardStopped) {
      this.running = false
      return { ok: false, msg: `TOPLAM BAKİYE TABANI kilitli (referans ${this.floorRefBalance.toFixed(2)} USDT, −%${this.settings.totalFloorPct} aşıldı) — önce "Tabanı Sıfırla" gerekir` }
    }
    this.ensureFloorRef()
    // günlük zarar tavanı — bugün tavan aşıldıysa yeni başlatma yok (yarın sıfırlanır)
    this.rollDailyRef()
    if (this.dayStartBalance > 0 && this.balance < this.dayStartBalance) {
      const dd = (this.balance - this.dayStartBalance) / this.dayStartBalance * 100
      if (dd <= -this.settings.dailyLossPct) {
        this.running = false
        return { ok: false, msg: `Günlük zarar tavanı aşıldı (%${dd.toFixed(2)}) — bot yarın yeniden başlatılabilir` }
      }
    }
    const scope = this.settings.scanMode === 'MULTI'
      ? `ÇOKLU TARAMA (${this.activeSymbols().length} coin)`
      : this.settings.symbol
    this.log('trade', `▶ BOT BAŞLADI — ${scope} | ${this.settings.mode} | ${this.settings.leverage}x | TP ${this.feeAwareTp().toFixed(3)}% | SL ${this.settings.stopLossPct.toFixed(3)}%`)
    // otomatik devam bayrağı: motor çöküp yeniden doğarsa bot kendi gelir
    // (günlük tavan / toplam taban hâlâ geçerliyse start yine reddedilir)
    kvSetString('autostart', '1')
    return { ok: true, msg: 'Bot başlatıldı' }
  }

  stop() {
    if (!this.running) return { ok: false, msg: 'Bot zaten durduruldu' }
    // bekleyen maker emri varsa iptal (LIVE: borsadan da)
    if (this.pending) {
      const p = this.pending
      if (p.liveOrderId !== null) {
        cancelOrder(p.symbol, p.liveOrderId).catch(() => { /* zaten kapalıysa */ })
      }
      this.cancelPending('bot durduruldu')
    }
    // Açık pozisyonu piyasa fiyatından kapat (bot durdurulurken içeride kalınmaz)
    if (this.position) this.closePosition('MANUAL')
    this.running = false
    kvSetString('autostart', '0')   // elle durduruldu — yeniden doğunca kendiliğinden açılmasın
    this.log('trade', '⏸ BOT DURDURULDU — açık pozisyonlar kapatıldı')
    return { ok: true, msg: 'Bot durduruldu' }
  }

  updateSettings(patch: Partial<BotSettings>, apiKey?: string, apiSecret?: string) {
    const s = { ...this.settings, ...patch }
    // --- güvenlik sınırları ---
    s.leverage = Math.min(Math.max(Math.round(s.leverage), 1), MAX_LEVERAGE)
    s.allocationPct = Math.min(Math.max(s.allocationPct, 1), 100)
    s.takeProfitPct = Math.max(s.takeProfitPct, 0.01)
    s.stopLossPct = Math.max(s.stopLossPct, 0.05)
    s.maxHoldSec = Math.min(Math.max(s.maxHoldSec, 10), 3600)
    s.cooldownSec = Math.min(Math.max(s.cooldownSec, 0), 300)
    s.takerFeePct = Math.min(Math.max(s.takerFeePct, 0), 0.5)
    s.minEdgePct = Math.min(Math.max(s.minEdgePct, 0), 2)
    s.startBalance = Math.max(s.startBalance, 10)
    s.scanMode = s.scanMode === 'MULTI' ? 'MULTI' : 'SINGLE'
    // rejim skoreri sınırları
    s.regimeFilter = !!s.regimeFilter
    s.regimeMinScore = Math.min(Math.max(s.regimeMinScore ?? 0.9, 0.3), 3)
    s.regimeTopN = Math.min(Math.max(Math.round(s.regimeTopN ?? 3), 1), 9)
    // ---- Aşama 1/2/3 parametre sınırları ----
    s.atrAdaptive = !!s.atrAdaptive
    s.atrTpMult = Math.min(Math.max(s.atrTpMult ?? 1.2, 0.3), 5)
    s.atrSlRatio = Math.min(Math.max(s.atrSlRatio ?? 1.8, 1.0), 5)
    s.riskParity = !!s.riskParity
    s.riskPct = Math.min(Math.max(s.riskPct ?? 0.5, 0.05), 5)
    s.makerEntry = !!s.makerEntry
    s.makerFeePct = Math.min(Math.max(s.makerFeePct ?? 0.018, 0), 0.1)
    s.makerWaitSec = Math.min(Math.max(s.makerWaitSec ?? 3, 1), 30)
    s.takerMinScore = Math.min(Math.max(s.takerMinScore ?? 0.20, 0), 2)   // hızlı yakala: güçlü sinyal direkt taker
    s.minScore = Math.min(Math.max(s.minScore ?? 0.15, 0), 2)             // skor tabanı: zayıf sinyal reddi
    s.flowFilter = !!s.flowFilter
    s.flowThreshold = Math.min(Math.max(s.flowThreshold ?? 0.08, 0.02), 0.3)
    s.htfFilter = !!s.htfFilter
    // ---- keskin çıkış motoru sınırları ----
    s.sharpExit = !!s.sharpExit
    s.trailArmPct = Math.min(Math.max(s.trailArmPct ?? 0.10, 0.03), 1)
    s.trailPct = Math.min(Math.max(s.trailPct ?? 0.08, 0.02), 0.5)
    s.momentumExit = !!s.momentumExit
    s.momPersistSec = Math.min(Math.max(Math.round(s.momPersistSec ?? 10), 0), 60)
    s.mtf5mFilter = !!s.mtf5mFilter
    s.dailyLossPct = Math.min(Math.max(s.dailyLossPct ?? 2, 0.5), 20)
    s.maxTradesPerDay = Math.min(Math.max(Math.round(s.maxTradesPerDay ?? 100), 0), 500)
    // ---- kanama kesme devreleri sınırları ----
    const prevFloor = this.settings.totalFloorPct
    s.totalFloorPct = Math.min(Math.max(s.totalFloorPct ?? 10, 0), 50)   // 0 = kapalı
    s.lossStreakLimit = Math.min(Math.max(Math.round(s.lossStreakLimit ?? 3), 0), 10) // 0 = kapalı
    s.lossStreakPauseSec = Math.min(Math.max(Math.round(s.lossStreakPauseSec ?? 900), 60), 7200)
    if (!Array.isArray(s.watchlist) || s.watchlist.length === 0) s.watchlist = this.settings.watchlist

    // Ücret farkındalığı: net kâr garantisi — TP, başabaş + minimum marj üstünde olmalı
    const minTp = this.roundTripFeePct() + s.minEdgePct
    if (s.takeProfitPct < minTp) {
      s.takeProfitPct = minTp
      this.log('warn', `TP %${patch.takeProfitPct} ücret başabaşının (%${minTp.toFixed(3)}) altındaydı → otomatik %${minTp.toFixed(3)}'ye yükseltildi`)
    }
    if (s.stopLossPct <= s.takeProfitPct) {
      s.stopLossPct = s.takeProfitPct * 1.8
      this.log('warn', `SL, TP'den küçük olamaz → SL %${s.stopLossPct.toFixed(3)}'ye ayarlandı`)
    }

    const symbolChanged = s.symbol !== this.settings.symbol
    const scanModeChanged = s.scanMode !== this.settings.scanMode
    const watchlistChanged = s.scanMode === 'MULTI' && JSON.stringify(s.watchlist) !== JSON.stringify(this.settings.watchlist)
    this.settings = s
    saveSettings(s)
    this.updateRegimeScores(true) // yeni eşiklerle skorları anında yeniden hesapla

    // bakiye tabanı: kapalıdan açıldıysa referansı ŞU ANDAKİ bakiyeye kur
    // (yoksa eski/kurgusal bir referans anında kilidi tetikler)
    if (prevFloor <= 0 && s.totalFloorPct > 0) {
      this.floorRefBalance = 0
      this.ensureFloorRef()
    }
    // taban daraltıldıysa (yeni eşik mevcut düşüşün içindeyse) hemen uygula
    this.checkTotalFloor()
    // ayar değişince mevcut mola yeni süreye göre uzatılır/kısaltılır (mantıklı varsayım: kalan süre korunur)

    if (apiKey && apiSecret) {
      setApiCreds(apiKey, apiSecret)
      this.log('info', 'API anahtarı bellekte güncellendi (diske YAZILMAZ)')
    }

    // güvenlik ağı: LIVE'a geçişte veya anahtar girildiğinde mutabakat devreye girer
    if (s.mode === 'LIVE' && hasApiCreds()) this.startReconLoop()

    if (scanModeChanged || watchlistChanged) {
      void this.switchScanMode()
    } else if (symbolChanged) {
      void this.switchSymbol(s.symbol)
    } else if (s.mode === 'LIVE') {
      this.ensureIsolatedAndLeveraged(s.symbol, s.leverage)
        .catch(e => this.log('error', `Kaldıraç/marj ayarlanamadı: ${String(e)}`))
    }
    this.log('info', `Ayarlar güncellendi: ${s.leverage}x, tahsis %${s.allocationPct}, TP %${s.takeProfitPct.toFixed(3)}, SL %${s.stopLossPct.toFixed(3)}, mod ${s.mode}, tarama ${s.scanMode}`)
    return { ok: true, msg: 'Ayarlar güncellendi' }
  }

  resetAll() {
    this.stop()
    deleteAllTrades()
    deleteAllEquity()
    this.trades = []
    this.dayKey = ''
    this.dayStartBalance = 0
    this.dayStopped = false
    // DÜZELTME: eğri, silinen geçmişin başlangıç değeriyle (1000) değil
    // GERÇEK mevcut bakiyeyle başlar — aksi halde grafikte ve maxDrawdown
    // istatistiğinde hiç yaşanmamış hayalet bir düşüş görünüyordu.
    this.equity = [{ t: Date.now(), balance: this.balance }]
    saveEquity(Date.now(), this.balance)
    this.statsCache = null
    this.lastStatsTrades = -1
    this.log('warn', 'Geçmiş tamamen sıfırlandı')
    return { ok: true, msg: 'Geçmiş sıfırlandı' }
  }

  resetBalance() {
    this.balance = this.settings.startBalance
    kvSetNumber('balance', this.balance)
    this.dayKey = ''
    this.dayStartBalance = 0
    this.dayStopped = false
    // taze başlangıç: bakiye tabanı referansı da yenilenir
    this.floorRefBalance = this.balance
    kvSetNumber('floor_ref_balance', this.floorRefBalance)
    this.hardStopped = false
    kvSetNumber('hard_stopped', 0)
    // eğriye anında nokta: sıfırlama grafikte 60sn beklemeden görünsün
    // ve maxDrawdown önbelleği bayat kalmasın (istatistik eğriden hesaplanır)
    this.equity.push({ t: Date.now(), balance: this.balance })
    if (this.equity.length > EQUITY_KEEP) this.equity.shift()
    try { saveEquity(Date.now(), this.balance) } catch { /* kritik değil */ }
    this.statsCache = null
    this.lastStatsTrades = -1
    this.log('warn', `PAPER bakiye ${this.settings.startBalance} USDT'ye sıfırlandı`)
    return { ok: true, msg: 'Bakiye sıfırlandı' }
  }

  /**
   * PAPER bakiyeyi elle ayarla — işlem geçmişi ve eşitlik eğrisi KORUNUR,
   * bakiye kullanıcının verdiği değerden devam eder.
   * (LIVE modda bakiye borsa hesabından okunduğu için reddedilir.)
   */
  setBalance(value: number): { ok: boolean; msg: string } {
    if (this.settings.mode === 'LIVE') {
      return { ok: false, msg: 'LIVE modda bakiye borsa hesabından okunur — elle ayarlanamaz' }
    }
    const v = Number(value)
    if (!isFinite(v) || v < 10 || v > 10_000_000) {
      return { ok: false, msg: 'Bakiye 10 ile 10.000.000 USDT arasında olmalı' }
    }
    const prev = this.balance
    this.balance = v
    kvSetNumber('balance', v)
    // elle bakiye değişimi = yeni temel: taban referansını da tazele
    // (kullanıcı kasayı doldurduysa/boşalttıysa eski referans anlamsızdır)
    this.floorRefBalance = v
    kvSetNumber('floor_ref_balance', v)
    // eğriye anında nokta: manuel değişim grafikte ve düşüş istatistiğinde
    // olduğu gibi (atlamalı) görünür — 60sn sonraki otomatik kaydı beklemez
    this.equity.push({ t: Date.now(), balance: v })
    if (this.equity.length > EQUITY_KEEP) this.equity.shift()
    try { saveEquity(Date.now(), v) } catch { /* kritik değil */ }
    this.statsCache = null
    this.lastStatsTrades = -1
    this.log('warn', `PAPER bakiye elle ayarlandı: ${prev.toFixed(2)} → ${v.toFixed(2)} USDT`)
    return { ok: true, msg: `Bakiye ${v.toFixed(2)} USDT olarak ayarlandı` }
  }

  manualClose(): { ok: boolean; msg: string } {
    if (!this.position) return { ok: false, msg: 'Açık pozisyon yok' }
    this.closePosition('MANUAL')
    return { ok: true, msg: 'Pozisyon kapatıldı' }
  }

  // ---------------- Kanama kesme devreleri (bakiye erozyonu koruması) ----------------

  /**
   * ARDIŞIK ZARAR MOLASI — "sürekli kayıp olmasın" isteğinin cevabı.
   * lossStreakLimit üst üste NET zararla kapanan işlem olduktan sonra
   * yeni giriş lossStreakPauseSec süresince yasaktır. Momentum-ölümü
   * tarzı küçük ama sürekli tırmalamalar (üncret kanaması) böylece
   * 3 işlemde bir kesilir; bot 15 dk sonra kendiliğinden dener.
   * Kâr getiren işlem seriyi sıfırlar.
   */
  private lossPauseRemainSec(): number {
    return Math.max(0, Math.ceil((this.lossPauseUntil - Date.now()) / 1000))
  }

  private onTradeClosed(net: number) {
    if (net < 0) {
      this.lossStreak++
      if (this.settings.lossStreakLimit > 0 && this.lossStreak >= this.settings.lossStreakLimit) {
        this.lossPauseUntil = Date.now() + this.settings.lossStreakPauseSec * 1000
        this.log('warn', `⛔ ARDIŞIK ZARAR MOLASI — ${this.lossStreak} işlem üst üste zarar, ${Math.round(this.settings.lossStreakPauseSec / 60)} dk giriş yasabı (kanama kesildi). Mola bitince bot kendiliğinden devam eder.`)
        this.engineSignal.lastSignal = `ARDIŞIK ZARAR MOLASI — ${this.lossStreak} zarar üst üste, ${Math.round(this.settings.lossStreakPauseSec / 60)} dk bekleme`
      }
    } else {
      if (this.lossStreak > 0) this.log('info', `Zarar serisi ${this.lossStreak} işlemde kapatıldı — kâr geldi, sayaç sıfır`)
      this.lossStreak = 0
    }
  }

  /**
   * TOPLAM BAKİYE TABANI — "bakiyeyi eritmesin" isteğinin cevabı.
   * Referans: koruma ilk kez açıldığı andaki bakiye (kalıcı, kv'de saklanır).
   * Bakiye referansın −totalFloorPct%'üne düşerse: pozisyon kapatılır,
   * bot KALICI olarak durur ve Start reddedilir; yalnızca panelden
   * "Tabanı Sıfırla" (clearFloor) ile yeni referans konarak devam edilir.
   * Günlük tavan ve zarar serisi molaları geçiciyken bu sigorta kalıcıdır.
   */
  private ensureFloorRef() {
    if (this.settings.totalFloorPct > 0 && this.floorRefBalance <= 0) {
      this.floorRefBalance = this.balance
      kvSetNumber('floor_ref_balance', this.floorRefBalance)
      this.log('info', `🛡 TOPLAM BAKİYE TABANI etkin — referans ${this.balance.toFixed(2)} USDT (−%${this.settings.totalFloorPct} = ${(this.balance * (1 - this.settings.totalFloorPct / 100)).toFixed(2)} USDT'te kalıcı dur)`)
    }
  }

  private checkTotalFloor() {
    if (this.settings.totalFloorPct <= 0 || this.hardStopped || this.floorRefBalance <= 0) return
    const usedPct = (this.balance - this.floorRefBalance) / this.floorRefBalance * 100
    if (usedPct <= -this.settings.totalFloorPct) {
      this.hardStopped = true
      this.running = false
      kvSetNumber('hard_stopped', 1)   // yeniden başlatmada da kilitli kalır
      if (this.position) this.closePosition('TOTAL_FLOOR')
      this.log('error', `🛑 TOPLAM BAKİYE TABANI aşıldı (referans ${this.floorRefBalance.toFixed(2)} → ${this.balance.toFixed(2)} USDT, %${usedPct.toFixed(2)}) — bot KALICI durduruldu. Devam etmek için panelden "Tabanı Sıfırla".`)
      this.engineSignal.lastSignal = 'TOPLAM BAKİYE TABANI — bot kalıcı durdu (elle sıfırlanır)'
    }
  }

  /** "Tabanı Sıfırla" — yeni referansı şu anki bakiyeye koyar, kalıcı durumu açar */
  clearFloor(): { ok: boolean; msg: string } {
    this.hardStopped = false
    kvSetNumber('hard_stopped', 0)
    this.floorRefBalance = this.balance
    kvSetNumber('floor_ref_balance', this.floorRefBalance)
    this.log('info', `🛡 Bakiye tabanı referansı yenilendi: ${this.balance.toFixed(2)} USDT (−%${this.settings.totalFloorPct} koruma aktif)`)
    return { ok: true, msg: `Taban referansı ${this.balance.toFixed(2)} USDT olarak yenilendi` }
  }

  // ---------------- Pazar verisi akışı ----------------

  private onKline1m(symbol: string, c: Candle, _closed: boolean) {
    const s = this.sym.get(symbol)
    if (!s) return
    this.mergeCandle1m(s, c)
    s.cur1m = c
    this.updateIndicatorsFor(s)
  }

  /** Sembolün candles1m dizisine mum birleştir (aynı dakika → değiştir, yenisi → ekle) */
  private mergeCandle1m(s: SymState, c: Candle) {
    const last = s.candles1m.at(-1)
    if (!last) { s.candles1m.push(c); s.candlesDirty = true; return }
    if (c.t === last.t) {
      s.candles1m[s.candles1m.length - 1] = c
    } else if (c.t > last.t) {
      s.candles1m.push(c)
      if (s.candles1m.length > CHART_1M_KEEP) s.candles1m.shift()
      s.candlesDirty = true
    }
  }

  /** Kirli mum önbelleğini sınırlı sıklıkta diske yaz */
  private lastCandleSave = 0
  private maybeSaveCandleCache() {
    const now = Date.now()
    if (now - this.lastCandleSave < 60000) return
    this.lastCandleSave = now
    for (const s of this.sym.values()) {
      if (s.candlesDirty) {
        saveCandleCache(s.symbol, s.candles1m)
        s.candlesDirty = false
      }
      // Aşama 3c: 1sn mumları da kalıcı yaz (yeniden başlatmada sıcak veri)
      if (s.candles1s.length > 0) {
        saveCandlesByKey(`candles1s:${s.symbol}`, s.candles1s.slice(-PERSIST_1S_KEEP))
      }
      // Aşama 3b: 15dk serisi
      if (s.candles15m.length > 0 || s.cur15m) {
        const all15 = s.cur15m ? [...s.candles15m, s.cur15m] : s.candles15m
        saveCandlesByKey(`candles15m:${s.symbol}`, all15.slice(-HTF_15M_KEEP))
      }
    }
  }

  /**
   * HER vuruşta çağrılır — O(1) hafif iş:
   * sembol durumunu güncelle + 1sn/1dk mum sentezi.
   * Ağır iş (indikatör/sinyal) yalnız saniye kapanışında.
   * Pozisyon yönetimi YALNIZ pozisyonun sembolünde çalışır.
   */
  private onTick(t: TickPayload) {
    const s = this.sym.get(t.symbol)
    if (!s) return
    s.price = t.price
    s.markPrice = t.price
    s.bid = t.bid
    s.ask = t.ask
    s.spread = t.bid > 0 && t.ask > 0 ? t.ask - t.bid : 0
    s.spreadPct = s.spread > 0 ? (s.spread / t.price) * 100 : 0
    if (s.spreadPct > 0) {
      s.spreadEma = s.spreadEma > 0 ? s.spreadEma * 0.998 + s.spreadPct * 0.002 : s.spreadPct
    }
    s.lastTradeTs = t.ts

    // ---- Aşama 3a: order-flow dengesizliği EMA'sı (S3) ----
    // bookTicker her vuruşta en iyi bid/ask BOYUTLARINI verir:
    // alış tarafı şişkinse (flowEma > 0.5) yukarı baskı, satış tarafı
    // şişkinse aşağı baskı. Hızlı EMA ile ~2-3 saniyelik pencere özetlenir.
    if (t.bidQty > 0 || t.askQty > 0) {
      const imb = t.bidQty / (t.bidQty + t.askQty)
      if (isFinite(imb) && imb >= 0 && imb <= 1) {
        s.flowEma = s.flowSamples < 1 ? imb : s.flowEma * (1 - FLOW_EMA_ALPHA) + imb * FLOW_EMA_ALPHA
        s.flowSamples++
      }
    }

    // ---- Aşama 2: bekleyen maker giriş emri dolulumu (PAPER) ----
    if (this.pending && this.pending.symbol === t.symbol) this.checkPendingFill(s)

    // 1 saniyelik mum sentezi
    const sec = Math.floor(t.ts / 1000) * 1000
    if (!s.cur1s || sec > s.cur1s.t) {
      if (s.cur1s) {
        s.candles1s.push(s.cur1s)
        // Aşama 3c: 1800 adet (30dk) saklanır — sıcak başlangıç verisi;
        // panel yalnız son CHART_1S_KEEP kadarını görür (bant genişliği aynı)
        if (s.candles1s.length > PERSIST_1S_KEEP) s.candles1s.shift()
        this.onSecondClose(s)
      }
      s.cur1s = { t: sec, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty }
    } else {
      const c = s.cur1s
      c.h = Math.max(c.h, t.price)
      c.l = Math.min(c.l, t.price)
      c.c = t.price
      c.v += t.qty
    }

    // 1 dakikalık mum sentezi — bookTicker modunda WS 1m kline yok (süzülüyor)
    if (this.streamMode === 'FUTURES') this.synth1mFromTick(s, t)

    // ---- Aşama 3b: 15dk mumu ticklerden topla (S4) ----
    this.fold15mFromTick(s, t)

    // ---- keskin çıkış: 5dk mumu ticklerden topla (MTF katmanı) ----
    this.fold5mFromTick(s, t)

    // Pozisyon yönetimi HER TICK'te — ama yalnız pozisyonun sembolünde
    if (this.position && this.running && this.position.symbol === t.symbol) this.manageExits()

    // performans sayacı
    this.tickCount++
    const now = Date.now()
    if (now - this.tickWindowStart >= 10000) {
      this.tickRate = Math.round(this.tickCount * 10000 / (now - this.tickWindowStart))
      this.tickCount = 0
      this.tickWindowStart = now
    }
    if (now - this.lastPerfLog > 60000) {
      this.lastPerfLog = now
      this.log('info', `Akış: ~${this.tickRate} mesaj/sn · ${this.activeSymbols().length} sembol · tarama ${this.scanDurationMs.toFixed(2)}ms/sn`)
    }
  }

  /** bookTicker vuruşlarından cari 1dk mumunu sentezle ve geçmişe yaz */
  private synth1mFromTick(s: SymState, t: TickPayload) {
    const min = Math.floor(t.ts / 60000) * 60000
    if (!s.synth1m || min > s.synth1m.t) {
      const last = s.candles1m[s.candles1m.length - 1]
      if (last && last.t === min) {
        // REST geçmişindeki cari (kısmi) dakika ile hizala — açılışı koru
        s.synth1m = { ...last }
      } else {
        s.synth1m = { t: min, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty }
      }
    } else {
      const c = s.synth1m
      c.h = Math.max(c.h, t.price)
      c.l = Math.min(c.l, t.price)
      c.c = t.price
      c.v += t.qty
    }
    this.mergeCandle1m(s, s.synth1m)
    this.maybeSaveCandleCache()
  }

  /** Saniye kapanışı: indikatörleri güncelle + (boştaysa) tarama yap */
  private onSecondClose(s: SymState) {
    this.updateIndicatorsFor(s)
    this.updateRegimeScores()   // 5sn'de bir gerçekten hesaplanır (iç eşik)
    if (!this.running) return
    if (this.settings.scanMode === 'SINGLE') {
      if (s.symbol === this.settings.symbol) this.evaluateEntrySingle(s)
    } else {
      this.evaluateScan()
    }
  }

  // ---------------- Rejim skoreri — "hangi coin şu an avlanmaya değer?" ----------------

  /**
   * REJİM SKORU = son 60 KAPANMIŞ 1m mumun ortalama aralığı (%) /
   *               (gidiş-dönüş taker ücreti + yumuşatılmış spread %)
   *
   * Birim işlem maliyeti başına piyasanın sunduğu hareket. 1.0 = hareket
   * tam olarak maliyete eşit (ölü piyasa) · 1.5+ = cömert av sahası.
   * Tick yoluna DOKUNULMAZ: yalnız saniye kapanışından çağrılır ve iç
   * eşik (5sn) yüzünden gerçek hesap dakikada ~12 kez, 9 sembolde ~1ms sürer.
   * HİSTEREZİS: bir coinin uygun sayılması için 2 üst üste uygun değerlendirme
   * gerekir (sıralama savrulmasını engeller); bir kez düşmek eligible'ı sıfırlar.
   */
  private regimeLastCalc = 0
  private updateRegimeScores(force = false) {
    const now = Date.now()
    if (!force && now - this.regimeLastCalc < 5000) return
    this.regimeLastCalc = now

    const active = this.activeSymbols()
    const scored: { s: SymState; raw: number }[] = []
    for (const symbol of active) {
      const s = this.sym.get(symbol)
      if (!s) continue
      const arr = s.candles1m.slice(-61, -1) // cari (kısmi) mum hariç son 60 kapalı mum
      if (arr.length < 20) {
        s.regimeScore = 0; s.regimeRank = 0; s.regimeStreak = 0; s.regimeEligible = false
        continue
      }
      let sum = 0
      for (const c of arr) sum += ((c.h - c.l) / (c.c || 1)) * 100
      const meanRange = sum / arr.length
      const spread = s.spreadEma > 0 ? s.spreadEma : 0.02 // tick gelmediyse temsili değer
      const cost = this.settings.takerFeePct * 2 + spread
      const raw = cost > 0 ? meanRange / cost : 0
      s.regimeScore = raw
      scored.push({ s, raw })
    }

    scored.sort((a, b) => b.raw - a.raw)
    scored.forEach((it, idx) => {
      it.s.regimeRank = idx + 1
      const qualifies = it.raw >= this.settings.regimeMinScore && (idx + 1) <= this.settings.regimeTopN
      if (qualifies) {
        it.s.regimeStreak = Math.min(it.s.regimeStreak + 1, 2)
        it.s.regimeEligible = it.s.regimeStreak >= 2
      } else {
        it.s.regimeStreak = 0
        it.s.regimeEligible = false
      }
    })
  }

  /** Rejim durum metni — panelde "neden işlem yok" sorusunun cevabı */
  private regimeView(): { filterOn: boolean; minScore: number; topN: number; eligible: string[]; status: string } {
    const active = this.activeSymbols()
    this.updateRegimeScores() // eşik dolmadıysa ucuz—atlar
    const eligible = active.filter(sym => this.sym.get(sym)?.regimeEligible ?? false)
    const names = eligible.map(sym => sym.replace('USDT', ''))
    if (!this.settings.regimeFilter) {
      return { filterOn: false, minScore: this.settings.regimeMinScore, topN: this.settings.regimeTopN, eligible: names, status: 'Rejim filtresi kapalı — tüm coinler işlem yapabilir' }
    }
    if (eligible.length === 0) {
      return { filterOn: true, minScore: this.settings.regimeMinScore, topN: this.settings.regimeTopN, eligible: names, status: `Rejim filtresi: 0/${active.length} coin uygun — piyasa sessiz, bilinçli bekleme (hareket işlem maliyetini karşılamıyor)` }
    }
    return { filterOn: true, minScore: this.settings.regimeMinScore, topN: this.settings.regimeTopN, eligible: names, status: `Rejim filtresi: ${eligible.length}/${active.length} coin uygun — ${names.join(', ')}` }
  }

  /** Sembolün indikatörlerini güncelle (EMA/RSI/ATR) — saniyede en fazla bir kez */
  private updateIndicatorsFor(s: SymState) {
    const m1 = s.candles1m
    const s1 = [...s.candles1s]
    if (s.cur1s) s1.push(s.cur1s)
    const cM = closes(m1, 60)
    const cS = closes(s1, 40)
    const emaFast1m = ema(cM, 9) ?? s.signal.emaFast1m
    const emaSlow1m = ema(cM, 21) ?? s.signal.emaSlow1m
    const emaFast1s = ema(cS, 5) ?? s.signal.emaFast1s
    const emaSlow1s = ema(cS, 20) ?? s.signal.emaSlow1s
    const rsi1m = rsi(cM, 14) ?? 50

    const atrV = atr(m1, 14) ?? 0
    s.atrPct = s.price > 0 ? (atrV / s.price) * 100 : 0   // Aşama 1: uyarlanabilir TP/SL girdisi
    const buf = Math.max(atrV * 0.25, s.price * 0.0002) // trend için min. tampon

    const trend1m: Indicators['trend1m'] =
      emaFast1m > emaSlow1m + buf ? 'BULL' : emaFast1m < emaSlow1m - buf ? 'BEAR' : 'FLAT'
    const momentum1s: Indicators['momentum1s'] =
      emaFast1s > emaSlow1s ? 'UP' : emaFast1s < emaSlow1s ? 'DOWN' : 'FLAT'

    // gürültü paketi: momentum yön değiştirdiği anda süreklilik sayacı sıfırlanır
    // (giriş için momPersistSec sn aynı yönde kalma şartı — eski değer henüz s.signal'da)
    if (momentum1s !== s.signal.momentum1s) s.momDirSince = Date.now()

    s.signal = {
      emaFast1m, emaSlow1m, emaFast1s, emaSlow1s, rsi1m, trend1m, momentum1s,
      lastSignal: s.signal.lastSignal,
    }
  }

  // ---------------- Giriş mantığı ----------------

  /** Tek sembol modu: klasik değerlendirme (aynı kurallar) */
  private evaluateEntrySingle(s: SymState) {
    if (this.position || this.pending) return
    const now = Date.now()
    if (now - this.lastEntryTs < this.settings.cooldownSec * 1000) return
    // kanama kesici: zarar serisi molası — bekleme nedeni görünsün
    const pause = this.lossPauseRemainSec()
    if (pause > 0) {
      const why = `ARDIŞIK ZARAR MOLASI — ${this.lossStreak} zarar üst üste, ${Math.ceil(pause / 60)} dk bekleme kaldı (kanama kesildi)`
      this.engineSignal.lastSignal = why
      s.signal.lastSignal = why
      return
    }
    // rejim kapısı — sessiz piyasada bilinçli bekleme
    if (this.settings.regimeFilter && !s.regimeEligible) {
      const why = `Bekle — rejim skoru ${s.regimeScore.toFixed(2)} < eşik ${this.settings.regimeMinScore.toFixed(2)} (hareket maliyeti karşılamıyor; sıra ${s.regimeRank || '—'})`
      this.engineSignal.lastSignal = why
      s.signal.lastSignal = why
      return
    }
    // günlük işlem tavanı — frekans disiplini (hedef bant 50-100/gün)
    if (this.settings.maxTradesPerDay > 0 && this.tradesToday >= this.settings.maxTradesPerDay) {
      const why = `GÜNLÜK İŞLEM TAVANI — bugün ${this.tradesToday}/${this.settings.maxTradesPerDay} işlem tamam, yarına kadar giriş kapalı`
      this.engineSignal.lastSignal = why
      s.signal.lastSignal = why
      return
    }
    // sembol soğuması — az önce zarar yazan coin 2 dk boyunca elenir
    if (Date.now() < (this.symCooldownUntil.get(s.symbol) ?? 0)) {
      const why = `Bekle — ${s.symbol} soğuma molasında (az önce zarar yazdı, aynı kıvılcım tekrar atlatmaz)`
      this.engineSignal.lastSignal = why
      s.signal.lastSignal = why
      return
    }
    const gate = this.entryGate(s)
    if (!gate.side) {
      this.engineSignal.lastSignal = gate.why
      s.signal.lastSignal = gate.why
      return
    }
    // skor tabanı — zayıf sinyal komisyon deliğidir (0.10'luk sinyaller hep zarar yazıyordu)
    if (gate.score < this.settings.minScore) {
      const why = `Bekle — skor ${gate.score.toFixed(2)} < taban ${this.settings.minScore.toFixed(2)} (sinyal çok zayıf, ücret karşılanmaz)`
      this.engineSignal.lastSignal = why
      s.signal.lastSignal = why
      return
    }
    this.openPosition(gate.side, gate.why, s, gate.score)
  }

  /**
   * Giriş kapısı — bir sembolde LONG/SHORT sinyali var mı?
   * Aynı 3 koşul + 3 güvenlik filtresi (tekli moddaki kurallar birebir).
   * Dönen 'why' bekleme durumunda açıklama, sinyalde gerekçedir.
   */
  private entryGate(s: SymState): { side: Side | null; why: string; score: number } {
    const { trend1m, momentum1s, rsi1m } = s.signal
    let side: Side | null = null
    let why = ''

    if (trend1m === 'BULL' && momentum1s === 'UP' && rsi1m < 72) {
      side = 'LONG'
      why = `1m trend BOĞA (EMA9>EMA21) + 1s momentum YUKARI, RSI ${rsi1m.toFixed(0)}`
    } else if (trend1m === 'BEAR' && momentum1s === 'DOWN' && rsi1m > 28) {
      side = 'SHORT'
      why = `1m trend AYI (EMA9<EMA21) + 1s momentum AŞAĞI, RSI ${rsi1m.toFixed(0)}`
    }

    if (!side) {
      return { side: null, why: `Bekle — trend ${trend1m}, momentum ${momentum1s}, RSI ${rsi1m.toFixed(0)}`, score: 0 }
    }

    // ---- gürültü paketi: momentum süreklilik şartı ----
    // momentum YÖN DEŞİŞTİRDİĞİ anda giriş yapma: 13 işlemin 7'si RSI 63-72
    // tepesinde taze dönmüş momentumla açılıp ortalama -0.29%'te momentum-ölümüyle
    // kapanıyordu (net -1.56). Yön en az momPersistSec sn kesintisiz tuttuysa sinyal gerçektir.
    const persistNeed = this.settings.momPersistSec ?? 0
    if (persistNeed > 0) {
      const heldSec = (Date.now() - s.momDirSince) / 1000
      if (heldSec < persistNeed) {
        const momTrTxt = momentum1s === 'UP' ? 'YUKARI' : momentum1s === 'DOWN' ? 'AŞAĞI' : 'DÜZ'
        return { side: null, why: `Bekle — momentum ${momTrTxt} yalnız ${heldSec.toFixed(0)} sn sürdü (${persistNeed} sn süreklilik şartı)`, score: 0 }
      }
    }

    // RSI aşırılık filtresi: zirveden/dipten girmeyi engelle
    if (side === 'LONG' && rsi1m > 78) return { side: null, why: `LONG engellendi — RSI ${rsi1m.toFixed(0)} aşırı alım`, score: 0 }
    if (side === 'SHORT' && rsi1m < 22) return { side: null, why: `SHORT engellendi — RSI ${rsi1m.toFixed(0)} aşırı satım`, score: 0 }

    // ---- Aşama 3a: order-flow dengesizliği yön onayı (S3) ----
    // en iyi bid/ask BOYUT dengesi: alış tarafı şişkinse yukarı baskı.
    // Yönle uyumlu belirgin baskı yoksa sinyal reddedilir.
    if (this.settings.flowFilter && s.flowSamples >= FLOW_MIN_SAMPLES) {
      const thr = this.settings.flowThreshold
      const f = s.flowEma
      if (side === 'LONG' && f < 0.5 + thr) {
        return { side: null, why: `LONG engellendi — defter dengesizliği %${(f * 100).toFixed(0)} (alış baskısı yetersiz)`, score: 0 }
      }
      if (side === 'SHORT' && f > 0.5 - thr) {
        return { side: null, why: `SHORT engellendi — defter dengesizliği %${(f * 100).toFixed(0)} (satış baskısı yetersiz)`, score: 0 }
      }
    }

    // ---- Aşama 3b: 15dk üst trend onayı (S4) ----
    // büyük resimle ters yönde girme. Veri yetersizse (NA) filtre pas geçer.
    if (this.settings.htfFilter && s.htfTrend !== 'NA') {
      if (side === 'LONG' && s.htfTrend !== 'BULL') {
        return { side: null, why: `LONG engellendi — 15dk trend ${s.htfTrend === 'BEAR' ? 'AYI' : 'YATAY'}`, score: 0 }
      }
      if (side === 'SHORT' && s.htfTrend !== 'BEAR') {
        return { side: null, why: `SHORT engellendi — 15dk trend ${s.htfTrend === 'BULL' ? 'BOĞA' : 'YATAY'}`, score: 0 }
      }
    }

    // ---- keskin çıkış: 5dk MTF onayı (1dk tetik + 5dk yön + 15dk trend) ----
    // orta katman ters yöndeüyse sinyal reddedilir; veri yetersizse (NA) pas geçer
    if (this.settings.mtf5mFilter && s.trend5m !== 'NA') {
      if (side === 'LONG' && s.trend5m !== 'BULL') {
        return { side: null, why: `LONG engellendi — 5dk trend ${s.trend5m === 'BEAR' ? 'AYI' : 'YATAY'}`, score: 0 }
      }
      if (side === 'SHORT' && s.trend5m !== 'BEAR') {
        return { side: null, why: `SHORT engellendi — 5dk trend ${s.trend5m === 'BULL' ? 'BOĞA' : 'YATAY'}`, score: 0 }
      }
    }

    // spike koruması: son 5 saniyede fiyat istediğimiz yönde zaten çok hareket ettiyse girme
    const recent = s.candles1s.slice(-5)
    if (recent.length === 5) {
      const spike = ((recent[4].c - recent[0].o) / recent[0].o) * 100
      const spikeLimit = this.feeAwareTp() * 0.8
      if (side === 'LONG' && spike > spikeLimit) return { side: null, why: `LONG engellendi — son 5sn'de +%${spike.toFixed(3)} sıçrama (tepeden giriş)`, score: 0 }
      if (side === 'SHORT' && spike < -spikeLimit) return { side: null, why: `SHORT engellendi — son 5sn'de %${spike.toFixed(3)} düşüş (dipten giriş)`, score: 0 }
    }

    // sinyal gücü skoru: trend genişliği + momentum tazeliği + RSI payı − spread cezası
    // gürültü paketi: momGap ağırlığı 1.5 → 0.5 — skor taze sıçramayı ödüllendirmeyi bıraktı
    // (1.5 iken en yüksek skorlar hep RSI 70+ tepelerindeki anlık fitillerde çıkıyordu)
    const trendGap = Math.abs(s.signal.emaFast1m - s.signal.emaSlow1m) / (s.price || 1) * 100
    const momGap = Math.abs(s.signal.emaFast1s - s.signal.emaSlow1s) / (s.price || 1) * 100
    const rsiRoom = side === 'LONG' ? Math.max(0, 72 - rsi1m) / 72 : Math.max(0, rsi1m - 28) / 28
    const score = trendGap * 1.0 + momGap * 0.5 + rsiRoom * 0.5 - s.spreadPct * 25
    return { side, why, score: Math.max(0, score) }
  }

  /**
   * Giriş kapısının CANLI DÖKÜMÜ — entryGate'in birebir aynı eşikleriyle,
   * tek farkla: erken dönüş yerine her koşulun geçti/kaldı durumu veri olarak
   * döner. Dashboard "Anlık Değerlendirme" paneli saniye saniye bunu gösterir:
   * "coin bulundu ama şu sebeple girmiyor" sorusunun cevabı buradadır.
   */
  private gateStatusFor(s: SymState): GateStatus {
    const { trend1m, momentum1s, rsi1m } = s.signal
    const dataOk = s.candles1m.length >= 30 && s.candles1s.length >= 12 && s.price > 0
    const side: Side | null = trend1m === 'BULL' ? 'LONG' : trend1m === 'BEAR' ? 'SHORT' : null
    const checks: GateCheck[] = []

    // 1) VERİ — motorun bu sembolü hiç değerlendirebilmesi için
    checks.push({
      key: 'DATA', label: 'Veri',
      ok: dataOk,
      value: dataOk
        ? `${Math.min(s.candles1m.length, 150)} mum · ${s.candles1s.length} sn`
        : `toplanıyor (${s.candles1m.length}/30 mum, ${s.candles1s.length}/12 sn)`,
    })

    // 2) TREND — yönün kendisi (FLAT = yön yok)
    const trendTxt = trend1m === 'BULL' ? 'BOĞA' : trend1m === 'BEAR' ? 'AYI' : 'YATAY'
    checks.push({ key: 'TREND', label: '1dk Trend', ok: side !== null, value: trendTxt })

    // 3) MOMENTUM — 1sn EMA5/20 yönle uyumlu mu + yön ne kadar süredir kesintisiz tutuyor
    const momTxt = momentum1s === 'UP' ? 'YUKARI' : momentum1s === 'DOWN' ? 'AŞAĞI' : 'DÜZ'
    const persistNeed = this.settings.momPersistSec ?? 0
    const momHeldSec = (Date.now() - s.momDirSince) / 1000
    const momDirOk = side === null ? null : (side === 'LONG' ? momentum1s === 'UP' : momentum1s === 'DOWN')
    const momOk = momDirOk === null ? null : momDirOk && (persistNeed <= 0 || momHeldSec >= persistNeed)
    checks.push({ key: 'MOMENTUM', label: '1sn Momentum', ok: momOk, value: persistNeed > 0 ? `${momTxt} · ${Math.min(momHeldSec, persistNeed).toFixed(0)}/${persistNeed} sn` : momTxt })

    // 4) RSI — yönlü eşik (LONG < 72, SHORT > 28)
    let rsiTxt = rsi1m.toFixed(0)
    if (rsi1m > 72) rsiTxt += ' · aşırı alım'
    else if (rsi1m < 28) rsiTxt += ' · aşırı satım'
    const rsiOk = side === null ? null : (side === 'LONG' ? rsi1m < 72 : rsi1m > 28)
    checks.push({ key: 'RSI', label: 'RSI 14', ok: rsiOk, value: rsiTxt })

    // 5) AKIŞ — bid/ask boyut dengesizliği (filtre kapalıysa "kapalı" göster)
    if (this.settings.flowFilter) {
      if (s.flowSamples < FLOW_MIN_SAMPLES) {
        checks.push({ key: 'FLOW', label: 'Defter Dengesi', ok: null, value: `örnekleniyor (${s.flowSamples}/${FLOW_MIN_SAMPLES})` })
      } else if (side === null) {
        checks.push({ key: 'FLOW', label: 'Defter Dengesi', ok: null, value: `%${(s.flowEma * 100).toFixed(0)} alış` })
      } else {
        const thr = this.settings.flowThreshold
        const fOk = side === 'LONG' ? s.flowEma >= 0.5 + thr : s.flowEma <= 0.5 - thr
        checks.push({ key: 'FLOW', label: 'Defter Dengesi', ok: fOk, value: `%${(s.flowEma * 100).toFixed(0)} alış` })
      }
    }

    // 6) 5DK MTF — orta katman yön onayı
    if (this.settings.mtf5mFilter) {
      const t5 = s.trend5m
      const t5Txt = t5 === 'BULL' ? 'BOĞA' : t5 === 'BEAR' ? 'AYI' : t5 === 'FLAT' ? 'YATAY' : 'veri yok'
      const t5Ok = t5 === 'NA' || side === null ? null : (side === 'LONG' ? t5 === 'BULL' : t5 === 'BEAR')
      checks.push({ key: 'MTF5M', label: '5dk Trend', ok: t5Ok, value: t5Txt })
    }

    // 7) 15DK HTF — büyük resim yön onayı
    if (this.settings.htfFilter) {
      const h = s.htfTrend
      const hTxt = h === 'BULL' ? 'BOĞA' : h === 'BEAR' ? 'AYI' : h === 'FLAT' ? 'YATAY' : 'veri yok'
      const hOk = h === 'NA' || side === null ? null : (side === 'LONG' ? h === 'BULL' : h === 'BEAR')
      checks.push({ key: 'HTF15M', label: '15dk Trend', ok: hOk, value: hTxt })
    }

    // 8) SPIKE — son 5 saniyede yönünde çok mu kaçtı (tepe/dip koruması)
    if (side !== null) {
      const recent = s.candles1s.slice(-5)
      const r0 = recent[0], r4 = recent[4]
      if (recent.length === 5 && r0 && r4) {
        const spike = ((r4.c - r0.o) / r0.o) * 100
        const spikeLimit = this.feeAwareTp() * 0.8
        const spOk = side === 'LONG' ? spike <= spikeLimit : spike >= -spikeLimit
        checks.push({ key: 'SPIKE', label: '5sn Sıçrama', ok: spOk, value: `${spike >= 0 ? '+' : ''}${spike.toFixed(3)}%` })
      }
    }

    // 9) REJİM — bu coinde hareket, maliyeti karşılıyor mu (sembolden bağımsız işler)
    if (this.settings.regimeFilter) {
      checks.push({
        key: 'REGIME', label: 'Rejim', ok: s.regimeEligible,
        value: `${s.regimeScore > 0 ? s.regimeScore.toFixed(2) : '—'}${s.regimeRank > 0 ? ` · #${s.regimeRank}` : ''}`,
      })
    }

    // ilk başarısız koşul = bekleme nedeni (değerlendirme sırası korunur)
    const blocker = checks.find(c => c.ok === false) ?? null
    const active = checks.filter(c => c.ok !== null).length
    const passed = checks.filter(c => c.ok === true).length
    let blockLabel: string
    if (!blocker) {
      blockLabel = dataOk && side ? `SİNYAL HAZIR — ${side} adayı, sinyal sırasına girdi` : 'Koşullar oluşması bekleniyor'
    } else {
      switch (blocker.key) {
        case 'DATA': blockLabel = `Veri toplanıyor — ${s.candles1m.length}/30 mum, ${s.candles1s.length}/12 sn seri`; break
        case 'TREND': blockLabel = '1dk trend YATAY — yön oluşması bekleniyor'; break
        case 'MOMENTUM': blockLabel = momDirOk
          ? `Momentum ${momTxt} — yalnız ${momHeldSec.toFixed(0)} sn sürdü (${persistNeed} sn süreklilik şartı; taze dönmüş sinyal gürültüdür)`
          : `1sn momentum ${momTxt} — trendin yönünde değil`; break
        case 'RSI': blockLabel = side === 'LONG'
          ? `RSI ${rsi1m.toFixed(0)} — LONG için fazla ısınmış (eşik 72)`
          : `RSI ${rsi1m.toFixed(0)} — SHORT için fazla soğumuş (eşik 28)`; break
        case 'FLOW': blockLabel = side === 'LONG'
          ? `Defter dengesizliği %${(s.flowEma * 100).toFixed(0)} — alış baskısı yetersiz (eşik %${((0.5 + this.settings.flowThreshold) * 100).toFixed(0)})`
          : `Defter dengesizliği %${(s.flowEma * 100).toFixed(0)} — satış baskısı yetersiz (eşik %${((0.5 - this.settings.flowThreshold) * 100).toFixed(0)})`; break
        case 'MTF5M': blockLabel = `5dk trend ${checks.find(c => c.key === 'MTF5M')?.value ?? ''} — orta katman onay vermiyor`; break
        case 'HTF15M': blockLabel = `15dk trend ${checks.find(c => c.key === 'HTF15M')?.value ?? ''} — büyük resim onay vermiyor`; break
        case 'SPIKE': blockLabel = `Son 5sn'de ${checks.find(c => c.key === 'SPIKE')?.value ?? ''} hareket — tepeden/dipten giriş engellendi`; break
        case 'REGIME': {
          if (s.regimeScore < this.settings.regimeMinScore) {
            blockLabel = `Rejim skoru ${s.regimeScore.toFixed(2)} < eşik ${this.settings.regimeMinScore.toFixed(2)} — hareket işlem maliyetini karşılamıyor`
          } else if (s.regimeRank > this.settings.regimeTopN) {
            blockLabel = `Rejim sırası #${s.regimeRank} — yalnız ilk ${this.settings.regimeTopN} coin işlem yapabilir (daha değerli avlar önde)`
          } else {
            blockLabel = `Rejim onayı bekleniyor — skor ${s.regimeScore.toFixed(2)} uygun, üst üste 2 değerlendirme gerekli`
          }
          break
        }
        default: blockLabel = 'Bekleme'; break
      }
    }
    return { symbol: s.symbol, side, checks, blockKey: blocker?.key ?? null, blockLabel, passed, active }
  }

  /**
   * ÇOKLU TARAMA — saniyede bir kez (ilk saniye kapanışında tetiklenir):
   * tüm sembolleri kapıdan geçir, geçenleri skarla, EN İYİSİNE gir.
   */
  private lastScanSec = 0
  private evaluateScan() {
    if (this.position || this.pending) return
    const now = Date.now()
    if (now - this.lastEntryTs < this.settings.cooldownSec * 1000) return
    // kanama kesici: zarar serisi molası — tarar ama girmez, nedeni görünür
    const pause = this.lossPauseRemainSec()
    if (pause > 0) {
      this.engineSignal.lastSignal = `ARDIŞIK ZARAR MOLASI — ${this.lossStreak} zarar üst üste, ${Math.ceil(pause / 60)} dk bekleme kaldı (tarama sürüyor, giriş kapalı)`
      return
    }
    // günlük işlem tavanı — frekans disiplini (hedef bant: günde 50-100 işlem)
    if (this.settings.maxTradesPerDay > 0 && this.tradesToday >= this.settings.maxTradesPerDay) {
      this.engineSignal.lastSignal = `GÜNLÜK İŞLEM TAVANI — bugün ${this.tradesToday}/${this.settings.maxTradesPerDay} işlem tamam, yarına kadar giriş kapalı`
      return
    }
    const secBucket = Math.floor(now / 1000)
    if (secBucket === this.lastScanSec) return   // bu saniye zaten tarandı
    this.lastScanSec = secBucket

    const t0 = performance.now()
    let best: { s: SymState; side: Side; why: string; score: number } | null = null
    let readyCount = 0
    let regimeBlocked = 0
    let cooldownBlocked = 0
    let weakBlocked = 0
    const parts: string[] = []

    for (const s of this.sym.values()) {
      if (!this.activeSymbols().includes(s.symbol)) continue
      if (s.candles1m.length < 30 || s.candles1s.length < 12 || s.price <= 0) continue
      const gate = this.entryGate(s)
      s.score = gate.score
      s.readySide = gate.side
      if (gate.side) {
        // REJİM KAPISI: düşük skorlu coinden sinyal bile olsa girilmez —
        // komisyon deliğinin kapanmasının tek kesin yolu seçici olmaktır.
        if (this.settings.regimeFilter && !s.regimeEligible) {
          regimeBlocked++
          continue
        }
        // SKOR TABANI: sinyal var ama zayıfsa girme — 0.10'luk sinyaller
        // momentum ölümüyle hep zarar yazıyordu; taban frekansı değil kaliteyi seçer
        if (this.settings.minScore > 0 && gate.score < this.settings.minScore) {
          weakBlocked++
          continue
        }
        // sembol soğuması: az önce MOMENTUM/SL yaşayan coin 2 dk elenir —
        // aynı kıvılcıma 9-64sn sonra tekrar atlamak (klasik churn) engellenir
        if (Date.now() < (this.symCooldownUntil.get(s.symbol) ?? 0)) {
          cooldownBlocked++
          continue
        }
        readyCount++
        parts.push(`${s.symbol.replace('USDT', '')} ${gate.side === 'LONG' ? '↑' : '↓'} ${gate.score.toFixed(2)}`)
        if (!best || gate.score > best.score) best = { s, side: gate.side, why: gate.why, score: gate.score }
      }
    }

    this.scanDurationMs = performance.now() - t0
    if (!best) {
      this.engineSignal.lastSignal = regimeBlocked > 0
        ? `Sinyal vardı ama rejim filtresi engelledi (${regimeBlocked} aday — piyasa hareketi maliyeti karşılamıyor, bilinçli bekleme)`
        : weakBlocked > 0
          ? `Sinyal vardı ama ${weakBlocked} aday skor tabanının altında (zayıf sinyal = komisyon deliği, bekleniyor)`
          : cooldownBlocked > 0
            ? `Sinyal vardı ama ${cooldownBlocked} coin soğuma molasında (az önce zarar yazan coin 2 dk elenir)`
            : readyCount === 0
              ? `Tarama (${this.activeSymbols().length} coin) — hazır sinyal yok`
              : `Tarama — ${readyCount} aday engellendi`
      return
    }

    // en güçlü fırsata gir — aynı klasik giriş yolu (skor: güçlü sinyal direkt taker)
    const why = `${best.why} · skor ${best.score.toFixed(2)} (en iyi ${this.activeSymbols().length} coinden)`
    this.openPosition(best.side, why, best.s, best.score)
    if (readyCount > 1) {
      this.log('info', `Fırsat sıralaması: ${parts.join(' · ')} → ${best.s.symbol} seçildi`)
    }
  }

  private async openPosition(side: Side, why: string, s: SymState, score?: number, forceTaker = false) {
    const settings = this.settings
    // ---- Aşama 1: uyarlanabilir TP/SL + risk eşitliği marjı ----
    const eff = this.effectiveTpSl(s)
    const minNotional = Math.max(s.filter.minNotional, 5)
    // bakiye koruması: pozisyon açacak para kalmadıysa botu durdur
    if (this.balance <= 0 || this.balance * (settings.allocationPct / 100) * settings.leverage < minNotional) {
      this.running = false
      this.log('error', `⛔ BAKİYE YETERSİZ (${this.balance.toFixed(2)} USDT) — bot güvenlik nedeniyle durduruldu. Ayarlardan bakiyeyi sıfırlayabilirsiniz.`)
      return
    }
    const margin = this.positionMargin(eff.slPct)
    if (margin * settings.leverage < minNotional) {
      this.running = false
      this.log('error', `⛔ RİSK PAYI YETERSİZ (marj ${margin.toFixed(2)} USDT < gereken ${(minNotional / settings.leverage).toFixed(2)}) — bot durduruldu. Risk %'sini veya tahsisi artırın.`)
      return
    }
    this.lastEntryTs = Date.now()

    // ---- Aşama 2: maker giriş (defter fiyatından post-only limit) ----
    // HIZLI YAKALA: güçlü sinyal (skor ≥ takerMinScore) maker beklemez — koşan
    // fiyatı yakalamak için direkt piyasa emri. forceTaker = maker süresi doldu,
    // sinyal hâlâ geçerli → ikinci şans piyasa emriyle.
    const strong = score !== undefined && this.settings.takerMinScore > 0 && score >= this.settings.takerMinScore
    if (strong) {
      this.log('trade', `⚡ GÜÇLÜ SİNYAL — maker atlandı, direkt piyasa emri | ${s.symbol} ${side} | skor ${score!.toFixed(2)} ≥ ${this.settings.takerMinScore.toFixed(2)}`)
    }
    if (settings.makerEntry && !strong && !forceTaker && s.bid > 0 && s.ask > 0) {
      const limitPrice = side === 'LONG' ? s.bid : s.ask
      let mqty = roundStep((margin * settings.leverage) / limitPrice, s.filter.stepSize)
      if (mqty < s.filter.minQty || mqty * limitPrice < minNotional) {
        mqty = Math.max(s.filter.minQty, roundStep(minNotional / limitPrice, s.filter.stepSize))
      }
      if (mqty >= s.filter.minQty && mqty * limitPrice >= minNotional) {
        const whyFull = eff.adaptive
          ? `${why} · ATR-uyarlanabilir TP %${eff.tpPct.toFixed(3)} / SL %${eff.slPct.toFixed(3)}`
          : why
        const pend: PendingEntry = {
          symbol: s.symbol, side, qty: mqty, limitPrice,
          placedTs: Date.now(), expiresTs: Date.now() + settings.makerWaitSec * 1000,
          why: whyFull,
          effTpPct: eff.tpPct, effSlPct: eff.slPct,
          leverage: settings.leverage, margin: (mqty * limitPrice) / settings.leverage,
          liveOrderId: null,
        }
        if (settings.mode === 'LIVE' && hasApiCreds()) {
          try {
            if (!this.leverageSetFor.has(s.symbol)) {
              await this.ensureIsolatedAndLeveraged(s.symbol, settings.leverage)
            }
            const tickPrice = this.roundToTick(limitPrice, s.filter.tickSize)
            const o = await limitMakerOrder(s.symbol, side === 'LONG' ? 'BUY' : 'SELL', mqty, tickPrice)
            pend.liveOrderId = o.orderId
            this.pending = pend
            this.startPendingPoll()
            this.log('trade', `LIVE maker giriş emri gönderildi (#${o.orderId}) ${mqty} @ ${tickPrice} — ${settings.makerWaitSec}sn'de dolmazsa piyasa emriyle yaklanır (hızlı yakala)`)
            this.engineSignal.lastSignal = `MAKER EMRİ ${side} ${s.symbol} @ ${tickPrice} — dolması bekleniyor (dolmazsa piyasa emriyle yaklanır)`
          } catch (e) {
            // post-only reddi (fiyat bizden önce kaçtı) → dürüst yol: taker'a düş
            this.log('warn', `Maker emri reddedildi → piyasa emriyle giriliyor: ${String(e)}`)
            return this.openPositionTaker(side, why, s, eff, margin)
          }
        } else {
          this.pending = pend
          const d = this.priceDigitsFor(limitPrice)
          this.engineSignal.lastSignal = `MAKER EMRİ ${side} ${s.symbol} @ ${limitPrice.toFixed(d)} — ${settings.makerWaitSec}sn'de dolmazsa piyasa emriyle yaklanır (hızlı yakala)`
          s.signal.lastSignal = this.engineSignal.lastSignal
          this.log('trade', `⇪ MAKER GİRİŞ EMRİ | ${s.symbol} ${side} | ${mqty} @ ${limitPrice.toFixed(d)} | ${settings.makerWaitSec}sn'de dolmazsa piyasa emriyle yaklanır (hızlı yakala — sinyal kaçmaz)`)
        }
        return
      }
    }

    // ---- klasik yol: anında taker giriş ----
    return this.openPositionTaker(side, why, s, eff, margin)
  }

  /** Taker (piyasa emri) giriş — maker reddedilince veya kapalıyken */
  private async openPositionTaker(side: Side, why: string, s: SymState, eff: { tpPct: number; slPct: number; adaptive: boolean }, margin: number) {
    const settings = this.settings
    const minNotional = Math.max(s.filter.minNotional, 5)
    let qty = roundStep((margin * settings.leverage) / s.price, s.filter.stepSize)

    if (qty < s.filter.minQty || qty * s.price < minNotional) {
      // Bakiye/lot kuralları yetmiyorsa izin verilen en küçük pozisyonu dene
      qty = Math.max(s.filter.minQty, roundStep(minNotional / s.price, s.filter.stepSize))
      if (qty * s.price < minNotional) {
        this.log('warn', `${s.symbol}: pozisyon açılamadı — bakiye minimum emir büyüklüğü için yetersiz (${minNotional} USDT)`)
        return
      }
    }
    const actualNotional = qty * s.price
    const entryFee = actualNotional * (settings.takerFeePct / 100)

    let entryPrice = s.price
    if (settings.mode === 'LIVE' && hasApiCreds()) {
      try {
        if (!this.leverageSetFor.has(s.symbol)) {
          await this.ensureIsolatedAndLeveraged(s.symbol, settings.leverage)
        }
        const res = await marketOrder(s.symbol, side === 'LONG' ? 'BUY' : 'SELL', qty)
        if (res.avgPrice > 0) entryPrice = res.avgPrice
        this.log('trade', `LIVE giriş emri gönderildi (#${res.orderId})`)
      } catch (e) {
        this.log('error', `LIVE giriş emri başarısız: ${String(e)}`)
        return
      }
    } else {
      // PAPER dolum: LONG ask'tan alır, SHORT bid'den satar (gerçek taker ekonomisi)
      entryPrice = this.fillPriceFor(s, side === 'LONG')
    }

    const whyFull = eff.adaptive
      ? `${why} · ATR-uyarlanabilir TP %${eff.tpPct.toFixed(3)} / SL %${eff.slPct.toFixed(3)}`
      : why
    this.position = {
      id: newId(),
      symbol: s.symbol,
      side,
      qty,
      entryPrice,
      notional: qty * entryPrice,
      margin: actualNotional / settings.leverage,
      leverage: settings.leverage,
      entryTime: Date.now(),
      entryFee,
      feeBreakevenPct: this.roundTripFeePct(),
      takeProfitPct: eff.tpPct,
      stopLossPct: eff.slPct,
      reason: whyFull,
      makerEntry: false,
      bestPrice: entryPrice,
      trailStop: null,
      adverseStreak: 0,
      momEvalSec: 0,
    }
    this.engineSignal.lastSignal = `GİRİŞ ${side} ${s.symbol} @ ${entryPrice.toFixed(this.priceDigitsFor(entryPrice))} — ${whyFull}`
    s.signal.lastSignal = this.engineSignal.lastSignal
    this.log('trade', `⇪ ${side} GİRİŞ | ${s.symbol} | ${qty} @ ${entryPrice.toFixed(this.priceDigitsFor(entryPrice))} | ${settings.leverage}x | Marj ${this.position.margin.toFixed(2)} USDT | Ücret ${entryFee.toFixed(3)} USDT`)
  }

  /** Çıkış referans fiyatı — LONG bid'den kapatır, SHORT ask'tan geri alır */
  private exitRefPriceFor(s: SymState, side: Side): number {
    if (s.bid > 0 && s.ask > 0) return side === 'LONG' ? s.bid : s.ask
    return s.price || s.bid || s.ask
  }

  /** PAPER dolum fiyatı — buy: en iyi satış (ask), sell: en iyi alış (bid) */
  private fillPriceFor(s: SymState, buy: boolean): number {
    if (s.bid > 0 && s.ask > 0) return buy ? s.ask : s.bid
    return s.price * (1 + (buy ? 1 : -1) * SLIPPAGE_PCT / 100)
  }

  // ---------------- Aşama 1/2/3: yeni yetenekler ----------------

  /** Aşama 3b: 15dk mumunu ticklerden topla; kova kapanınca seriye kat */
  private fold15mFromTick(s: SymState, t: TickPayload) {
    const bucket = Math.floor(t.ts / 900000) * 900000
    if (!s.cur15m || bucket > s.cur15m.t) {
      if (s.cur15m) {
        s.candles15m.push(s.cur15m)
        if (s.candles15m.length > HTF_15M_KEEP) s.candles15m.shift()
        this.updateHtfTrend(s)
      }
      s.cur15m = { t: bucket, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty }
    } else {
      const c = s.cur15m
      c.h = Math.max(c.h, t.price)
      c.l = Math.min(c.l, t.price)
      c.c = t.price
      c.v += t.qty
    }
  }

  /** 15dk trendi — EMA9/EMA21 + ATR tamponu; veri yetersizse NA (filtre pas geçer) */
  private updateHtfTrend(s: SymState) {
    const closes15 = s.candles15m.map(c => c.c)
    if (closes15.length < 30) { s.htfTrend = 'NA'; return }
    const f = ema(closes15, 9), sl = ema(closes15, 21)
    if (f === null || sl === null) { s.htfTrend = 'NA'; return }
    const a = atr(s.candles15m, 14)
    const ref = s.price || closes15[closes15.length - 1]
    const buf = Math.max((a ?? 0) * 0.25, ref * 0.0002)
    s.htfTrend = f > sl + buf ? 'BULL' : f < sl - buf ? 'BEAR' : 'FLAT'
  }

  /** Keskin çıkış: 5dk mumunu ticklerden topla; kova kapanınca seriye kat */
  private fold5mFromTick(s: SymState, t: TickPayload) {
    const bucket = Math.floor(t.ts / 300000) * 300000
    if (!s.cur5m || bucket > s.cur5m.t) {
      if (s.cur5m) {
        s.candles5m.push(s.cur5m)
        if (s.candles5m.length > HTF_15M_KEEP) s.candles5m.shift()
        this.update5mTrend(s)
      }
      s.cur5m = { t: bucket, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty }
    } else {
      const c = s.cur5m
      c.h = Math.max(c.h, t.price)
      c.l = Math.min(c.l, t.price)
      c.c = t.price
      c.v += t.qty
    }
  }

  /** 5dk trendi — EMA9/EMA21 tamponuyla; veri yetersizse NA (filtre pas geçer) */
  private update5mTrend(s: SymState) {
    const closes5 = s.candles5m.map(c => c.c)
    if (closes5.length < 21) { s.trend5m = 'NA'; return }
    const f = ema(closes5, 9), sl = ema(closes5, 21)
    if (f === null || sl === null) { s.trend5m = 'NA'; return }
    const ref = s.price || closes5[closes5.length - 1]
    const buf = ref * 0.0002   // %0.02 tampon — mikro gürültüyü FLAT'a atar
    s.trend5m = f > sl + buf ? 'BULL' : f < sl - buf ? 'BEAR' : 'FLAT'
  }

  /** Keskin çıkış: 1dk geçmişten 5dk serisi tohumla (motor açılışında anında hazır) */
  private seed5mFrom1m(s: SymState) {
    if (s.candles1m.length < 25) return
    if (s.candles5m.length >= 21) { this.update5mTrend(s); return }
    const map = new Map<number, Candle>()
    for (const c of s.candles1m) {
      const b = Math.floor(c.t / 300000) * 300000
      const cur = map.get(b)
      if (!cur) map.set(b, { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })
      else {
        cur.h = Math.max(cur.h, c.h)
        cur.l = Math.min(cur.l, c.l)
        cur.c = c.c
        cur.v += c.v
      }
    }
    s.candles5m = [...map.values()].sort((a, b) => a.t - b.t).slice(-HTF_15M_KEEP)
    this.update5mTrend(s)
  }

  /**
   * Aşama 1: bu girişte kullanılacak TP/SL.
   * ATR-uyarlanabilir modda coinin GERÇEK 1dk oynaklığından hesaplanır:
   * hareketli coine geniş hedef, ölü coine dar (ya da hiç) işlem.
   * feeAwareTp tabanı her zaman korunur — ücret deliği kapanamaz.
   */
  private effectiveTpSl(s: SymState): { tpPct: number; slPct: number; adaptive: boolean } {
    const floorTp = this.feeAwareTp()
    if (!this.settings.atrAdaptive || s.atrPct <= 0) {
      return { tpPct: floorTp, slPct: this.settings.stopLossPct, adaptive: false }
    }
    // keskin çıkış modu: TP geniş GERİ koruma tavanı (kârı sınırlamaz —
    // trailing yönetir), SL sert ters koruması; R:R ~3:1'e açılır
    if (this.settings.sharpExit) {
      // SL tabanı kullanıcının SL ayarını da sayar (SL %0.54 → taban %0.41):
      // ölü piyasada SL'nin TP'nin altına çakılıp risk/ödülü 1:1'e düşürmesi engellendi.
      // TP tavanı da en az SL × 1.2 — R:R her zaman lehte.
      const slFloor = Math.max(0.30, this.settings.stopLossPct * 0.75)
      const sl = Math.min(Math.max(s.atrPct * 2, slFloor), 1.0)
      const tp = Math.min(Math.max(s.atrPct * 3, floorTp, sl * 1.2), 5)
      return { tpPct: tp, slPct: sl, adaptive: true }
    }
    const tp = Math.min(Math.max(s.atrPct * this.settings.atrTpMult, floorTp), 5)
    const sl = Math.min(tp * this.settings.atrSlRatio, 10)
    return { tpPct: tp, slPct: sl, adaptive: true }
  }

  /**
   * Aşama 1: risk eşitliği marjı — her işlemin SL seviyesinde kaybedeceği
   * para bakiyenin sabit %'si (riskPct). Tahsis (allocationPct) tavan
   * olarak kalır: risk-parity hesabı tavandan küçükse küçük olan kullanılır.
   */
  private positionMargin(slPct: number): number {
    const cap = this.balance * (this.settings.allocationPct / 100)
    if (!this.settings.riskParity || slPct <= 0) return cap
    const risk = this.balance * (this.settings.riskPct / 100)
    const byRisk = risk / (this.settings.leverage * slPct / 100)
    return Math.max(Math.min(byRisk, cap), 0)
  }

  /**
   * Aşama 2 (PAPER): bekleyen maker emri bu vuruşta doldu mu?
   * KÖTÜMSER kural: alış emrimiz ancak karşımızdaki ASK ona düştüğünde
   * dolar (bir satış emri bizim bid'imize çarpmış olmalı).
   */
  private checkPendingFill(s: SymState) {
    const p = this.pending
    if (!p) return
    if (Date.now() >= p.expiresTs) { this.fallbackToTaker(s, 'süre doldu'); return }
    const filled = p.side === 'LONG'
      ? s.ask > 0 && s.ask <= p.limitPrice
      : s.bid > 0 && s.bid >= p.limitPrice
    if (filled) this.finalizePendingPosition(p.limitPrice, p.qty, true)
  }

  /**
   * HIZLI YAKALA (onaylı): maker emri süresi doldu → sinyal hâlâ geçerliyse
   * piyasa emriyle yakala; geçersizse dürüst iptal (eski davranış).
   * Rasyon (ölçülmüş): maker tasarrufu ~0.04 USDT, kaçan sinyal ~0.57 USDT —
   * %62 sinyal kaçışıyla 15 kat kötü takas yapıyorduk. Kapılar yeniden
   * değerlendirilir: yön değiştiyse/RSI dolduysa girilmez.
   */
  private fallbackToTaker(s: SymState, reason: string) {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.stopPendingPoll()
    const gate = this.entryGate(s)
    if (gate.side === p.side) {
      const waited = Math.max(1, Math.round((Date.now() - p.placedTs) / 1000))
      this.log('trade', `⚡ HIZLI YAKALA | ${p.symbol} ${p.side} maker ${waited}sn'de dolmadı → piyasa emriyle giriliyor (sinyal hâlâ geçerli, skor ${gate.score.toFixed(2)})`)
      void this.openPosition(gate.side, `${gate.why} · hızlı yakala (maker ${waited}sn'de dolmadı)`, s, gate.score, true)
    } else {
      this.log('info', `Maker giriş emri iptal (${p.symbol} ${p.side} @ ${p.limitPrice}) — ${reason} + sinyal artık geçersiz: ${gate.why}`)
      this.lastEntryTs = Date.now()   // aynı sinyalle anında yeniden denemeyi engelle
    }
  }

  /** Bekleyen maker emri iptali — sinyalin kaçması dürüstçe kayda geçer */
  private cancelPending(reason: string) {
    const p = this.pending
    if (!p) return
    this.pending = null
    this.stopPendingPoll()
    this.log('info', `Maker giriş emri iptal (${p.symbol} ${p.side} @ ${p.limitPrice}) — ${reason}`)
    // aynı sinyalle anında yeniden denemeyi engelle
    this.lastEntryTs = Date.now()
  }

  /** Maker dolumu → pozisyon (PAPER ve LIVE ortak yol) */
  private finalizePendingPosition(entryPrice: number, qty: number, maker: boolean) {
    const p = this.pending
    if (!p || qty <= 0) { this.pending = null; this.stopPendingPoll(); return }
    this.pending = null
    this.stopPendingPoll()
    const s = this.sym.get(p.symbol)
    if (!s) return
    const feePct = maker ? this.settings.makerFeePct : this.settings.takerFeePct
    const entryFee = qty * entryPrice * (feePct / 100)
    this.position = {
      id: newId(),
      symbol: p.symbol,
      side: p.side,
      qty,
      entryPrice,
      notional: qty * entryPrice,
      margin: p.margin,
      leverage: p.leverage,
      entryTime: Date.now(),
      entryFee,
      feeBreakevenPct: this.roundTripFeePct(),
      takeProfitPct: p.effTpPct,
      stopLossPct: p.effSlPct,
      reason: p.why,
      makerEntry: maker,
      bestPrice: entryPrice,
      trailStop: null,
      adverseStreak: 0,
      momEvalSec: 0,
    }
    const d = this.priceDigitsFor(entryPrice)
    this.engineSignal.lastSignal = `GİRİŞ ${p.side} ${p.symbol} @ ${entryPrice.toFixed(d)} (maker) — ${p.why}`
    s.signal.lastSignal = this.engineSignal.lastSignal
    this.log('trade', `⇪ ${p.side} GİRİŞ (MAKER) | ${p.symbol} | ${qty} @ ${entryPrice.toFixed(d)} | ${p.leverage}x | Marj ${p.margin.toFixed(2)} USDT | Ücret ${entryFee.toFixed(3)} USDT | TP %${p.effTpPct.toFixed(3)} / SL %${p.effSlPct.toFixed(3)}`)
  }

  private stopPendingPoll() {
    if (this.pendingPollTimer) { clearInterval(this.pendingPollTimer); this.pendingPollTimer = null }
  }

  /** LIVE: bekleyen maker emrini saniyede bir yokla (dolum/iptal) */
  private startPendingPoll() {
    if (this.pendingPollTimer) return
    this.pendingPollTimer = setInterval(() => { void this.pollPendingLive() }, 1000)
  }

  private async pollPendingLive() {
    const p = this.pending
    if (!p || p.liveOrderId === null) return
    try {
      const o = await getOrder(p.symbol, p.liveOrderId)
      if (o.executedQty > 0 && (o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED')) {
        if (o.status === 'FILLED') {
          this.finalizePendingPosition(o.avgPrice > 0 ? o.avgPrice : p.limitPrice, o.executedQty, true)
          return
        }
        // kısmi dolum + süre doldu → kalanı iptal et, dolan kısmı pozisyon yap
        if (Date.now() >= p.expiresTs) {
          try { await cancelOrder(p.symbol, p.liveOrderId) } catch { /* zaten kapalı */ }
          this.finalizePendingPosition(o.avgPrice > 0 ? o.avgPrice : p.limitPrice, o.executedQty, true)
        }
        return
      }
      if (Date.now() >= p.expiresTs) {
        try { await cancelOrder(p.symbol, p.liveOrderId) } catch { /* zaten kapalı */ }
        // HIZLI YAKALA (LIVE): emir iptal edildi → sinyal hâlâ geçerliyse piyasa emriyle yakala
        const s = this.sym.get(p.symbol)
        const gate = s ? this.entryGate(s) : null
        if (s && gate && gate.side === p.side) {
          const waited = Math.max(1, Math.round((Date.now() - p.placedTs) / 1000))
          this.pending = null
          this.stopPendingPoll()
          this.log('trade', `⚡ HIZLI YAKALA (LIVE) | ${p.symbol} ${p.side} maker ${waited}sn'de dolmadı → piyasa emriyle giriliyor (sinyal hâlâ geçerli, skor ${gate.score.toFixed(2)})`)
          void this.openPosition(gate.side, `${gate.why} · hızlı yakala (LIVE maker ${waited}sn'de dolmadı)`, s, gate.score, true)
        } else {
          this.cancelPending('süre doldu (LIVE)')
        }
      }
    } catch {
      // geçici sorgu hatası — sonraki saniye tekrar denenir
    }
  }

  /** Fiyatı sembolün tick boyutına yuvarla (LIVE limit emirleri için) */
  private roundToTick(price: number, tickSize: number): number {
    if (!tickSize || tickSize <= 0) return price
    return Math.round(price / tickSize) * tickSize
  }

  /** Çıkış kontrolü — pozisyonun sembolünde HER vuruşta çalışır */
  private manageExits() {
    const p = this.position!
    const s = this.sym.get(p.symbol)
    if (!s || s.price <= 0) return
    const dir = p.side === 'LONG' ? 1 : -1
    const ref = this.exitRefPriceFor(s, p.side)
    const movePct = ((ref / p.entryPrice) - 1) * 100 * dir

    // ---- keskin çıkış motoru: saati değil kâr koruması yönetir ----
    if (this.settings.sharpExit) {
      // 1) zirve takibi + trailing kilit (yalnız lehte yönde sıkışır, asla gevşemez)
      if (dir === 1 ? ref > p.bestPrice : ref < p.bestPrice) {
        p.bestPrice = ref
        const bestMove = ((p.bestPrice / p.entryPrice) - 1) * 100 * dir
        if (bestMove >= this.settings.trailArmPct) {
          const cand = p.bestPrice * (1 - dir * this.settings.trailPct / 100)
          if (p.trailStop === null || (dir === 1 ? cand > p.trailStop : cand < p.trailStop)) {
            p.trailStop = cand
          }
        }
      }
      // 2) trailing kilidine çarptı → kilitlenmiş kârla çık (maker)
      const ts = p.trailStop
      if (ts !== null && (dir === 1 ? ref <= ts : ref >= ts)) { this.closePosition('TRAIL'); return }
      // 3) momentum ölümü: 1sn momentum belirgin şekilde aleyhine döndüyse
      //    (8 sn üst üste) VE pozisyon zarardaysa bekleme yok.
      //    Sıfır hareketli/küçük kârlı pozisyonlar TAKER ücret yakmamalı —
      //    1sn EMA gürültüsüyle scratch döngüsü buradan engellenir.
      //    Kâr kilidi zaten kurulduysa dokunma — trailing koruması yeter.
      if (this.settings.momentumExit) {
        const secNow = Math.floor(Date.now() / 1000)
        if (p.momEvalSec !== secNow) {
          p.momEvalSec = secNow
          const mom = s.signal.momentum1s
          const against = (p.side === 'LONG' && mom === 'DOWN') || (p.side === 'SHORT' && mom === 'UP')
          p.adverseStreak = against ? p.adverseStreak + 1 : 0
          // HASAR EŞİĞİ: 1sn gürültüsü seni atamaz — momentum ölümü yalnız
          // kayıp, pozisyonun ücret başabaşını VE SL mesafesinin %35'ini
          // aştığında gerçek ölümdür. Küçük ekside çıkmak scratch döngüsüdür
          // (3 saatte 26 momentum çıkışı = −4.5 USDT ücret kanaması);
          // pozisyon trailing/SL/timeout güvenliğinde nefes alır.
          const damageFloor = Math.max(p.feeBreakevenPct, p.stopLossPct * 0.35)
          if (p.adverseStreak >= 8 && movePct < -damageFloor) {
            this.closePosition('MOMENTUM'); return
          }
        }
      }
      // 4) sert ters: SL (koruyucu — her zaman taker)
      if (movePct <= -p.stopLossPct) { this.closePosition('STOP_LOSS'); return }
      // 5) geniş TP tavanı — kârı sınırlamaz, uç senaryo koruması (maker)
      if (movePct >= p.takeProfitPct) { this.closePosition('TAKE_PROFIT'); return }
      // 6) güvenlik tavanı: kâr yönetimi DEĞİL — 15dk'dan uzun süren
      //    pozisyon ancak kayıt dışı kalmasın diye kapatılır
      const heldSharp = (Date.now() - p.entryTime) / 1000
      const capSec = Math.max(this.settings.maxHoldSec, 900)
      if (heldSharp >= capSec) { this.closePosition('TIMEOUT'); return }
      return
    }

    // ---- klasik çıkış (eski davranış) ----
    if (movePct >= p.takeProfitPct) { this.closePosition('TAKE_PROFIT'); return }
    if (movePct <= -p.stopLossPct) { this.closePosition('STOP_LOSS'); return }
    const heldSec = (Date.now() - p.entryTime) / 1000
    if (heldSec >= this.settings.maxHoldSec) { this.closePosition('TIMEOUT'); return }

    // Sinyal ters döndüyse ve pozisyon zarardaysa bekleme — flip çıkışı
    const { trend1m } = s.signal
    if ((p.side === 'LONG' && trend1m === 'BEAR') || (p.side === 'SHORT' && trend1m === 'BULL')) {
      if (heldSec > 10 && movePct < 0) { this.closePosition('SIGNAL_FLIP'); return }
    }
  }

  closePosition(reason: ExitReason) {
    const p = this.position
    if (!p) return
    const s = this.sym.get(p.symbol)
    if (!s) { this.position = null; return }
    const settings = this.settings

    if (settings.mode === 'LIVE' && hasApiCreds()) {
      // ---- Aşama 2 (LIVE): TP çıkışını maker limit emriyle dene ----
      // hedefe reduce-only LIMIT konur; 2sn içinde dolmazsa piyasa emrine
      // düşülür (koruyucu çıkışlar SL/zaman aşımı her zaman piyasa emridir)
      if (p.makerEntry && (reason === 'TAKE_PROFIT' || (reason === 'TRAIL' && p.trailStop !== null))) {
        void this.tryMakerTpExit(p, s)
        return
      }
      marketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, true)
        .then(res => {
          const px = res.avgPrice > 0 ? res.avgPrice : this.exitRefPriceFor(s, p.side)
          this.settleClose(p, px, reason, settings.takerFeePct)
        })
        .catch(e => {
          this.log('error', `LIVE çıkış emri başarısız (tekrar denenecek): ${String(e)}`)
        })
      return
    }
    // PAPER dolum: LONG bid'den satar, SHORT ask'tan geri alır
    let exitPrice = this.fillPriceFor(s, p.side !== 'LONG')
    // ---- Aşama 2 (PAPER): maker TP — hedefe konmuş limit emri KENDİ
    // fiyatından dolar (spread ödenmez, maker ücreti ödenir).
    // manageExits yalnız fiyat hedefi GEÇTİĞİNDE tetiklendiği için
    // limit dolumu güvenli sayılır; kayıt hedef fiyatından yapılır
    // (gerçek dolulum daha iyiyse bile kötümser kayıt tercih edilir).
    if (p.makerEntry && reason === 'TAKE_PROFIT') {
      const dir = p.side === 'LONG' ? 1 : -1
      exitPrice = p.entryPrice * (1 + dir * p.takeProfitPct / 100)
    } else if (p.makerEntry && reason === 'TRAIL' && p.trailStop !== null) {
      // kilit seviyesine konmuş limit emrin KENDİ fiyatından dolum
      // (spread ödenmez, maker ücreti ödenir — kötümser kayıt tercih edilir)
      exitPrice = p.trailStop
    }
    this.settleClose(p, exitPrice, reason)
  }

  /** LIVE: TP'yi (veya trailing kilidini) maker limit emriyle kapatmayı dene (2sn), dolmazsa piyasa */
  private async tryMakerTpExit(p: Position, s: SymState) {
    const dir = p.side === 'LONG' ? 1 : -1
    const fallback = p.entryPrice * (1 + dir * p.takeProfitPct / 100)
    const target = this.roundToTick(
      p.trailStop !== null && p.trailStop < fallback && p.trailStop > p.entryPrice
        ? p.trailStop
        : fallback,
      s.filter.tickSize,
    )
    try {
      const o = await limitMakerOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, target, true)
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && this.position === p) {
        await new Promise(r => setTimeout(r, 500))
        const st = await getOrder(p.symbol, o.orderId)
        if (st.status === 'FILLED' && st.executedQty > 0) {
          this.settleClose(p, st.avgPrice > 0 ? st.avgPrice : target, 'TAKE_PROFIT', this.settings.makerFeePct)
          return
        }
        if (st.status === 'CANCELED' || st.status === 'REJECTED' || st.status === 'EXPIRED') break
      }
      await cancelOrder(p.symbol, o.orderId).catch(() => { /* zaten kapalı */ })
      // iptal anında dolmuş olabilir → son durum kontrolü
      const st = await getOrder(p.symbol, o.orderId).catch(() => null)
      if (st && st.status === 'FILLED' && st.executedQty >= p.qty) {
        this.settleClose(p, st.avgPrice > 0 ? st.avgPrice : target, 'TAKE_PROFIT', this.settings.makerFeePct)
        return
      }
      // tam dolmadı (kısmi/hiç) → kalanı piyasa emriyle kapat, TAMAMEN
      // taker ücretiyle kaydet (kötümser — maker avantajı ancak tam doluda)
      const res = await marketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, true)
      this.settleClose(p, res.avgPrice > 0 ? res.avgPrice : this.exitRefPriceFor(s, p.side), 'TAKE_PROFIT', this.settings.takerFeePct)
    } catch (e) {
      this.log('error', `LIVE maker TP çıkışı başarısız → piyasa emri deneniyor: ${String(e)}`)
      try {
        const res = await marketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, true)
        this.settleClose(p, res.avgPrice > 0 ? res.avgPrice : this.exitRefPriceFor(s, p.side), 'TAKE_PROFIT', this.settings.takerFeePct)
      } catch (e2) {
        this.log('error', `LIVE çıkış emri başarısız (tekrar denenecek): ${String(e2)}`)
      }
    }
  }

  private settleClose(p: Position, exitPrice: number, reason: ExitReason, exitFeePct?: number) {
    const settings = this.settings
    const dir = p.side === 'LONG' ? 1 : -1
    const gross = (exitPrice - p.entryPrice) * p.qty * dir
    // ücret farkındalığı (Aşama 2): maker girişli pozisyonun TP çıkışı maker
    // ücretiyle, koruyucu çıkışlar (SL/zaman/sinyal/manuel/mutabakat) taker ile
    const feePct = exitFeePct ?? (((reason === 'TAKE_PROFIT' || reason === 'TRAIL') && p.makerEntry) ? settings.makerFeePct : settings.takerFeePct)
    const exitFee = p.qty * exitPrice * (feePct / 100)
    const fees = p.entryFee + exitFee
    const net = gross - fees
    const movePct = ((exitPrice / p.entryPrice) - 1) * 100 * dir
    const holdSec = Math.max(1, Math.round((Date.now() - p.entryTime) / 1000))
    const prevBalance = this.balance

    // PAPER: net doğrudan bakiyeye yansır → bileşik büyüme otomatik
    // LIVE: muhasebe kaydı aynı; bakiye API'den periyodik senkronize edilir
    if (settings.mode === 'PAPER') {
      this.balance += net
      kvSetNumber('balance', this.balance)
    }

    const trade: Trade = {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      exitPrice,
      entryTime: p.entryTime,
      exitTime: Date.now(),
      holdSec,
      grossPnl: gross,
      fees,
      netPnl: net,
      pnlPct: (net / p.margin) * 100,
      movePct,
      balanceAfter: this.balance,
      reason,
      entrySignal: p.reason,
    }
    this.trades = [trade, ...this.trades].slice(0, 200)
    try {
      saveTrade(trade)
    } catch (e) {
      this.log('error', `İşlem kaydı yazılamadı (muhasebe devam ediyor): ${String(e)}`)
    }

    this.equity.push({ t: Date.now(), balance: this.balance })
    if (this.equity.length > EQUITY_KEEP) this.equity.shift()
    try {
      saveEquity(Date.now(), this.balance)
    } catch { /* eşitlik noktası kritik değil */ }

    this.position = null
    this.statsCache = null

    // günlük işlem sayacı (tavan kontrolü) — gece yarısı rollDailyRef sıfırlar
    this.rollDailyRef()
    this.tradesToday++
    // sembol soğuması: momentum ölümü/SL yaşayan coin 2 dk elenir —
    // "aynı coin, aynı yön, 30sn sonra tekrar giriş" döngüsü buradan kesilir
    if (reason === 'MOMENTUM' || reason === 'STOP_LOSS') {
      this.symCooldownUntil.set(p.symbol, Date.now() + 120_000)
    }

    // zarar serisi koruması: SL sonrası bekleme süresini 3 katına çıkar (sıralı zararları kes)
    if (reason === 'STOP_LOSS') {
      this.lastEntryTs = Date.now() + this.settings.cooldownSec * 2000 // efektif 3x cooldown
    }

    const emoji = net >= 0 ? '✓' : '✗'
    const reasonTR = { TAKE_PROFIT: 'KÂR ALINDI', STOP_LOSS: 'ZARAR KESİLDİ', SIGNAL_FLIP: 'SİNYAL TERSLEŞTİ', TIMEOUT: 'SÜRE DOLDU', MANUAL: 'MANUEL', RECON: 'MUTABAKAT DÜZELTMESİ', TRAIL: 'KÂR KİLİTLENDİ', MOMENTUM: 'MOMENTUM ÖLDÜ', DAILY_STOP: 'GÜNLÜK TAVAN', TOTAL_FLOOR: 'TOPLAM TABAN' }[reason]
    this.log('trade', `${emoji} ${reasonTR} | ${p.symbol} ${p.side} ${p.qty} @ ${exitPrice.toFixed(this.priceDigitsFor(exitPrice))} | Brüt ${gross.toFixed(3)} − Ücret ${fees.toFixed(3)} = NET ${net.toFixed(3)} USDT (${trade.pnlPct.toFixed(2)}% marj) | Bakiye: ${prevBalance.toFixed(2)} → ${this.balance.toFixed(2)}`)
    this.engineSignal.lastSignal = `ÇIKIŞ (${reasonTR}) ${p.symbol} — net ${net.toFixed(3)} USDT`

    // kanama kesme devreleri: zarar serisi sayacı + günlük tavan + toplam taban
    this.onTradeClosed(net)
    this.checkDailyLoss()
    this.checkTotalFloor()
  }

  /** Gün referansını güncelle — gün değişince tavan yeniden başlar */
  private rollDailyRef() {
    const today = new Date().toISOString().slice(0, 10)
    if (this.dayKey !== today) {
      this.dayKey = today
      this.dayStartBalance = this.balance
      this.dayStopped = false
      this.tradesToday = 0          // günlük işlem tavanı yeni güne sıfırlanır
    }
  }

  /** Günlük zarar tavanı — aşıldıysa pozisyonu kapat + botu günü bitir */
  private checkDailyLoss() {
    if (this.settings.dailyLossPct <= 0 || this.dayStopped) return
    this.rollDailyRef()
    if (this.dayStartBalance <= 0) return
    const dd = (this.balance - this.dayStartBalance) / this.dayStartBalance * 100
    if (dd <= -this.settings.dailyLossPct) {
      this.dayStopped = true
      this.running = false
      if (this.position) this.closePosition('DAILY_STOP')
      this.log('error', `⛔ GÜNLÜK ZARAR TAVANI (%${this.settings.dailyLossPct}) aşıldı (${dd.toFixed(2)}%) — bot bugün için durduruldu, yarın otomatik sıfırlanır`)
      this.engineSignal.lastSignal = 'GÜNLÜK ZARAR TAVANI — bot durdu'
    }
  }

  // ---------------- Ücret farkındalığı yardımcıları ----------------

  roundTripFeePct(): number {
    return this.settings.takerFeePct * 2 // giriş + çıkış taker
  }

  feeAwareTp(): number {
    const min = this.roundTripFeePct() + this.settings.minEdgePct
    return Math.max(this.settings.takeProfitPct, min)
  }

  // ---------------- İstatistikler ----------------

  computeStats(): EngineStats {
    if (this.statsCache && this.lastStatsTrades === this.trades.length) return this.statsCache
    const n = this.trades.length
    const wins = this.trades.filter(t => t.netPnl >= 0)
    const losses = this.trades.filter(t => t.netPnl < 0)
    const netPnl = this.trades.reduce((a, t) => a + t.netPnl, 0)
    const grossPnl = this.trades.reduce((a, t) => a + t.grossPnl, 0)
    const totalFees = this.trades.reduce((a, t) => a + t.fees, 0)
    const sumWin = wins.reduce((a, t) => a + t.netPnl, 0)
    const sumLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0))

    let peak = -Infinity, maxDd = 0
    for (const p of this.equity) {
      peak = Math.max(peak, p.balance)
      maxDd = Math.max(maxDd, (peak - p.balance) / peak * 100)
    }
    const elapsedH = Math.max(0.25, (Date.now() - this.startedAt) / 3600000)

    this.statsCache = {
      totalTrades: n,
      wins: wins.length,
      losses: losses.length,
      winRate: n > 0 ? (wins.length / n) * 100 : 0,
      netPnl, grossPnl, totalFees,
      avgNet: n > 0 ? netPnl / n : 0,
      bestTrade: n > 0 ? Math.max(...this.trades.map(t => t.netPnl)) : 0,
      worstTrade: n > 0 ? Math.min(...this.trades.map(t => t.netPnl)) : 0,
      // Infinity JSON'ta null'a düşer → protokol: null = ∞ (kayıp yok, kazanç var)
      profitFactor: sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? null : 0),
      maxDrawdownPct: maxDd,
      avgHoldSec: n > 0 ? this.trades.reduce((a, t) => a + t.holdSec, 0) / n : 0,
      tradesPerHour: n / elapsedH,
    }
    this.lastStatsTrades = this.trades.length
    return this.statsCache
  }

  // ---------------- Snapshot (dashboard'a giden veri) ----------------

  openPositionView(): OpenPositionView | null {
    const p = this.position
    if (!p) return null
    const s = this.sym.get(p.symbol)
    const px = s?.price || p.entryPrice
    const exitRef = s ? this.exitRefPriceFor(s, p.side) || px : px
    const dir = p.side === 'LONG' ? 1 : -1
    const movePct = ((exitRef / p.entryPrice) - 1) * 100 * dir
    const gross = (exitRef - p.entryPrice) * p.qty * dir
    const estExitFee = p.qty * exitRef * (this.settings.takerFeePct / 100)
    const fees = p.entryFee + estExitFee
    const net = gross - fees
    return {
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryTime: p.entryTime,
      markPrice: px,
      movePct,
      grossPnl: gross,
      fees,
      netPnl: net,
      pnlPct: (net / p.margin) * 100,
      takeProfitPrice: p.entryPrice * (1 + dir * p.takeProfitPct / 100),
      stopLossPrice: p.entryPrice * (1 - dir * p.stopLossPct / 100),
      trailStop: p.trailStop,   // kâr kilidi çentiği (pistte gösterilir)
      holdSec: Math.floor((Date.now() - p.entryTime) / 1000),
      maxHoldSec: this.settings.maxHoldSec,
      reason: p.reason,
    }
  }

  /** Tarayıcı radarı — izlenen tüm sembollerin tek satırlık özeti */
  private watchItems(): WatchItem[] {
    const active = this.activeSymbols()
    const items: WatchItem[] = []
    // hazır sayımında taze kapı durumu + kilitler kullanılır (s.readySide
    // pozisyon açıkken güncellenmez — radar bu yüzden bayat bilgi gösterirdi)
    const cooldownLeftMs = this.lastEntryTs + this.settings.cooldownSec * 1000 - Date.now()
    const locked = !this.running || !!this.position || !!this.pending || this.dayStopped || cooldownLeftMs > 0
    for (const symbol of active) {
      const s = this.sym.get(symbol)
      if (!s) {
        items.push({
          symbol, price: 0, change24hPct: 0, spreadPct: 0,
          trend1m: 'FLAT', momentum1s: 'FLAT', rsi1m: 50,
          score: 0, ready: false, readySide: null, readyData: false,
          regimeScore: 0, regimeRank: 0, regimeEligible: false,
          flow: null, htfTrend: 'NA',
          gate: { side: null, blockKey: 'DATA', blockLabel: 'Veri toplanıyor' },
        })
        continue
      }
      const gs = this.gateStatusFor(s)
      const gateReady = gs.blockKey === null && !!gs.side
      items.push({
        symbol,
        price: s.price,
        change24hPct: s.change24hPct,
        spreadPct: s.spreadPct,
        trend1m: s.signal.trend1m,
        momentum1s: s.signal.momentum1s,
        rsi1m: s.signal.rsi1m,
        score: s.score,
        ready: gateReady && !locked,
        readySide: gateReady ? gs.side : null,
        readyData: s.candles1m.length >= 30 && s.candles1s.length >= 12,
        regimeScore: s.regimeScore,
        regimeRank: s.regimeRank,
        regimeEligible: s.regimeEligible,
        flow: s.flowSamples >= FLOW_MIN_SAMPLES ? +s.flowEma.toFixed(4) : null,
        htfTrend: s.htfTrend,
        gate: { side: gs.side, blockKey: gs.blockKey, blockLabel: gs.blockLabel },
      })
    }
    // en güçlü sinyal en üstte
    items.sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || b.score - a.score)
    return items
  }

  snapshot(): EngineSnapshot {
    const disp = this.displaySymbol()
    const s = this.sym.get(disp)
    const d = this.priceDigitsFor(s?.price ?? 0)
    // hassasiyeti azaltarak JSON boyutunu küçük tut (grafik için yeterli)
    const trim = (c: Candle): Candle => ({
      t: c.t,
      o: +c.o.toFixed(d), h: +c.h.toFixed(d),
      l: +c.l.toFixed(d), c: +c.c.toFixed(d),
      v: +c.v.toFixed(3),
    })
    const candles1m = [...(s?.candles1m ?? [])]
    const cur1m = s?.cur1m
    if (cur1m && candles1m.length > 0 && cur1m.t === candles1m[candles1m.length - 1].t) {
      // zaten dahil
    } else if (cur1m) candles1m.push(cur1m)
    const candles1s = [...(s?.candles1s ?? [])]
    if (s?.cur1s) candles1s.push(s.cur1s)

    const pos = this.openPositionView()
    const equity = pos ? this.balance + pos.netPnl : this.balance
    const startBal = this.equity[0]?.balance ?? this.settings.startBalance
    const displayInd: Indicators = s
      ? { ...s.signal, lastSignal: this.engineSignal.lastSignal }
      : { ...this.engineSignal }

    // günlük tavan referansı taze olsun (gece yarısı sonrası doğru gösterir)
    this.rollDailyRef()
    const dayLossPct = this.dayStartBalance > 0
      ? (this.balance - this.dayStartBalance) / this.dayStartBalance * 100
      : 0
    const entryLock: EntryLock = {
      running: this.running,
      busySymbol: this.position?.symbol ?? null,
      busySide: this.position?.side ?? null,
      pendingSymbol: this.pending?.symbol ?? null,
      pendingSide: this.pending?.side ?? null,
      cooldownRemainSec: Math.max(0, Math.ceil((this.lastEntryTs + this.settings.cooldownSec * 1000 - Date.now()) / 1000)),
      dayStopped: this.dayStopped,
      dayLossPct: +dayLossPct.toFixed(2),
      dayLossLimitPct: this.settings.dailyLossPct,
      lossStreak: this.lossStreak,
      lossPauseRemainSec: this.lossPauseRemainSec(),
      lossStreakLimit: this.settings.lossStreakLimit,
      tradesToday: this.tradesToday,
      maxTradesPerDay: this.settings.maxTradesPerDay ?? 0,
      hardStopped: this.hardStopped,
      floorUsedPct: this.floorRefBalance > 0 ? +(((this.balance - this.floorRefBalance) / this.floorRefBalance) * 100).toFixed(2) : 0,
      floorLimitPct: this.settings.totalFloorPct,
    }

    return {
      connected: this.connected,
      wsStatus: this.wsStatus,
      streamMode: this.streamMode,
      streamSource: this.streamMode === 'FUTURES'
        ? (this.settings.scanMode === 'MULTI'
          ? `Binance Futures bookTicker · ${this.activeSymbols().length} sembol tek sokette`
          : 'Binance Futures (bookTicker)')
        : 'Binance Spot (yedek)',
      running: this.running,
      settings: this.settings,
      scanMode: this.settings.scanMode,
      displaySymbol: disp,
      trackedSymbols: this.activeSymbols(),
      scanner: {
        tickRate: this.tickRate,
        watch: this.watchItems(),
        regime: this.regimeView(),
      },
      price: s?.price ?? 0,
      bid: s?.bid ?? 0,
      ask: s?.ask ?? 0,
      spread: s?.spread ?? 0,
      spreadPct: s?.spreadPct ?? 0,
      priceChange24hPct: s?.change24hPct ?? 0,
      markPrice: s?.markPrice ?? 0,
      serverTime: Date.now(),
      account: {
        balance: this.balance,
        startBalance: startBal,
        growthPct: startBal > 0 ? ((this.balance / startBal) - 1) * 100 : 0,
        equity,
      },
      position: pos,
      pending: this.pending ? {
        symbol: this.pending.symbol,
        side: this.pending.side,
        qty: this.pending.qty,
        limitPrice: this.pending.limitPrice,
        placedSec: Math.round((Date.now() - this.pending.placedTs) / 1000),
        expiresSec: Math.max(0, Math.round((this.pending.expiresTs - Date.now()) / 1000)),
      } : null,
      indicators: displayInd,
      gateDetail: s ? this.gateStatusFor(s) : null,
      entryLock,
      stats: this.computeStats(),
      candles1m: candles1m.slice(-CHART_1M_KEEP).map(trim),
      candles1s: candles1s.slice(-CHART_1S_KEEP).map(trim),
      equity: this.equity.slice(-EQUITY_KEEP),
      trades: this.trades.slice(0, 50),
      feeBreakevenPct: this.roundTripFeePct(),
      logs: this.logs.slice(-40),
      recon: { ...this.recon, issues: [...this.recon.issues] },
      api: (() => {
        const w = getApiWeight()
        return w ? { weightUsed1m: w.used1m, weightLimit1m: 2400, updatedAt: w.updatedAt } : null
      })(),
    }
  }

  priceDigitsFor(p: number): number {
    const v = p || 1
    if (v >= 10000) return 2
    if (v >= 100) return 3
    if (v >= 1) return 4
    return 6
  }

  log(level: LogLine['level'], msg: string) {
    this.logs.push({ t: Date.now(), level, msg })
    if (this.logs.length > 60) this.logs.shift()
    const tag = { info: '·', trade: '◆', warn: '!', error: '✕' }[level]
    console.log(`[${tag}] ${msg}`)
  }

  /** Dakikalık eşitlik anlık görüntüsü (dış zamanlayıcıdan) */
  maybeSaveEquity() {
    const now = Date.now()
    if (now - this.lastEquitySave > 60000) {
      this.lastEquitySave = now
      const eq = this.balance + (this.openPositionView()?.netPnl ?? 0)
      this.equity.push({ t: now, balance: eq })
      if (this.equity.length > EQUITY_KEEP) this.equity.shift()
      saveEquity(now, eq)
    }
  }

  async boot() {
    const symbols = this.activeSymbols()
    await this.bootstrapMarkets(symbols)
    this.stream.connect(symbols)
    this.scheduleHistoryRetry()
    // günün işlem sayacını DB'den geri yükle — motor gün içinde yeniden
    // doğarsa günlük tavan doğru sayıdan devam eder
    this.rollDailyRef()
    {
      const d = new Date()
      this.tradesToday = countTradesSince(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    }
    // otomatik devam: motor çöktüyse/yeniden doğduysa çalışır durum geri gelir
    // (elle durdurulduysa bayrak sönüktür; korumalar hâlâ veto edebilir)
    // ENGINE_AUTOSTART=1 → DB taze olduğunda (bayrak henüz yazılmamışsa) varsayılan açık;
    // bir kez açılıp kapatıldığında DB'deki değer kazanır.
    if (kvGetString('autostart', process.env.ENGINE_AUTOSTART === '1' ? '1' : '0') === '1') {
      const r = this.start()
      this.log(r.ok ? 'info' : 'warn', r.ok
        ? `Otomatik devam — bot çalışır durumda geri getirildi (bugün ${this.tradesToday} işlem)`
        : `Otomatik devam engellendi: ${r.msg}`)
    }
    // güvenlik ağı: yeniden başlatma sonrası yetim pozisyon yakalama (anahtar varsa)
    if (this.settings.mode === 'LIVE' && hasApiCreds()) this.startReconLoop()
    setInterval(() => this.maybeSaveEquity(), 15000)
    setInterval(() => this.maybeSaveCandleCache(), 30000)
    // 24s değişim yoklaması — klines tabanlı refresh24h (durum değişince loglar).
    // 5 dk'da bir yeter: 24s'lik yüzde bunun için zaten ağır çekim.
    setInterval(() => {
      void this.refresh24h(this.activeSymbols())
    }, 300000)
  }
}
