# Render — $0 ACİL PLAN (dashboard ile Git deploy — Kasım 2026)

> **Durum (4 Kasım 2026):** Northflank hâlâ major outage (Networking/Services/Builds çökük, giriş yok).
> Render'da **API ile servis oluşturma bu hesapta 402 kart engeli** yedi ("Payment information
> is required") — imaj yolu da Git yolu da aynı. Yeni hesap + verimerkezi IP'sinden API üzerinden
> ilk servis oluşturma, risk sinyali olarak değerlendirilmiş olabilir.
> **Aktif yol: Render DASHBOARD'tan, kullanıcının kendi telefonundan manuel Git deploy.**
> **4 Kasım güncelleme:** Servis dashboard'dan OLUŞTURULDU (`srv-dbl1cmdbedkc73eqqm70`,
> `https://katlabot.onrender.com`, Frankfurt, free). **Kalıcı deploy 5 Kasım: commit 59e177e**
> (düzelttilmiş Caddyfile + A-paketi varsayılanları) — live, dockerCommand runtime fix KALDIRILDI.

## Neden Render?
- **Kart YOK** (Hobby workspace $0 — dashboard akışında istenmiyorsa)
- Public repomuzdan **Dockerfile build** (GitHub Actions'a ihtiyaç yok, imaj çekmeye de gerek yok)
- **WebSocket desteği** — panel Socket.IO + Binance WS sorunsuz
- **Frankfurt bölgesi** → Binance ABD IP engelinden uzak
- $0: Free instance (512 MB RAM, paylaşımlı CPU), 750 saat/ay = tek 7/24 servis için yeter

### Sınırlar (bilinçli kabul)
| Sınır | Etki | Çözüm |
|---|---|---|
| 15 dk içgelen trafik yoksa **uykuya girer** (~1 dk uyanma) | bot durur | **Pinger** (cron-job.org, dakikalık) |
| Kalıcı disk YOK | deploy/restart'ta SQLite sıfırlanır | taze DB + `ENGINE_AUTOSTART=1` → bot kendiliğinden başlar (PAPER mod — kabul) |
| 512 MB RAM / paylaşımlı CPU | panel hafif yavaş | kağıt scalper için yeter |
| 500 build dk/ay | her push ~8 dk build | seyrek push yap |

### Port uyumu (otomatik)
Render web servisine `PORT=10000` verir; Caddyfile `:{$PORT:7860}` onu takip eder → eşleşir.
Dashboard'da port ayarı yapmaya gerek yok.

### 🔧 Kök neden kaydı (3-4 Kasım 2026 — çözüldü)
İlk Caddyfile'da site adresi `{$PORT:7860}` idi (başta `:` YOK). `PORT=10000` gelince
Caddy bunu **hostname "10000"** yorumladı → otomatik HTTPS/ACME döngüsüne girdi,
`:443` dinledi, **10000 hiç açılmadı** → Render "still scanning port 10000" + ACME
hata selleri (kullanıcının gördüğü error kodları). Caddy v2.11.7 ile adapt testi
kanıtladı: düzeltilmiş `:{$PORT:7860}` → dinleyici `:10000`, host yok, ACME yok.
Yerel `deploy/Caddyfile` düzeltlidi (commit fdd4f4e, 3 Kasım 17:47Z) ama GitHub'a
**hiç push edilmedi** — deploy edilen 41d8ef0'da hâlâ bozuk (raw.githubusercontent
üzerinden doğrulandı, 4 Kasım).

**5 Kasım — TOHUM BAKİYE 100 (restart sonrası 93.36'ya dönüş düzeltildi):** Kullanıcı
panelden bakiyeyi 100 yapıyordu; her deploy/restart/uyku-uyanma sonrası 93.36'ya
dönüyordu — free planda disk kalıcı olmadığından SQLite silinip `store.ts`
`DEFAULT_SETTINGS.startBalance` (93.36, o günkü gerçek bakiye) uygulanıyordu. Tohum
**93.36 → 100** yapıldı: artık her taze DB 100 USDT'den açılır (işlem geçmişi restart'ta
yine sıfırlanır — free sınırı, kalıcı tarih için northflank.md).

**5 Kasım — KALICI ÇÖZÜM PUSH EDİLDİ:** Yeni PAT alındı (klasik ghp_, yalnız bu repo,
iş bitince rotate/sil). `GH_TOKEN=… bun scripts/deploy-git.ts github katlabot --public`
→ commit **59e177e** → autoDeploy 2,5 dk'da **live**. Aynı push'ta A-paketi ayarları
`store.ts` DEFAULT_SETTINGS'e gömüldü (TP/SL 0.9 · kilit 0.30/0.15 · tutuş 600s ·
soğuma 90s · taker eşiği 1.5 · startBalance 93.36) — artık her restart/uyku sonrası
DB sıfırlansa bile bot DOĞRU ayarlarla ve 93.36 bakiyeyle açılır. Canlıdan doğrulandı.
Not: Render API'den servis OLUŞTURMA bu kartsız hesapta 402 verir; mevcut servisi
PATCH ile güncellemek (dockerCommand, ayarlar) ÇALIŞIR — bkz. `scripts/render_apply_cmd.py`.

**4 Kasım — GEÇİCİ RUNTIME FİX (TARİHE KARIŞTI):** `sh -c "..."` biçimli dockerCommand
**127** ile öldü — Render dockerCommand'i SHELL YORUMLAMASI OLMADAN çalıştırıyor
(tırnak/`;`/`||` KULLANMA; events API'de `nonZeroExit: 127` görülür). O zamanki çözüm:
`dockerCommand = /usr/bin/env PORT=:10000 /app/start.sh` (bozuk Caddyfile'e env'den
`:10000` verip port-dinleyici yapar; deploy dep-dbl28kdbedkc73esqds0 → LIVE, 18:16Z,
auth'suz 401 · auth'lu 200 · engine.io handshake ✅).
**5 Kasım'da repo Caddyfile düzeldiği için TEMİZLENDİ** (`render_apply_cmd.py --clear`)
— yeni deploy image ENTRYPOINT'iyle (tini + start.sh) açar. Ders kalıcı:
dockerCommand'da shell sözdizimi KULLANMA.

## Adımlar (dashboard — TELEFONDAN, kullanıcının kendi IP'siyle, ~5 dk)

1. **https://dashboard.render.com** → giriş (futurescoderbot@gmail.com)
   - e-posta doğrulama uyarısı çıkarsa önce onu tamamla
2. **New + → Web Service**
3. **Build and deploy from a Git repository** → **Public Git repository** alanına:
   `https://github.com/bitbey27/katlabot`
   (GitHub hesabı bağlamaya GEREK YOK — public link yeterli; bağlarsan da sadece bu repoyu seç, **seslichat'e dokunma**)
4. Ayarlar:

| Alan | Değer |
|---|---|
| Name | `katlabot` |
| Branch | `main` |
| Region | **Frankfurt (EU)** — ABD seçme |
| Runtime | Docker (otomatik algılanır — Dockerfile repo kökünde) |
| Instance Type | **Free** |

5. **Environment variables** (Environment bölümüne):

| Değişken | Değer | Not |
|---|---|---|
| `ENGINE_AUTOSTART` | `1` | taze DB'de bot kendiliğinden başlar |
| `PANEL_USER` | `katla` | panel basic auth kullanıcı adı |
| `PANEL_PASS` | güçlü bir şifre | public URL için ŞART |

6. **Deploy Web Service** → build ~5-8 dk → URL: `https://katlabot-xxxx.onrender.com`
7. **Logs** sekmesinde `[start] panel basic auth AKTIF` + motorun `socket.io` satırları görülmeli.

⚠️ **Health Check Path'i BOŞ bırak** (custom path koyarsan basic auth 401 döner, servis
"unhealthy" görünür; varsayılan kontrol yeterli).

## Pinger — KRİTİK, atlanması yasak 🚨
15 dk içgelen istek yoksa uyur (Binance'e giden DIŞ WS bağlantısı sayılmaz!):

1. **https://cron-job.org** → ücretsiz hesap
2. **Create Job** → URL: `https://<servis>.onrender.com/` → **Every 1 minute** → Create
3. Ping'e 401 dönse bile trafik sayılır — sorun değil.

## Servis oluştuktan sonra: API ile yönetim
Oluşturma adımındaki 402 engeli, MEVCUT servis yönetimini kapsamaz — `RENDER_API_KEY`
ile durum sorgulama, env güncelleme, deploy tetikleme çalışır
(`scripts/render_deploy_git.sh` içindeki poll bölümü, `curl /v1/services/<id>`).

- Deploy iptali: `POST /v1/services/<sid>/deploys/<did>/cancel` — DİKKAT: kök seviyeli
  `/v1/deploys/<did>/cancel` 404 verir; DOĞRUSU iç içe (nested) yol.
- Teşhis: `GET /v1/services/<sid>/events?limit=N` → `deploy_ended`/`build_ended` +
  `reason.failure.nonZeroExit` (127 = komut bulunamadı). Log endpoint'i (`/v1/logs`)
  bu hesapta parametre hatası veriyor — events kullan.
- Env değişkenleri: `PUT /v1/services/<sid>/env-vars` (listeyle wholesale değişir;
  `PORT=10000`'i listede tutmayı unutma). 4 Kasım'da `ENGINE_AUTOSTART=1` +
  `PANEL_USER`/`PANEL_PASS` bu yoldan yazıldı (şifre yalnız sohbet + Render env'de —
  repoya/CLI çıktısına ASLA yazma).

⚠️ API anahtarı sohbette paylaşıldı — kurulum bitince Render panelinden
(Account Settings → API Keys) **rotate edilmesi gerekiyor**.

## Dashboard da kart isterse?
- Banka **debit** kartı varsa eklenebilir — Free planda tahsilat $0 (750 saat/ay sınıra kadar).
- Kart yoksa Render elenir → Northflank'in düzelmesi beklenir (status.northflank.com;
  son kontrol 4 Kasım: Networking/Services/Builds hâlâ major outage) → düzelince
  `deploy/northflank.md` uygulanır (kart yok, kalıcı disk, uykusuz — long-term en iyisi).
- Elenenler: ClawCloud (kapandı), Modal (60 sn girişimsiz uyku), Back4App (AI pivot),
  Fly/Koyeb/Railway/Oracle/GCP (kart), HF (PRO), Zeabur (kapanıyor).

## Bakım notları
- Deploy/restart = DB sıfır → bakiye `store.ts` tohumuna döner (5 Kasım'dan beri **100
  USDT**). Panelden elle ayarladığın bakiye yalnız o oturumda yaşar. Geçmiş önemliyse panelden not al.
- 750 saat/ay: tek 7/24 servis = 744 saat → içeride. İkinci free servis AÇMA.
- Repo'ya push = otomatik rebuild (~8 dk) + DB sıfır — seyrek yap.
