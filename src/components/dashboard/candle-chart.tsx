'use client'

// ============================================================
// Canlı mum grafiği — saf SVG, TradingView tarzı koyu tema
//  - 1m mumlar + EMA9/EMA21 bindirmeleri
//  - açık pozisyon için giriş/TP/SL çizgileri
//  - canlı fiyat çizgisi + sağ eksen etiketi
//  - alt bantta hacim
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle, OpenPositionView } from '@/lib/engine-types'
import { fmtPrice, priceDigits } from '@/lib/format'

function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  if (values.length < period) return values.map(() => null)
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue }
    if (i === period - 1) { out.push(e); continue }
    e = values[i] * k + e * (1 - k)
    out.push(e)
  }
  return out
}

interface Props {
  candles: Candle[]
  livePrice: number
  position: OpenPositionView | null
  height?: number
}

export function CandleChart({ candles, livePrice, position, height = 400 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 900
      setWidth(Math.max(360, Math.floor(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const d = useMemo(() => priceDigits(livePrice || candles.at(-1)?.c || 1), [livePrice, candles])

  const geom = useMemo(() => {
    if (candles.length === 0) return null
    const padL = 10, padR = 74, padT = 14, padB = 22, volH = 46, gap = 8
    const plotW = Math.max(50, width - padL - padR)
    const plotH = Math.max(80, height - padT - padB - volH - gap)

    // fiyat aralığı: görünen mumlar + pozisyon çizgileri + canlı fiyat
    let lo = Infinity, hi = -Infinity
    for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h) }
    const extra: number[] = [livePrice]
    if (position) extra.push(position.entryPrice, position.takeProfitPrice, position.stopLossPrice)
    for (const p of extra) { if (isFinite(p) && p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p) } }
    const range = hi - lo || hi * 0.001 || 1
    lo -= range * 0.08
    hi += range * 0.08

    const n = candles.length
    const cw = plotW / n // yuva genişliği
    const bodyW = Math.max(1.5, Math.min(11, cw * 0.66))

    const y = (p: number) => padT + plotH - ((p - lo) / (hi - lo)) * plotH
    const x = (i: number) => padL + i * cw + cw / 2

    // hacim ölçeği
    const maxVol = Math.max(...candles.map(c => c.v), 1e-9)
    const volY = (v: number) => height - padB - (v / maxVol) * volH

    // EMA'lar
    const closes = candles.map(c => c.c)
    const ema9 = emaSeries(closes, 9)
    const ema21 = emaSeries(closes, 21)

    const linePath = (series: (number | null)[]) => {
      let p = ''
      let started = false
      series.forEach((v, i) => {
        if (v === null) return
        const cmd = started ? 'L' : 'M'
        p += `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)} `
        started = true
      })
      return p.trim()
    }

    // yatay ızgara çizgileri (5 seviye)
    const gridLevels: number[] = []
    for (let i = 0; i <= 4; i++) gridLevels.push(lo + ((hi - lo) * i) / 4)

    // zaman etiketleri (~6 adet)
    const timeTicks: Array<{ i: number; label: string }> = []
    const step = Math.max(1, Math.floor(n / 6))
    for (let i = n - 1; i >= 0; i -= step) {
      timeTicks.push({ i, label: new Date(candles[i].t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) })
    }

    return { padL, padR, padT, plotW, plotH, lo, hi, n, cw, bodyW, y, x, volY, ema9, ema21, linePath, gridLevels, timeTicks, volTop: height - padB - volH }
  }, [candles, width, height, livePrice, position])

  if (!geom) {
    return (
      <div ref={wrapRef} className="flex items-center justify-center h-[400px] text-zinc-500 text-sm">
        Grafik verisi bekleniyor…
      </div>
    )
  }

  const { y, x, cw, bodyW, volY, linePath, gridLevels, timeTicks, volTop } = geom
  const up = 'fill-emerald-500'
  const down = 'fill-rose-500'
  const lastC = candles[candles.length - 1]
  const priceUp = livePrice >= lastC.o
  const liveY = y(livePrice)

  const posLines = position ? (
    <g>
      {/* giriş */}
      <line x1={geom.padL} x2={width - geom.padR} y1={y(position.entryPrice)} y2={y(position.entryPrice)} stroke="#e4e4e7" strokeWidth={1} strokeDasharray="5 4" />
      <rect x={width - geom.padR + 2} y={y(position.entryPrice) - 8} width={70} height={16} rx={3} className="fill-zinc-700" />
      <text x={width - geom.padR + 6} y={y(position.entryPrice) + 4} className="fill-zinc-100" fontSize={10} fontFamily="monospace">G {fmtPrice(position.entryPrice, d)}</text>
      {/* TP */}
      <line x1={geom.padL} x2={width - geom.padR} y1={y(position.takeProfitPrice)} y2={y(position.takeProfitPrice)} stroke="#10b981" strokeWidth={1} strokeDasharray="2 3" />
      <rect x={width - geom.padR + 2} y={y(position.takeProfitPrice) - 8} width={70} height={16} rx={3} className="fill-emerald-900" />
      <text x={width - geom.padR + 6} y={y(position.takeProfitPrice) + 4} className="fill-emerald-300" fontSize={10} fontFamily="monospace">TP {fmtPrice(position.takeProfitPrice, d)}</text>
      {/* SL */}
      <line x1={geom.padL} x2={width - geom.padR} y1={y(position.stopLossPrice)} y2={y(position.stopLossPrice)} stroke="#f43f5e" strokeWidth={1} strokeDasharray="2 3" />
      <rect x={width - geom.padR + 2} y={y(position.stopLossPrice) - 8} width={70} height={16} rx={3} className="fill-rose-950" />
      <text x={width - geom.padR + 6} y={y(position.stopLossPrice) + 4} className="fill-rose-300" fontSize={10} fontFamily="monospace">SL {fmtPrice(position.stopLossPrice, d)}</text>
    </g>
  ) : null

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={height} role="img" aria-label="Canlı mum grafiği">
        {/* ızgara */}
        {gridLevels.map((p, i) => (
          <g key={i}>
            <line x1={geom.padL} x2={width - geom.padR} y1={y(p)} y2={y(p)} stroke="#27272a" strokeWidth={1} />
            <text x={width - geom.padR + 6} y={y(p) + 3.5} className="fill-zinc-500" fontSize={10} fontFamily="monospace">{fmtPrice(p, d)}</text>
          </g>
        ))}

        {/* hacim */}
        {candles.map((c, i) => (
          <rect
            key={`v${c.t}`}
            x={x(i) - bodyW / 2}
            y={volY(c.v)}
            width={bodyW}
            height={Math.max(1, height - 22 - volY(c.v))}
            className={c.c >= c.o ? 'fill-emerald-500/25' : 'fill-rose-500/25'}
          />
        ))}
        <line x1={geom.padL} x2={width - geom.padR} y1={volTop} y2={volTop} stroke="#27272a" strokeWidth={1} />

        {/* mumlar */}
        {candles.map((c, i) => {
          const isUp = c.c >= c.o
          const col = isUp ? up : down
          const yO = y(c.o), yC = y(c.c)
          const top = Math.min(yO, yC)
          const h = Math.max(1.2, Math.abs(yC - yO))
          return (
            <g key={c.t}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={isUp ? '#10b981' : '#f43f5e'} strokeWidth={1} />
              <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={h} className={col} rx={0.5} />
            </g>
          )
        })}

        {/* EMA bindirmeleri */}
        <path d={linePath(geom.ema9)} fill="none" stroke="#fbbf24" strokeWidth={1.4} opacity={0.9} />
        <path d={linePath(geom.ema21)} fill="none" stroke="#a78bfa" strokeWidth={1.4} opacity={0.75} />

        {/* pozisyon çizgileri */}
        {posLines}

        {/* canlı fiyat */}
        {livePrice > 0 && (
          <g>
            <line x1={geom.padL} x2={width - geom.padR} y1={liveY} y2={liveY} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" className="animate-pulse" />
            <rect x={width - geom.padR + 2} y={liveY - 9} width={70} height={18} rx={3} className={priceUp ? 'fill-emerald-500' : 'fill-rose-500'} />
            <text x={width - geom.padR + 6} y={liveY + 4} className="fill-zinc-950 font-bold" fontSize={11} fontFamily="monospace">{fmtPrice(livePrice, d)}</text>
          </g>
        )}

        {/* zaman ekseni */}
        {timeTicks.map((tt, i) => (
          <text key={i} x={x(tt.i)} y={height - 6} textAnchor="middle" className="fill-zinc-500" fontSize={10} fontFamily="monospace">{tt.label}</text>
        ))}
      </svg>
      {/* lejant */}
      <div className="flex items-center gap-4 px-2 pt-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-amber-400" />EMA 9</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-violet-400" />EMA 21</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />Yükseliş</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-rose-500" />Düşüş</span>
        <span className="ml-auto tabular-nums">{candles.length} mum · 1dk</span>
      </div>
    </div>
  )
}
