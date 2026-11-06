'use client'

// ============================================================
// İşlem geçmişi — TEK BAKIŞTA NET KÂR/ZARAR
//
// Tasarım ilkeleri:
//  1) Satırın kendisi sonucu haykırır: kârlı işlem yeşil zemin + sol
//     yeşil şerit + ✓ ikonu; zararlı kırmızı. Renk körlüğüne dayanıklı
//     (ikon + işaret de var).
//  2) NET USDT tek büyük sayıdır — hareket/brüt/ücret dökümü satır
//     tıklanınca açılan detay paneline taşındı (gürültü azaldı).
//  3) Başlıkta özet şerit: toplam işlem, ✓/✗ sayısı, toplam net.
//  4) Mobil uyum: her işlem kompakt kart; yana kaydırma yok.
// ============================================================

import { useState } from 'react'
import { History, Check, X, ChevronDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useBotStore } from '@/lib/bot-store'
import { fmtPrice, fmtSignedUsd, fmtUsd, fmtPct, fmtDur, fmtTimeSec, pnlClass, priceDigits, EXIT_REASON_TR } from '@/lib/format'
import type { Trade } from '@/lib/engine-types'

export function TradeLog() {
  const snap = useBotStore((s) => s.snapshot)
  const trades = snap?.trades ?? []
  const stats = snap?.stats
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm font-semibold text-zinc-300">
          <History className="h-4 w-4 text-zinc-500" aria-hidden />
          İşlem Geçmişi
          {/* özet şerit — "bugün toplam ne durumdayım" sorusuna tek bakış */}
          {stats && stats.totalTrades > 0 ? (
            <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium tabular-nums">
              <span className="text-zinc-500">{stats.totalTrades} işlem</span>
              <span className="text-zinc-700">·</span>
              <span className="text-emerald-400">✓ {stats.wins}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-rose-400">✗ {stats.losses}</span>
              <span className="text-zinc-700">·</span>
              <span className={`rounded px-1.5 py-0.5 font-bold ${pnlClass(stats.netPnl)} bg-zinc-800/80`}>
                TOPLAM NET {fmtSignedUsd(stats.netPnl)} USDT
              </span>
            </span>
          ) : (
            <Badge variant="outline" className="ml-auto border-zinc-700 bg-zinc-800/60 text-[11px] tabular-nums text-zinc-400">
              0 kayıt
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {/* sabit yükseklik — kayıt sayısı arttıkça panel UZAMAZ, içerik kayar */}
        <ScrollArea className="h-[420px] rounded-lg border border-zinc-800">
          {trades.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
              Henüz kapanan işlem yok — bot çalışırken burası dolacak
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/70">
              {trades.map((t) => (
                <TradeRow
                  key={t.id}
                  t={t}
                  open={openId === t.id}
                  onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

/** Tek işlem satırı — sonuç rengi + tıklanınca açılan ücret dökümü */
function TradeRow({ t, open, onToggle }: { t: Trade; open: boolean; onToggle: () => void }) {
  const win = t.netPnl >= 0
  const d = priceDigits(t.entryPrice)

  return (
    <div className={win ? 'bg-emerald-500/[0.055]' : 'bg-rose-500/[0.055]'}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-l-2 px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600 ${win ? 'border-l-emerald-500' : 'border-l-rose-500'}`}
      >
        {/* sonuç ikonu — renk körlüğüne dayanıklı işaret */}
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${win ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`} aria-label={win ? 'kârlı işlem' : 'zararlı işlem'}>
          {win ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
        </span>

        {/* zaman + coin + yön */}
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">{fmtTimeSec(t.exitTime)}</span>
        <span className="font-mono text-xs font-bold text-zinc-200">{t.symbol.replace('USDT', '')}</span>
        <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-bold ${t.side === 'LONG' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-rose-500/40 bg-rose-500/10 text-rose-400'}`}>
          {t.side}
        </Badge>

        {/* fiyat + süre (dar ekranda doğal sarar) */}
        <span className="font-mono text-[11px] tabular-nums text-zinc-400">
          {fmtPrice(t.entryPrice, d)} <span className="text-zinc-600">→</span> {fmtPrice(t.exitPrice, d)}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">{fmtDur(t.holdSec)}</span>

        {/* çıkış nedeni */}
        <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${t.reason === 'TAKE_PROFIT' || t.reason === 'TRAIL'
          ? 'border-emerald-500/40 text-emerald-400'
          : t.reason === 'STOP_LOSS'
            ? 'border-rose-500/40 text-rose-400'
            : t.reason === 'MOMENTUM'
              ? 'border-amber-500/40 text-amber-400'
              : 'border-zinc-600 text-zinc-400'}`}>
          {EXIT_REASON_TR[t.reason] ?? t.reason}
        </Badge>

        {/* NET — tek büyük sayı; mobilde kendi satırına sağa yaslanır */}
        <span className={`ml-auto flex items-baseline gap-2 font-bold tabular-nums ${win ? 'text-emerald-400' : 'text-rose-400'}`}>
          <span className="text-sm">
            NET {fmtSignedUsd(t.netPnl, 3)} <span className="text-[10px] font-normal opacity-70">USDT</span>
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${win ? 'bg-emerald-500/15' : 'bg-rose-500/15'}`}>
            {fmtPct(t.pnlPct)}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 self-center text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>

      {/* detay paneli: hareket / brüt / ücret / bakiye + giriş sinyali */}
      {open && (
        <div className={`border-l-2 px-3 pb-2.5 pt-1 ${win ? 'border-l-emerald-500/40' : 'border-l-rose-500/40'}`}>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <DetailCell label="Fiyat hareketi" value={fmtPct(t.movePct, 3)} cls={pnlClass(t.movePct)} />
            <DetailCell label="Brüt kâr/zarar" value={`${fmtSignedUsd(t.grossPnl, 3)} USDT`} cls={pnlClass(t.grossPnl)} />
            <DetailCell label="İşlem ücreti" value={`−${fmtUsd(t.fees, 3)} USDT`} cls="text-amber-500/90" />
            <DetailCell label="Bakiye sonrası" value={`${fmtUsd(t.balanceAfter)} USDT`} cls="text-zinc-300" />
          </div>
          <p className="mt-1.5 break-words text-[11px] leading-relaxed text-zinc-500">
            <span className="text-zinc-400">Giriş sinyali:</span> {t.entrySignal}
          </p>
        </div>
      )}
    </div>
  )
}

function DetailCell({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/60 px-2 py-1.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className={`font-mono text-[11px] font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}
