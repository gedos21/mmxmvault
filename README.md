# GedOS Vault Bridge

mmxMatrix'i bu Obsidian vault'una bağlar: işlemleri Markdown notu olarak yazar
ve vault'taki model/kavram notlarını siteye geri okutur.

## Kurulum — BRAT ile (önerilen)

Eklenti Obsidian'ın community listesinde değil. Mağazada olmayan eklentileri
kurmanın standart yolu **BRAT**:

1. `Settings → Community plugins → Browse` → **BRAT** (Obsidian42 - BRAT)
   eklentisini kur ve etkinleştir.
2. Komut paletinden (`⌘P` macOS / `Ctrl+P` Windows-Linux) **BRAT: Add a beta
   plugin for testing** komutunu çalıştır.
3. Açılan kutuya `gedos21/mmxmvault` yaz ve onayla.

BRAT eklentiyi indirir, etkinleştirir ve sonraki sürümleri kendisi günceller.
Dosya kopyalaman ya da gizli klasör bulman gerekmez.

## Kurulum — elle

BRAT kullanmak istemiyorsan bu klasördeki üç dosyayı vault'una kopyala:

```
<vault>/.obsidian/plugins/gedos-vault-bridge/
├── main.js
├── manifest.json
└── versions.json
```

Proje kökünden, macOS / Linux (Terminal):

```bash
mkdir -p "<vault>/.obsidian/plugins/gedos-vault-bridge" && \
cp obsidian-plugin/{main.js,manifest.json,versions.json} "$_"
```

Windows (PowerShell):

```powershell
$dest = "<vault>\.obsidian\plugins\gedos-vault-bridge"
New-Item -ItemType Directory -Force -Path $dest
Copy-Item obsidian-plugin\main.js, obsidian-plugin\manifest.json, obsidian-plugin\versions.json $dest
```

`.obsidian` gizli bir klasördür: macOS'ta Finder'da `⇧⌘.`, Windows'ta Dosya
Gezgini'nde **Görünüm → Gizli öğeler** ile görünür olur. Klasör adı
`manifest.json` içindeki `id` ile birebir aynı olmalı. Sonra Obsidian'ı yeniden
başlat ve `Settings → Community plugins` altından eklentiyi etkinleştir.

Bu yolda güncellemeleri de elle yaparsın: dosyaları üzerine kopyala, ardından
eklentiyi kapatıp yeniden aç.

## Bağlantı

Eklenti masaüstünde `127.0.0.1:27125` üzerinde çalışır ve yalnızca bu makineden
erişilebilir. Ayarlardaki erişim anahtarını mmxMatrix'te
**Graph View → Obsidian vault bağla** penceresine gir.

Bağlandıktan sonra `syncToGedos` işaretli her işlem
`GedOS/Trading Journal/YYYY/MM/` altına Markdown notu olarak yazılır. Site,
bağlantı yokken kaydedilen işlemleri sıraya alır ve vault bağlanınca gönderir.

## Notlara ne yazılır

Not iki bölgeye ayrılır:

- `<!-- mmx:start -->` ve `<!-- mmx:end -->` arası ile frontmatter'da payload'ın
  sahiplendiği anahtarlar **mmxMatrix'e** aittir, her senkronizasyonda yenilenir.
- Blok dışındaki her şey **sana** aittir: kendi yazdıkların, eklediğin
  bağlantılar ve görseller, kendi frontmatter anahtarların. Bunlara dokunulmaz.

`mmx_rev` notun yazıldığı veritabanı sürümünü, `mmx_hash` ise yönetilen bloğun
diske düştüğü hâlinin özetini tutar.

## Uçlar

| Uç | İş |
|---|---|
| `GET /health` | bağlantı testi ve sürüm yetenekleri |
| `GET /graph` | vault'un gerçek not/bağlantı topolojisi |
| `GET /notes?type=model,concept` | model ve kavram notları |
| `POST /trades` | işlem notu yaz veya güncelle |

Hepsi `X-GedOS-Token` başlığı ister.

## Sürüm çıkarma (geliştirici notu)

BRAT `manifest.json`'ı **repository kökünde** arar, bu yüzden eklentinin kendi
public repo'su gerekir (`gedos21/mmxmvault`). Bu klasördeki dosyalar o
repo'nun kökünde durmalı.

Yeni sürüm için:

1. `manifest.json` içindeki `version`'ı yükselt ve `versions.json`'a
   `"<sürüm>": "<minAppVersion>"` satırını ekle.
2. Aynı numarayla bir git tag'i at (`v` öneki olmadan: `0.2.0`).
3. O tag'den bir GitHub Release oluştur ve `main.js`, `manifest.json`
   dosyalarını **release asset** olarak yükle.

BRAT güncellemeleri release asset'lerinden okur. Aynı hazırlık, ileride
community store başvurusunun da ön şartıdır.
