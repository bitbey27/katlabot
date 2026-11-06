// ============================================================
// POST /api/engine/start — istemci tarafı kendinden iyileştirme
//
// Dashboard "Motor'a bağlanılıyor…" perdesinde 15sn'den uzun
// kalırsa bu uca POST atar; motor düşmüşse sunucu onu yeniden
// başlatır. Motor zaten çalışıyorsa hiçbir şey yapmaz (idempotent).
// ============================================================

import { NextResponse } from 'next/server'
import { ensureEngineRunning } from '@/lib/engine-spawn'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const r = await ensureEngineRunning()
    return NextResponse.json(r, { status: r.ok ? 200 : 500 })
  } catch (e) {
    return NextResponse.json(
      { ok: false, started: false, msg: `Motor başlatılamadı: ${String(e)}` },
      { status: 500 },
    )
  }
}

// kolay denetim için GET de izin ver (tarayıcıda hızlı kontrol)
export async function GET() {
  return POST()
}
