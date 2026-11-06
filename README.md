---
title: KatlaBot
emoji: 🤖
colorFrom: gray
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# KatlaBot — Binance Futures Scalping (PAPER)

Tek konteynerde çalışan tam sistem:

- **Caddy** (giriş proxy) → **Next.js panel** (port 3000) + **Bun işlem motoru** (port 3003, Socket.IO)
- Motor, Next.js `instrumentation` kancasıyla otomatik doğar; çökerse panel API'si yeniden başlatır
- SQLite kalıcılığı: `mini-services/trade-engine/db/katlabot.db` (ayarlar + bakiye + işlem geçmişi)
- Bot açılışta `autostart` bayrağına göre kendiliğinden başlar

> Not: bu imajda DB yoktur — ilk açılışta motor taze SQLite DB açar.
> Kalıcı 7/24 için Render talimatına bakın (deploy/render.md). Northflank iyileşirse
> kalıcı diskli oraya taşınır (deploy/northflank.md).
