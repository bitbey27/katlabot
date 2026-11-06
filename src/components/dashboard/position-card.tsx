'use client'

// Açık pozisyon kartı — canlı K/Z, TP/SL ilerleme, manuel kapat

import { ArrowDownRight, ArrowUpRight, X, Timer, Shield, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useBotStore, useLivePosition } from '@/lib/bot-store'
import { sendControl } from '@/lib/engine-socket'
import { fmtPrice, fmtUsd, fmtSignedUsd, fmtPct, fmtDur, pnlClass, priceDigits } from '@/lib/format'
import { useToast } from '@/hooks/use-toast'

export function PositionCard() {
  const snap = useBotStore((s) => s.snapshot)
  const position = useLivePosition()
  const { toast } = useToast()
  const pending = snap?.pending ?? null

  if (!position) {
    // ---- Aşama 2: bekleyen maker giriş emri görünümü ----
    if (pending) {
      const d = priceDigits(pending.limitPrice)
      return (
        <Card className="border-sky-500/30 bg-sky-950/20 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
                <Target className="h-4 w-4 text-sky-400" aria-hidden />
                Maker Giriş Emri Bekliyor
              </span>
              <span className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-bold ${pending.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                {pending.symbol.replace('USDT', '')} · {pending.side}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-[11px] text-zinc-500">Limit fiyatı (defterin kendi tarafı)</p>
                <p className="font-mono text-lg font-bold text-sky-300">{fmtPrice(pending.limitPrice, d)}</p>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-zinc-500">Miktar</p>
                <p className="font-mono text-sm font-semibold text-zinc-200">{pending.qty}</p>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">
                Fiyat emre gelirse <span className="text-emerald-400">maker ücretiyle</span> dolar
              </span>
              <span className="rounded bg-sky-500/15 px-2 py-0.5 font-mono font-bold text-sky-300 tabular-nums">
                {pending.expiresSec} sn sonra iptal
              </span>
            </div>
            <Progress value={Math.max(0, Math.min(100, (pending.placedSec / Math.max(1, pending.placedSec + pending.expiresSec)) * 100))} className="h-1.5" />
            <p className="text-[11px] leading-relaxed text-zinc-600">
              Dolmazsa sinyal dürüstçe kaçar — maker ücretinin bedeli. SL/zaman aşımı çıkışları her zaman piyasa emridir.
            </p>
          </CardContent>
        </Card>
      )
    }
    return (
      <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <Target className="h-4 w-4 text-zinc-500" aria-hidden />
            Açık Pozisyon
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center gap-1 py-8 text-center">
          <div className="text-2xl" aria-hidden>⏸</div>
          <p className="text-sm font-medium text-zinc-400">Pozisyon yok — sinyal bekleniyor</p>
          <p className="max-w-[240px] text-xs text-zinc-600">
            {snap?.running
              ? 'Motor her saniye piyasa tarıyor; uygun momento yakalandığında otomatik giriş yapacak.'
              : 'Botu başlatın; motor sinyal avına çıkacak.'}
          </p>
        </CardContent>
      </Card>
    )
  }

  const isLong = position.side === 'LONG'
  const d = priceDigits(position.entryPrice)
  const base = position.symbol.replace('USDT', '')
  // ---- TP/SL pisti geometrisi: SL (sol) ← giriş → TP (sağ) ----
  // fiyat işaretçisi 4Hz tikle KAYAR: TP'ye yaklaştıkça ileri, SL'e yaklaştıkça geri
  const slPct = Math.abs(position.entryPrice - position.stopLossPrice) / position.entryPrice * 100
  const tpPctD = Math.abs(position.takeProfitPrice - position.entryPrice) / position.entryPrice * 100
  const spanPct = slPct + tpPctD || 1
  const entryPct = Math.min(96, Math.max(4, (slPct / spanPct) * 100))
  const curPct = Math.min(99, Math.max(1, ((position.movePct + slPct) / spanPct) * 100))
  const inProfit = position.movePct >= 0
  const distSl = Math.max(0, slPct + position.movePct)
  const distTp = Math.max(0, tpPctD - position.movePct)
  const trailMovePct = position.trailStop && position.trailStop > 0
    ? ((position.trailStop / position.entryPrice) - 1) * 100 * (isLong ? 1 : -1)
    : null
  const trailPct = trailMovePct !== null
    ? Math.min(99, Math.max(1, ((trailMovePct + slPct) / spanPct) * 100))
    : null
  const holdLeft = Math.max(0, position.maxHoldSec - position.holdSec)
  // keskin çıkışta gerçek tavan: en az 15dk güvenlik sınırı (saat değil kayıt dışı koruma)
  const capLeft = snap?.settings.sharpExit
    ? Math.max(0, Math.max(position.maxHoldSec, 900) - position.holdSec)
    : holdLeft

  const closeNow = () => {
    sendControl({ action: 'close' }, (r) => {
      toast({ title: r.ok ? 'Pozisyon kapatıldı' : 'İşlem başarısız', description: r.msg, variant: r.ok ? 'default' : 'destructive' })
    })
  }

  return (
    <Card className={`border shadow-none ${isLong ? 'border-emerald-500/30 bg-emerald-950/20' : 'border-rose-500/30 bg-rose-950/20'}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <Target className="h-4 w-4 text-zinc-500" aria-hidden />
            Açık Pozisyon
          </span>
          <span className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-bold ${isLong ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
            {isLong ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
            {position.symbol.replace('USDT', '')} · {position.side} · {snap?.settings.leverage ?? 10}x
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* net K/Z — en büyük gösterge */}
        <div className="text-center">
          <div className={`font-mono text-3xl font-bold tabular-nums ${pnlClass(position.netPnl)}`}>
            {fmtSignedUsd(position.netPnl)} <span className="text-sm font-semibold">USDT</span>
          </div>
          <div className={`text-xs font-medium ${pnlClass(position.netPnl)}`}>
            {fmtPct(position.pnlPct)} marj getirisi · fiyat {fmtPct(position.movePct, 3)}
          </div>
        </div>

        {/* TP/SL pisti — fiyat işaretçisi kayarak ilerler/geriler */}
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
            <span className="text-rose-400">SL {fmtPrice(position.stopLossPrice, d)}</span>
            <span className="flex items-center gap-1"><Timer className="h-3 w-3" aria-hidden />{fmtDur(position.holdSec)} · {snap?.settings.sharpExit ? <>güvenlik tavanı {fmtDur(capLeft)}</> : <>{fmtDur(holdLeft)} kaldı</>}</span>
            <span className="text-emerald-400">TP {fmtPrice(position.takeProfitPrice, d)}</span>
          </div>
          <div
            className="relative h-2.5 rounded-full bg-zinc-800"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(curPct)}
            aria-label={`Fiyat, SL ile TP arası pistin yüzde ${Math.round(curPct)} konumunda`}
          >
            {/* zarar bölgesi (girişe kadar) */}
            <div className="absolute inset-y-0 left-0 rounded-l-full bg-gradient-to-r from-rose-600/60 to-rose-500/15" style={{ width: `${entryPct}%` }} />
            {/* kâr bölgesi (girişten TP'ye) */}
            <div className="absolute inset-y-0 right-0 rounded-r-full bg-gradient-to-l from-emerald-500/60 to-emerald-400/15" style={{ width: `${100 - entryPct}%` }} />
            {/* dolgu: girişten anlık fiyata — kârda yeşil, zararda kırmızı akar */}
            <div
              className={`absolute inset-y-[3px] rounded-full ${inProfit ? 'bg-emerald-500/80' : 'bg-rose-500/80'}`}
              style={{
                left: `${Math.min(entryPct, curPct)}%`,
                width: `${Math.abs(curPct - entryPct)}%`,
                transition: 'left 300ms ease-out, width 300ms ease-out',
              }}
            />
            {/* giriş çentiği */}
            <div className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-zinc-400" style={{ left: `${entryPct}%` }} aria-hidden />
            {/* kâr kilidi çentiği (kurulduysa) */}
            {trailPct !== null && (
              <div
                className="absolute -top-1 -bottom-1 w-[3px] rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]"
                style={{ left: `${trailPct}%`, transition: 'left 300ms ease-out' }}
                title={`Kâr kilidi ${fmtPrice(position.trailStop!, d)} (net kâr tabanı)`}
                aria-label="Kâr kilidi"
              />
            )}
            {/* fiyat işaretçisi — 4Hz tikte kayan daire */}
            <div
              className={`absolute top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-zinc-950 ${inProfit ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]' : 'bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.7)]'}`}
              style={{ left: `${curPct}%`, transition: 'left 300ms ease-out' }}
              aria-hidden
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] font-medium tabular-nums">
            <span className="text-rose-400/90">SL'e %{distSl.toFixed(2)}</span>
            <span className={inProfit ? 'text-emerald-400/90' : 'text-rose-400/90'}>
              {fmtPct(position.movePct, 3)}
              {trailMovePct !== null && <span className="ml-1 text-amber-400/90" title="Kâr kilidi tabanı">· kilit {fmtPct(trailMovePct)}</span>}
            </span>
            <span className="text-emerald-400/90">TP'ye %{distTp.toFixed(2)}</span>
          </div>
        </div>

        {/* detaylar */}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs">
          <Row label="Miktar" value={`${position.qty} ${base}`} />
          <Row label="Giriş" value={fmtPrice(position.entryPrice, d)} />
          <Row label="Anlık" value={fmtPrice(position.markPrice, d)} />
          <Row label="Pozisyon" value={`${fmtUsd(position.qty * position.markPrice, 0)} USDT`} />
          <Row label="Brüt K/Z" value={fmtSignedUsd(position.grossPnl, 3)} valueClass={pnlClass(position.grossPnl)} />
          <Row label="Ücret (giriş+çıkış)" value={`-${fmtUsd(position.fees, 3)}`} valueClass="text-amber-400" />
        </dl>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500">
          <Shield className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" aria-hidden />
          {position.reason}
        </p>

        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 border-rose-500/40 bg-rose-950/30 font-semibold text-rose-400 hover:bg-rose-900/40 hover:text-rose-300"
          onClick={closeNow}
        >
          <X className="h-4 w-4" aria-hidden />
          Pozisyonu Manuel Kapat
        </Button>
      </CardContent>
    </Card>
  )
}

function Row({ label, value, valueClass = 'text-zinc-200' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`font-mono tabular-nums font-medium ${valueClass}`}>{value}</dd>
    </div>
  )
}
