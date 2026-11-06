// ============================================================
// KatlaBot Engine Server — Socket.IO (port 3003)
// Not: socket.io yolu '/' olduğu için (Caddy yönlendirme şartı)
// tüm istemci iletişimi socket.io olayları üzerinden yürür:
//   - istemci → sunucu : 'control' (ack'li), 'get-state'
//   - sunucu → istemci : 'state' (1Hz tam durum), 'tick' (4Hz fiyat)
// ============================================================

import { createServer } from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { Server } from 'socket.io'
import { TradeEngine } from './src/engine'
import type { ControlAction } from './src/types'

const PORT = 3003
const httpServer = createServer()
const io = new Server(httpServer, {
  // Caddy yönlendirmesi için yol DEĞİŞTİRİLMEZ
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ?XTransformPort=3003 sorgusuyla gelen NORMAL SAYFA isteği motora düşer
// (proxy bu isteği 3003'e yönlendirir). Motor bir web sayfası servis etmez;
// el sıkışma olmayan (EIO yok) her isteğe yönlendirme sayfası verilir.
// Aksi halde tarayıcıda ham JSON görünür: {"code":0,"message":"Transport
// unknown"} — paylaşılan linkin bozuk görünmesinin sebebi buydu.
// Middleware, el sıkışma doğrulamasından ÖNCE çalıştığı için bunu yakalar.
io.engine.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
  const url = req.url ?? '/'
  if (!url.includes('EIO=')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>KatlaBot</title>'
      + '<meta http-equiv="refresh" content="0;url=/">'
      + '<style>body{background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
      + '.box{text-align:center;padding:2rem}</style></head>'
      + '<body><div class="box"><h2>KatlaBot motoru çalışıyor</h2><p>Dashboard sayfasına yönlendiriliyorsunuz…</p></div></body></html>')
    return
  }
  next()
})

const engine = new TradeEngine()

type ControlResult = { ok: boolean; msg: string }

async function handleControl(a: ControlAction): Promise<ControlResult> {
  switch (a.action) {
    case 'start': return engine.start()
    case 'stop': return engine.stop()
    case 'close': return engine.manualClose()
    case 'reset': return engine.resetAll()
    case 'resetBalance': return engine.resetBalance()
    case 'setBalance': return engine.setBalance(a.balance ?? 0)
    case 'updateSettings': return engine.updateSettings(a.settings ?? {}, a.apiKey, a.apiSecret)
    case 'clearFloor': return engine.clearFloor()
    // Not: 'backtest' / 'backtestApply' kaldırıldı — motor yalnız canlı değerlendirme yapar
    default: return { ok: false, msg: 'Bilinmeyen işlem' }
  }
}

io.on('connection', (socket) => {
  console.log(`[KatlaBot] İstemci bağlandı: ${socket.id}`)
  // Yeni istemciye anında tam durum gönder
  socket.emit('state', engine.snapshot())

  socket.on('control', (a: ControlAction, ack?: (r: unknown) => void) => {
    void handleControl(a)
      .then((result) => {
        ack?.(result)
        // ayar/başlat/durdur değişikliklerini herkese anında yansıt
        io.emit('state', engine.snapshot())
      })
      .catch((e) => ack?.({ ok: false, msg: String(e) }))
  })

  socket.on('get-state', (_: unknown, ack?: (r: unknown) => void) => {
    const snap = engine.snapshot()
    if (ack) ack(snap)
    else socket.emit('state', snap)
  })

  socket.on('disconnect', () => {
    console.log(`[KatlaBot] İstemci ayrıldı: ${socket.id}`)
  })
})

// 1Hz tam durum yayını
setInterval(() => {
  if (io.engine.clientsCount > 0) io.emit('state', engine.snapshot())
}, 1000)

// 4Hz hızlı fiyat vuruşu (grafiklerin canlı çizgisi + pozisyon K/Z için)
// — displaySymbol: çoklu taramada grafikte gösterilen coin
setInterval(() => {
  if (io.engine.clientsCount > 0 && engine.price > 0) {
    io.emit('tick', {
      sym: engine.displaySymbol(),
      p: engine.price,
      t: Date.now(),
      m: engine.markPrice,
      b: engine.bid,
      a: engine.ask,
      pos: engine.openPositionView(),
    })
  }
}, 250)

// ---------------- Başlat ----------------

engine.boot().then(() => {
  console.log(`[KatlaBot] Motor hazır — mod: ${engine.settings.scanMode}, semboller: ${engine.activeSymbols().join(', ')}`)
}).catch(e => console.error('[KatlaBot] Başlatma hatası:', e))

httpServer.listen(PORT, () => {
  console.log(`[KatlaBot] Engine sunucusu ${PORT} portunda dinliyor`)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)) })
process.on('uncaughtException', (e) => console.error('[KatlaBot] Yakalanmamış hata:', e))
