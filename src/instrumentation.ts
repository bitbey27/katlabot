// ============================================================
// Next.js instrumentation — sunucu her açılışında çalışır.
//
// Görevi: trade-engine (port 3003, `bun index.ts`) süreçlerini
// sandbox yenilendiğinde kaybediyoruz; Next.js denetimci tarafından
// otomatik geri gelen tek süreç bu sunucudur. Motoru buradan
// ayrık süreç olarak başlatarak dashboard'la birlikte yaşam
// döngüsüne bağlıyoruz. Port kontrolü sayesinde idempotenttir:
// motor zaten çalışıyorsa hiçbir şey yapmaz.
// ============================================================

export async function register() {
  // yalnız Node.js sunucu çalışma zamanında (edge'de değil)
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { ensureEngineRunning } = await import('./lib/engine-spawn')
    const r = await ensureEngineRunning()
    console.log(`[instrumentation] trade-engine: ${r.msg}`)
  } catch (e) {
    console.error(`[instrumentation] trade-engine başlatılamadı: ${String(e)}`)
  }
}
