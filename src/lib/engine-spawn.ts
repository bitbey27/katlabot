// ============================================================
// Motor yaşam döngüsü yardımcısı (yalnız sunucu tarafı)
//
// KÖK NEDEN (tespit edilen hata): sandbox oturum yenilendiğinde
// süreçler kapanır — Next.js denetimci tarafından geri gelir ama
// `bun index.ts` (port 3003) KENDİ KENDİNE geri gelmez. Dashboard
// bu yüzden "Motor'a bağlanılıyor…" perdesinde sonsuza dek bekler.
//
// Çözüm: motor, dashboard sunucusunun yaşam döngüsüne bağlandı.
//   1) instrumentation.ts → Next açılırken motoru spawn eder
//   2) /api/engine/start  → istemci tarafı kendinden iyileştirme:
//      snapshot gelmiyorsa sayfa bu uca POST atar
// İkisi de bağlantı-noktası kontrolüyle idempotent: çalışan
// motora dokunmaz, çift süreç açmaz.
// ============================================================

import { spawn } from 'child_process'
import { existsSync, openSync } from 'fs'
import { join } from 'path'
import net from 'net'

const ENGINE_PORT = 3003
const ENGINE_DIR = join(process.cwd(), 'mini-services', 'trade-engine')
const ENGINE_LOG = '/tmp/engine.log'

// geliştirme sunucusu yeniden derlenirken aynı süreçte ikinci spawn'u engelle
const g = globalThis as unknown as { __katlaEngineSpawnBusy?: boolean }

function bunBin(): string {
  return existsSync('/usr/local/bin/bun') ? '/usr/local/bin/bun' : 'bun'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Motor dinliyor mu? (TCP bağlantı denemesi — HTTP'den hızlı ve kesin) */
export function isEngineUp(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ port: ENGINE_PORT, host: '127.0.0.1' })
    s.setTimeout(800)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => { s.destroy(); resolve(false) })
  })
}

/**
 * Motoru (gerekirse) başlat. Ayrık (detached) süreç olarak açılır:
 * dashboard'un ömrüne bağlı kalmaz; sandbox süreç temizliğinde
 * kapatılırsa bir sonraki Next açılışında veya API çağrısında geri gelir.
 */
export async function ensureEngineRunning(): Promise<{ ok: boolean; started: boolean; msg: string }> {
  if (await isEngineUp()) return { ok: true, started: false, msg: 'motor zaten çalışıyor' }
  if (g.__katlaEngineSpawnBusy) return { ok: true, started: false, msg: 'motor zaten başlatılıyor' }
  g.__katlaEngineSpawnBusy = true
  try {
    const out = openSync(ENGINE_LOG, 'a')
    const child = spawn(bunBin(), ['index.ts'], {
      cwd: ENGINE_DIR,
      detached: true,          // kendi oturumuna ayrılır → bash zincirinden kopar
      stdio: ['ignore', out, out],
      env: { ...process.env },
    })
    child.unref()
    child.once('error', (e) => console.error(`[engine-spawn] başlatılamadı: ${String(e)}`))
    // WS + mum yüklemesi için ~10-20sn tanı — port hazır olana dek bekle
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      if (await isEngineUp()) {
        console.log(`[engine-spawn] motor ayağa kalktı (pid ${child.pid})`)
        return { ok: true, started: true, msg: 'motor başlatıldı' }
      }
    }
    return { ok: false, started: true, msg: 'motor 15sn içinde port açmadı — /tmp/engine.log dosyasına bakın' }
  } finally {
    g.__katlaEngineSpawnBusy = false
  }
}
