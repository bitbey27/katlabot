'use client'

// İstatistik kartları — bakiye, büyüme, net K/Z, kazanma oranı, işlem hızı, ücretler

import { Wallet, TrendingUp, Percent, Target, Zap, Receipt } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useBotStore, useLivePosition } from '@/lib/bot-store'
import { fmtUsd, fmtSignedUsd, fmtPct, fmtDur, pnlClass } from '@/lib/format'

export function StatCards() {
  const snap = useBotStore((s) => s.snapshot)
  const position = useLivePosition()
  const acc = snap?.account
  const stats = snap?.stats

  const equity = acc ? (position ? acc.balance + position.netPnl : acc.balance) : 0

  // Kâr faktörü protokolü: motor Infinity'yi JSON üzerinden null gönderir (kayıp yok = ∞).
  // DİKKAT: JS'te isFinite(null) === true (null→0 zorlaması) — eski kod bu yüzden patlıyordu.
  const pfRaw = stats ? stats.profitFactor : undefined // undefined = veri yok, null = ∞
  const pfNum: number | undefined =
    pfRaw === undefined ? undefined : pfRaw != null && isFinite(pfRaw) ? pfRaw : pfRaw === null && (stats?.wins ?? 0) > 0 ? Infinity : 0

  const cards = [
    {
      label: 'Bakiye (Özkaynak)',
      value: `${fmtUsd(equity)}`,
      sub: acc ? `Başlangıç ${fmtUsd(acc.startBalance)} · ${fmtPct(acc.growthPct)} büyüme` : '—',
      icon: Wallet,
      tone: 'text-emerald-400',
      valueClass: (acc?.growthPct ?? 0) >= 0 ? 'text-zinc-100' : 'text-rose-400',
    },
    {
      label: 'Toplam Net K/Z',
      value: `${fmtSignedUsd(stats?.netPnl ?? 0)}`,
      sub: stats ? `Brüt ${fmtSignedUsd(stats.grossPnl)} − Ücret ${fmtUsd(stats.totalFees)}` : '—',
      icon: TrendingUp,
      tone: 'text-emerald-400',
      valueClass: pnlClass(stats?.netPnl ?? 0),
    },
    {
      label: 'Kazanma Oranı',
      value: stats ? `${stats.winRate.toFixed(1)}%` : '—',
      sub: stats ? `${stats.wins} kâr / ${stats.losses} zarar` : '—',
      icon: Percent,
      tone: 'text-amber-400',
      valueClass: (stats?.winRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-zinc-100',
    },
    {
      label: 'İşlem Sayısı',
      value: `${stats?.totalTrades ?? 0}`,
      sub: stats ? `${stats.tradesPerHour.toFixed(1)} işlem/saat · ort. ${fmtDur(stats.avgHoldSec)}` : '—',
      icon: Zap,
      tone: 'text-amber-400',
      valueClass: 'text-zinc-100',
    },
    {
      label: 'Kâr Faktörü',
      value: pfNum === undefined ? '—' : isFinite(pfNum) ? pfNum.toFixed(2) : pfNum > 0 ? '∞' : '—',
      sub: stats ? `En iyi ${fmtSignedUsd(stats.bestTrade)} · En kötü ${fmtSignedUsd(stats.worstTrade)}` : '—',
      icon: Target,
      tone: 'text-emerald-400',
      valueClass: (pfNum ?? 0) >= 1 ? 'text-emerald-400' : 'text-rose-400',
    },
    {
      label: 'Ücret Bedeli',
      value: `${fmtUsd(stats?.totalFees ?? 0)}`,
      sub: snap ? `Taker %${snap.settings.takerFeePct.toFixed(4)} · başabaş %${snap.feeBreakevenPct.toFixed(3)}` : '—',
      icon: Receipt,
      tone: 'text-rose-400',
      valueClass: 'text-amber-400',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {cards.map((c) => (
        <Card key={c.label} className="border-zinc-800 bg-zinc-900/60 shadow-none">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-500">
              <c.icon className={`h-3.5 w-3.5 ${c.tone}`} aria-hidden />
              {c.label}
            </div>
            <div className={`mt-1.5 truncate font-mono text-lg font-bold tabular-nums sm:text-xl ${c.valueClass}`}>
              {c.value}
            </div>
            <div className="mt-1 truncate text-[11px] text-zinc-500">{c.sub}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
