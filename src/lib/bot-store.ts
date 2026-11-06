'use client'

// ============================================================
// KatlaBot durum deposu (zustand) — 1Hz durum + 4Hz fiyat vuruşu
// ============================================================

import { create } from 'zustand'
import type { EngineSnapshot, TickData } from './engine-types'

interface BotState {
  socketConnected: boolean
  snapshot: EngineSnapshot | null
  tick: TickData | null
  lastUpdate: number
  setSocketConnected: (v: boolean) => void
  setSnapshot: (s: EngineSnapshot) => void
  setTick: (t: TickData) => void
}

export const useBotStore = create<BotState>((set) => ({
  socketConnected: false,
  snapshot: null,
  tick: null,
  lastUpdate: 0,
  setSocketConnected: (v) => set({ socketConnected: v }),
  setSnapshot: (s) => set({ snapshot: s, lastUpdate: Date.now() }),
  setTick: (t) => set({ tick: t }),
}))

/** En güncel fiyat (tick varsa tick, yoksa durum anlık görüntüsü) */
export function useLivePrice(): number {
  const tick = useBotStore((s) => s.tick)
  const snapshot = useBotStore((s) => s.snapshot)
  if (tick && Date.now() - tick.t < 5000) return tick.p
  return snapshot?.price ?? 0
}

/** En güncel pozisyon görünümü (4Hz tick'ten) */
export function useLivePosition() {
  const tick = useBotStore((s) => s.tick)
  const snapshot = useBotStore((s) => s.snapshot)
  if (tick && Date.now() - tick.t < 5000 && tick.pos !== undefined) return tick.pos
  return snapshot?.position ?? null
}

/** En güncel bid/ask (4Hz tick'ten, yoksa 1Hz durumdan) */
export function useLiveBidAsk(): { bid: number; ask: number; spreadPct: number } {
  const tick = useBotStore((s) => s.tick)
  const snapshot = useBotStore((s) => s.snapshot)
  const fresh = tick && Date.now() - tick.t < 5000
  const bid = fresh && tick.b ? tick.b : (snapshot?.bid ?? 0)
  const ask = fresh && tick.a ? tick.a : (snapshot?.ask ?? 0)
  return { bid, ask, spreadPct: snapshot?.spreadPct ?? 0 }
}
