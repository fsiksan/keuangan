<p align="center">
  <img height="300" height="auto" src="https://github.com/sipalingnode/sipalingnode/blob/main/logo.png">
</p>

<h2 align="center"><b>Follow Community Team</b></h2>
<p align="center">
  <a href="https://www.airdropasc.com" target="_blank"><img src="https://github.com/sipalingnode/sipalingnode/blob/main/logo.png" width="50"/></a>&nbsp;&nbsp;&nbsp;
  <a href="https://t.me/airdropasc" target="_blank"><img src="https://github.com/user-attachments/assets/56e7f6ee-18b7-4b36-becc-ec6e4de7bff9" width="50"/></a>&nbsp;&nbsp;&nbsp;
  <a href="https://x.com/Autosultan_team" target="_blank"><img src="https://github.com/user-attachments/assets/fbb43aa4-9652-4a49-b984-5cf032b6b1ac" width="50"/></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.youtube.com/@ZamzaSalim" target="_blank"><img src="https://github.com/user-attachments/assets/c15509f9-acb7-49ce-989a-5bac62e7e549" width="50"/></a>
</p>

---
# Manage Your Money
---
## Create Spreasheet Drive
* Open [GoogleDrive](https://drive.google.com/drive/u/0/home)
* Click Baru/New
* Google Spreadsheet
* Contoh URL spreadsheet: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit
* Copy bagian: 1AbCdEfGhIjKlMnOpQrStUvWxYz
* Itu adalah: spreadsheetId
---
## Install Nodejs
```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install nodejs -y
```
---
## Clone Repository
```
git clone https://github.com/sipalingnode/keuangan.git
cd keuangan
```
---
## Activate Api & Create Apikey Spreadsheet
* Open [GoogleConsole](https://console.cloud.google.com/)
* Klik menu (pojok kiri)
* api&services > library
* pilih google sheet > enable api
* Klik menu (pojok kiri)
* IAM&Admin > service accounts
* create service accounts
* Open service accounts
* Pilih keys > add keys
* Create New Key > pilih json
* Download file json
* Rename json to rekap-credentials.json
* Upload file rekap-credentials.json to folder keuangan
---
## Add Access to Spreadsheet
* Open file rekap-credentials.json
* Cari: "client_email": "rekap-bot@xxxxx.iam.gserviceaccount.com"
* Copy email
* Open Spreadsheet
* Klik share/bagikan
* Add email to editor
---
## Create Telegram Bot
* Open [BotFather](https://t.me/BotFather)
* Send: `/newbot`
* Enter bot name & username
* Copy the BOT TOKEN
## Get Telegram Chat ID
* Open [GetID](https://t.me/userinfobot)
* Send: /start
* Copy your Chat ID
---
## Edit file rekap.json
```
nano rekap.json
```
**Simpan gunakan `CTRL+X+Y` lalu `ENTER`**
---
## Install Modul
```
npm init -y
npm install telegraf googleapis @anthropic-ai/sdk
```
---
## (Opsional) Fitur Baca Struk Otomatis
Agar bot bisa membaca foto struk dan mencatat pengeluaran otomatis, pilih salah
satu penyedia LLM (vision) lewat `llmProvider` di `rekap.json`.

### Pilihan 1: Claude (Anthropic)
* `"llmProvider": "claude"`
* Buat API key di [Anthropic Console](https://console.anthropic.com/)
* Isi `anthropicApiKey` (atau env `ANTHROPIC_API_KEY`) dan `anthropicModel`

### Pilihan 2: LLM lain (OpenAI-compatible)
Cocok untuk OpenAI, OpenRouter, Groq, Together, Gemini (endpoint OpenAI-compatible),
LLM lokal (Ollama/LM Studio), dll — apa saja yang mendukung endpoint
`/chat/completions`.
* `"llmProvider": "openai"`
* `openaiBaseUrl` — base URL API (contoh: `https://api.openai.com/v1`,
  `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`)
* `openaiApiKey` — API key penyedia (atau env `OPENAI_API_KEY`)
* `openaiModel` — nama model vision (contoh: `gpt-4o`, `gpt-4o-mini`,
  `google/gemini-2.0-flash-exp`, `llava`)

> ⚠️ **PENTING: model harus mendukung gambar (vision/multimodal).**
> Model teks biasa (mis. **MiniMax teks**, Llama text, DeepSeek-Chat) **tidak bisa
> membaca foto** — bot akan selalu balas "tidak bisa membaca struk".

### Rekomendasi model vision (bagus untuk baca struk)

| Model | Penyedia | `openaiBaseUrl` | `openaiModel` |
|-------|----------|-----------------|---------------|
| Gemini 2.0 Flash (murah, OCR bagus) | [Google AI Studio](https://aistudio.google.com/apikey) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| GPT-4o mini | [OpenAI](https://platform.openai.com/) | `https://api.openai.com/v1` | `gpt-4o-mini` |
| via OpenRouter | [OpenRouter](https://openrouter.ai/) | `https://openrouter.ai/api/v1` | `google/gemini-2.0-flash-001` atau `openai/gpt-4o-mini` |
| Claude (Haiku/Sonnet) | Anthropic | gunakan `llmProvider: "claude"` | `claude-haiku-4-5` / `claude-sonnet-4-6` |

Contoh `rekap.json` memakai Gemini (murah & jago OCR):
```json
{
  "llmProvider": "openai",
  "openaiBaseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "openaiApiKey": "AI...kunci-google-ai-studio",
  "openaiModel": "gemini-2.0-flash"
}
```

Bot akan otomatis menentukan **toko** (dari logo/nama di struk) dan **kategori**
(Makanan, Transportasi, Belanja, Kesehatan, Hiburan, Tagihan, Lainnya) lalu
mencatatnya sebagai pengeluaran.
---
## Running
```
node rekap.js
```
---
## Available Commands

| Command | Description |
|----------|-------------|
| /start | Petunjuk pengisian & penggunaan + tombol pintasan |
| /help | Bantuan lengkap |
| /menu | Tampilkan tombol pintasan |
| /ringkasan | Dashboard: saldo, top kategori, status budget/target, hutang |
| /saldo | Saldo total & ringkasan bulan ini |
| /hari [DD MM YYYY] | Rekap harian |
| /minggu | Rekap 7 hari terakhir |
| /bulan [MM YYYY] | Rekap bulanan |
| /laporan [MM YYYY] | Laporan + grafik + proyeksi + anomali (kirim gambar chart) |
| /analisa | Analisa lengkap + grafik di Sheet |
| /kategori | Rincian item per kategori (bulan ini) |
| /tips | Saran hemat dari AI berdasarkan data bulan ini |
| /budget | Lihat budget per kategori & pemakaian bulan ini |
| /target | Lihat target tabungan & progress |
| /langganan | Kelola tagihan rutin (tambah/hapus/jalan) |
| /hutang | Catatan hutang & piutang |
| /neraca | Neraca: aset, liabilitas, ekuitas (akun otomatis) |
| /akun | Saldo per akun/dompet (Kas, Bank, GoPay, ...) |
| /cari <kata> | Cari transaksi (kategori/toko/catatan/pencatat) |
| /export [MM YYYY] | Unduh data CSV (semua atau per bulan) |
| /edit | Edit transaksi terakhir (item/kategori/toko/nominal/catatan) |
| /hapus | Hapus transaksi terakhir (dengan konfirmasi) |
| /batal | Kembalikan transaksi yang baru saja dihapus |
| /migrasi | Rapikan data lama (normalisasi kategori, isi Item kosong) |

### Neraca (Balance Sheet)

Sheet **Neraca** berisi **Aset** & **Liabilitas** yang bisa kamu input, dan
otomatis menghitung **Ekuitas** (kekayaan bersih = Aset − Liabilitas).

```
aset Bank BCA 5jt          # tambah aset
aset Emas 10jt
liabilitas KPR 100jt       # tambah liabilitas/kewajiban
aset hapus Emas            # hapus item
/neraca                    # lihat neraca lengkap
```

### Akun / Dompet (multi-rekening)

Setiap transaksi bisa menyebut **akun/dompet** dengan `pakai <akun>`:
```
keluar makan 25rb pakai gopay
masuk gaji 5jt pakai bank bca
keluar belanja 200rb pakai bank bca di Indomaret
```
Saldo tiap akun (Kas, GoPay, Bank BCA, ...) dihitung **otomatis** dari transaksi
dan tampil sebagai aset di **Neraca**. Tanpa `pakai`, akun default = **Kas**.
Lihat ringkas via `/akun`.

Item lain (emas, properti, utang) diinput manual lewat perintah `aset`/`liabilitas`
atau langsung di sheet **Neraca** (kolom: Tipe, Nama, Nilai, Sumber). Baris dengan
Sumber `auto` dikelola bot (saldo akun); jangan diubah manual.

### Hutang & Piutang

```
hutang budi 200000        # kamu pinjam uang dari Budi
piutang andi 150000       # Andi pinjam uang dari kamu
lunas budi                # tandai lunas (hapus catatan)
/hutang                   # lihat ringkasan + posisi bersih
```

### Edit transaksi terakhir

```
/edit kategori transportasi
/edit toko Indomaret
/edit nominal 30000
/edit catatan beli bensin
```

### Laporan bulanan otomatis

Setiap tanggal 1 (jam `monthlyReportHour`), bot mengirim ringkasan bulan
sebelumnya ke semua user. Nonaktifkan dengan `"monthlyReportEnabled": false`.

### Catat untuk tanggal lampau (backdate)

Tambahkan `tgl <tanggal>` di mana saja pada pesan:
* `keluar makan 50000 tgl 5` → tanggal 5 bulan ini
* `keluar bensin 50rb tgl 3/6/2026`

### Hapus budget / target

* `budget hapus makanan`
* `target hapus liburan`

## Transaction Examples

* keluar makan 100000 (toko otomatis "Lainnya")
* keluar makan 100000 di warung agam
* keluar bensin 50rb di SPBU Shell #isi full
* masuk gaji 5jt
* keluar toko=warung Agam kategori=makan 318000  (format label)

Catatan opsional ditambahkan dengan `#` di akhir.

## Budget, Target, Langganan

```
budget makanan 1jt          # set budget bulanan per kategori
target liburan 5jt          # buat target tabungan
nabung liburan 500k         # tambah tabungan ke target
/langganan tambah Netflix; Hiburan; 54000; 1   # tagihan rutin tiap tgl 1
/langganan tambah Gaji; Gaji; 5jt; 25; ; masuk # PEMASUKAN rutin tiap tgl 25
/langganan jalan            # catat langganan jatuh tempo hari ini
```

Langganan mendukung **pengeluaran** dan **pemasukan rutin** (tambahkan
`masuk` di field terakhir). Cocok untuk gaji, cicilan, atau langganan bulanan.

Bot memberi **peringatan budget** otomatis saat pengeluaran kategori mendekati
(80%) atau melebihi batas, dan **reminder harian** + **langganan otomatis**
sesuai jadwal (`reminderHour` / `langgananHour` di rekap.json).

## Foto Struk & Suara

* **Foto/upload struk** → dibaca AI, lalu muncul **tombol konfirmasi** untuk
  ganti kategori / simpan / batal sebelum dicatat.
* **Pesan suara** → ditranskripsi (butuh `openaiApiKey` + `sttModel`, mis.
  `whisper-1`) lalu diproses seperti teks ("keluar makan 50rb di warteg").

## Multi-user (suami–istri / keluarga)

Beberapa user Telegram bisa memakai bot yang sama dan menulis ke **satu Google
Sheet yang sama**. Untuk rumah tangga, **disarankan satu sheet gabungan** supaya
budget, saldo, dan analisa menjadi satu "keuangan keluarga". Setiap transaksi
otomatis menyimpan **kolom Pencatat** sehingga tetap terlihat siapa yang mencatat,
dan ada rincian "Pengeluaran per Pencatat" di sheet Analisa + `/analisa`.

Cara mengatur (pakai `users` agar nama tampil rapi):
```json
"users": {
  "111111111": "Suami",
  "222222222": "Istri"
}
```
Id pada `users` otomatis diizinkan. Alternatif: isi `allowedUserIds` (dipisah
koma) bila tak ingin memetakan nama (nama diambil dari profil Telegram).
Reminder & langganan otomatis dikirim ke semua user tersebut.

> Mau benar-benar terpisah? Bisa jalankan **2 instance bot** dengan
> `spreadsheetId` berbeda. Tapi untuk pasangan, satu sheet gabungan + kolom
> Pencatat jauh lebih praktis (budget & saldo menyatu).

## Mode Multi-tenant (jual ke banyak pelanggan)

Satu bot bisa melayani **banyak pelanggan**, masing-masing dengan spreadsheet
sendiri dan masa aktif sendiri. Aktifkan di `rekap.json`:

```json
"multiTenant": true,
"masterSpreadsheetId": "ID_SPREADSHEET_MASTER",
"pelangganSheetName": "Pelanggan",
"adminUserIds": "356841296",
"groupLink": "https://t.me/+D5IRzFMN2mM5NzM1"
```

- **masterSpreadsheetId**: spreadsheet pusat berisi sheet **Pelanggan** dengan
  kolom: `Telegram ID | Nama | Email | Spreadsheet ID | Sheet Name | Paket | Aktif Sampai`
  (header dibuat otomatis). Pastikan service account jadi editor di sini & di tiap sheet pelanggan.
- **adminUserIds**: yang boleh memakai perintah admin (default = ownerUserId).
- User yang belum terdaftar / kedaluwarsa otomatis ditolak dengan ajakan daftar.

**Perintah admin:**
```
/daftar TelegramID; Nama; Email; SpreadsheetID; [AktifSampai]; [SheetName]
   contoh: /daftar 356841296; Budi; budi@gmail.com; 1AbC...; 31/12/2026; Rekap
   (AktifSampai kosong = lifetime; format tanggal DD/MM/YYYY atau YYYY-MM-DD)
/pelanggan                 - daftar pelanggan + status aktif
/perpanjang TelegramID DD/MM/YYYY   (atau: lifetime)
/hapususer TelegramID
```

**Alur onboarding:** pelanggan bayar -> join grup Telegram (lihat username/ID)
-> isi Email & Nama (via Google Form) -> kamu salin template sheet, share ke
email pelanggan (Editor) + share ke service account -> jalankan `/daftar ...`
-> kirim link bot + panduan. Selesai, pelanggan langsung bisa pakai.

> Catatan: fitur "kategori map" (pemetaan kategori custom) hanya aktif di mode
> pribadi (single-tenant); di mode multi-tenant dinonaktifkan agar tidak
> tercampur antar pelanggan.

## Kolom Spreadsheet

| Tanggal | Item | Kategori | Toko | Pemasukan | Pengeluaran | Catatan | Pencatat |
|---------|------|----------|------|-----------|-------------|---------|----------|

**Item** = nama/jenis spesifik (mis. `bensin`), **Kategori** = pengelompokan induk
otomatis (mis. `Transportasi`). Rekap & analisa memakai data **Kategori**;
gunakan `/kategori` untuk melihat rincian item di tiap kategori.

### Atur kategori sendiri (custom mapping)

Kalau pengelompokan otomatis kurang pas, ajari botnya:
```
kategori map rokok Pribadi      # item "rokok" -> kategori Pribadi
kategori map kopi Jajan
kategori unmap rokok            # hapus pemetaan
kategori map                    # lihat semua pemetaan
```
Pemetaan custom diprioritaskan di atas aturan bawaan dan disimpan di sheet
**KategoriMap**.

Sheet tambahan otomatis: **Budget**, **Langganan**, **Target**, **Hutang**, **KategoriMap**, **Neraca**, **Analisa**.

## Sheet Analisa (otomatis + grafik)

Sheet **Analisa** dibuat & diperbarui otomatis setiap ada transaksi, berisi:
* Ringkasan: total pemasukan, pengeluaran, saldo, jumlah transaksi, rata-rata pengeluaran
* Tabel pengeluaran per kategori, per toko, per pencatat (dengan persentase)
* Tabel **pemasukan per kategori**
* Ringkasan per bulan (pemasukan, pengeluaran, saldo)
* **Grafik**: pie Pemasukan vs Pengeluaran, pie pengeluaran per Kategori/Toko/Pencatat,
  pie pemasukan per Kategori, dan bar Pemasukan & Pengeluaran per Bulan
* Judul & header tabel diberi warna agar lebih enak dilihat

**Gambar ilustrasi (opsional):** isi `analisaImageUrl` / `neracaImageUrl` /
`budgetImageUrl` di rekap.json dengan URL gambar publik untuk menampilkan
ilustrasi di pojok sheet (pakai rumus `IMAGE()`). Kosongkan jika tidak ingin gambar.

**Font (opsional):** `sheetFont` mengatur font sheet Neraca & Budget
(default `Roboto`).

### Sheet Neraca & Budget (dipercantik + grafik)

* **Neraca**: header berwarna, format Rupiah, dan **grafik kolom** Aset vs
  Liabilitas vs Ekuitas (muncul saat `/neraca`).
* **Budget**: kolom **Terpakai (bln ini)** & **Sisa** dihitung otomatis, plus
  **grafik Budget vs Terpakai** per kategori (muncul saat `/budget` atau saat
  set budget).

> Balasan bot dibuat santai & ramah (mis. "Sip, dicatat ya 👌").

## Induk Kategori (anti kategori ganda)

Sinonim otomatis digabung jadi satu induk kategori, jadi "makan", "makanan",
dan "warung" semuanya tercatat sebagai **Makanan**. Induk kategori pengeluaran:

`Makanan` · `Minuman` · `Kebutuhan Pokok` · `Transportasi` · `Kesehatan` ·
`Hiburan` · `Tagihan` · `Pendidikan` · `Belanja` · `Lainnya`

Induk kategori pemasukan: `Gaji` · `Bonus` · `Usaha` · `Investasi` · `Freelance`.

Kategori yang tidak dikenal tetap disimpan apa adanya (huruf dirapikan).
---
