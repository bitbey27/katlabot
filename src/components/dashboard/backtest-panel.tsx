'use client'

// Geçmişe Dönük Test + Parametre Optimizasyonu paneli.
// Motor, İSTEK ÜZERİNE 1500 adet 1dk mumı üzerinde TP×SL×süre ızgarasını
// (280 kombinasyon) canlı stratejinin AYNI indikatörleriyle oynatır;
// ilk %70'te optimizer, son %30'da şampiyon doğrulaması yapılır.
// Bu modül canlı tick yoluna dokunmaz — çalışırken bot akmaya devam eder.

import { useState } from 'react'
import { FlaskConical, Play, CheckCircle2, AlertTriangle, Wand2, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBotStore } from '@/lib/bot-store'
import { sendControl } from '@/lib/engine-socket'
import type { BacktestReport, ControlResult, HeatmapCell } from '@/lib/engine-types'
import { useToast } from '@/hooks/use-toast'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT']

export function BacktestPanel() {
  const snap = useBotStore((s) => s.snapshot)
  const { toast } = useToast()
  const [symbol, setSymbol] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<BacktestReport | null>(null)
  const [confirmApply, setConfirmApply] = useState(false)

  const runSymbol = symbol || snap?.displaySymbol || snap?.settings.symbol || 'BTCUSDT'

  const run = () => {
    if (running) return
    setRunning(true)
    setConfirmApply(false)
    sendControl({ action: 'backtest', backtestSymbol: runSymbol }, (r: ControlResult) => {
      setRunning(false)
      if (r.ok && r.report) {
        setReport(r.report)
        toast({ title: 'Backtest tamamlandı', description: `${r.report.combosTested} kombinasyon · ${r.report.durationMs}ms` })
      } else {
        toast({ title: 'Backtest başarısız', description: r.msg, variant: 'destructive' })
      }
    })
  }

  const apply = () => {
    if (!report?.champion) return
    sendControl({
      action: 'backtestApply',
      backtestParams: {
        takeProfitPct: report.champion.params.tpPct,
        stopLossPct: report.champion.params.slPct,
        maxHoldSec: report.champion.params.maxHoldSec,
      },
    }, (r: ControlResult) => {
      setConfirmApply(false)
      toast({
        title: r.ok ? 'Ayar motora uygulandı' : 'Uygulanamadı',
        description: r.msg,
        variant: r.ok ? 'default' : 'destructive',
      })
    })
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-300">
          <FlaskConical className="h-4 w-4 text-violet-400" aria-hidden />
          Backtest + Optimizasyon
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-bold text-violet-300">
            1500 mum · 280 kombinasyon
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Select value={runSymbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-[130px] border-zinc-700 bg-zinc-900 font-mono text-xs" aria-label="Backtest sembolü">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-700 bg-zinc-900">
                {SYMBOLS.map((s) => <SelectItem key={s} value={s} className="font-mono">{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={run}
              disabled={running}
              className="h-8 gap-1.5 bg-violet-600 font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {running ? 'Çalışıyor…' : 'Backtest Çalıştır'}
            </Button>
          </div>
        </CardTitle>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Geçmiş 1500 dakikalık veri üzerinde TP × SL × pozisyon süresi ızgarası taranır — canlı stratejinin
          <span className="text-zinc-300"> aynı indikatörleriyle</span>, her işlemde gerçek komisyon + spread ödenerek.
          İlk %70&apos;te en kârlı ayar bulunur, son %30&apos;luk <span className="text-zinc-300">hiç görülmemiş</span> dilimde doğrulanır;
          doğrulamayı geçmeyen ayar uygulanmaz. Canlı izleme etkilenmez.
        </p>
      </CardHeader>
      <CardContent className="pb-3">
        {running && (
          <div className="flex flex-col items-center gap-2 py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-violet-400" aria-hidden />
            <p className="text-xs text-zinc-500">Geçmiş veri çekiliyor ve 280 kombinasyon oynatılıyor… (birkaç saniye)</p>
          </div>
        )}

        {!running && !report && (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center">
            <p className="text-sm font-medium text-zinc-400">Henüz test yapılmadı</p>
            <p className="max-w-[420px] text-xs text-zinc-600">
              Coin seç ve çalıştır — ısı haritası, en iyi ayar ve doğrulama sonucu burada görünecek.
              Bot şu an: TP %{snap?.settings.takeProfitPct.toFixed(2) ?? '—'} · SL %{snap?.settings.stopLossPct.toFixed(2) ?? '—'} · süre {snap?.settings.maxHoldSec ?? '—'}sn
            </p>
          </div>
        )}

        {!running && report && (
          <div className="space-y-4">
            {/* karar bandı */}
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed ${
              report.recommended
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/5 text-amber-300'
            }`}>
              {report.recommended
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
              <div>
                <p className="font-semibold">{report.symbol} · {report.candlesUsed} mum ({Math.round(report.candlesUsed / 60)} saat) · {report.combosTested} kombinasyon · {report.durationMs}ms</p>
                <p className="mt-1 text-zinc-300">{report.verdict}</p>
              </div>
            </div>

            {report.champion && (
              <>
                {/* şampiyon kartları: eğitim vs doğrulama */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <MetricBox
                    title="En İyi Ayar"
                    rows={[
                      ['TP', `%${report.champion.params.tpPct}`],
                      ['SL', `%${report.champion.params.slPct}`],
                      ['Süre', `${report.champion.params.maxHoldSec} sn`],
                    ]}
                    highlight
                  />
                  <MetricBox
                    title="Eğitim (%70)"
                    rows={[
                      ['İşlem', `${report.champion.trades}`],
                      ['Kazanma', `%${report.champion.winRate.toFixed(0)}`],
                      ['Net K/Z', `${signed(report.champion.netPnl)} USDT`],
                      ['Kâr Faktörü', pf(report.champion.profitFactor)],
                      ['Maks. Düşüş', `%${report.champion.maxDdPct.toFixed(1)}`],
                    ]}
                    tone={report.champion.netPnl}
                  />
                  <MetricBox
                    title="Doğrulama (%30 — görülmemiş)"
                    rows={
                      report.championValid
                        ? [
                            ['İşlem', `${report.championValid.trades}`],
                            ['Kazanma', `%${report.championValid.winRate.toFixed(0)}`],
                            ['Net K/Z', `${signed(report.championValid.netPnl)} USDT`],
                            ['Kâr Faktörü', pf(report.championValid.profitFactor)],
                            ['Maks. Düşüş', `%${report.championValid.maxDdPct.toFixed(1)}`],
                          ]
                        : []
                    }
                    tone={report.championValid?.netPnl}
                  />
                </div>

                {/* uygula bölgesi */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="text-xs text-zinc-400">
                    <span className="text-zinc-500">Botun şu anki ayarı:</span>{' '}
                    <span className="font-mono text-zinc-300">
                      TP %{report.currentParams.tpPct} · SL %{report.currentParams.slPct} · {report.currentParams.maxHoldSec}sn
                    </span>
                    {' — '}
                    <span className="text-zinc-500">önerilen:</span>{' '}
                    <span className={`font-mono ${report.recommended ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      TP %{report.champion.params.tpPct} · SL %{report.champion.params.slPct} · {report.champion.params.maxHoldSec}sn
                    </span>
                  </div>
                  {confirmApply ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-amber-300">TP/SL/süre ayarları değişecek — emin misin?</span>
                      <Button size="sm" onClick={apply} className="h-8 gap-1 bg-emerald-600 font-semibold text-white hover:bg-emerald-500">
                        <Wand2 className="h-3.5 w-3.5" aria-hidden /> Evet, Uygula
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmApply(false)} className="h-8 gap-1 border-zinc-700 bg-zinc-900 text-zinc-300">
                        <X className="h-3.5 w-3.5" aria-hidden /> Vazgeç
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setConfirmApply(true)}
                      disabled={!report.recommended}
                      title={report.recommended ? 'Şampiyon ayarı motora uygula' : 'Doğrulamayı geçmedi — uygulama güvenli değil'}
                      className="h-8 gap-1 bg-emerald-600 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Wand2 className="h-3.5 w-3.5" aria-hidden />
                      {report.recommended ? 'En İyi Ayarı Uygula' : 'Doğrulanmadı — Uygulanamaz'}
                    </Button>
                  )}
                </div>

                {/* ısı haritası */}
                <Heatmap report={report} />

                {/* şampiyonun eğitim eğrisi */}
                {report.equityCurve.length > 2 && (
                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-zinc-400">Şampiyonun bakiye eğrisi (eğitim, bileşik)</p>
                    <EquitySpark values={report.equityCurve} start={snap?.settings.startBalance ?? 1000} />
                  </div>
                )}

                {/* işlem örnekleri */}
                {report.tradesSample.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-[11px] font-semibold text-zinc-400 hover:text-zinc-300">
                      İlk {Math.min(report.tradesSample.length, 30)} işlem (örnek) ▾
                    </summary>
                    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
                      <table className="w-full border-collapse text-left">
                        <thead>
                          <tr className="border-b border-zinc-800 bg-zinc-900 text-[10px] uppercase tracking-wide text-zinc-600">
                            <th className="px-2 py-1.5 font-medium">#</th>
                            <th className="px-2 py-1.5 font-medium">Yön</th>
                            <th className="px-2 py-1.5 text-right font-medium">Giriş mumu</th>
                            <th className="px-2 py-1.5 text-right font-medium">Süre</th>
                            <th className="px-2 py-1.5 text-right font-medium">Hareket</th>
                            <th className="px-2 py-1.5 text-right font-medium">Net</th>
                            <th className="px-2 py-1.5 text-center font-medium">Çıkış</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.tradesSample.map((t, k) => (
                            <tr key={k} className="border-b border-zinc-800/60 last:border-0">
                              <td className="px-2 py-1 font-mono text-[11px] text-zinc-500">{k + 1}</td>
                              <td className="px-2 py-1">
                                <span className={`rounded px-1.5 py-px text-[9px] font-bold ${t.side === 'LONG' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>{t.side}</span>
                              </td>
                              <td className="px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-400">{t.entryIdx}</td>
                              <td className="px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-400">{Math.round(t.holdSec / 60)}dk</td>
                              <td className={`px-2 py-1 text-right font-mono text-[11px] tabular-nums ${t.movePct >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{t.movePct >= 0 ? '+' : ''}{t.movePct.toFixed(3)}%</td>
                              <td className={`px-2 py-1 text-right font-mono text-[11px] tabular-nums font-bold ${t.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{t.netPnl >= 0 ? '+' : ''}{t.netPnl.toFixed(2)}</td>
                              <td className="px-2 py-1 text-center text-[10px] text-zinc-500">{exitTR(t.reason)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}

            {!report.champion && (
              <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500">{report.verdict}</p>
            )}

            <p className="text-[10px] leading-relaxed text-zinc-600">
              Dürüstlük notu: canlı bot saniyelik momentumla girer; bu test 1dk kapanışlarıyla çalıştığı için giriş anı
              ±1 dakika kayabilir (TP/SL/süre ekonomisi birebir korunur). Simülasyon spread&apos;i %{report.spreadPct.toFixed(4)} sabitleyerek kullanır.
              Geçmiş performans gelecek getirinin garantisi değildir.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------- yardımcı bileşenler ----------------

function MetricBox({ title, rows, tone, highlight }: {
  title: string
  rows: [string, string][]
  tone?: number
  highlight?: boolean
}) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? 'border-violet-500/30 bg-violet-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
      <p className={`mb-1.5 text-[11px] font-bold uppercase tracking-wide ${highlight ? 'text-violet-300' : 'text-zinc-500'}`}>{title}</p>
      <div className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-zinc-500">{k}</span>
            <span className={`font-mono text-xs tabular-nums font-semibold ${
              k === 'Net K/Z' && tone !== undefined
                ? tone >= 0 ? 'text-emerald-400' : 'text-rose-400'
                : 'text-zinc-200'
            }`}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Heatmap({ report }: { report: BacktestReport }) {
  if (report.heatmap.length === 0) return null
  const tps = [...new Set(report.heatmap.map((c: HeatmapCell) => c.tp))].sort((a, b) => a - b)
  const sls = [...new Set(report.heatmap.map((c: HeatmapCell) => c.sl))].sort((a, b) => a - b)
  const values = report.heatmap.map((c) => c.netPnl)
  const min = Math.min(...values), max = Math.max(...values)
  const cellStyle = (v: number): React.CSSProperties => {
    if (max <= min) return {}
    const norm = (v - min) / (max - min) // 0..1
    // kırmızıdan yeşile: negatif → gül, pozitif → zümrüt
    const alpha = 0.15 + norm * 0.55
    const bg = v >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(244,63,94,${alpha})`
    return { backgroundColor: bg }
  }
  const champ = report.champion

  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold text-zinc-400">
        Net kâr ısı haritası (USDT) — satır: TP, kolon: SL · hücredeki değer o (TP, SL) için en iyi süreyle eğitimdeki net sonuç
      </p>
      <div className="overflow-x-auto">
        <table className="border-collapse text-center">
          <thead>
            <tr>
              <th className="px-2 py-1 text-[10px] font-medium text-zinc-600">TP＼SL</th>
              {sls.map((sl) => (
                <th key={sl} className="px-2 py-1 text-[10px] font-medium text-zinc-500">%{sl}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tps.map((tp) => (
              <tr key={tp}>
                <td className="px-2 py-0.5 text-[10px] font-medium text-zinc-500">%{tp}</td>
                {sls.map((sl) => {
                  const cell = report.heatmap.find((c) => c.tp === tp && c.sl === sl)
                  const isChamp = champ && champ.params.tpPct === tp && champ.params.slPct === sl
                  return (
                    <td key={sl} className="p-0.5">
                      {cell ? (
                        <div
                          style={cellStyle(cell.netPnl)}
                          title={`TP %${tp} · SL %${sl} · süre ${cell.bestHoldSec}sn · ${cell.trades} işlem · net ${signed(cell.netPnl)} USDT`}
                          className={`flex h-8 min-w-[52px] items-center justify-center rounded font-mono text-[10px] tabular-nums font-semibold text-zinc-100 ${isChamp ? 'ring-2 ring-violet-400' : ''}`}
                        >
                          {cell.netPnl >= 0 ? '+' : ''}{Math.round(cell.netPnl)}
                        </div>
                      ) : (
                        <div className="flex h-8 min-w-[52px] items-center justify-center rounded bg-zinc-900/60 text-[10px] text-zinc-700">—</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">
        Mor çerçeve = seçilen şampiyon. Komşu hücreler de yeşilse ayar sağlamdır; tek başına parlayan hücre şans tepesidir.
      </p>
    </div>
  )
}

function EquitySpark({ values, start }: { values: number[]; start: number }) {
  const w = 600, h = 80
  const min = Math.min(start, ...values)
  const max = Math.max(start, ...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 8) - 4
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const up = values[values.length - 1] >= start
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" role="img" aria-label="Backtest bakiye eğrisi">
      <line x1="0" y1={h - ((start - min) / range) * (h - 8) - 4} x2={w} y2={h - ((start - min) / range) * (h - 8) - 4} stroke="#52525b" strokeWidth="1" strokeDasharray="4 4" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={up ? '#34d399' : '#fb7185'}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
}

function pf(v: number): string {
  return v === Infinity ? '∞' : v.toFixed(2)
}

function exitTR(r: string): string {
  switch (r) {
    case 'TAKE_PROFIT': return 'TP'
    case 'STOP_LOSS': return 'SL'
    case 'SIGNAL_FLIP': return 'sinyal dönüş'
    case 'TIMEOUT': return 'süre'
    default: return r.toLowerCase()
  }
}
