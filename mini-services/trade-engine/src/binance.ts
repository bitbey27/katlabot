// ============================================================
// Binance Futures istemcisi — ÇOKLU SEMBOL DESTEKLİ
//  - BİRİNCİL WS: fstream bookTicker combined stream (9 sembol
//    TEK sokette multiplexed ~800 mesaj/sn — ölçüldü, hız kaybı yok)
//  - YEDEK WS   : spot aggTrade + kline_1m + ticker (otomatik geçiş)
//  - REST: kline geçmişi, exchangeInfo (TOPLU), 24s değişim (TOPLU)
//  - LIVE mod: HMAC-SHA256 imzalı emir gönderimi
// Ücret/miktar doğruluğu: fapi.binance.com (USDT-M Futures)
// ============================================================

import { createHmac, randomUUID } from 'crypto'
import type { Candle } from './types'

// NOT: Bu ağda Binance FUTURES WebSocket'i (fstream) yalnızca `bookTicker`
// çerçevelerini geçirir (aggTrade / kline_* / markPrice / ticker süzülür).
// bookTicker ~400-700 güncelleme/sn ile GERÇEK futures en iyi alış/satış
// fiyatını verir — scalping için aggTrade'den bile daha iyidir.
// Bu yüzden:
//   BİRİNCİL  : fstream bookTicker (gerçek futures emir defteri)
//   YEDEK     : spot akışı (aggTrade + kline_1m + ticker) — futures akışı
//               8sn veri vermezse otomatik geçilir, 90sn'de bir futures
//               paralel probla kesintisiz yeniden denenir.
// Kline geçmişi: önce futures REST, yedek spot REST.
const FAPI_HOST = 'https://fapi.binance.com'
const SPOT_API_HOST = 'https://api.binance.com'
const FWS_HOST = 'wss://fstream.binance.com'
const SPOT_WS_HOST = 'wss://stream.binance.com:9443'

// Basit bellek içi HTTP GET yardımcısı (Bun fetch)
async function fapiGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
  return httpGet(`${FAPI_HOST}${path}`, params)
}

// Genel HTTP GET yardımcısı
async function httpGet(url: string, params: Record<string, string | number> = {}): Promise<any> {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  const full = `${url}${qs ? '?' + qs : ''}`
  const res = await fetch(full, { method: 'GET' })
  if (url.startsWith(FAPI_HOST)) captureApiWeight(res) // herkese açık fapi istekleri de IP ağırlığına yazılır
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text().catch(() => '')}`)
  return res.json()
}

/** Geçmiş 1m mumları çeker (bootstrap) — önce futures, yedek spot.
 *  `endTime` verilirse o zamandan geriye sayfalar (geçmiş sayfalama). */
export async function fetchKlines(symbol: string, interval = '1m', limit = 200, endTime?: number): Promise<Candle[]> {
  const params: Record<string, string | number> = { symbol, interval, limit }
  if (endTime) params.endTime = endTime
  try {
    const raw = await httpGet(`${FAPI_HOST}/fapi/v1/klines`, params)
    return parseKlines(raw)
  } catch {
    const raw = await httpGet(`${SPOT_API_HOST}/api/v3/klines`, params)
    return parseKlines(raw)
  }
}

function parseKlines(raw: any[]): Candle[] {
  return raw.map((k: any[]) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }))
}

export interface SymbolFilter {
  stepSize: number
  minQty: number
  minNotional: number
  tickSize: number
}

// REST hız limitine takıldığında kullanılan bilinen sembol kuralları
// (Binance USDT-M Futures LOT_SIZE / MIN_NOTIONAL değerleri)
const KNOWN_FILTERS: Record<string, SymbolFilter> = {
  BTCUSDT:  { stepSize: 0.001, minQty: 0.001, minNotional: 5,   tickSize: 0.1 },
  ETHUSDT:  { stepSize: 0.001, minQty: 0.001, minNotional: 5,   tickSize: 0.01 },
  BNBUSDT:  { stepSize: 0.01,  minQty: 0.01,  minNotional: 5,   tickSize: 0.01 },
  SOLUSDT:  { stepSize: 0.1,   minQty: 0.1,   minNotional: 5,   tickSize: 0.01 },
  XRPUSDT:  { stepSize: 0.1,   minQty: 0.1,   minNotional: 5,   tickSize: 0.0001 },
  DOGEUSDT: { stepSize: 1,     minQty: 1,     minNotional: 5,   tickSize: 0.00001 },
  ADAUSDT:  { stepSize: 1,     minQty: 1,     minNotional: 5,   tickSize: 0.0001 },
  AVAXUSDT: { stepSize: 0.1,   minQty: 0.1,   minNotional: 5,   tickSize: 0.01 },
  LINKUSDT: { stepSize: 0.01,  minQty: 0.01,  minNotional: 5,   tickSize: 0.001 },
}

const filterCache = new Map<string, SymbolFilter>()

/** Tüm sembollerin filtrelerini TEK exchangeInfo çağrısıyla çeker (hız limiti dostu) */
export async function fetchFiltersForSymbols(symbols: string[]): Promise<Map<string, SymbolFilter>> {
  const out = new Map<string, SymbolFilter>()
  const missing = symbols.filter(s => !filterCache.has(s))
  if (missing.length > 0) {
    try {
      const info = await fapiGet('/fapi/v1/exchangeInfo')
      for (const raw of (info.symbols as any[] ?? [])) {
        const f: SymbolFilter = {
          stepSize: Number(raw.filters?.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize ?? 0.001),
          minQty: Number(raw.filters?.find((f: any) => f.filterType === 'LOT_SIZE')?.minQty ?? 0.001),
          minNotional: Number(raw.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL')?.notional ?? 5),
          tickSize: Number(raw.filters?.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0.1),
        }
        filterCache.set(raw.symbol, f)
      }
    } catch { /* hız limiti / ağ hatası → bilinen değerler */ }
  }
  for (const s of symbols) {
    out.set(s, filterCache.get(s) ?? KNOWN_FILTERS[s] ?? { stepSize: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.1 })
  }
  return out
}

export async function fetchSymbolFilter(symbol: string): Promise<SymbolFilter> {
  const m = await fetchFiltersForSymbols([symbol])
  return m.get(symbol)!
}

/** 24s değişim — tek sembol (hata → null) */
export async function fetch24hChange(symbol: string): Promise<number | null> {
  try {
    const t = await fapiGet('/fapi/v1/ticker/24hr', { symbol })
    const v = Number(t.priceChangePercent)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** 24s değişim — klines'tan (5 Kasım): /fapi/v1/ticker/24hr bazı bulut IP'lerinde tıkanıyor;
 *  klines ailesi boot'ta kanıtlanmış. 1h×25 mum ≈ 24 saatlik pencere, ağırlık ~2. */
export async function fetch24hChangeViaKlines(symbol: string): Promise<number | null> {
  try {
    const k = await fetchKlinesRetry(symbol, '1h', 25, undefined, 1)
    if (k.length < 2) return null
    const first = k[0], last = k[k.length - 1]
    const pct = ((last.c - first.o) / first.o) * 100
    return Number.isFinite(pct) ? pct : null
  } catch {
    return null
  }
}

/** 24s değişim — birden çok sembol TEK istekte (çoklu tarama için) */
export async function fetch24hChanges(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  try {
    // symbols=["A","B"] biçimi — yalnızca istenen semboller döner
    const q = encodeURIComponent(JSON.stringify(symbols))
    const res = await fetch(`${FAPI_HOST}/fapi/v1/ticker/24hr?symbols=${q}`)
    if (!res.ok) throw new Error(String(res.status))
    const arr = await res.json() as any[]
    for (const t of arr) {
      const v = Number(t.priceChangePercent)
      if (Number.isFinite(v)) out.set(t.symbol, v)
    }
  } catch {
    // toplu istek desteklenmezse tek tek dene
    for (const s of symbols) {
      const v = await fetch24hChange(s)
      if (v !== null) out.set(s, v)
    }
  }
  return out
}

/** Kline çekme — hız limitine karşı yeniden denemeli */
export async function fetchKlinesRetry(symbol: string, interval = '1m', limit = 200, endTime?: number, tries = 4): Promise<Candle[]> {
  let lastErr: unknown = null
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchKlines(symbol, interval, limit, endTime)
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 2500 * (i + 1)))
    }
  }
  throw lastErr
}

// ---------------- LIVE mod imzalı istekler ----------------

export interface ApiCreds { key: string; secret: string }

let creds: ApiCreds | null = null
export function setApiCreds(key: string, secret: string) { creds = { key, secret } }
export function hasApiCreds() { return !!creds }

// ---------------- Güvenlik ağı: API hız limiti göstergesi ----------------
// Binance her fapi yanıtında X-MBX-USED-WEIGHT-1M başlığı döndürür:
// bu IP'nin son 1 dakikada harcanan istek ağırlığı (tavan ~2400/dk).
// Sınır 429 öncesi görüldüğü için dashboard'da canlı gösterilir.
export interface ApiWeightInfo { used1m: number; updatedAt: number }
let lastApiWeight: ApiWeightInfo | null = null
export function getApiWeight(): ApiWeightInfo | null { return lastApiWeight }
function captureApiWeight(res: Response) {
  try {
    const w = Number(res.headers.get('x-mbx-used-weight-1m') ?? 0)
    if (w > 0) lastApiWeight = { used1m: w, updatedAt: Date.now() }
  } catch { /* başlık yok — sorun değil */ }
}

async function signedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<any> {
  if (!creds) throw new Error('API anahtarı tanımlı değil')
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: '5000',
  }
  const qs = Object.entries(all).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const sig = createHmac('sha256', creds.secret).update(qs).digest('hex')
  const url = `${FAPI_HOST}${path}?${qs}&signature=${sig}`
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': creds.key } })
  captureApiWeight(res) // imzalı istekler de aynı IP ağırlık havuzundan düşer
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(body)}`)
  return body
}

/** Kaldıraç ayarla (LIVE) */
export async function setLeverage(symbol: string, leverage: number) {
  return signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage })
}

/**
 * Marj tipini ISOLATED'a çevir (LIVE) — RİSK YÖNETİMİ:
 * CROSS marjda pozisyonun teminatı TÜM cüzdan bakiyesidir (likidasyon hesabı
 * bütün bakiyeye göre yapılır). ISOLATED'da risk, yalnız pozisyona ayrılan
 * marjla sınırlı kalır — hesabın geri kalanı dokunulmaz.
 * Sembol zaten ISOLATED ise Binance -4046 döner; bu hata değil, başarıdir.
 * Açık pozisyon varken değiştirilemez (-4048); çağıran taraf uyarı loglar.
 */
export async function setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED' = 'ISOLATED') {
  try {
    return await signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType })
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e)
    if (msg.includes('-4046')) return { code: -4046, msg: 'zaten bu marj tipinde' }
    throw e
  }
}

/** Piyasa emri (LIVE). reduceOnly çıkışlar için. */
export async function marketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: number, reduceOnly = false): Promise<{ orderId: number; avgPrice: number }> {
  const res = await signedRequest('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity,
    newOrderRespType: 'RESULT',
    ...(reduceOnly ? { reduceOnly: 'true' } : {}),
  })
  // RESULT tipinde avgPrice döner; boşsa fiyatı sorgula
  let avg = Number(res.avgPrice ?? 0)
  if (!avg) {
    try {
      const q = await signedRequest('GET', '/fapi/v1/order', { symbol, orderId: res.orderId })
      avg = Number(q.avgPrice ?? q.price ?? 0)
    } catch { /* yoksa 0 kalır, çağıran tick fiyatını kullanır */ }
  }
  return { orderId: res.orderId, avgPrice: avg }
}

// ---------------- LIVE maker emirleri (Aşama 2) ----------------

export interface RestOrder {
  orderId: number
  status: string          // NEW / PARTIALLY_FILLED / FILLED / CANCELED / ...
  executedQty: number     // gerçekleşen miktar (base)
  avgPrice: number        // gerçekleşen ortalama fiyat (dolu değilse 0)
}

/**
 * LIMIT_MAKER (post-only) emir — defterin öbür tarafını geçmez:
 * fiyat bugün en iyi bid/ask'e dokunursa Binance emri reddeder.
 * Dolarsa maker ücreti ödenir (taker'ın ~1/3'ü). reduceOnly ile
 * TP çıkışlarında da kullanılabilir.
 */
export async function limitMakerOrder(
  symbol: string, side: 'BUY' | 'SELL', quantity: number, price: number, reduceOnly = false,
): Promise<RestOrder> {
  const res = await signedRequest('POST', '/fapi/v1/order', {
    symbol, side, quantity, price,
    type: 'LIMIT_MAKER',
    newOrderRespType: 'RESULT',
    ...(reduceOnly ? { reduceOnly: 'true' } : {}),
  })
  return {
    orderId: Number(res.orderId),
    status: String(res.status ?? 'NEW'),
    executedQty: Number(res.executedQty ?? 0),
    avgPrice: Number(res.avgPrice ?? 0),
  }
}

/** Bekleyen emri iptal et (kısmi dolum varsa kalan iptal edilir) */
export async function cancelOrder(symbol: string, orderId: number): Promise<void> {
  await signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId })
}

/** Emir durumu sorgula (LIVE maker dolulumu izlemek için) */
export async function getOrder(symbol: string, orderId: number): Promise<RestOrder> {
  const res = await signedRequest('GET', '/fapi/v1/order', { symbol, orderId })
  return {
    orderId: Number(res.orderId),
    status: String(res.status ?? 'NEW'),
    executedQty: Number(res.executedQty ?? 0),
    avgPrice: Number(res.avgPrice ?? 0),
  }
}

/** Hesap bakiyesi (LIVE) — USDT kullanılabilir bakiye */
export async function fetchBalance(): Promise<number | null> {
  try {
    const res = await signedRequest('GET', '/fapi/v2/balance')
    const usdt = (res as any[]).find(b => b.asset === 'USDT')
    return usdt ? Number(usdt.availableBalance) : null
  } catch {
    return null
  }
}

// ---------------- Güvenlik ağı: pozisyon mutabakatı ----------------

/** Borsadaki gerçek açık pozisyon satırı (LIVE mutabakat için) */
export interface PositionRiskRow {
  symbol: string
  positionAmt: number      // işaretli: + LONG, − SHORT, 0 = pozisyon yok
  entryPrice: number
  markPrice: number
  unRealizedProfit: number
  isolated: boolean
  leverage: number
  updateTime: number
}

/**
 * /fapi/v2/positionRisk — borsa gerçeği. Mutabakatın tek doğruluk kaynağı:
 * "bot açıldı sandı ama açılmadı" ve tersi "açıldı ama bot bilmiyor"
 * senaryoları bu listede görünür. Emir başına ~5 ağırlık; 60sn'de bir
 * çağrı dakikada ~5 ağırlık = tavanın binde ikisi.
 */
export async function fetchPositionRisk(): Promise<PositionRiskRow[]> {
  const rows = await signedRequest('GET', '/fapi/v2/positionRisk')
  return (rows as any[]).map(r => ({
    symbol: String(r.symbol),
    positionAmt: Number(r.positionAmt),
    entryPrice: Number(r.entryPrice),
    markPrice: Number(r.markPrice),
    unRealizedProfit: Number(r.unRealizedProfit),
    isolated: !!r.isolated,
    leverage: Number(r.leverage),
    updateTime: Number(r.updateTime),
  }))
}

// ---------------- WebSocket pazar akışı (ÇOKLU SEMBOL) ----------------

export type StreamMode = 'FUTURES' | 'SPOT'

/** Tek fiyat vuruşu — bookTicker'dan gelirse bid/ask doludur */
export interface TickPayload {
  symbol: string   // hangi sembolden geldi (combined stream)
  price: number    // takip fiyatı (futures: bid/ask ortası; spot: son işlem)
  ts: number
  bid: number      // en iyi alış (0 = yok → motor kayma uygular)
  ask: number      // en iyi satış (0 = yok)
  qty: number      // işlem hacmi (futures modda yön değişiminde kote hacmi vektörü)
  bidQty: number   // en iyi alış emrinin boyutu (order-flow dengesizliği için; 0 = yok)
  askQty: number   // en iyi satış emrinin boyutu (0 = yok)
}

export type WsHandlers = {
  onTick: (t: TickPayload) => void
  onKline1m: (symbol: string, c: Candle, closed: boolean) => void   // yalnız SPOT yedek modda gelir
  onTicker24h: (symbol: string, priceChangePct: number) => void     // yalnız SPOT yedek modda gelir
  onMode: (mode: StreamMode, status: string) => void
  onOpen: () => void
  onClose: () => void
  onError: (e: unknown) => void
}

const STALL_MS = 8000          // bu kadar süre VERİ gelmezse yedeğe geç
const PROBE_EVERY_MS = 90000   // SPOT yedeğindeyken futures'ı paralel yeniden dene
const WATCHDOG_MIN_GAP_MS = 10000 // watchdog'un art arda bağlantı denemesi arası

export class BinanceStream {
  private ws: WebSocket | null = null
  private probeWs: WebSocket | null = null
  private symbols: string[] = []
  private handlers: WsHandlers
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private lastMsgTs = 0
  private lastAttemptTs = 0
  private reconnectDelay = 3000
  private prevMid = new Map<string, number>()   // sembol başına önceki orta fiyat
  mode: StreamMode = 'FUTURES'

  constructor(handlers: WsHandlers) { this.handlers = handlers }

  get currentSymbols() { return this.symbols }

  /** Çoklu sembol bağlantısı — TÜM semboller TEK sokette multiplexed */
  connect(symbols: string[]) {
    this.symbols = [...symbols]
    this.prevMid.clear()
    // ilk deneme için grace — watchdog 8sn VERİ bekler (bağlantı değil)
    this.lastMsgTs = Date.now()
    this.reconnectDelay = 3000
    this.connectFutures()
    this.startWatchdog()
  }

  // ---------- BİRİNCİL: Futures bookTicker combined (gerçek emir defteri) ----------

  private connectFutures() {
    this.cleanupSocket()
    this.mode = 'FUTURES'
    this.prevMid.clear()
    this.lastAttemptTs = Date.now()
    const streams = this.symbols.map(s => `${s.toLowerCase()}@bookTicker`).join('/')
    const ws = new WebSocket(`${FWS_HOST}/stream?streams=${streams}`)
    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.handlers.onOpen()
      this.handlers.onMode('FUTURES', this.symbols.length > 1
        ? `Futures emir defteri canlı (${this.symbols.length} sembol · tek soket)`
        : 'Futures emir defteri canlı (bookTicker)')
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return   // eski soketin olayı — yoksay
      this.handlers.onClose()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', (e) => {
      if (this.ws !== ws) return
      this.handlers.onError(e)
    })
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return
      try {
        const msg = JSON.parse((ev.data as string) ?? '{}')
        const d = msg.data ?? msg
        if (d.b === undefined) return
        const bid = Number(d.b), ask = Number(d.a)
        if (!bid || !ask || bid <= 0 || ask <= 0) return
        const symbol = String(d.s ?? '') || String(msg.stream ?? '').split('@')[0].toUpperCase()
        if (!symbol) return
        const ts = Number(d.T ?? d.E) || Date.now()
        const mid = (bid + ask) / 2
        // aktivite vektörü: orta fiyat yükselirse satış tarafı kote hacmi,
        // düşerse alış tarafı kote hacmi (hacim çubuğu vekili)
        let qty = 0
        const prev = this.prevMid.get(symbol) ?? 0
        if (prev > 0 && mid !== prev) {
          qty = mid > prev ? Number(d.A ?? 0) : Number(d.B ?? 0)
        }
        this.prevMid.set(symbol, mid)
        this.lastMsgTs = Date.now()
        this.reconnectDelay = 3000
        this.handlers.onTick({ symbol, price: mid, ts, bid, ask, qty, bidQty: Number(d.B ?? 0), askQty: Number(d.A ?? 0) })
      } catch { /* bozuk mesajı yok say */ }
    })
  }

  // ---------- YEDEK: Spot akışı (çoklu sembol combined) ----------

  private connectSpot() {
    this.cleanupSocket()
    this.mode = 'SPOT'
    this.prevMid.clear()
    this.lastAttemptTs = Date.now()
    const streams = this.symbols
      .flatMap(sym => [`${sym.toLowerCase()}@aggTrade`, `${sym.toLowerCase()}@kline_1m`, `${sym.toLowerCase()}@ticker`])
      .join('/')
    const ws = new WebSocket(`${SPOT_WS_HOST}/stream?streams=${streams}`)
    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.handlers.onOpen()
      this.handlers.onMode('SPOT', this.symbols.length > 1
        ? `Spot yedek akışı canlı (${this.symbols.length} sembol · futures yeniden denenecek)`
        : 'Spot yedek akışı canlı (futures yeniden denenecek)')
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return   // eski soketin olayı — yoksay
      this.handlers.onClose()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', (e) => {
      if (this.ws !== ws) return
      this.handlers.onError(e)
    })
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return
      try {
        const msg = JSON.parse((ev.data as string) ?? '{}')
        const d = msg.data ?? msg
        const symbol = String(d.s ?? '')
        if (!symbol) return
        if (d.e === 'aggTrade') {
          this.lastMsgTs = Date.now()
          this.reconnectDelay = 3000
          this.handlers.onTick({ symbol, price: Number(d.p), ts: Number(d.T), bid: 0, ask: 0, qty: Number(d.q), bidQty: 0, askQty: 0 })
        } else if (d.e === 'kline') {
          const k = d.k
          const candle: Candle = {
            t: Number(k.t), o: Number(k.o), h: Number(k.h),
            l: Number(k.l), c: Number(k.c), v: Number(k.v),
          }
          this.handlers.onKline1m(symbol, candle, Boolean(k.x))
        } else if (d.e === '24hrTicker') {
          this.handlers.onTicker24h(symbol, Number(d.P))
        }
      } catch { /* bozuk mesajı yok say */ }
    })

    this.scheduleFuturesProbe()
  }

  // ---------- Watchdog: sessiz akış tespiti + mod geçişi ----------

  private startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = setInterval(() => {
      if (this.symbols.length === 0) return
      const idle = Date.now() - this.lastMsgTs
      const sinceAttempt = Date.now() - this.lastAttemptTs
      if (idle <= STALL_MS || sinceAttempt < WATCHDOG_MIN_GAP_MS) return
      // Soket açık ama VERİ akmıyor (bu ağın fstream filtresinin belirtisi)
      if (this.mode === 'FUTURES') {
        this.handlers.onMode('SPOT', 'Futures akışı sessiz — spot yedeğe geçildi')
      }
      this.connectSpot()
    }, 3000)
  }

  // ---------- Futures geri dönüş probu (paralel, kesintisiz) ----------

  private scheduleFuturesProbe() {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = setTimeout(() => this.probeFutures(), PROBE_EVERY_MS)
  }

  private probeFutures() {
    if (this.mode === 'FUTURES' || this.symbols.length === 0) return
    let got = 0
    let done = false
    const streams = this.symbols.map(s => `${s.toLowerCase()}@bookTicker`).slice(0, 3).join('/')
    let probe: WebSocket
    try {
      probe = new WebSocket(`${FWS_HOST}/stream?streams=${streams}`)
    } catch {
      this.scheduleFuturesProbe()
      return
    }
    this.probeWs = probe

    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try { probe.close() } catch { /* yoksay */ }
      if (this.probeWs === probe) this.probeWs = null
      if (ok && this.mode !== 'FUTURES') {
        this.handlers.onMode('FUTURES', 'Futures emir defteri geri geldi — ana akışa dönüldü')
        this.connectFutures()
      } else {
        this.scheduleFuturesProbe()
      }
    }

    const killer = setTimeout(() => finish(got >= 3), 6000)
    probe.addEventListener('message', () => {
      got++
      if (got >= 3) {
        clearTimeout(killer)
        finish(true)
      }
    })
    probe.addEventListener('error', () => {
      clearTimeout(killer)
      finish(false)
    })
    probe.addEventListener('close', () => {
      clearTimeout(killer)
      finish(got >= 3)
    })
  }

  private scheduleReconnect() {
    if (this.symbols.length === 0) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
    this.reconnectTimer = setTimeout(() => {
      if (this.mode === 'FUTURES') this.connectFutures()
      else this.connectSpot()
    }, delay)
  }

  private cleanupSocket() {
    // ÖNCE referansı bırak → eski soketin olayları görmezden gelinir
    if (this.ws) {
      const old = this.ws
      this.ws = null
      try { old.close() } catch { /* yoksay */ }
    }
    if (this.probeWs) {
      const oldProbe = this.probeWs
      this.probeWs = null
      try { oldProbe.close() } catch { /* yoksay */ }
    }
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  disconnect() {
    this.cleanupSocket()
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null }
    this.symbols = []
  }
}

export function newId(): string {
  return randomUUID().slice(0, 13).replace(/-/g, '')
}
