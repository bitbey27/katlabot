'use client'

// Bakiye eğrisi (bileşik büyümenin grafiği) + motor günlüğü

import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts'
import { LineChart as LineChartIcon, ScrollText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useBotStore } from '@/lib/bot-store'
import { fmtTime, fmtUsd } from '@/lib/format'

export function EquityCard() {
  const snap = useBotStore((s) => s.snapshot)
  const equity = snap?.equity ?? []
  const start = snap?.account.startBalance ?? 1000

  const data = equity.map((p) => ({ t: p.t, b: p.balance, label: fmtTime(p.t) }))
  const last = data.at(-1)?.b ?? start
  const up = last >= start
  const minB = Math.min(...data.map((p) => p.b), start)
  const maxB = Math.max(...data.map((p) => p.b), start)
  const pad = (maxB - minB) * 0.15 || Math.max(1, start * 0.01)

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <LineChartIcon className="h-4 w-4 text-emerald-400" aria-hidden />
          Bakiye Eğrisi — Bileşik Katlama
          <span className={`ml-auto font-mono text-xs tabular-nums ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtUsd(last)} USDT
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <div className="flex h-[150px] items-center justify-center text-xs text-zinc-500">
            Kapanan her işlem eğriye bir nokta ekler…
          </div>
        ) : (
          <div className="h-[150px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={up ? '#10b981' : '#f43f5e'} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={up ? '#10b981' : '#f43f5e'} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fill: '#52525b', fontSize: 10 }} interval="preserveStartEnd" minTickGap={40} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                <YAxis domain={[minB - pad, maxB + pad]} tick={{ fill: '#52525b', fontSize: 10 }} width={58} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtUsd(v, 0)} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11, color: '#e4e4e7' }}
                  labelStyle={{ color: '#a1a1aa' }}
                  formatter={(v: number) => [`${fmtUsd(v)} USDT`, 'Bakiye']}
                />
                <ReferenceLine y={start} stroke="#52525b" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="b" stroke={up ? '#10b981' : '#f43f5e'} strokeWidth={1.8} fill="url(#eqFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function EngineLogCard() {
  const snap = useBotStore((s) => s.snapshot)
  const logs = [...(snap?.logs ?? [])].reverse() // en yeni üstte

  const colorFor = (level: string) =>
    level === 'trade' ? 'text-emerald-400' : level === 'warn' ? 'text-amber-400' : level === 'error' ? 'text-rose-400' : 'text-zinc-400'

  return (
    <Card className="flex h-full flex-col border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <ScrollText className="h-4 w-4 text-zinc-500" aria-hidden />
          Motor Günlüğü
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden pb-3">
        <ScrollArea className="h-[188px] rounded-lg border border-zinc-800 bg-zinc-950/60">
          <div className="space-y-1 p-2.5 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 && <p className="text-zinc-600">Henüz kayıt yok…</p>}
            {logs.map((l, i) => (
              <div key={`${l.t}-${i}`} className="flex gap-2">
                <span className="shrink-0 text-zinc-600">{fmtTime(l.t)}</span>
                <span className={colorFor(l.level)}>{l.msg}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
