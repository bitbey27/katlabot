'use client'

// Ayarlar dialogu — iki katmanlı düzen:
//   1) Ana görünüm: yalnız temel ayarlar (mod, tarama, kaldıraç, TP/SL, bakiye)
//   2) "Gelişmiş Ayarlar" bölmesi: strateji parametreleri — her ayarın altında
//      ÖNERİLEN değer + "neye göre değiştirilir" notu
//   3) En altta: önerilen ayarlar kartı + tek tıkla "Önerilere Dön"
// Form, dialog her açıldığında yeniden mount edilerek güncel ayarlarla başlar

import { useState } from 'react'
import {
  Settings2, ShieldAlert, KeyRound, RotateCcw, Trash2, Save, Radar, Gauge, Wallet,
  Activity, Layers, Crosshair, ChevronDown, SlidersHorizontal, Sparkles, Info,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useBotStore } from '@/lib/bot-store'
import { sendControl } from '@/lib/engine-socket'
import type { BotSettings, EngineSnapshot } from '@/lib/engine-types'
import { useToast } from '@/hooks/use-toast'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT']

/**
 * ÖNERİLEN AYARLAR (A-paketi v2 — 5 Kasım canlı verisiyle ayarlandı).
 * "Önerilere Dön" bu değerleri forma yazar; kaydetmek kullanıcıya kalır.
 * Rasyonel: 13 işlemlik gün — tüm kâr kilit çıkışından (+0.62), tüm kanama
 * momentum-ölümü çıkışından (−1.56) gelmişti; gürültü paketi bu ölçütle kuruldu.
 */
const RECOMMENDED: Partial<BotSettings> = {
  takeProfitPct: 0.90,
  stopLossPct: 0.90,
  trailArmPct: 0.35,
  trailPct: 0.20,
  momPersistSec: 10,
  cooldownSec: 90,
  maxHoldSec: 600,
  atrAdaptive: true,
  atrTpMult: 1.2,
  atrSlRatio: 1.8,
  riskParity: true,
  riskPct: 0.5,
  makerEntry: true,
  makerFeePct: 0.018,
  makerWaitSec: 3,
  takerMinScore: 1.5,
  minScore: 0.15,
  flowFilter: true,
  flowThreshold: 0.08,
  htfFilter: true,
  mtf5mFilter: true,
  sharpExit: true,
  momentumExit: true,
  regimeFilter: true,
  regimeMinScore: 0.9,
  regimeTopN: 3,
  dailyLossPct: 2,
  maxTradesPerDay: 100,
  totalFloorPct: 10,
  lossStreakLimit: 3,
  lossStreakPauseSec: 900,
  takerFeePct: 0.05,
  minEdgePct: 0.06,
}

/** Ayar altı öneri notu: "Önerilen: X — neye göre değiştirilir" */
function Rec({ value, children }: { value: string; children?: React.ReactNode }) {
  return (
    <p className="mt-1 text-[11px] leading-snug text-zinc-500">
      <span className="font-semibold text-emerald-400/90">Önerilen: {value}</span>
      {children ? <span> — {children}</span> : null}
    </p>
  )
}

/** Gelişmiş bölüm içindeki grup başlığı */
function GroupTitle({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <div>
        <p className="text-sm font-semibold text-zinc-200">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{desc}</p>
      </div>
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const snap = useBotStore((s) => s.snapshot)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 sm:max-w-[560px]">
        {open && snap ? (
          <SettingsForm snap={snap} onClose={() => onOpenChange(false)} />
        ) : (
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Bot Ayarları</DialogTitle>
            <DialogDescription className="text-zinc-500">Motor bağlantısı bekleniyor…</DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SettingsForm({ snap, onClose }: { snap: EngineSnapshot; onClose: () => void }) {
  const { toast } = useToast()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [form, setForm] = useState<BotSettings>(() => ({
    ...snap.settings,
    // motor eski sürümden geliyorsa güvenli varsayılanlar
    totalFloorPct: snap.settings.totalFloorPct ?? 10,
    lossStreakLimit: snap.settings.lossStreakLimit ?? 3,
    lossStreakPauseSec: snap.settings.lossStreakPauseSec ?? 900,
    maxTradesPerDay: snap.settings.maxTradesPerDay ?? 100,
    momPersistSec: snap.settings.momPersistSec ?? 10,
    takerMinScore: snap.settings.takerMinScore ?? 1.5,
    minScore: snap.settings.minScore ?? 0.15,
  }))
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  // mevcut bakiye — motor gerçeğinden (account.balance) başlar, kullanıcı düzenler
  const [balInput, setBalInput] = useState<string>(
    () => (Math.round((snap.account?.balance ?? 0) * 100) / 100).toString(),
  )

  const breakeven = form.takerFeePct * 2
  const minTp = breakeven + form.minEdgePct
  const set = <K extends keyof BotSettings>(k: K, v: BotSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const save = () => {
    sendControl({ action: 'updateSettings', settings: form, apiKey: apiKey || undefined, apiSecret: apiSecret || undefined }, (r) => {
      toast({ title: r.ok ? 'Ayarlar kaydedildi' : 'Kaydedilemedi', description: r.msg, variant: r.ok ? 'default' : 'destructive' })
      if (r.ok) onClose()
    })
  }

  const resetBalance = () => {
    sendControl({ action: 'resetBalance' }, (r) => {
      toast({ title: 'Bakiye sıfırlandı', description: r.msg, variant: r.ok ? 'default' : 'destructive' })
    })
  }

  const resetAll = () => {
    sendControl({ action: 'reset' }, (r) => {
      toast({ title: 'Geçmiş sıfırlandı', description: r.msg, variant: r.ok ? 'default' : 'destructive' })
    })
  }

  // önerilen strateji paketini forma yazar (kaydetmez — kullanıcı göz atıp Kaydet der)
  const applyRecommended = () => {
    setForm((f) => ({ ...f, ...RECOMMENDED }))
    toast({
      title: 'Önerilen ayarlar forma yazıldı',
      description: 'Değişiklikleri gözden geçirip "Kaydet"e bas — kaydedilmeden hiçbir şey motora gitmez.',
    })
  }

  // bakiyeyi elle ayarla — geçmiş korunur, bakiye girilen değerden devam eder
  const applyBalance = () => {
    const v = Number(balInput.replace(',', '.'))
    if (balInput.trim() === '' || !isFinite(v)) {
      toast({ title: 'Geçersiz bakiye', description: 'Sayısal bir USDT değeri girin', variant: 'destructive' })
      return
    }
    sendControl({ action: 'setBalance', balance: v }, (r) => {
      toast({ title: r.ok ? 'Bakiye ayarlandı' : 'Ayarlanamadı', description: r.msg, variant: r.ok ? 'default' : 'destructive' })
    })
  }

  // garanti edilen kâr tabanı: kilit kurulduğunda en kötü çıkış noktası
  const lockFloor = form.trailArmPct - form.trailPct

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-zinc-100">
          <Settings2 className="h-5 w-5 text-emerald-400" aria-hidden />
          Bot Ayarları
        </DialogTitle>
        <DialogDescription className="text-zinc-500">
          Temel ayarlar burada; strateji detayları <span className="text-zinc-300">Gelişmiş Ayarlar</span> bölmesinde.
          Her gelişmiş ayarın altında önerilen değer ve neye göre değiştirileceği yazar.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        {/* ============ TEMEL: işlem modu ============ */}
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold text-zinc-200">Canlı İşlem Modu (LIVE)</Label>
              <p className="mt-0.5 text-xs text-zinc-500">
                Kapalı = PAPER simülasyon (sanal bakiye) · Açık = Binance Futures'tan gerçek emir
              </p>
            </div>
            <Switch
              checked={form.mode === 'LIVE'}
              onCheckedChange={(v) => set('mode', v ? 'LIVE' : 'PAPER')}
              aria-label="Canlı işlem modu"
            />
          </div>
          {form.mode === 'LIVE' && (
            <div className="space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-950/15 p-3">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-amber-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                Gerçek para riski! API anahtarında <b>futures yetkisi</b> açık, <b>withdrawal yetkisi kapalı</b> olmalı.
                Anahtarlar yalnızca motor belleğinde tutulur, diske yazılmaz.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="apiKey" className="flex items-center gap-1.5 text-xs text-zinc-300">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden /> API Anahtarı
                </Label>
                <Input id="apiKey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Değiştirmek için girin (boş = mevcut)" className="h-9 border-zinc-700 bg-zinc-900 font-mono text-xs" autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="apiSecret" className="text-xs text-zinc-300">API Gizli Anahtarı</Label>
                <Input id="apiSecret" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Değiştirmek için girin" className="h-9 border-zinc-700 bg-zinc-900 font-mono text-xs" autoComplete="off" />
              </div>
            </div>
          )}
        </div>

        {/* ============ TEMEL: tarama + grafik odağı ============ */}
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-2">
              <Radar className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden />
              <div>
                <Label className="text-sm font-semibold text-zinc-200">Çoklu Coin Taraması</Label>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                  Açık = 9 coin <span className="text-zinc-300">tek WebSocket soketinde</span> taranır, en güçlü sinyale girilir ·
                  Kapalı = yalnız seçili sembol
                </p>
              </div>
            </div>
            <Switch
              checked={form.scanMode === 'MULTI'}
              onCheckedChange={(v) => set('scanMode', v ? 'MULTI' : 'SINGLE')}
              aria-label="Çoklu coin taraması"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-xs font-semibold text-zinc-300">{form.scanMode === 'MULTI' ? 'Grafik Odağı' : 'Sembol'}</Label>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {form.scanMode === 'MULTI'
                  ? 'Grafikte hangi coin görünsün (işlem açılınca otomatik geçer)'
                  : 'USDT-M vadeli işlemler'}
              </p>
            </div>
            <Select value={form.symbol} onValueChange={(v) => set('symbol', v)}>
              <SelectTrigger className="h-9 w-[150px] border-zinc-700 bg-zinc-900 font-mono text-sm" aria-label="Sembol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-700 bg-zinc-900">
                {SYMBOLS.map((s) => <SelectItem key={s} value={s} className="font-mono">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ============ TEMEL: kaldıraç + tahsis ============ */}
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold text-zinc-200">Kaldıraç</Label>
              <span className={`font-mono text-sm font-bold ${form.leverage >= 16 ? 'text-rose-400' : form.leverage >= 8 ? 'text-amber-400' : 'text-emerald-400'}`}>{form.leverage}x</span>
            </div>
            <Slider value={[form.leverage]} min={1} max={25} step={1} onValueChange={([v]) => set('leverage', v)} aria-label="Kaldıraç" />
            <Rec value="10x">işlem başına kayıp riski riskPct belirler; kaldıraç yalnız marj verimliliği ve likidasyon payıdır ({form.leverage}x'te likidasyon ~%{(100 / form.leverage).toFixed(1)} uzakta, SL %0.9'un çok ötesinde). Yükseltmek işlemin kayıp riskini ARTIRMAZ ama likidasyon ihtimalini büyütür.</Rec>
          </div>
          <Separator className="bg-zinc-800" />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold text-zinc-200">Pozisyon Tahsisi</Label>
              <span className="font-mono text-sm font-bold text-emerald-400">%{form.allocationPct}</span>
            </div>
            <Slider value={[form.allocationPct]} min={5} max={100} step={5} onValueChange={([v]) => set('allocationPct', v)} aria-label="Pozisyon tahsisi" />
            <Rec value="%25">her işlemde bakiyenin bu yüzdesi marj olarak ayrılır. Risk eşitliği açıksa bu bir TAVANDIR — gerçek boyutu risk % belirler.</Rec>
          </div>
        </div>

        {/* ============ TEMEL: TP / SL ============ */}
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tp" className="text-xs font-semibold text-zinc-300">Kâr Hedefi — TP (%)</Label>
              <Input id="tp" type="number" min={minTp} step={0.01} value={form.takeProfitPct}
                onChange={(e) => set('takeProfitPct', Number(e.target.value))}
                className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
              <p className="text-[11px] text-amber-500/90">Min %{minTp.toFixed(3)} (ücret +%{form.minEdgePct} marj)</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sl" className="text-xs font-semibold text-zinc-300">Zarar Kes — SL (%)</Label>
              <Input id="sl" type="number" min={0.05} step={0.01} value={form.stopLossPct}
                onChange={(e) => set('stopLossPct', Number(e.target.value))}
                className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
            </div>
          </div>
          <Rec value="TP %0.90 · SL %0.90">av, gidiş-dönüş komisyonun (%0.10) en az 3 katı olmalı — altındaki hareketler ücret deliğidir. SL, TP'nin en fazla ~2 katı olmalı; motor küçükse otomatik düzeltir. ATR-uyarlanabilir açıkken bunlar taban/tavan görevi görür, gerçek TP/SL coine göre hesaplanır.</Rec>
          <p className="rounded-md bg-zinc-950/60 p-2 font-mono text-[11px] tabular-nums text-zinc-500">
            TP %{form.takeProfitPct.toFixed(3)} − ücret %{breakeven.toFixed(3)} = net %{(form.takeProfitPct - breakeven).toFixed(3)}
            <span className="text-emerald-400"> → marjda %{((form.takeProfitPct - breakeven) * form.leverage).toFixed(2)} kâr/işlem</span>
          </p>
        </div>

        {/* ============ GELİŞMİŞ AYARLAR — katlanabilir bölme ============ */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-lg border border-zinc-700 bg-zinc-900/25">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg p-3.5 text-left hover:bg-zinc-800/25">
            <div className="flex items-start gap-2">
              <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-zinc-200">Gelişmiş Ayarlar</p>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                  Sinyal filtreleri · uyarlanabilir risk · çıkış motoru · güvenlik devreleri · ücretler —{' '}
                  <span className="text-zinc-400">her ayarın altında önerisi yazar</span>
                </p>
              </div>
            </div>
            <ChevronDown className="h-5 w-5 shrink-0 text-zinc-500 transition-transform duration-200 group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-4 border-t border-zinc-800 p-3.5">
              <p className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-950/10 p-2.5 text-[11px] leading-relaxed text-amber-300/90">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Bu ayarlar botun karakterini değiştirir. Bir değerle oynamadan önce altındaki öneri satırını oku —
                orada <b>o ayarın neye göre büyütülüp küçültüleceği</b> yazar. Emin değilsen en alttaki
                <b> Önerilere Dön</b>'ü kullan.
              </p>

              {/* ---- Gelişmiş grup 1: sinyal seçiciliği ---- */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                <GroupTitle
                  icon={<Activity className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />}
                  title="Sinyal Seçiciliği (giriş filtreleri)"
                  desc="Hangi sinyalin işleme dönüştüğüne karar veren katmanlar — hepsi frekansı düşürüp kaliteyi artırır."
                />

                {/* rejim filtresi */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">Rejim Filtresi</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                      Coinin hareket/maliyet skorunu sürekli ölçer; yalnız eşiği geçen ilk N coinden işlem yapılır.
                    </p>
                  </div>
                  <Switch checked={form.regimeFilter} onCheckedChange={(v) => set('regimeFilter', v)} aria-label="Rejim filtresi" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Minimum rejim skoru</Label>
                    <span className={`font-mono text-xs font-bold ${form.regimeMinScore >= 1 ? 'text-emerald-400' : 'text-amber-400'}`}>{form.regimeMinScore.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.regimeMinScore]} min={0.4} max={2} step={0.05} onValueChange={([v]) => set('regimeMinScore', v)} aria-label="Minimum rejim skoru" />
                  <Rec value="0.90">1.00 = hareket tam komisyon+spread'i karşılıyor. İşlem sayısı çok az gelirse 0.80'e in; gereksiz işlem artarsa 1.10'a çık.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">İşlem yapacak maks. coin</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">ilk {form.regimeTopN}</span>
                  </div>
                  <Slider value={[form.regimeTopN]} min={1} max={9} step={1} onValueChange={([v]) => set('regimeTopN', v)} aria-label="Maksimum coin sayısı" />
                  <Rec value="3">en değerli avlara odak. Daha çok sinyal istersen 5 — ama ortalama av kalitesi düşer.</Rec>
                </div>

                <Separator className="bg-zinc-800" />

                {/* momentum süreklilik — gürültü paketi */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-zinc-300">Momentum Süreklilik Şartı (sn)</Label>
                    <span className="font-mono text-xs font-bold text-cyan-300">{form.momPersistSec ?? 0} sn</span>
                  </div>
                  <Slider value={[form.momPersistSec ?? 10]} min={0} max={30} step={1} onValueChange={([v]) => set('momPersistSec', v)} aria-label="Momentum süreklilik şartı" />
                  <Rec value="10 sn">momentum yön değiştirdikten sonra en az bu kadar kesintisiz sürmeli — girer girmez dönen sahte sinyaller (RSI tepelerindeki fitiller) böyle kesilir. "Momentum öldü" zararları hâlâ ağırlaşırsa 15'e çıkar; işlem sayısı çok düşerse 6-8'e in. 0 = kapalı.</Rec>
                </div>

                <Separator className="bg-zinc-800" />

                {/* skor tabanı + taker eşiği */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-zinc-300">Giriş Skor Tabanı</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">{form.minScore.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.minScore]} min={0} max={1} step={0.01} onValueChange={([v]) => set('minScore', v)} aria-label="Skor tabanı" />
                  <Rec value="0.15">altındaki sinyal komisyon deliğidir. Kazanma oranı düşükse 0.20'ye çıkar; sinyal kıtlığı varsa 0.10'a in.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-zinc-300">Taker'a Geçiş Skoru (hızlı yakala)</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">{form.takerMinScore.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.takerMinScore]} min={0} max={2} step={0.05} onValueChange={([v]) => set('takerMinScore', v)} aria-label="Taker geçiş skoru" />
                  <Rec value="1.50">bu skorun üstündeki istisna sinyaller maker beklemeyip direkt piyasadan girer (kaçmaz). Kaçan iyi sinyal görürsen 1.0'a in. 0 = hepsi maker bekler.</Rec>
                </div>

                <Separator className="bg-zinc-800" />

                {/* maker ekonomisi */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-xs font-semibold text-zinc-300">Maker Girişler (düşük ücret)</Label>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                        Giriş defter fiyatından post-only limit: gidiş-dönüş ücret <span className="text-emerald-400">%{((form.makerFeePct) * 2).toFixed(3)}</span> (taker %{(form.takerFeePct * 2).toFixed(3)}).
                      </p>
                    </div>
                    <Switch checked={form.makerEntry} onCheckedChange={(v) => set('makerEntry', v)} aria-label="Maker emirler" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="makerWait" className="text-[11px] font-semibold text-zinc-400">Dolum bekleme (sn)</Label>
                      <Input id="makerWait" type="number" min={1} max={30} step={1} value={form.makerWaitSec}
                        onChange={(e) => set('makerWaitSec', Number(e.target.value))}
                        className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
                      <Rec value="3 sn">bu sürede dolmazsa sinyal hâlâ geçerliyse piyasa emriyle yakalanır. Dolmayan emir oranı yüksekse 2'ye in; ücret tasarrufu istersen 5'e çıkar (bedeli: sinyaller kaçar).</Rec>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="makerFee" className="text-[11px] font-semibold text-zinc-400">Maker ücreti (%)</Label>
                      <Input id="makerFee" type="number" min={0} max={0.1} step={0.0001} value={form.makerFeePct}
                        onChange={(e) => set('makerFeePct', Number(e.target.value))}
                        className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
                      <Rec value="%0.018">borsanın VIP-0 maker tarifesidir — borsa değiştirirsen güncelle, yoksa kâr hesabı yanılır.</Rec>
                    </div>
                  </div>
                </div>

                <Separator className="bg-zinc-800" />

                {/* order-flow + zaman katmanları */}
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">Order-Flow Onayı</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">Emir defterindeki alış/satış boyut dengesi yönü onaylar.</p>
                  </div>
                  <Switch checked={form.flowFilter} onCheckedChange={(v) => set('flowFilter', v)} aria-label="Order-flow filtresi" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Dengesizlik eşiği</Label>
                    <span className="font-mono text-xs font-bold text-rose-300">±{(form.flowThreshold * 100).toFixed(0)}%</span>
                  </div>
                  <Slider value={[form.flowThreshold]} min={0.02} max={0.3} step={0.01} onValueChange={([v]) => set('flowThreshold', v)} aria-label="Dengesizlik eşiği" />
                  <Rec value="%8">belirgin baskı gerektirir (seçici). "Akış yüzünden hep bekliyor" diyorsan %5'e in.</Rec>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">15dk Üst Trend Onayı</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">Büyük resimle ters yönde giriş yasak.</p>
                  </div>
                  <Switch checked={form.htfFilter} onCheckedChange={(v) => set('htfFilter', v)} aria-label="15dk trend filtresi" />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">5dk Yön Onayı (MTF)</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">1dk tetik + 5dk yön + 15dk trend üçlüsü uyuşmadan giriş yok.</p>
                  </div>
                  <Switch checked={form.mtf5mFilter} onCheckedChange={(v) => set('mtf5mFilter', v)} aria-label="5dk onayı" />
                </div>
                <Rec value="ikisi de AÇIK">zaman katmanları frekansı düşürüp kaliteyi artırır; ancak "hiç işlem yok" sorununda önce rejim skoru ve momentum sürekliliğine bak — bunları kapatmak last resort'tur.</Rec>
              </div>

              {/* ---- Gelişmiş grup 2: uyarlanabilir risk ---- */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                <GroupTitle
                  icon={<Gauge className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" aria-hidden />}
                  title="Uyarlanabilir Risk ve Boyutlandırma"
                  desc="TP/SL ve işlem boyutu coinin gerçek oynaklığına ve sabit riske göre ayarlanır."
                />
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">ATR-Uyarlanabilir TP/SL</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">TP/SL sabit % yerine 1dk ATR oynaklığından hesaplanır; ücret başabaş tabanı korunur.</p>
                  </div>
                  <Switch checked={form.atrAdaptive} onCheckedChange={(v) => set('atrAdaptive', v)} aria-label="ATR uyarlanabilir TP/SL" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">ATR çarpanı (TP = ATR% ×)</Label>
                    <span className="font-mono text-xs font-bold text-violet-300">×{form.atrTpMult.toFixed(1)}</span>
                  </div>
                  <Slider value={[form.atrTpMult]} min={0.5} max={3} step={0.1} onValueChange={([v]) => set('atrTpMult', v)} aria-label="ATR TP çarpanı" />
                  <Rec value="×1.2">TP'ye hiç ulaşılmıyorsa 1.0'a in; coin hızlı akıyor ve kâr erken kesiliyorsa 1.5'e çıkar.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">SL / TP oranı (R:R)</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">{form.atrSlRatio.toFixed(1)}x</span>
                  </div>
                  <Slider value={[form.atrSlRatio]} min={1} max={4} step={0.1} onValueChange={([v]) => set('atrSlRatio', v)} aria-label="SL TP oranı" />
                  <Rec value="1.8x">TP'ye ulaşınca kazanılan zararın 1.8 katı. SL çok sık değiyorsa 2.0-2.5'e çık (işlem sayısı düşer, kayıp/kez küçülür).</Rec>
                </div>
                <Separator className="bg-zinc-800" />
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">Risk Eşitliği Boyutlandırma</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">Her işlemin SL'de kaybedeceği para sabit %risk; tahsis (%) tavan olarak kalır.</p>
                  </div>
                  <Switch checked={form.riskParity} onCheckedChange={(v) => set('riskParity', v)} aria-label="Risk eşitliği" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">İşlem başı risk (% bakiye)</Label>
                    <span className="font-mono text-xs font-bold text-amber-400">%{form.riskPct.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.riskPct]} min={0.1} max={2} step={0.05} onValueChange={([v]) => set('riskPct', v)} aria-label="İşlem başı risk" />
                  <Rec value="%0.50">10 üst üste SL'de bakiyenin ~%5'i gider (seri korumasıyla yumuşatılır). Bu, kaldıraç değil, işlemin kayıp büyüklüğüdür — agresiflik buradan ayarlanır.</Rec>
                </div>
              </div>

              {/* ---- Gelişmiş grup 3: çıkış motoru ---- */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                <GroupTitle
                  icon={<Crosshair className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden />}
                  title="Çıkış Motoru (kâr kilidi + momentum ölümü)"
                  desc="Saati değil kâr koruması yönetir: zirve takibi, sıkışan kilit, ölü trendte erken çıkış."
                />
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">Keskin Çıkış Motoru</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">Kapatırsan klasik mod: sabit TP/SL + saat.</p>
                  </div>
                  <Switch checked={form.sharpExit} onCheckedChange={(v) => set('sharpExit', v)} aria-label="Keskin çıkış motoru" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Kâr kilidi eşiği (zirve +%)</Label>
                    <span className="font-mono text-xs font-bold text-cyan-300">+%{form.trailArmPct.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.trailArmPct]} min={0.03} max={0.5} step={0.01} onValueChange={([v]) => set('trailArmPct', v)} aria-label="Kâr kilidi eşiği" disabled={!form.sharpExit} />
                  <Rec value="+%0.35">kilit bu kâr seviyesinde kurulur. Daha erken güvence istersen düşür — ama garanti taban (kilit − iz) ücret başabaşının altına inmesin.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Zirveden iz toleransı (%)</Label>
                    <span className="font-mono text-xs font-bold text-cyan-300">{form.trailPct.toFixed(2)}</span>
                  </div>
                  <Slider value={[form.trailPct]} min={0.02} max={0.3} step={0.01} onValueChange={([v]) => set('trailPct', v)} aria-label="İz toleransı" disabled={!form.sharpExit} />
                  <Rec value="%0.20">trendin nefes payı — geri çekilme bunu aşarsa kilitli kârla çıkılır. Genişletirsen trend daha uzun taşır ama taban düşer: garanti taban şu an <span className="font-mono font-semibold text-zinc-300">+%{lockFloor.toFixed(2)}</span> (ücret başabaşı %0.10'un üzerinde kalmalı).</Rec>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs font-semibold text-zinc-300">Momentum Ölüm Çıkışı</Label>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">Momentum belirgin şekilde öldüyse ve zarar hasar eşiğini aştıysa beklemeden çık — SL'den çok daha küçük kayıpla.</p>
                  </div>
                  <Switch checked={form.momentumExit} onCheckedChange={(v) => set('momentumExit', v)} aria-label="Momentum çıkışı" disabled={!form.sharpExit} />
                </div>
                <Rec value="AÇIK">bu çıkış zararın büyümesini keser; gürültüden kaçmak için onu kapatma, giriş tarafındaki süreklilik şartını (10 sn) kullan.</Rec>
                <Separator className="bg-zinc-800" />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Maks. pozisyon süresi (sn)</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">{form.maxHoldSec} sn</span>
                  </div>
                  <Slider value={[form.maxHoldSec]} min={30} max={1800} step={10} onValueChange={([v]) => set('maxHoldSec', v)} aria-label="Maksimum süre" />
                  <Rec value="600 sn (10dk)">keskin çıkışta süre kâr yönetimi değil güvenlik tavanıdır (sert tavan 15dk). Küçültmek ölü pozisyonları erken temizler ama trendlere darbe vurur.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">İşlemler arası bekleme (sn)</Label>
                    <span className="font-mono text-xs font-bold text-zinc-300">{form.cooldownSec} sn</span>
                  </div>
                  <Slider value={[form.cooldownSec]} min={0} max={120} step={1} onValueChange={([v]) => set('cooldownSec', v)} aria-label="Bekleme süresi" />
                  <Rec value="90 sn">aynı coinde zarar yazıp hemen geri girme zincirini keser. Aynı coinden tekrar zarar geliyorsa 120'ye çıkar.</Rec>
                </div>
              </div>

              {/* ---- Gelişmiş grup 4: güvenlik devreleri ---- */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                <GroupTitle
                  icon={<Layers className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />}
                  title="Güvenlik Devreleri (kanama koruması)"
                  desc="Bot kendi kendini durdurur: günlük tavan, toplam taban, zarar serisi molası, işlem tavanı."
                />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Günlük zarar tavanı (%)</Label>
                    <span className="font-mono text-xs font-bold text-amber-300">−%{form.dailyLossPct.toFixed(1)}</span>
                  </div>
                  <Slider value={[form.dailyLossPct]} min={0.5} max={10} step={0.5} onValueChange={([v]) => set('dailyLossPct', v)} aria-label="Günlük zarar tavanı" />
                  <Rec value="−%2">gün bu zarara ulaşırsa bot o günü bitirir, ertesi gün otomatik sıfırlanır. Psikolojik limitin buysa dokunma.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Günlük işlem tavanı</Label>
                    <span className="font-mono text-xs font-bold text-emerald-300">{form.maxTradesPerDay > 0 ? `${form.maxTradesPerDay} işlem` : 'SINIRSIZ'}</span>
                  </div>
                  <Slider value={[form.maxTradesPerDay]} min={0} max={300} step={10} onValueChange={([v]) => set('maxTradesPerDay', v)} aria-label="Günlük işlem tavanı" />
                  <Rec value="100">hedef bant günde 50-100 kaliteli işlem — kanamayı değil gereksiz işlemi keser. 0 = sınırsız.</Rec>
                </div>
                <Separator className="bg-zinc-800" />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">TOPLAM bakiye tabanı (%)</Label>
                    <span className="font-mono text-xs font-bold text-rose-300">{form.totalFloorPct > 0 ? `−%${form.totalFloorPct}` : 'KAPALI'}</span>
                  </div>
                  <Slider value={[form.totalFloorPct]} min={0} max={30} step={1} onValueChange={([v]) => set('totalFloorPct', v)} aria-label="Toplam bakiye tabanı" />
                  <Rec value="−%10">bakiye bu kadar erirse bot KALICI durur — devam etmek panelden "Tabanı Sıfırla" ile bilinçli yapılır. 0 = kapalı.</Rec>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] font-semibold text-zinc-400">Ardışık zarar molası</Label>
                    <span className="font-mono text-xs font-bold text-amber-300">{form.lossStreakLimit > 0 ? `${form.lossStreakLimit} zarar` : 'KAPALI'}</span>
                  </div>
                  <Slider value={[form.lossStreakLimit]} min={0} max={10} step={1} onValueChange={([v]) => set('lossStreakLimit', v)} aria-label="Ardışık zarar limiti" />
                  <div className="flex items-center justify-between pt-1">
                    <Label className="text-[11px] font-medium text-zinc-500">Mola süresi</Label>
                    <span className="font-mono text-xs font-bold text-amber-300">{Math.round(form.lossStreakPauseSec / 60)} dk</span>
                  </div>
                  <Slider value={[form.lossStreakPauseSec]} min={60} max={3600} step={60} onValueChange={([v]) => set('lossStreakPauseSec', v)} aria-label="Mola süresi" />
                  <Rec value="3 zarar → 15 dk">piyasa/bot uyumsuzluğunu keser; kâr gelince sayaç sıfırlanır. Mola sırasında tarama sürer, giriş kapalıdır.</Rec>
                </div>
              </div>

              {/* ---- Gelişmiş grup 5: ücret parametreleri ---- */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                <GroupTitle
                  icon={<Gauge className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />}
                  title="Ücret Parametreleri"
                  desc="Net kâr hesabının temeli — borsa tarifenle uyumlu olmalı."
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="fee" className="text-[11px] font-semibold text-zinc-400">Taker ücreti (%)</Label>
                    <Input id="fee" type="number" min={0} max={0.2} step={0.0001} value={form.takerFeePct}
                      onChange={(e) => set('takerFeePct', Number(e.target.value))}
                      className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
                    <Rec value="%0.050">Binance futures VIP-0 taker. Gidiş-dönüş: %{breakeven.toFixed(3)}.</Rec>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edge" className="text-[11px] font-semibold text-zinc-400">Minimum net marj (%)</Label>
                    <Input id="edge" type="number" min={0} max={1} step={0.01} value={form.minEdgePct}
                      onChange={(e) => set('minEdgePct', Number(e.target.value))}
                      className="h-9 border-zinc-700 bg-zinc-900 font-mono text-sm" />
                    <Rec value="%0.06">TP, ücretlerin üstünde en bu kadar net kâr bırakır — motorun otomatik TP tabanı bununla hesaplanır.</Rec>
                  </div>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* ============ ÖNERİLEN AYARLAR — alttaki özet kart ============ */}
        <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-950/10 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-emerald-300">Önerilen Ayarlar</p>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                  A-paketi v2 — 5 Kasım canlı işlem verisiyle ölçülüp ayarlandı. Değiştirmeden önce ölçüt:
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={applyRecommended}
              className="h-8 shrink-0 gap-1.5 border-emerald-500/40 bg-emerald-950/30 text-emerald-400 hover:bg-emerald-900/40 hover:text-emerald-300">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Önerilere Dön
            </Button>
          </div>
          <ul className="grid grid-cols-1 gap-1.5 text-[11px] leading-relaxed text-zinc-400 sm:grid-cols-2">
            <li><span className="font-mono font-semibold text-zinc-200">TP / SL %0.90</span> — av, gidiş-dönüş komisyonun 3 katı: altı ücret deliği</li>
            <li><span className="font-mono font-semibold text-zinc-200">Kilit +0.35 / iz 0.20</span> — garanti taban +0.15, trende %33 nefes payı</li>
            <li><span className="font-mono font-semibold text-zinc-200">Momentum 10 sn</span> — RSI-tepe sahte dönüş girişleri kesildi</li>
            <li><span className="font-mono font-semibold text-zinc-200">Bekleme 90 sn</span> — aynı coinde zarar zinciri kırılır</li>
            <li><span className="font-mono font-semibold text-zinc-200">ATR ×1.2 · SL×1.8</span> — hedef coinin oynaklığından</li>
            <li><span className="font-mono font-semibold text-zinc-200">Risk %0.5</span> — 10 üst üste SL ≈ bakiyenin %5'i</li>
            <li><span className="font-mono font-semibold text-zinc-200">Gün −%2 · taban −%10</span> — kanama tavanları</li>
            <li><span className="font-mono font-semibold text-zinc-200">3 zarar → 15 dk</span> — uyumsuz piyasa molası</li>
          </ul>
          <p className="text-[10px] leading-relaxed text-zinc-600">
            "Önerilere Dön" yalnızca forma yazar — kaydetmeden motora hiçbir şey gitmez.
          </p>
        </div>

        {/* ============ TEMEL: PAPER bakiyesi ============ */}
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
          <div className="flex items-end justify-between gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="startBal" className="text-xs font-semibold text-zinc-300">PAPER Başlangıç Bakiyesi (USDT)</Label>
              <Input id="startBal" type="number" min={10} step={100} value={form.startBalance}
                onChange={(e) => set('startBalance', Number(e.target.value))}
                className="h-9 w-[140px] border-zinc-700 bg-zinc-900 font-mono text-sm" />
              <p className="text-[11px] text-zinc-500">"Bakiyeyi Sıfırla" bakiyeyi bu değere döndürür.</p>
            </div>
            <Button variant="outline" size="sm" onClick={resetBalance}
              className="h-9 gap-1.5 border-amber-500/40 bg-amber-950/20 text-amber-400 hover:bg-amber-900/30 hover:text-amber-300">
              <RotateCcw className="h-4 w-4" aria-hidden /> Bakiyeyi Sıfırla
            </Button>
          </div>
          {snap.settings.mode === 'PAPER' && (
            <>
              <Separator className="bg-zinc-800" />
              <div className="flex items-end justify-between gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="setBal" className="text-xs font-semibold text-zinc-300">Mevcut Bakiyeyi Elle Ayarla (USDT)</Label>
                  <Input id="setBal" type="number" min={10} step={10} value={balInput}
                    onChange={(e) => setBalInput(e.target.value)}
                    placeholder="örn. 2500"
                    className="h-9 w-[140px] border-zinc-700 bg-zinc-900 font-mono text-sm" />
                  <p className="text-[11px] text-zinc-500">
                    Anlık:{' '}
                    <span className="font-mono font-semibold text-emerald-400">
                      {snap.account.balance.toFixed(2)} USDT
                    </span>{' '}
                    · Geçmiş korunur, bakiye girdiğin değerden devam eder (yalnız PAPER modunda).
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={applyBalance} disabled={balInput.trim() === ''}
                  className="h-9 gap-1.5 border-emerald-500/40 bg-emerald-950/20 text-emerald-400 hover:bg-emerald-900/30 hover:text-emerald-300">
                  <Wallet className="h-4 w-4" aria-hidden /> Uygula
                </Button>
              </div>
            </>
          )}
        </div>

        {/* ============ TEMEL: tehlikeli bölge ============ */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/25 bg-rose-950/10 p-3.5">
          <div>
            <p className="text-sm font-semibold text-rose-300">Tüm Geçmişi Sil</p>
            <p className="mt-0.5 text-xs text-zinc-500">İşlem kayıtları ve bakiye eğrisi kalıcı olarak silinir.</p>
          </div>
          <Button variant="outline" size="sm" onClick={resetAll}
            className="h-9 gap-1.5 border-rose-500/40 bg-rose-950/20 text-rose-400 hover:bg-rose-900/30 hover:text-rose-300">
            <Trash2 className="h-4 w-4" aria-hidden /> Sıfırla
          </Button>
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} className="border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800">
          Vazgeç
        </Button>
        <Button onClick={save} className="gap-1.5 bg-emerald-600 font-semibold text-white hover:bg-emerald-500">
          <Save className="h-4 w-4" aria-hidden /> Kaydet
        </Button>
      </DialogFooter>
    </>
  )
}
