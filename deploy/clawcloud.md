# ClawCloud Run — ⛔ ÖLDÜ (30 Haziran 2026'da kapandı) — bkz. `northflank.md`

> **GEÇERSİZ:** ClawCloud 1 Haziran 2026'da yeni kayıt/satışı durdurdu, 30 Haziran 2026'da
> barındırmayı tamamen kapattı. `run.claw.cloud` artık DNS'te çözümlenmüyor (8.8.8.8 ve
> 1.1.1.1 üzerinden doğrulandı). Yeni ana plan: **`deploy/northflank.md`** — aşağıdaki içerik yalnızca arşiv amaçlıdır.

## Neden burası? (arşiv)
- **Ömür boyu $5/ay ücretsiz kredi** — GitHub hesabıyla giriş (180+ gün eski hesapta her ay yenilenir)
- **Kart / kimlik doğrulama yok**
- **Uyumaz** (Render/Koyeb/SnapDeploy gibi 15 dk-1 saatte uyuma yok)
- **Bölge seçilir**: Frankfurt / Tokyo / Singapore → Binance ABD IP engelinden uzak
- **Kalıcı disk (PVC)** → SQLite işlem geçmişi reset yemez
- Bizim app ~0.5 vCPU + 1 GB RAM + 1 GB disk ≈ **$3-4/ay → $5 kredinin içinde → cepten $0**

## $0 mimari (public repo)
```
public GitHub repo  →  Actions (public repoda dakika limiti YOK)
                   →  ghcr.io/<user>/katlabot:latest (public paket = depolama ÜCRETSİZ)
                   →  ClawCloud Launchpad imajı çeker (anonim pull, credential gerektirmez)
```
Kod public olur → bu yüzden deploy script'i `--public` modunda **SQLite DB'yi repoya koymaz**
(bakiye + işlem geçmişi dışarı sızmasın). Motor taze DB açar; ClawCloud'ta kalıcı disk devralır.
Bot yok, sırrı yok: PAPER modda çalışıyor, içinde hiçbir API anahtarı yok.

## Adımlar

### 1. Repo + imaj (ben yapıyorum)
```
GH_TOKEN=github_pat_...  bun scripts/deploy-git.ts github katlabot --public
```
- repo'yu açar, iter; Actions imajı ghcr.io'ya basar (~5 dk)
- script token'ı sadece bellekte kullanır; diske YAZILMAZ, ekrana BASILMAZ
- hesap yaşını da otomatik kontrol eder (180 gün şartı)

### 2. Hesap (sen — ~5 dk)
1. https://run.claw.cloud → **Get Started Free**
2. **GitHub ile giriş** (kredi bunu şart koşuyor; 180+ gün eski hesap = her ay $5)
3. Bölge: **Frankfurt** (ABD değil — Binance engeli)

### 3. Uygulama (App Launchpad → Create App)
| Alan | Değer |
|---|---|
| Name | katlabot |
| Image | `ghcr.io/<github-kullanıcı>/katlabot:latest` |
| CPU | 0.5 |
| Memory | 1 GB |
| Container Port | **7860** |
| Public Access | ✓ aç |

**Ortam değişkenleri (Environment → ekle):**
| Değişken | Değer | Not |
|---|---|---|
| `ENGINE_AUTOSTART` | `1` | taze DB ile bot kendiliğinden başlar (sonra DB'deki bayrak kazanır) |
| `PANEL_USER` | ör. `katla` | panel basic auth kullanıcı adı |
| `PANEL_PASS` | güçlü bir şifre | panel basic auth — public URL için **ÖNERİLİR** |

**Kalıcı disk (Local Storage → + add):**
Mount Path: `/app/.next/standalone/mini-services/trade-engine/db` · 1 GB

> **Dikkat — gerçek DB yolu:** Next standalone sunucusu `process.chdir` yaptığı için motor
> `.next/standalone/mini-services/trade-engine` altından çalışır ve DB'yi orada açar.
> Kalıcı disk MUTLAKA bu yola bağlanmalı, yoksa her yeniden doğuşta geçmiş silinir.
>
> Disk ilk takılışta boş olur → motor taze DB açar (bakiye = panel `startBalance` ayarı).
> Farklı bir bakiyeye taşımak istersen panelden Bakiye alanını düzelt (tohum: 100 USDT).

### 4. Sonuç
- Public Address: `https://katlabot-<workspace>.<bölge>.app.sealos.io` tarzı URL
- Panel açılır → tarayıcı kullanıcı/şifre sorar (`PANEL_USER`/`PANEL_PASS`) → motor 5-10 sn içinde bağlanır → bot (ENGINE_AUTOSTART=1) işlemeye başlar

## Yedek yol: private repo
`--public` olmadan çalıştırırsan repo private olur ve DB (100 bakiye + geçmiş) imaja girer.
O zaman Launchpad'de "Custom Registry" → ghcr.io + kullanıcı adı + PAT (read:packages).
Private repoda Actions 2000 dk/ay ücretsizdir (bizim build ~5 dk — bol bol yeter) ama
ghcr özel paket depolaması 500 MB ücretsiz limitine takabilir; imaj ~300-400 MB.
