// ============================================================
// KatlaBot — Geçmişe Dönük Test + Parametre Optimizasyonu
//
// TASARIM İLKELERİ:
//  1) SIFIR SAPMA: canlı motorun KENDİ ema/rsi/atr fonksiyonlarıyla
//     hesaplanır — backtest'e ayrı indikatör kodu YAZILMAZ.
//  2) GERÇEK EKONOMİ: gidiş-dönüş ücret (taker veya maker) + yarı
//     spread maliyeti düşülür; pozisyon boyutu canlıdaki formülle
//     (bakiye × tahsis × kaldıraç) bileşik büyür.
//  3) KÖTÜMSER ÇIKIŞ: aynı mumda TP ve SL'e birlikte değiliyorsa
//     SL önce sayılır (gerçekçi backtest'in bedeli).
//  4) AŞIRI UYUM KORUMASI: verinin ilk %70'inde (eğitim) ızgara
//     aranır, şampiyon son %30'da (doğrulama — hiç görülmemiş veri)
//     sınanır. Doğrulamayı geçmeyen ayar "uygula" olarak önerilmez.
//  5) DÜRÜST MAKER (Aşama 2): post-only giriş emri yalnız fiyat
//     İSTEĞİMİZE gelirse dolar (low ≤ limit); makerWaitSec içinde
//     gelmezse sinyal KAÇAR (işlem yapılmaz) — maker'ın bedeli
//     simsiz gizlenmez. TP çıkışı limit fiyattan dolar, maker ücreti.
//  6) 1sn MODU (Aşama 3c): yeterli 1sn mumu varsa simülasyon canlı
//     girişle AYNI çözünürlükte koşar: momentum = 1s EMA5/20 (canlıdaki
//     gibi — gürültü paketi), trend/RSI/ATR 1m serisinden zaman damgasıyla hizalanır.
//     order-flow dengesizliği (S3) tarihsel defter verisi olmadığından
//     backtest'e SIMüle EDİLEMEZ — canlıda yalnız giriş sayısını azaltır
//     (seçicilik artar); rapor bunu dürüstçe not eder.
// ============================================================

import type {
  Candle, Side, ExitReason, BacktestParams, BacktestMetrics, BacktestReport,
  HeatmapCell, BacktestTradeView,
} from './types'
import { ema, rsi, atr } from './indicators'

// Izgara (kullanıcıyla konuşulmuş aralık)
export const GRID_TP = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60]
export const GRID_SL = [0.20, 0.30, 0.40, 0.54, 0.70, 0.90, 1.20]
export const GRID_HOLD = [60, 90, 120, 180, 300]

const WARMUP = 30          // ilk 30 mum indikatör ısınması (canlıda da aynı eşik)
const TRAIN_RATIO = 0.70   // %70 eğitim / %30 doğrulama
const MIN_TRADES = 40      // şampiyon için minimum işlem (istatistiksel güvence)
const MAX_DD_LIMIT = 15    // şampiyon için max düşüş tavanı (%)
const PF_TRAIN_MIN = 1.3   // eğitimde minimum kâr faktörü
const PF_VALID_MIN = 1.15  // doğrulamada minimum kâr faktörü
const COOLDOWN_BARS = 1    // çıkıştan sonra en az 1 mum bekle (canlı 4sn ≈ 1 mumdan az)
const MIN_1S_CANDLES = 300 // 1s modun açılması için gereken 1sn mumu

/** Ön-hesaplanmış indikatör serileri — ızgaradan bağımsız, bir kez üretilir */
interface Series {
  trend: ('BULL' | 'BEAR' | 'FLAT')[]
  momentum: ('UP' | 'DOWN' | 'FLAT')[]
  momStable?: ('UP' | 'DOWN' | 'FLAT')[]   // gürültü paketi: ≥10sn kesintisiz yön (canlı momPersistSec=10 aynası)
  rsiArr: number[]
  atrArr: number[]   // mutlak ATR (adaptif TP için %'ye çevrilir)
  closeArr: number[]
}

function buildSeries(candles: Candle[]): Series {
  const closes = candles.map(c => c.c)
  const emaFast: number[] = [], emaSlow: number[] = [], rsiArr: number[] = [], atrArr: number[] = []
  const trend: ('BULL' | 'BEAR' | 'FLAT')[] = []
  const momentum: ('UP' | 'DOWN' | 'FLAT')[] = []

  for (let i = 0; i < candles.length; i++) {
    const win = closes.slice(0, i + 1)
    const cur = closes[i] ?? candles[i]?.c ?? 0
    const f = ema(win.slice(-60), 9)
    const sl = ema(win.slice(-60), 21)
    const r = rsi(win.slice(-60), 14)
    const a = atr(candles.slice(0, i + 1), 14)
    emaFast.push(f ?? cur)
    emaSlow.push(sl ?? cur)
    rsiArr.push(r ?? 50)
    atrArr.push(a ?? 0)

    // Trend — canlı motorun formülü birebir: EMA farkı ± ATR tamponu
    const buf = Math.max((a ?? 0) * 0.25, cur * 0.0002)
    trend.push(f !== null && sl !== null
      ? (f > sl + buf ? 'BULL' : f < sl - buf ? 'BEAR' : 'FLAT')
      : 'FLAT')

    // Momentum vekili (1m mod): kapanış önceki kapanışı geçti mi
    if (i === 0) momentum.push('FLAT')
    else {
      const prev = closes[i - 1] ?? cur
      momentum.push(cur > prev ? 'UP' : cur < prev ? 'DOWN' : 'FLAT')
    }
  }
  return { trend, momentum, rsiArr, atrArr, closeArr: closes }
}

/**
 * 1s HİZALI seriler (Aşama 3c): her 1sn mumuna, içinde bulunduğu
 * 1dk mumunun trend/RSI/ATR'si yazılır; momentum 1s EMA3/8'den
 * (canlı girişin aynısı) hesaplanır.
 */
function buildSeries1s(candles1s: Candle[], candles1m: Candle[], series1m: Series): Series {
  const closes1s = candles1s.map(c => c.c)
  const trend: ('BULL' | 'BEAR' | 'FLAT')[] = []
  const momentum: ('UP' | 'DOWN' | 'FLAT')[] = []
  const rsiArr: number[] = []
  const atrArr: number[] = []

  // 1m mumlarını zamana göre aramak için başlangıç imleci (monoton ilerler)
  let mIdx = 0
  for (let i = 0; i < candles1s.length; i++) {
    const t1s = candles1s[i].t
    while (mIdx + 1 < candles1m.length && candles1m[mIdx + 1].t <= t1s) mIdx++
    trend.push(series1m.trend[mIdx] ?? 'FLAT')
    rsiArr.push(series1m.rsiArr[mIdx] ?? 50)
    atrArr.push(series1m.atrArr[mIdx] ?? 0)
    // momentum: 1s EMA5/20 (canlıdaki momentum1s'in aynısı — gürültü paketi)
    const f = ema(closes1s.slice(Math.max(0, i - 40), i + 1), 5)
    const sl = ema(closes1s.slice(Math.max(0, i - 40), i + 1), 20)
    momentum.push(f !== null && sl !== null ? (f > sl ? 'UP' : f < sl ? 'DOWN' : 'FLAT') : 'FLAT')
  }
  // gürültü paketi aynası: yön en az 10sn kesintisiz sürmedikçe sinyal sayılmaz
  // (canlı momPersistSec=10 — RSI-tepe taze dönmüş momentum girişleri kesilir)
  const persistSec = 10
  const momStable: ('UP' | 'DOWN' | 'FLAT')[] = []
  let runDir: 'UP' | 'DOWN' | 'FLAT' = 'FLAT', runLen = 0
  for (const m of momentum) {
    if (m === runDir) runLen++
    else { runDir = m; runLen = 1 }
    momStable.push(runDir !== 'FLAT' && runLen >= persistSec ? runDir : 'FLAT')
  }
  return { trend, momentum, momStable, rsiArr, atrArr, closeArr: closes1s }
}

/** Canlı giriş kuralı — aynı 3 koşul (trend + momentum + RSI) + süreklilik */
function entrySide(series: Series, i: number): Side | null {
  const tr = series.trend[i] ?? 'FLAT'
  const mo = series.momStable?.[i] ?? series.momentum[i] ?? 'FLAT'
  const r = series.rsiArr[i] ?? 50
  if (tr === 'BULL' && mo === 'UP' && r < 72) return 'LONG'
  if (tr === 'BEAR' && mo === 'DOWN' && r > 28) return 'SHORT'
  return null
}

/** Girişte RSI aşırılık güvenlik filtresi (canlıdaki gibi) */
function rsiBlocked(side: Side, r: number): boolean {
  return side === 'LONG' ? r > 78 : r < 22
}

export interface SimConfig {
  startBalance: number
  allocationPct: number
  leverage: number
  takerFeePct: number
  spreadPct: number          // temsili yarı-yön spread maliyeti (motorun canlı ölçümünden)
  minNotional: number
  /** ücret-farkındalıklı TP tabanı (canlıdaki feeAwareTp ile aynı formül) */
  feeAwareTpPct: number
  /** Aşama 2: maker ekonomisi simülasyonu (null = kapalı) */
  maker?: { makerFeePct: number; makerWaitSec: number } | null
  /** Aşama 1: uyarlanabilir TP/SL karşılaştırması (null = kapalı) */
  adaptive?: { atrTpMult: number; atrSlRatio: number } | null
}

/**
 * Tek kombinasyonu verilen mum aralığında oynat.
 * barSec: mum uzunluğu (60 = 1m mod, 1 = 1s mod) — süre hesabı buna göre.
 */
function simulate(
  candles: Candle[],
  series: Series,
  params: BacktestParams,
  cfg: SimConfig,
  fromIdx: number,
  toIdx: number,
  barSec = 60,
  collect?: { trades: BacktestTradeView[]; equity: number[] },
): BacktestMetrics {
  const { tpPct, slPct, maxHoldSec } = params
  const dir = (s: Side) => (s === 'LONG' ? 1 : -1)
  const halfSpread = cfg.spreadPct / 2 / 100   // yüzde → oran, yön başına yarı spread
  const maker = cfg.maker ?? null
  const waitBars = maker ? Math.max(1, Math.round(maker.makerWaitSec / barSec)) : 0

  let balance = cfg.startBalance
  let peak = balance, maxDd = 0
  let wins = 0, trades = 0
  let sumNet = 0, sumHold = 0
  let grossWin = 0, grossLoss = 0

  let i = fromIdx + WARMUP
  while (i < toIdx) {
    const side = entrySide(series, i)
    if (!side || rsiBlocked(side, series.rsiArr[i] ?? 50)) { i++; continue }

    // ---- Aşama 1: uyarlanabilir TP/SL (ATR'den, işlem başına) ----
    let effTp = tpPct, effSl = slPct
    if (cfg.adaptive) {
      const atrPct = (series.atrArr[i] ?? 0) / (candles[i]?.c || 1) * 100
      effTp = Math.min(Math.max(atrPct * cfg.adaptive.atrTpMult, cfg.feeAwareTpPct), 5)
      effSl = Math.min(effTp * cfg.adaptive.atrSlRatio, 10)
    }

    // Pozisyon boyutu — canlı formül: bakiye × tahsis × kaldıraç
    const margin = balance * (cfg.allocationPct / 100)
    let notional = margin * cfg.leverage
    if (notional < cfg.minNotional) notional = Math.min(cfg.minNotional, balance) // son çare: en küçük emir
    if (notional < cfg.minNotional) break // bakiye bitti → oyun bitti

    // ---- Giriş ----
    const rawEntry = candles[i]?.c ?? 0
    if (rawEntry <= 0) { i++; continue }

    let entryPrice: number
    let entryFeePct: number
    let entryIdx = i

    if (maker) {
      // post-only limit: LONG bid'e (kapanışın yarı-spread altına) konur.
      // Dolum kuralı (kötümser): istediğimiz yönde İSTENEN tarafa fiyat
      // gelmeli — alışta low ≤ limit (birisi bize sattı), satışta high ≥ limit.
      const limit = rawEntry * (1 - dir(side) * halfSpread)
      let filled = false
      for (let k = i; k <= Math.min(i + waitBars, toIdx - 1) && !filled; k++) {
        const c = candles[k]
        if (!c) break
        if (side === 'LONG' ? c.l <= limit : c.h >= limit) { filled = true; entryIdx = k }
      }
      if (!filled) {
        // sinyal KAÇTI — maker'ın dürüst bedeli; bir sonraki aday bara geç
        i += 1 + COOLDOWN_BARS
        continue
      }
      entryPrice = limit
      entryFeePct = maker.makerFeePct
    } else {
      entryPrice = rawEntry * (1 + dir(side) * halfSpread)   // taker: karşı taraftan
      entryFeePct = cfg.takerFeePct
    }

    const qty = notional / entryPrice
    const entryFee = notional * (entryFeePct / 100)

    // ---- Çıkış taraması — giriş mumundan ileriye ----
    const tpTarget = entryPrice * (1 + dir(side) * effTp / 100)
    const slTarget = entryPrice * (1 - dir(side) * effSl / 100)
    let exitPrice = entryPrice, exitIdx = entryIdx
    let reason: ExitReason = 'TIMEOUT'
    let closed = false

    for (let j = entryIdx + 1; j < toIdx; j++) {
      const c = candles[j]
      if (!c) break
      const heldSec = (j - entryIdx) * barSec

      // 1) süre tavanı
      if (heldSec >= maxHoldSec) { exitPrice = c.c; exitIdx = j; reason = 'TIMEOUT'; closed = true; break }
      // 2) KÖTÜMSER KURAL: aynı mumda TP+SL birlikteyse SL önce
      const hitTP = side === 'LONG' ? c.h >= tpTarget : c.l <= tpTarget
      const hitSL = side === 'LONG' ? c.l <= slTarget : c.h >= slTarget
      if (hitSL) { exitPrice = slTarget; exitIdx = j; reason = 'STOP_LOSS'; closed = true; break }
      if (hitTP) { exitPrice = tpTarget; exitIdx = j; reason = 'TAKE_PROFIT'; closed = true; break }
      // 3) sinyal ters dönüş + zarardaysa (canlıdaki kuralın karşılığı, 10sn eşik atlanır)
      if (j > entryIdx + 1) {
        const tr = series.trend[j] ?? 'FLAT'
        const against = side === 'LONG' ? tr === 'BEAR' : tr === 'BULL'
        const cur = (c.c - entryPrice) * dir(side)
        if (against && cur < 0) { exitPrice = c.c; exitIdx = j; reason = 'SIGNAL_FLIP'; closed = true; break }
      }
      // 4) pencere sonu — kapanmadan ulaşıldıysa son mumdan kapat
      if (j === toIdx - 1) { exitPrice = c.c; exitIdx = j; reason = 'TIMEOUT'; closed = true; break }
    }
    if (!closed) { exitPrice = entryPrice; exitIdx = entryIdx; reason = 'TIMEOUT' }

    // ---- Çıkış ekonomisi ----
    // maker girişli TP çıkışı: limit KENDİ fiyatından dolar (spread yok, maker ücreti).
    // diğer tüm çıkışlar: piyasa emri → yarı spread + taker ücreti (canlıdaki gibi).
    const makerTp = !!maker && reason === 'TAKE_PROFIT'
    const exitAdj = makerTp ? exitPrice : exitPrice * (1 - dir(side) * halfSpread)
    const exitFeePct = makerTp ? maker!.makerFeePct : cfg.takerFeePct
    const gross = (exitAdj - entryPrice) * qty * dir(side)
    const exitFee = qty * exitAdj * (exitFeePct / 100)
    const net = gross - entryFee - exitFee
    balance += net

    trades++
    sumNet += net
    sumHold += (exitIdx - entryIdx) * barSec
    if (net >= 0) { wins++; grossWin += net } else { grossLoss += Math.abs(net) }
    peak = Math.max(peak, balance)
    maxDd = Math.max(maxDd, peak > 0 ? (peak - balance) / peak * 100 : 0)

    if (collect) {
      if (collect.trades.length < 30) {
        collect.trades.push({
          side, entryIdx: entryIdx, exitIdx: exitIdx, holdSec: (exitIdx - entryIdx) * barSec,
          netPnl: +net.toFixed(3),
          movePct: +(((exitAdj / entryPrice) - 1) * 100 * dir(side)).toFixed(3),
          reason,
        })
      }
      collect.equity.push(+balance.toFixed(2))
    }

    i = exitIdx + 1 + COOLDOWN_BARS // çıkış + bekleme → sonraki aday mum
  }

  return {
    trades, wins,
    winRate: trades > 0 ? (wins / trades) * 100 : 0,
    netPnl: sumNet,
    finalBalance: balance,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDdPct: maxDd,
    avgHoldSec: trades > 0 ? sumHold / trades : 0,
    avgNet: trades > 0 ? sumNet / trades : 0,
  }
}

/**
 * TAM OPTİMİZASYON AKIŞI:
 *   1) indikatör serilerini bir kez üret (1s modda 1s hizalı da)
 *   2) eğitim penceresinde 280 kombinasyon oynat
 *   3) ısı haritasını (TP×SL, hücre başına en iyi süre) doldur
 *   4) şampiyonu kurallarla seç (min işlem, düşüş, kâr faktörü)
 *   5) şampiyonu doğrulama penceresinde sına → öneri ver
 *   6) Aşama 1: canlı uyarlanabilir ayarların aynı penceredeki sonucu
 */
export function runOptimization(
  symbol: string,
  candles: Candle[],
  cfg: SimConfig,
  currentParams: BacktestParams,
  candles1s?: Candle[],
): BacktestReport {
  const t0 = performance.now()
  const n = candles.length
  const split = Math.floor(n * TRAIN_RATIO)
  const series1m = buildSeries(candles)

  // ---- Aşama 3c: mod seçimi — yeterli 1sn veri varsa 1s modu ----
  const use1s = !!candles1s && candles1s.length >= MIN_1S_CANDLES
  // 1s serisi 1m geçmişinin hangi dakikasından başlıyorsa oradan hizala
  let simCandles = candles
  let simSeries = series1m
  let barSec = 60
  let fromIdx = 0
  if (use1s && candles1s) {
    const c1s = candles1s!
    simCandles = c1s
    simSeries = buildSeries1s(c1s, candles, series1m)
    barSec = 1
    // 1s dizisi 1m serisinin WARMUP'ından sonraki dakikadan başlamalı
    const firstTs = c1s[0].t
    let mi = 0
    while (mi < candles.length && candles[mi].t < firstTs) mi++
    fromIdx = Math.max(0, mi - WARMUP)
  }

  const combos: { params: BacktestParams; m: BacktestMetrics }[] = []
  const heat = new Map<string, HeatmapCell>()

  for (const tp of GRID_TP) {
    // ücret farkındalığı: TP başabaşın altına inemez (canlı kuralın aynısı)
    if (tp < cfg.feeAwareTpPct) continue
    for (const sl of GRID_SL) {
      if (sl <= tp) continue // SL, TP'den küçük/eşit olamaz (canlı kuralı)
      let bestCell: HeatmapCell | null = null
      for (const hold of GRID_HOLD) {
        const params = { tpPct: tp, slPct: sl, maxHoldSec: hold }
        const m = simulate(simCandles, simSeries, params, cfg, fromIdx, split, barSec)
        combos.push({ params, m })
        if (!bestCell || m.netPnl > bestCell.netPnl) {
          bestCell = { tp, sl, bestHoldSec: hold, netPnl: m.netPnl, trades: m.trades }
        }
      }
      if (bestCell) heat.set(`${tp}|${sl}`, bestCell)
    }
  }

  // Şampiyon seçimi — kurallı filtre, sonra net kâr
  const qualified = combos.filter(c =>
    c.m.trades >= MIN_TRADES &&
    c.m.maxDdPct <= MAX_DD_LIMIT &&
    (c.m.profitFactor >= PF_TRAIN_MIN || c.m.profitFactor === Infinity),
  )
  const pool = qualified.length > 0 ? qualified : combos.filter(c => c.m.trades >= Math.min(20, MIN_TRADES / 2))
  let champion: { params: BacktestParams; m: BacktestMetrics } | null = null
  for (const c of pool) {
    if (!champion || c.m.netPnl > champion.m.netPnl) champion = c
  }

  // Doğrulama — şampiyon hiç görülmemiş son %30'da
  let championValid: BacktestMetrics | null = null
  let recommended = false
  let verdict = ''

  if (champion) {
    championValid = simulate(simCandles, simSeries, champion.params, cfg, split, n, barSec)
    const pfOk = championValid.profitFactor === Infinity || championValid.profitFactor >= PF_VALID_MIN
    recommended = championValid.netPnl > 0 && pfOk && championValid.trades >= 10

    if (recommended) {
      verdict = `Doğrulandı: TP %${champion.params.tpPct} / SL %${champion.params.slPct} / süre ${champion.params.maxHoldSec}sn ` +
        `eğitimde +${champion.m.netPnl.toFixed(1)} USDT, görülmemiş %30'luk dilimde +${championValid.netPnl.toFixed(1)} USDT ` +
        `(PF ${championValid.profitFactor === Infinity ? '∞' : championValid.profitFactor.toFixed(2)}). Ayar uygulanabilir.`
    } else {
      verdict = `DİKKAT: en iyi eğitim ayarı (TP %${champion.params.tpPct} / SL %${champion.params.slPct} / ${champion.params.maxHoldSec}sn) ` +
        `görülmemiş dilimde ${championValid.netPnl >= 0 ? '+' : ''}${championValid.netPnl.toFixed(1)} USDT yaptı — doğrulamayı geçmedi. ` +
        `Ayarı olduğu gibi bırakmak daha güvenli.`
    }
  } else {
    verdict = 'Hiçbir kombinasyon minimum işlem sayısına ulaşamadı — bu pencerede strateji sinyal üretmedi (sessiz piyasa).'
  }

  // ---- Aşama 1: canlı uyarlanabilir ayarların aynı penceredeki sonucu ----
  // (aynı TP/SL teorik değil: işlem başına ATR'den hesaplanan gerçek hedefler)
  let adaptive: (BacktestMetrics & { tpPctAvg: number; slPctAvg: number }) | null = null
  if (cfg.adaptive) {
    const liveLikeParams: BacktestParams = {
      tpPct: cfg.feeAwareTpPct, // taban — adaptive her işlemde ATR'den üstüne çıkar
      slPct: cfg.feeAwareTpPct * cfg.adaptive.atrSlRatio,
      maxHoldSec: currentParams.maxHoldSec,
    }
    const m = simulate(simCandles, simSeries, liveLikeParams, cfg, fromIdx, n, barSec)
    // ortalama etkili TP/SL (bilgi amaçlı — ATR ortalamasından)
    const atrMean = simSeries.atrArr.slice(fromIdx).reduce((a, b) => a + b, 0) / Math.max(1, n - fromIdx)
    const closeMean = simSeries.closeArr[fromIdx] || 1
    const tpAvg = Math.min(Math.max((atrMean / closeMean) * 100 * cfg.adaptive.atrTpMult, cfg.feeAwareTpPct), 5)
    adaptive = { ...m, tpPctAvg: +tpAvg.toFixed(3), slPctAvg: +(tpAvg * cfg.adaptive.atrSlRatio).toFixed(3) }
    verdict += ` Uyarlanabilir mod (canlı çarpanlar): ${m.trades} işlem, net ${m.netPnl >= 0 ? '+' : ''}${m.netPnl.toFixed(1)} USDT.`
  }

  if (use1s) {
    verdict += ` 1sn çözünürlüklü dürüst mod (canlı girişle aynı momentum); order-flow filtresi tarihsiz defter verisi olmadığından simüle edilmez — canlıda yalnız işlem sayısını azaltır.`
  }

  // Şampiyonun işlem/eğri detayı (panelde gösterim için yeniden oynat)
  const collect = { trades: [] as BacktestTradeView[], equity: [] as number[] }
  if (champion) simulate(simCandles, simSeries, champion.params, cfg, fromIdx, split, barSec, collect)
  const equityCurve = collect.equity.length > 200
    ? collect.equity.filter((_, k) => k % Math.ceil(collect.equity.length / 200) === 0)
    : collect.equity

  return {
    symbol,
    candlesUsed: n,
    trainCandles: split,
    validCandles: n - split,
    spreadPct: cfg.spreadPct,
    combosTested: combos.length,
    durationMs: Math.round(performance.now() - t0),
    mode: use1s ? '1s' : '1m',
    candles1sUsed: use1s ? (candles1s?.length ?? 0) : 0,
    makerOn: !!cfg.maker,
    adaptive,
    champion: champion ? { ...champion.m, params: champion.params } : null,
    championValid,
    recommended,
    verdict,
    heatmap: [...heat.values()],
    equityCurve,
    tradesSample: collect.trades,
    currentParams,
  }
}
