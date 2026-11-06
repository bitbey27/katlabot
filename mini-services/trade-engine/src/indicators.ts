// ============================================================
// Teknik indikatörler — EMA, RSI, ATR
// Yüksek frekanslı hesaplama için hafif ve state'li (incremental)
// ============================================================

import type { Candle } from './types'

/** Kapanış dizisinden EMA hesaplar (dizi boşsa null) */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

/** Son N kapanışı verir */
export function closes(candles: Candle[], n: number): number[] {
  return candles.slice(-n).map(c => c.c)
}

/** Wilder RSI */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d; else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) { avgGain = (avgGain * (period - 1) + d) / period }
    else { avgLoss = (avgLoss * (period - 1) - d) / period }
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** ATR — volatilite bazlı tampon için */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)))
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period
}

/** Sayıyı adım (stepSize) katına yuvarlar */
export function roundStep(value: number, step: number): number {
  if (step <= 0) return value
  return Math.floor(value / step) * step
}
