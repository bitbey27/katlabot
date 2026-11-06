'use client'

// Bot kontrol paneli — strateji göstergeleri, sinyal durumu, ücret matematiği
//
// "Anlık Değerlendirme" bölümü artık TEK SATIR metin değil:
//  1) Motor anlatımı (lastSignal) — giriş/çıkış olayları canlı anlatır
//  2) Giriş kapısı matrisi — her koşul ✓/✗ ile satır satır, saniye saniye
//     ("coin bulundu ama şu sebeple girmiyor" sorusunun cevabı)
//  3) Global kilitler — pozisyon/cooldown/günlük tavan durumu
//  4) Bekleme nedeni — ilk başarısız koşulun insan cümlesi

import { BrainCircuit, Gauge, ArrowUpDown, Coins, AlertTriangle, Check, X, Minus } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useBotStore } from '@/lib/bot-store'
import { fmtPrice } from '@/lib/format'
import type { GateCheck } from '@/lib/engine-types'

export function BotPanel() {
  const snap = useBotStore((s) => s.snapshot)
  const ind = snap?.indicators
  const s = snap?.settings
  const gate = snap?.gateDetail ?? null
  const lock = snap?.entryLock
  const disp = snap?.displaySymbol?.replace('USDT', '') ?? ''
  const d = snap ? (snap.price >= 100 ? 2 : snap.price >= 1 ? 3 : 6) : 2

  const trendBadge = ind?.trend1m === 'BULL'
    ? { text: 'BOĞA ↑', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' }
    : ind?.trend1m === 'BEAR'
      ? { text: 'AYI ↓', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-400' }
      : { text: 'DÜZ —', cls: 'border-zinc-600 bg-zinc-800/60 text-zinc-400' }

  const momBadge = ind?.momentum1s === 'UP'
    ? { text: 'YUKARI', cls: 'text-emerald-400' }
    : ind?.momentum1s === 'DOWN'
      ? { text: 'AŞAĞI', cls: 'text-rose-400' }
      : { text: 'DÜZ', cls: 'text-zinc-400' }

  const rsi = ind?.rsi1m ?? 50
  const rsiState = rsi > 70 ? 'Aşırı Alım' : rsi < 30 ? 'Aşırı Satım' : 'Nötr'
  const rsiColor = rsi > 70 ? 'text-rose-400' : rsi < 30 ? 'text-emerald-400' : 'text-zinc-300'

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <BrainCircuit className="h-4 w-4 text-emerald-400" aria-hidden />
          Strateji Motoru
          {disp && (
            <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] font-bold text-zinc-400">
              {disp}
            </span>
          )}
          <Badge variant="outline" className={`ml-auto border px-1.5 py-0 text-[10px] font-bold ${trendBadge.cls}`}>
            {trendBadge.text}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ---- Anlık Değerlendirme: saniye saniye giriş kapısı matrisi ---- */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-zinc-500">
            <Gauge className="h-3.5 w-3.5" aria-hidden />
            Anlık Değerlendirme
            {gate && (
              <>
                {/* yön adayı — trendin baktığı taraf */}
                {gate.side ? (
                  <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-bold ${gate.side === 'LONG'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-400'}`}>
                    {gate.side} adayı
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 px-1.5 py-0 text-[10px] font-bold text-zinc-500">
                    yön yok
                  </Badge>
                )}
                {/* canlılık nabzı — snapshot her saniye yenilenir */}
                <span className="ml-auto flex items-center gap-1.5 font-mono tabular-nums text-zinc-600">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  canlı {snap ? new Date(snap.serverTime).toLocaleTimeString('tr-TR', { hour12: false }) : '—'}
                </span>
              </>
            )}
          </div>

          {/* motor anlatımı — giriş/çıkış olaylarını tek cümleyle anlatır */}
          <p className="mb-2 font-mono text-[11px] leading-relaxed text-zinc-400">
            {ind?.lastSignal ?? 'Motor bağlanıyor…'}
          </p>

          {gate ? (
            <>
              {/* koşul matrisi — her satır: ikon + koşul + canlı değer */}
              <div className="divide-y divide-zinc-800/60 overflow-hidden rounded-md border border-zinc-800/70">
                {gate.checks.map((c) => (
                  <GateRow key={c.key} c={c} blocking={gate.blockKey === c.key} />
                ))}
              </div>

              {/* bekleme nedeni / hazır durumu */}
              {gate.blockKey === null ? (
                <div className="mt-2 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold leading-snug text-emerald-300">
                  <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {gate.blockLabel} · {gate.passed}/{gate.active} koşul tamam
                </div>
              ) : (
                <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] font-medium leading-snug text-amber-300">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    <span className="font-bold">NEDEN BEKLİYOR:</span> {gate.blockLabel}
                    <span className="text-amber-400/70"> · {gate.passed}/{gate.active} koşul tamam</span>
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-zinc-500">Kapı matrisi motor verisiyle doldurulacak…</p>
          )}

          {/* global kilitler — sembolden bağımsız "neden hiç girişyok" katmanı */}
          {lock && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {!lock.running ? (
                lock.hardStopped ? (
                  <LockChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300" title="TOPLAM bakiye tabanı aşıldı — bot kalıcı durdu, yalnız Tabanı Sıfırla ile devam eder">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden /> TOPLAM TABAN KİLİDİ ({lock.floorUsedPct.toFixed(1)}% / −%{lock.floorLimitPct})
                  </LockChip>
                ) : lock.dayStopped ? (
                  <LockChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300" title="Günlük zarar tavanı aşıldı — yarın otomatik sıfırlanır">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden /> GÜNLÜK TAVAN ({lock.dayLossPct.toFixed(1)}% / %{lock.dayLossLimitPct})
                  </LockChip>
                ) : (
                  <LockChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300" title="Bot çalışmıyor — Başlat düğmesiyle aç">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden /> BOT DURDU
                  </LockChip>
                )
              ) : lock.dayStopped ? (
                <LockChip cls="border-rose-500/40 bg-rose-500/10 text-rose-300" title="Günlük zarar tavanı aşıldı — yarın otomatik sıfırlanır">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden /> GÜNLÜK TAVAN ({lock.dayLossPct.toFixed(1)}% / %{lock.dayLossLimitPct})
                </LockChip>
              ) : lock.lossPauseRemainSec > 0 ? (
                <LockChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300" title="Üst üste net zarar — kanama kesme molası: tarama sürer, giriş kapalı">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden /> ZARAR MOLASI: {lock.lossStreak} zarar — {Math.ceil(lock.lossPauseRemainSec / 60)}dk kaldı
                </LockChip>
              ) : (lock.maxTradesPerDay ?? 0) > 0 && lock.tradesToday >= lock.maxTradesPerDay ? (
                <LockChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300" title="Günlük işlem tavanı doldu — yarın otomatik sıfırlanır">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden /> İŞLEM TAVANI: {lock.tradesToday}/{lock.maxTradesPerDay} — yarına kadar
                </LockChip>
              ) : lock.pendingSymbol ? (
                <LockChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300" title="Maker giriş emri defterde bekliyor — dolması için süre işliyor">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden /> EMİR BEKLİYOR: {lock.pendingSymbol.replace('USDT', '')} {lock.pendingSide}
                </LockChip>
              ) : lock.busySymbol ? (
                <LockChip cls="border-emerald-500/40 bg-emerald-500/10 text-emerald-300" title="Açık pozisyon var — keskin çıkış motoru yönetiyor, yeni giriş yapılmaz">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> POZİSYON: {lock.busySymbol.replace('USDT', '')} {lock.busySide} — çıkış motoru yönetiyor
                </LockChip>
              ) : lock.cooldownRemainSec > 0 ? (
                <LockChip cls="border-amber-500/40 bg-amber-500/10 text-amber-300" title="Son işlem sonrası bekleme süresi işliyor">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden /> BEKLEME {lock.cooldownRemainSec}sn
                </LockChip>
              ) : (
                <LockChip cls="border-zinc-700 bg-zinc-800/50 text-zinc-400" title="Motor serbest — uygun sinyali tarıyor">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> SERBEST — sinyal taranıyor
                </LockChip>
              )}
              {lock.running && !lock.dayStopped && lock.dayLossPct < -0.05 && (
                <LockChip cls="border-zinc-700 bg-zinc-800/50 text-zinc-500" title="Bugünkü bakiye değişimi — tavana yakınlık">
                  bugün {lock.dayLossPct.toFixed(1)}% (tavan −%{lock.dayLossLimitPct})
                </LockChip>
              )}
              {lock.running && (lock.maxTradesPerDay ?? 0) > 0 && (
                <LockChip cls="border-zinc-700 bg-zinc-800/50 text-zinc-500" title="Bugünkü işlem sayısı / günlük tavan (hedef 50-100)">
                  işlem {lock.tradesToday ?? 0}/{lock.maxTradesPerDay}
                </LockChip>
              )}
              {lock.running && !lock.hardStopped && lock.floorLimitPct > 0 && lock.floorUsedPct < -0.05 && (
                <LockChip cls="border-zinc-700 bg-zinc-800/50 text-zinc-500" title="Toplam bakiye tabanından kullanılan pay — kalıcı durma sigortası">
                  toplam {lock.floorUsedPct.toFixed(1)}% (taban −%{lock.floorLimitPct})
                </LockChip>
              )}
              {lock.running && lock.lossStreak > 0 && lock.lossPauseRemainSec === 0 && (
                <LockChip cls="border-zinc-700 bg-zinc-800/50 text-zinc-500" title="Üst üste zarar sayısı — limite yaklaşınca mola başlar">
                  zarar serisi {lock.lossStreak}/{lock.lossStreakLimit}
                </LockChip>
              )}
            </div>
          )}
        </div>

        {/* indikatör ızgarası */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">1dk EMA 9/21</div>
            <div className="mt-1 font-mono tabular-nums text-zinc-300">
              {fmtPrice(ind?.emaFast1m, d)} <span className="text-zinc-600">/</span> {fmtPrice(ind?.emaSlow1m, d)}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">1sn Momentum (EMA 3/8)</div>
            <div className={`mt-1 font-mono tabular-nums font-semibold ${momBadge.cls}`}>
              {momBadge.text} · {fmtPrice(ind?.emaFast1s, d)}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">RSI (14 · 1dk)</div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full ${rsi > 70 ? 'bg-rose-500' : rsi < 30 ? 'bg-emerald-500' : 'bg-amber-400'}`}
                  style={{ width: `${Math.min(100, Math.max(0, rsi))}%` }}
                  aria-hidden
                />
              </div>
              <span className={`font-mono tabular-nums font-semibold ${rsiColor}`}>{rsi.toFixed(1)}</span>
              <span className="text-[10px] text-zinc-600">{rsiState}</span>
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">Pozisyon Formülü</div>
            <div className="mt-1 font-mono tabular-nums text-zinc-300">
              {s ? `${s.allocationPct}% bakiye × ${s.leverage}x` : '—'}
            </div>
          </div>
        </div>

        {/* ücret matematiği — kullanıcının net kâr garantisi */}
        {s && snap && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-950/15 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
              <Coins className="h-3.5 w-3.5" aria-hidden />
              Ücret Farkındalığı (net kâr şartı)
            </div>
            <div className="space-y-1 font-mono text-[11px] leading-relaxed tabular-nums text-zinc-400">
              <div className="flex justify-between"><span>Gidiş-dönüş taker ücreti</span><span className="text-amber-400">%{snap.feeBreakevenPct.toFixed(3)}</span></div>
              <div className="flex justify-between"><span>Kâr alım eşiği (TP)</span><span className="text-emerald-400">%{s.takeProfitPct.toFixed(3)}</span></div>
              <div className="flex justify-between"><span>Garantili net marj</span><span className="text-emerald-400">%{(s.takeProfitPct - snap.feeBreakevenPct).toFixed(3)} (+{((s.takeProfitPct - snap.feeBreakevenPct) * s.leverage).toFixed(2)}% marj)</span></div>
              <div className="flex justify-between"><span>Zarar kes (SL)</span><span className="text-rose-400">%{s.stopLossPct.toFixed(3)}</span></div>
            </div>
          </div>
        )}

        {/* bileşik büyüme notu */}
        <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-[11px] leading-relaxed text-zinc-500">
          <ArrowUpDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
          <span>
            Pozisyon boyutu güncel bakiyeden hesaplanır — her net kâr bir sonraki işlemin tabanını büyütür
            (<span className="text-zinc-300">bileşik katlama</span>). Maksimum kaldıraç <span className="text-zinc-300">10x</span> ile sınırlıdır.
          </span>
        </div>

        {snap?.settings.mode === 'LIVE' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-950/20 p-2.5 text-[11px] leading-relaxed text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>CANLI İŞLEM modu aktif — emirler Binance Futures hesabınızdan gerçek parayla gönderilir.</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Tek koşul satırı — ✓ geçti · ✗ ENGEL (vurgulu) · – yönsüz/filtre kapalı */
function GateRow({ c, blocking }: { c: GateCheck; blocking: boolean }) {
  const icon = c.ok === true
    ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="geçti" />
    : c.ok === false
      ? <X className="h-3.5 w-3.5 text-rose-400" aria-label="engel" />
      : <Minus className="h-3.5 w-3.5 text-zinc-600" aria-label="işlevsel değil" />
  return (
    <div
      className={`flex items-center gap-2 px-2 py-[3px] text-[11px] leading-relaxed ${blocking
        ? 'bg-rose-500/[0.08] font-semibold text-zinc-200'
        : c.ok === true
          ? 'text-zinc-400'
          : c.ok === false
            ? 'text-zinc-400'
            : 'text-zinc-500/70'}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={`shrink-0 ${blocking ? 'text-rose-300' : 'text-zinc-500'}`}>{c.label}</span>
      <span className={`ml-auto truncate font-mono tabular-nums ${blocking ? 'text-rose-300' : c.ok === true ? 'text-zinc-300' : 'text-zinc-500'}`} title={c.value}>
        {c.value}
      </span>
    </div>
  )
}

/** Global kilit rozeti — motoru girişten alıkoyan durum */
function LockChip({ cls, title, children }: { cls: string; title: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${cls}`}
    >
      {children}
    </span>
  )
}
