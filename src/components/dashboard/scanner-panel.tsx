'use client'

// Çoklu Coin Tarayıcı — 9 coinin canlı radarı.
// Motor TEK WebSocket soketinde tüm coinleri izler; burada her coinin
// trend/momentum/RSI/skor durumu ve hazır sinyali gösterilir.
// Satıra tıklayınca grafik o coin'e odaklanır.

import { Radar } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotStore } from '@/lib/bot-store'
import { sendControl } from '@/lib/engine-socket'
import { fmtPrice, fmtPct, priceDigits } from '@/lib/format'
import type { WatchItem } from '@/lib/engine-types'

/** Kapı koşulunun radar satırındaki kısa adı — "neden bekliyor" etiketi */
const BLOCK_SHORT: Record<string, string> = {
  DATA: 'veri',
  TREND: 'trend yatay',
  MOMENTUM: 'momentum',
  RSI: 'RSI',
  FLOW: 'akış',
  MTF5M: '5dk',
  HTF15M: '15dk',
  SPIKE: 'sıçrama',
  REGIME: 'rejim',
}

export function ScannerPanel() {
  const snap = useBotStore((s) => s.snapshot)
  const multi = snap?.scanMode === 'MULTI'
  const watch = snap?.scanner.watch ?? []
  const tickRate = snap?.scanner.tickRate ?? 0
  const posSymbol = snap?.position?.symbol ?? null
  const displaySymbol = snap?.displaySymbol ?? snap?.settings.symbol ?? ''
  const regime = snap?.scanner.regime

  const focusSymbol = (symbol: string) => {
    if (symbol === displaySymbol) return
    sendControl({ action: 'updateSettings', settings: { symbol } })
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-300">
          <Radar className="h-4 w-4 text-emerald-400" aria-hidden />
          Çoklu Coin Tarayıcı
          <Badge
            variant="outline"
            className={`ml-auto border px-1.5 py-0 text-[10px] font-bold ${multi
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-zinc-600 bg-zinc-800/60 text-zinc-400'}`}
          >
            {multi ? `${watch.length} COİN AKTİF` : 'TEK COİN'}
          </Badge>
        </CardTitle>
        {multi && (
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Tüm coinler tek WebSocket soketinde izleniyor
            {tickRate > 0 && (
              <> · <span className="font-mono tabular-nums text-zinc-400">~{tickRate} mesaj/sn</span></>
            )}
            · sinyal üretenlerin en güçlüsüne girilir.
          </p>
        )}
        {regime && (
          <div className={`mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed ${
            !regime.filterOn
              ? 'border-zinc-800 bg-zinc-900/40 text-zinc-500'
              : regime.eligible.length > 0
                ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300/90'
                : 'border-amber-500/25 bg-amber-500/5 text-amber-300/90'
          }`}>
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
              !regime.filterOn ? 'bg-zinc-600' : regime.eligible.length > 0 ? 'bg-emerald-400' : 'bg-amber-400'
            }`} aria-hidden />
            <span>{regime.status}</span>
          </div>
        )}
      </CardHeader>
      <CardContent className="pb-2">
        {!multi ? (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center">
            <p className="text-sm font-medium text-zinc-400">Çoklu tarama kapalı</p>
            <p className="max-w-[260px] text-xs text-zinc-600">
              Ayarlar → Tarama Modu&apos;nu açın; bot 9 coini aynı anda tarayıp en iyi fırsata girecek.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900 text-[10px] uppercase tracking-wide text-zinc-600">
                  <th className="px-2 py-1.5 font-medium">Coin</th>
                  <th className="px-2 py-1.5 text-right font-medium">Fiyat</th>
                  <th className="px-2 py-1.5 text-right font-medium">24s</th>
                  <th className="px-2 py-1.5 text-center font-medium">Trend</th>
                  <th className="px-2 py-1.5 text-right font-medium">RSI</th>
                  <th className="px-2 py-1.5 text-right font-medium">Rejim</th>
                  <th className="px-2 py-1.5 text-right font-medium">Skor</th>
                  <th className="px-2 py-1.5 text-center font-medium">Sinyal</th>
                </tr>
              </thead>
              <tbody>
                {watch.map((w) => (
                  <WatchRow
                    key={w.symbol}
                    w={w}
                    active={posSymbol === w.symbol}
                    focused={displaySymbol === w.symbol}
                    onFocus={focusSymbol}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {multi && (
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
            Satıra tıkla → grafik o coine odaklanır. Skor = trend gücü + momentum tazeliği + RSI payı − spread cezası.
            <span className="text-zinc-500"> Rejim</span> = son 60 dkda birim işlem maliyeti başına sunulan hareket
            (yeşil nokta = o coinden işlem yapmaya değer). İşlem açılınca bot otomatik olarak pozisyonun coinine geçer.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function WatchRow({ w, active, focused, onFocus }: {
  w: WatchItem
  active: boolean
  focused: boolean
  onFocus: (symbol: string) => void
}) {
  const d = priceDigits(w.price || 1)
  const base = w.symbol.replace('USDT', '')
  const trendCls = w.trend1m === 'BULL' ? 'text-emerald-400' : w.trend1m === 'BEAR' ? 'text-rose-400' : 'text-zinc-500'
  const trendTxt = w.trend1m === 'BULL' ? '↑' : w.trend1m === 'BEAR' ? '↓' : '—'
  const momTxt = w.momentum1s === 'UP' ? '↗' : w.momentum1s === 'DOWN' ? '↘' : '·'
  const momCls = w.momentum1s === 'UP' ? 'text-emerald-400/70' : w.momentum1s === 'DOWN' ? 'text-rose-400/70' : 'text-zinc-600'
  const rsi = w.rsi1m
  const rsiCls = rsi > 70 ? 'text-rose-400' : rsi < 30 ? 'text-emerald-400' : 'text-zinc-300'
  const scorePct = Math.min(100, w.score * 40) // 2.5 skor ≈ tam bar

  return (
    <tr
      onClick={() => onFocus(w.symbol)}
      className={`cursor-pointer border-b border-zinc-800/60 last:border-0 transition-colors ${active
        ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/40'
        : focused
          ? 'bg-zinc-800/40'
          : 'hover:bg-zinc-800/25'}`}
    >
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className={`font-mono text-xs font-bold ${active ? 'text-emerald-400' : focused ? 'text-zinc-200' : 'text-zinc-300'}`}>
            {base}
          </span>
          {active && (
            <span className="rounded bg-emerald-500/20 px-1 py-px text-[9px] font-bold text-emerald-400">İŞLEMDE</span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 text-right font-mono text-[11px] tabular-nums text-zinc-300">
        {w.price > 0 ? fmtPrice(w.price, d) : '—'}
      </td>
      <td className={`px-2 py-1.5 text-right font-mono text-[11px] tabular-nums ${w.change24hPct >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
        {fmtPct(w.change24hPct, 1)}
      </td>
      <td className="px-2 py-1.5 text-center">
        <span className={`inline-flex items-center gap-0.5 font-mono text-xs font-bold ${trendCls}`} title="1dk EMA trend + 1sn momentum">
          {trendTxt}<span className={`text-[10px] font-medium ${momCls}`}>{momTxt}</span>
        </span>
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <div className="h-1 w-10 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
            <div
              className={`h-full ${rsi > 70 ? 'bg-rose-500' : rsi < 30 ? 'bg-emerald-500' : 'bg-amber-400'}`}
              style={{ width: `${Math.min(100, Math.max(0, rsi))}%` }}
            />
          </div>
          <span className={`font-mono text-[11px] tabular-nums ${rsiCls}`}>{rsi.toFixed(0)}</span>
        </div>
      </td>
      <td className="px-2 py-1.5 text-right" title="Rejim skoru: son 60 dk ort. 1dk aralığı / (2×taker + spread). 1.0 = hareket tam maliyeti karşılıyor">
        <div className="flex items-center justify-end gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              w.regimeEligible ? 'bg-emerald-400' : w.regimeScore > 0 ? 'bg-zinc-600' : 'bg-zinc-800'
            }`}
            aria-hidden
          />
          <span className={`font-mono text-[11px] tabular-nums ${
            w.regimeEligible ? 'font-bold text-emerald-400' : 'text-zinc-400'
          }`}>
            {w.regimeScore > 0 ? w.regimeScore.toFixed(2) : '—'}
          </span>
          {w.regimeRank > 0 && (
            <span className="w-4 text-[9px] tabular-nums text-zinc-600">#{w.regimeRank}</span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <div className="h-1 w-10 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
            <div className="h-full bg-sky-400/80" style={{ width: `${scorePct}%` }} />
          </div>
          <span className="w-8 font-mono text-[11px] tabular-nums text-zinc-300">
            {w.score > 0 ? w.score.toFixed(2) : '—'}
          </span>
        </div>
      </td>
      <td className="px-2 py-1.5 text-center" title={w.gate?.blockLabel ?? ''}>
        {!w.readyData ? (
          <span className="text-[10px] text-zinc-600">veri…</span>
        ) : w.ready && w.readySide ? (
          <span className={`rounded px-1.5 py-px text-[9px] font-bold ${w.readySide === 'LONG'
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-rose-500/15 text-rose-400'}`}>
            {w.readySide}
          </span>
        ) : w.gate && w.gate.blockKey === null && w.gate.side ? (
          <span className={`rounded px-1.5 py-px text-[9px] font-bold ${w.gate.side === 'LONG'
            ? 'border border-emerald-500/40 text-emerald-400/80'
            : 'border border-rose-500/40 text-rose-400/80'}`}>
            {w.gate.side}·sırada
          </span>
        ) : w.gate?.blockKey ? (
          <span className="rounded bg-zinc-800/70 px-1.5 py-px text-[9px] font-medium text-zinc-400" title={w.gate.blockLabel}>
            {BLOCK_SHORT[w.gate.blockKey] ?? 'bekliyor'}
          </span>
        ) : (
          <span className="text-[10px] text-zinc-600">—</span>
        )}
      </td>
    </tr>
  )
}
