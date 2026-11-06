# syntax=docker/dockerfile:1
# ============================================================
# KatlaBot — tek konteynerde tüm sistem
#   Caddy (giriş proxy, $PORT) → Next.js panel (:3000) + Bun motor (:3003)
#   Motor, Next instrumentation (engine-spawn) ile otomatik doğar ve
#   öz-yeniden-canlanır; SQLite kalıcılığı mini-services/.../db içinde.
#   HF Spaces / ClawCloud Run / herhangi bir Docker platformunda çalışır.
# ============================================================

# araç kaynakları
FROM oven/bun:1 AS bun-src

FROM node:22-slim

# Caddy (resmî download API artık ÇIPLAK binary döndürür — arşiv değil, tar YOK)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
 && chmod +x /usr/local/bin/caddy \
 && caddy version

# Bun motor çalıştırıcısı (oven imajından glibc ikilisi)
COPY --from=bun-src /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# ---- bağımlılıklar (kaynak değişse bile önbellekten gelir) ----
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY mini-services/trade-engine/package.json mini-services/trade-engine/bun.lock ./mini-services/trade-engine/
RUN cd mini-services/trade-engine && bun install --frozen-lockfile

# ---- kaynak + üretim derlemesi ----
COPY . .

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN ./node_modules/.bin/next build \
 && cp -r .next/static .next/standalone/.next/ \
 && cp -r public .next/standalone/ \
 && rm -rf .next/standalone/mini-services \
 && cp -r mini-services .next/standalone/mini-services \
 && cp deploy/Caddyfile /app/Caddyfile \
 && cp deploy/start.sh /app/start.sh \
 && chmod +x /app/start.sh

# ---- çalıştırma: node kullanıcısı (imajda hazır, UID 1000), yazılabilir dizinler ----
# (node:22-slim'de UID 1000 zaten `node`'a ait — useradd'a gerek yok, çakışma da yok)
RUN mkdir -p /data/caddy /data/caddy-config \
 && chown -R node:node /app /data
USER node
ENV XDG_DATA_HOME=/data/caddy \
    XDG_CONFIG_HOME=/data/caddy-config

EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--", "/app/start.sh"]
