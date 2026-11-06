'use client'

// Sayı/para/süre biçimlendirme yardımcıları (TR yerel ayarına yakın, sabit basamak)

export function fmtPrice(p: number | undefined | null, digits?: number): string {
  if (p === undefined || p === null || !isFinite(p)) return '—'
  const d = digits ?? priceDigits(p)
  return p.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function priceDigits(p: number): number {
  if (p >= 10000) return 2
  if (p >= 100) return 2
  if (p >= 1) return 3
  return 6
}

export function fmtUsd(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  return `${sign}${Math.abs(v).toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function fmtSignedUsd(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !isFinite(v)) return '—'
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return `${sign}${Math.abs(v).toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function fmtPct(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !isFinite(v)) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)}%`
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour12: false })
}

export function fmtTimeSec(ts: number): string {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour12: false, second: '2-digit' })
}

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} sn`
  const m = Math.floor(s / 60)
  return `${m}dk ${s % 60}sn`
}

export function pnlClass(v: number): string {
  if (v > 0) return 'text-emerald-400'
  if (v < 0) return 'text-rose-400'
  return 'text-zinc-400'
}

export const EXIT_REASON_TR: Record<string, string> = {
  TAKE_PROFIT: 'Kâr Alındı',
  STOP_LOSS: 'Zarar Kesildi',
  SIGNAL_FLIP: 'Sinyal Tersleşti',
  TIMEOUT: 'Süre Doldu',
  MANUAL: 'Manuel',
  RECON: 'Mutabakat Düzeltmesi',
  TRAIL: 'Kâr Kilitlendi',
  MOMENTUM: 'Momentum Öldü',
  DAILY_STOP: 'Günlük Tavan',
  TOTAL_FLOOR: 'Toplam Bakiye Tabanı',
}
