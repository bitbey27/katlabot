'use client'

// Saniyelik momentum şeridi — 1s mumlarından mini çubuk grafik
// Kullanıcının "her saniye izleme" isteğinin görsel kanıtı

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle } from '@/lib/engine-types'
import { priceDigits } from '@/lib/format'

interface Props {
  candles: Candle[]
  height?: number
}

export function MicroChart({ candles, height = 96 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setWidth(Math.max(320, Math.floor(entries[0]?.contentRect.width ?? 900)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view = useMemo(() => {
    if (candles.length === 0) return null
    const n = candles.length
    const padR = 12
    const plotW = width - padR
    const cw = plotW / n
    const bodyW = Math.max(1, Math.min(8, cw * 0.7))
    // y eksenini son 60 mumun aralığına göre normalize et (mikro ölçek)
    const ref = candles.slice(-60)
    const lo = Math.min(...ref.map(c => c.l))
    const hi = Math.max(...ref.map(c => c.h))
    const range = hi - lo || 1
    const y = (p: number) => 6 + (height - 12) * (1 - (p - lo) / range)
    const x = (i: number) => i * cw + cw / 2
    // son 1s kapanış çizgisi
    let path = ''
    candles.forEach((c, i) => {
      path += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c.c).toFixed(1)} `
    })
    return { y, x, bodyW, path, n }
  }, [candles, width, height])

  if (!view) {
    return (
      <div ref={wrapRef} className="flex items-center justify-center h-24 text-xs text-zinc-500">
        Saniyelik akış bekleniyor…
      </div>
    )
  }

  const { y, x, bodyW, path } = view
  const last = candles[candles.length - 1]
  const first = candles[0]
  const rising = last.c >= first.o

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={height} role="img" aria-label="Saniyelik fiyat akışı">
        {candles.map((c, i) => {
          const isUp = c.c >= c.o
          const yO = y(c.o), yC = y(c.c)
          return (
            <g key={c.t}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={isUp ? '#10b981' : '#f43f5e'} strokeWidth={0.75} opacity={0.8} />
              <rect x={x(i) - bodyW / 2} y={Math.min(yO, yC)} width={bodyW} height={Math.max(0.8, Math.abs(yC - yO))} className={isUp ? 'fill-emerald-500/80' : 'fill-rose-500/80'} rx={0.5} />
            </g>
          )
        })}
        <path d={path.trim()} fill="none" stroke={rising ? '#fbbf24' : '#fb923c'} strokeWidth={1.2} opacity={0.7} />
      </svg>
      <div className="flex items-center justify-between px-2 text-[11px] text-zinc-500">
        <span>1 saniyelik mumlar — son {candles.length} sn</span>
        <span className="tabular-nums">{rising ? '↗' : '↘'} mikro momentum</span>
      </div>
    </div>
  )
}
