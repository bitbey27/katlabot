'use client'

// Üst bar — sembol, canlı fiyat, durum rozetleri, BAŞLAT/DURDUR

import { Activity, Play, Square, Wifi, WifiOff, Settings2, ShieldCheck, ShieldAlert, Gauge, ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useBotStore, useLivePrice, useLiveBidAsk } from '@/lib/bot-store'
import { sendControl } from '@/lib/engine-socket'
import { fmtPrice, fmtPct, priceDigits } from '@/lib/format'
import { useToast } from '@/hooks/use-toast'
import { priceDigits as pd } from '@/lib/format'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT']

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const snapshot = useBotStore((s) => s.snapshot)
  const socketConnected = useBotStore((s) => s.socketConnected)
  const price = useLivePrice()
  const { bid, ask, spreadPct } = useLiveBidAsk()
  const { toast } = useToast()

  const running = snapshot?.running ?? false
  const hardStopped = snapshot?.entryLock?.hardStopped ?? false
  const symbol = snapshot?.displaySymbol ?? snapshot?.settings.symbol ?? 'BTCUSDT'
  const isMulti = snapshot?.scanMode === 'MULTI'
  const watchCount = snapshot?.trackedSymbols.length ?? 1
  const mode = snapshot?.settings.mode ?? 'PAPER'
  const change = snapshot?.priceChange24hPct ?? 0
  const digits = pd(price || 1)
  const hasBook = bid > 0 && ask > 0
  const isFutures = snapshot?.streamMode !== 'SPOT'

  const toggleRun = () => {
    sendControl({ action: running ? 'stop' : 'start' }, (r) => {
      toast({
        title: r.ok ? (running ? 'Bot durduruldu' : 'Bot başlatıldı') : 'İşlem başarısız',
        description: r.msg,
        variant: r.ok ? 'default' : 'destructive',
      })
    })
  }

  const changeSymbol = (sym: string) => {
    if (sym === symbol) return
    sendControl({ action: 'updateSettings', settings: { symbol: sym } }, (r) => {
      toast({ title: 'Sembol değiştirildi', description: r.msg })
    })
  }

  // TOPLAM bakiye tabanı kilitken: referansı şu anki bakiyeye tazele,
  // bot tekrar başlatılabilir hale gelir (bilinçli onay eylemi)
  const clearFloor = () => {
    sendControl({ action: 'clearFloor' }, (r) => {
      toast({
        title: r.ok ? 'Bakiye tabanı sıfırlandı' : 'İşlem başarısız',
        description: r.msg,
        variant: r.ok ? 'default' : 'destructive',
      })
    })
  }

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/80">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
        {/* logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 border border-emerald-500/30">
            <Activity className="h-4.5 w-4.5 text-emerald-400" aria-hidden />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight text-zinc-100">KATLA<span className="text-emerald-400">BOT</span></div>
            <div className="text-[10px] text-zinc-500">Binance Futures Scalper</div>
          </div>
        </div>

        <div className="hidden h-8 w-px bg-zinc-800 md:block" aria-hidden />

        {/* sembol + fiyat — çoklu modda seçim = grafik odağı */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-start gap-0.5">
            <Select value={symbol} onValueChange={changeSymbol}>
              <SelectTrigger className="h-9 w-[132px] border-zinc-700 bg-zinc-900 text-sm font-semibold text-zinc-100" aria-label={isMulti ? 'Grafik odağı seç' : 'Sembol seç'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-700 bg-zinc-900">
                {SYMBOLS.map((s) => (
                  <SelectItem key={s} value={s} className="text-zinc-100">{s.replace('USDT', '/USDT')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isMulti && (
              <span className="rounded bg-sky-500/15 px-1.5 py-px text-[10px] font-bold text-sky-400">
                ÇOKLU TARAMA · {watchCount} coin
              </span>
            )}
          </div>
          <div className="tabular-nums leading-tight">
            <div className={`text-lg font-bold ${change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtPrice(price, digits)}
            </div>
            <div className={`text-[11px] font-medium ${change >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
              24s {fmtPct(change)}
            </div>
            {hasBook && (
              <div className="hidden font-mono text-[10px] text-zinc-500 sm:block" title="En iyi alış / satış (futures emir defteri)">
                <span className="text-rose-400/80">A {fmtPrice(ask, digits)}</span>
                <span className="mx-1 text-zinc-700">·</span>
                <span className="text-emerald-400/80">Y {fmtPrice(bid, digits)}</span>
                <span className="ml-1 text-zinc-600">({spreadPct.toFixed(3)}%)</span>
              </div>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* WS durumu */}
          <Badge variant="outline" className={`gap-1.5 border px-2 py-1 text-[11px] font-medium ${socketConnected ? (isFutures ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/40 bg-amber-500/10 text-amber-400') : 'border-rose-500/40 bg-rose-500/10 text-rose-400'}`}>
            {socketConnected ? <Wifi className="h-3 w-3" aria-hidden /> : <WifiOff className="h-3 w-3" aria-hidden />}
            {socketConnected
              ? (snapshot?.connected ? (isFutures ? 'Futures canlı' : 'Spot yedek') : 'Binance bekliyor')
              : 'Motor kopuk'}
          </Badge>

          {/* güvenlik ağı A: borsa ↔ bot mutabakatı (yalnız LIVE'da görünür) */}
          {snapshot?.recon && snapshot.recon.status !== 'OFF' && (
            <Badge
              variant="outline"
              className={`gap-1.5 border px-2 py-1 text-[11px] font-semibold ${snapshot.recon.status === 'OK'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-rose-500/50 bg-rose-500/10 text-rose-400'}`}
              title={snapshot.recon.status === 'OK'
                ? `Borsa ve bot defteri uyumlu — son kontrol ${Math.max(1, Math.round((Date.now() - snapshot.recon.lastCheck) / 1000))} sn önce${snapshot.recon.autoClosed > 0 ? ` · bugüne dek ${snapshot.recon.autoClosed} yetim pozisyon otomatik kapatıldı` : ''}`
                : snapshot.recon.issues.join('\n')}
            >
              {snapshot.recon.status === 'OK' ? <ShieldCheck className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}
              {snapshot.recon.status === 'OK'
                ? 'Mutabakat ✓'
                : snapshot.recon.status === 'ERROR'
                  ? 'Mutabakat hatası'
                  : `Mutabakat: ${snapshot.recon.issues.length} sorun`}
            </Badge>
          )}

          {/* güvenlik ağı B: API hız limiti (Binance IP ağırlığı, son 1 dk) */}
          {snapshot?.api && (
            <Badge
              variant="outline"
              className={`gap-1.5 border px-2 py-1 font-mono text-[11px] tabular-nums ${(() => {
                const pct = snapshot.api!.weightUsed1m / Math.max(1, snapshot.api!.weightLimit1m)
                if (pct >= 0.7) return 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                if (pct >= 0.5) return 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                return 'border-zinc-600 bg-zinc-800/60 text-zinc-400'
              })()}`}
              title={`Binance istek ağırlığı (IP başına, son 1 dk): ${snapshot.api.weightUsed1m}/${snapshot.api.weightLimit1m}. Tavanın %70'i aşılırsa Binance 429 vermeden önce sınırlama yapar; bot bu düzeyde asla bulunmaz.`}
            >
              <Gauge className="h-3 w-3" aria-hidden />
              API {snapshot.api.weightUsed1m}/{snapshot.api.weightLimit1m}
            </Badge>
          )}

          {/* mod rozeti */}
          <Badge variant="outline" className={`border px-2 py-1 text-[11px] font-bold ${mode === 'LIVE' ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-zinc-600 bg-zinc-800/60 text-zinc-300'}`}>
            {mode === 'LIVE' ? '⚡ CANLI İŞLEM' : 'PAPER (SİMÜLASYON)'}
          </Badge>

          {/* TOPLAM bakiye tabanı kilidi — bilinçli sıfırlama düğmesiyle açılır */}
          {hardStopped && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 border-rose-500/50 bg-rose-500/10 font-bold text-rose-300 hover:bg-rose-500/20"
              onClick={clearFloor}
              aria-label="Toplam bakiye tabanını sıfırla ve korumayı yeniden kur"
              title="Taban referansını şu anki bakiyeye yeniler — bot tekrar başlatılabilir olur"
            >
              <ShieldX className="h-4 w-4" aria-hidden />
              TABANI SIFIRLA
            </Button>
          )}

          {/* durum */}
          <Badge variant="outline" className={`gap-1.5 border px-2 py-1 text-[11px] font-semibold ${running ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-zinc-600 bg-zinc-800/60 text-zinc-400'}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${running ? 'animate-pulse bg-emerald-400' : 'bg-zinc-500'}`} aria-hidden />
            {running ? 'ÇALIŞIYOR' : 'BEKLEMEDE'}
          </Badge>

          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={onOpenSettings}
            aria-label="Bot ayarlarını aç"
          >
            <Settings2 className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Ayarlar</span>
          </Button>

          <Button
            size="sm"
            className={`h-9 gap-1.5 font-bold ${running
              ? 'bg-rose-600 hover:bg-rose-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}
            onClick={toggleRun}
            aria-label={running ? 'Botu durdur' : 'Botu başlat'}
          >
            {running ? <Square className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            {running ? 'DURDUR' : 'BAŞLAT'}
          </Button>
        </div>
      </div>
    </header>
  )
}
