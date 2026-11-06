# Northflank — kalıcı 7/24, $0 yol (⛔ ŞU AN GİRİŞ YAPILAMIYOR — bekletiliyor)

> **DURUM (3-4 Kasım 2026):** 30 Ekim sızıntısının ardından Networking / Services /
> Builds / Certificates bileşenleri hâlâ **major outage**; kayıt ve giriş hiçbir yolla
> (form + GitHub OAuth dahil) çalışmıyor. Platform arkası çökmüş durumda — kullanıcı
> hatası değil. **Aktif plan: `deploy/render.md`** (Render $0). Bu sayfa iyileşince
> tekrar dene — kalıcı diskli, uykusuz, 0.5 CPU olduğu için long-term olarak Render'dan iyi.

> **Not (3 Kasım 2026):** ClawCloud kapandı — 1 Haziran 2026'da yeni kaydı durdurdu,
> 30 Haziran 2026'da barındırma servisini tamamen kapattı; `run.claw.cloud` artık DNS'te
> çözümlenmiyor. O yüzden link hiç açılmıyordu — cihaz/ülke engeli değil, servis öldü.
> Yeni ana plan: **Northflank Sandbox** (ücretsiz katman).

## Neden burası?
- **Sandbox planı ücretsiz, kart yok**: 2 servis + 2 job + 1 veritabanı, ayda **$20'ya kadar kaynak** kullanımı cepten $0
- **Uyumaz** — "Always on, no sleeping" resmen yazıyor (Render/Koyeb gibi 15 dk uyuma yok)
- **Kalıcı disk (NVMe volume)** → SQLite işlem geçmişi reset yemez
- **Bölge seçilir** (Frankfurt/London gibi AB bölgeleri var) → Binance ABD IP engelinden uzak
- Toplam maliyetimiz: 0.5 vCPU/1 GB plan ($12/ay) + 2 GB disk (~$0.23/ay) ≈ **$12.3/ay → $20 kotasının içinde → cepten $0**

### ⚠️ Bilinmesi gereken (güvenlik olayı)
Northflank, **30 Ekim 2026'da bir sızma yaşadı**: mevcut workload'ların ortam
değişkenleri çözülebilmiş, bazı kullanıcıların AI API anahtarları kötüye kullanılmış.
Platform 31 Ekim'de yamaladı, denetim günlüklerini herkese açtı ve toparlandı
(durum sayfası: status.northflank.com — App/API şu an çalışır durumda).
**Bizim için pratik anlamı:** olaydan SONRA açılan yeni hesap eski sızıntının
içinde değil. Yine de bot'a sonradan girilecek Binance API anahtarı **sadece
trade yetkili (withdrawal KAPALI)** olmalı — bu zaten scalper kuralı, şimdi iki kat önemli.

## $0 mimari (değişmedi)
```
public GitHub repo (bitbey27/katlabot)
  → GitHub Actions (public repoda dakika limiti yok)
  → ghcr.io/bitbey27/katlabot:latest  (public paket = depolama ÜCRETSİZ, anonim pull ✅ doğrulandı)
  → Northflank imajı çeker ve çalıştırır
```
Kod public olduğu için imajda **SQLite DB yok** (bakiye + geçmiş dışarı sızmasın).
Motor taze DB açar; Northflank kalıcı diski devralır. PAPER modda, içinde API anahtarı yok.

## Adımlar (Northflank iyileştiğinde uygula)

### 1. Hesap aç (sen — ~2 dk)
**Önerilen yol: e-posta formunu değil `GitHub` butonunu kullan.**
1. https://app.northflank.com/signup → **GitHub** butonuna bas → `bitbey27` hesabıyla onayla
   (reCAPTCHA/form hatası bu yolda yaşanmaz; repo erişimi istemez, istese de sadece okuma)
2. E-posta formunda ısrar edersen:
   - önce **Log in** dene (aynı e-posta ile kısmen açılmış hesap kalmış olabilir → "unknown error"in en yaygın sebebi)
   - giriş çalışmazsa **Forgot password** akışını dene
   - kullanıcı adını değiştir (`maskelikatil` alınmış olabilir)
   - gizli sekme + mobil veri/WiFi değiştir; yine olursa birkaç saat sonra tekrar dene (olay sonrası toparlanma sürüyor)

### 2. Proje oluştur
Login sonrası: **Create project** → isim: `katlabot` → Sandbox (free) plan.

### 3. Servis oluştur (imajdan — build'e gerek yok)
**Create new → Service → Deploy an image / External image** (container registry'den):

| Alan | Değer |
|---|---|
| Registry | `ghcr.io` (kimlik bilgisi isterse: kullanıcı `bitbey27` + **read:packages** yetkili PAT; public imaj için genelde istemez) |
| Image path | `bitbey27/katlabot:latest` |
| Region | **Frankfurt** (yoksa London) — ABD bölgesi seçme (Binance IP engeli) |
| Plan | **nf-compute-50** (0.5 vCPU · 1 GB) = $12/ay — `nf-compute-100` ($24/ay) $20 kotasını AŞAR, seçme |
| Instances | 1 |

### 4. Ağ (Networking)
- **Ports → Add port**: `7860`, tip **HTTP (public)** → otomatik `https://...code.run` adresi + TLS alırsın
- Public URL basic auth ile korunuyor (`PANEL_USER`/`PANEL_PASS`)

### 5. Ortam değişkenleri (Environment → Secrets/Variables)
| Değişken | Değer | Not |
|---|---|---|
| `ENGINE_AUTOSTART` | `1` | taze DB ile bot kendiliğinden başlar (sonra DB'deki bayrak kazanır) |
| `PANEL_USER` | ör. `katla` | panel basic auth kullanıcı adı |
| `PANEL_PASS` | güçlü bir şifre | panel basic auth — public URL için ÖNERİLİR |

### 6. Kalıcı disk (Volumes → + create)
Mount Path: `/app/.next/standalone/mini-services/trade-engine/db` · **2 GB** (ayrıca ~$0.23)

> **Dikkat — gerçek DB yolu:** Next standalone sunucusu `process.chdir` yaptığı için motor
> `.next/standalone/mini-services/trade-engine` altından çalışır ve DB'yi orada açar.
> Kalıcı disk MUTLAKA bu yola bağlanmalı, yoksa her yeniden doğuşta geçmiş silinir.
>
> Disk ilk takılışta boş olur → motor taze DB açar (bakiye = panel `startBalance` ayarı).
> Farklı bir bakiyeye taşımak istersen panelden Bakiye alanını düzelt (tohum: 100 USDT).

### 7. Sonuç
- Public Address: `https://katlabot-....code.run` tarzı URL
- Panel açılır → tarayıcı kullanıcı/şifre sorar → motor 5-10 sn içinde bağlanır → bot (ENGINE_AUTOSTART=1) işlemeye başlar

## Yedek yol: Git'ten build (imaj yolu takılırsa)
Create new → Service → **Combined (build + deploy)** → deployment source: Git →
public repo `https://github.com/bitbey27/katlabot`, branch `main`, build type **Dockerfile**.
GitHub hesabı bağlantısı isterse bağla (sadece seçtiğin repolere okuma verir;
**seslichat projesine hiç dokunma, onu seçme**). Build ~5 dk sürer, kaynak kotası aynı.

## Bütçe özeti (aylık)
| Kalem | Tutar |
|---|---|
| nf-compute-50 (0.5 vCPU · 1 GB, 7/24) | $12.00 |
| 2 GB kalıcı disk | ~$0.23 |
| Trafik (bot + panel, ~5 GB egress) | ~$0.30 |
| **Toplam** | **~$12.5 / $20 kota → cepten $0** ✅ |
