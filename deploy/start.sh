#!/bin/sh
# ============================================================
# KatlaBot konteyner girişi
#   1. Caddy: platform portundan ($PORT) geleni panele/motora dağıtır
#   2. Next.js (standalone): panel — açılışta instrumentation
#      motoru (bun index.ts) kendiliğinden doğurur (özyaşam döngüsü)
#   3. Motor: DB'de autostart=1 ise bot DOĞRUDAN işlemeye başlar
# Süreçlerden biri ölürse konteyner ölür → platform yeniden başlatır.
# ============================================================
set -u
cd /app

# ---- isteğe bağlı panel kilidi (public URL için) ----
# PANEL_PASS tanımlıysa Caddy basic auth devreye girer (kullanıcı: PANEL_USER, varsayılan admin).
# Tanımsızsa auth.d boş kalır → davranış eskisiyle birebir aynı (auth yok).
if [ -n "${PANEL_PASS:-}" ]; then
        mkdir -p /app/auth.d
        HASH=$(caddy hash-password --plaintext "$PANEL_PASS")
        printf 'basic_auth {\n\t%s %s\n}\n' "${PANEL_USER:-admin}" "$HASH" > /app/auth.d/panel.caddy
        echo "[start] panel basic auth AKTIF — kullanici: ${PANEL_USER:-admin}"
else
        rm -f /app/auth.d/panel.caddy 2>/dev/null || true
        echo "[start] panel basic auth KAPALI (PANEL_PASS tanimli degil)"
fi

caddy run --config /app/Caddyfile --adapter caddyfile &
CADDY_PID=$!

PORT=3000 HOSTNAME=0.0.0.0 node /app/.next/standalone/server.js &
NODE_PID=$!

echo "[start] caddy(pid $CADDY_PID) + next(pid $NODE_PID) ayakta — dış port \${PORT:-7860}"

# sağlık gözcüsü: 5 sn'de bir iki süreci de kontrol et
while true; do
        if ! kill -0 "$CADDY_PID" 2>/dev/null; then
                echo "[start] CADDY KAPANDI — konteyner yeniden başlatılacak"
                exit 1
        fi
        if ! kill -0 "$NODE_PID" 2>/dev/null; then
                echo "[start] NEXT KAPANDI — konteyner yeniden başlatılacak"
                exit 1
        fi
        sleep 5
done
