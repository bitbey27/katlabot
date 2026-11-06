'use client'

// Dashboard kabuğu — socket.io bağlantısı + genel yerleşim

import { useEffect, useState } from 'react'
import { TopBar } from './top-bar'
import { StatCards } from './stat-cards'
import { CandleChart } from './candle-chart'
import { MicroChart } from './micro-chart'
import { PositionCard } from './position-card'
import { BotPanel } from './bot-panel'
import { ScannerPanel } from './scanner-panel'
import { EquityCard, EngineLogCard } from './equity-card'
import { TradeLog } from './trade-log'
import { SettingsDialog } from './settings-dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useBotStore, useLivePrice, useLivePosition } from '@/lib/bot-store'
import { getEngineSocket, releaseEngineSocket } from '@/lib/engine-socket'
import type { EngineSnapshot, TickData } from '@/lib/engine-types'
import { CandlestickChart, Gauge, ShieldAlert } from 'lucide-react'

export function DashboardShell() {
  const setSnapshot = useBotStore((s) => s.setSnapshot)
  const setTick = useBotStore((s) => s.setTick)
  const setSocketConnected = useBotStore((s) => s.setSocketConnected)
  const snapshot = useBotStore((s) => s.snapshot)
  const price = useLivePrice()
  const position = useLivePosition()
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    const socket = getEngineSocket()
    const onState = (s: EngineSnapshot) => setSnapshot(s)
    const onTick = (t: TickData) => setTick(t)
    const onConnect = () => setSocketConnected(true)
    const onDisconnect = () => setSocketConnected(false)
    socket.on('state', onState)
    socket.on('tick', onTick)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    if (socket.connected) setSocketConnected(true)
    return () => {
      socket.off('state', onState)
      socket.off('tick', onTick)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      releaseEngineSocket()
    }
  }, [setSnapshot, setTick, setSocketConnected])

  const symbol = snapshot?.displaySymbol ?? snapshot?.settings.symbol ?? '—'
  const isMulti = snapshot?.scanMode === 'MULTI'
  const hasSnapshot = !!snapshot
  const recon = snapshot?.recon
  const reconBad = recon && (recon.status === 'MISMATCH' || recon.status === 'ERROR')

  // Güvenlik ağı: kendinden iyileştirme — snapshot 15sn'de gelmediyse motor
  // düşmüş demektir; /api/engine/start sunucu tarafında yeniden başlatır,
  // socket.io otomatik yeniden bağlanır. Motor ayaktaysa uç hiçbir şey yapmaz.
  useEffect(() => {
    if (hasSnapshot) return
    let attempts = 0
    const id = setInterval(async () => {
      attempts++
      if (attempts > 5) { clearInterval(id); return }
      try { await fetch('/api/engine/start', { method: 'POST' }) } catch { /* sonraki deneme */ }
    }, 15000)
    return () => clearInterval(id)
  }, [hasSnapshot])

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />

      <main className="mx-auto max-w-[1600px] space-y-3 px-3 py-3 sm:px-4 sm:py-4">
        {/* yükleniyor perdesi */}
        {!hasSnapshot && (
          <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-zinc-500">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" aria-hidden />
            <p className="text-sm">Motor'a bağlanılıyor…</p>
            <p className="text-xs text-zinc-600">Motor düşmüşse 15 saniye içinde otomatik yeniden başlatılır</p>
          </div>
        )}

        {hasSnapshot && (
          <>
            {/* güvenlik ağı: mutabakat uyumsuzluğu bandı */}
            {reconBad && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
                <div>
                  <span className="font-bold text-rose-200">Borsa ↔ bot mutabakat uyumsuzluğu:</span>{' '}
                  {recon!.issues.join(' · ')}
                  {recon!.status === 'ERROR' && ' — borsa bilgisi alınamıyor, API anahtarını kontrol et'}
                </div>
              </div>
            )}

            <StatCards />

            {/* ana ızgara: grafik + sağ sütun */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <div className="space-y-3 xl:col-span-2">
                {/* 1dk mum grafiği */}
                <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
                  <CardHeader className="pb-1">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-300">
                      <CandlestickChart className="h-4 w-4 text-emerald-400" aria-hidden />
                      {symbol} — 1 Dakika
                      {isMulti && (
                        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold text-sky-400">
                          TARAMA: {snapshot?.trackedSymbols.length ?? 0} coin
                        </span>
                      )}
                      {position && (
                        <span className={`ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${position.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                          {position.side} AÇIK
                        </span>
                      )}
                      <span className="ml-auto font-mono text-xs font-normal tabular-nums text-zinc-500">
                        saniyelik izleme aktif
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-2">
                    <CandleChart candles={snapshot.candles1m} livePrice={price} position={position} height={400} />
                  </CardContent>
                </Card>

                {/* saniyelik mikro grafik */}
                <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
                  <CardHeader className="pb-1">
                    <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
                      <Gauge className="h-4 w-4 text-amber-400" aria-hidden />
                      Saniyelik Hız Akışı
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-2">
                    <MicroChart candles={snapshot.candles1s} height={96} />
                  </CardContent>
                </Card>
              </div>

              {/* sağ sütun: tarayıcı radarı + pozisyon + strateji */}
              <div className="space-y-3">
                <ScannerPanel />
                <PositionCard />
                <BotPanel />
              </div>
            </div>

            {/* alt ızgara: geçmiş + eğri + günlük */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <TradeLog />
              </div>
              <div className="flex flex-col gap-3">
                <EquityCard />
                <EngineLogCard />
              </div>
            </div>
          </>
        )}

        <footer className="mt-2 border-t border-zinc-800/70 pt-3 pb-1 text-[11px] leading-relaxed text-zinc-600">
          <p>
            <span className="text-zinc-500">Veri kaynağı:</span> Binance USDT-M Futures emir defteri (bookTicker) ·
            çoklu tarama modunda tüm coinler <span className="text-zinc-500">tek WebSocket soketinde</span> izlenir (hız kaybı yok) ·
            PAPER dolumları gerçek bid/ask fiyatlarından yapılır; futures akışı kesilirse spot yedeğe otomatik geçilir ·
            LIVE modda emirler Binance Futures hesabınızdan gerçek parayla gönderilir · PAPER mod simülasyondur, yatırım tavsiyesi değildir.
            Vadeli işlemler kaldıraç içerir ve yüksek kayıp riski taşır.
          </p>
        </footer>
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
