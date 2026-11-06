'use client'

// ============================================================
// Motor socket.io bağlantısı — tekil (singleton) istemci
// Gateway kuralı: yol her zaman '/', port sadece XTransformPort ile
// ============================================================

import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import type { ControlAction, ControlResult, EngineSnapshot, TickData } from './engine-types'

let socket: Socket | null = null
let refCount = 0

export function getEngineSocket(): Socket {
  if (!socket) {
    // Yerel geliştirme: space-z proxy'si yok → motora doğrudan bağlan.
    // Yayın ortamı: gateway kuralı — yol '/', port XTransformPort sorgusuyla.
    const isLocalDev = typeof window !== 'undefined'
      && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
    socket = io(isLocalDev ? 'http://127.0.0.1:3003' : '/?XTransformPort=3003', {
      path: '/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
    })
  }
  refCount++
  return socket
}

export function releaseEngineSocket() {
  refCount = Math.max(0, refCount - 1)
  // socket bilinçli olarak canlı kalır — sayfa ömrü boyunca tek bağlantı
}

export function sendControl(action: ControlAction, onResult?: (r: ControlResult) => void) {
  if (!socket || !socket.connected) {
    onResult?.({ ok: false, msg: 'Motor bağlantısı yok — yeniden bağlanıyor' })
    return
  }
  socket.emit('control', action, (r: ControlResult | undefined) => {
    onResult?.(r ?? { ok: false, msg: 'Motor yanıt vermedi' })
  })
}

export function requestState() {
  socket?.emit('get-state', null)
}

export type { EngineSnapshot, TickData }
