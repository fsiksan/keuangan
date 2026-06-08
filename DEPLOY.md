# Deploy Bot 24 Jam di VPS (PM2 + Auto-restart)

Panduan menjalankan bot non-stop di VPS Ubuntu (mis. Contabo, DigitalOcean,
Biznet, Vultr). Asumsi VPS Ubuntu 22.04 dan akses SSH.

## 1. Siapkan VPS & Node.js
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v && npm -v
```

## 2. Ambil kode
```bash
git clone https://github.com/fsiksan/keuangan.git
cd keuangan
npm install telegraf googleapis @anthropic-ai/sdk
```

## 3. Siapkan konfigurasi (JANGAN di-commit)
```bash
# kredensial Google service account
nano rekap-credentials.json     # tempel isi file JSON dari Google Cloud

# konfigurasi bot
nano rekap.json
```
Contoh `rekap.json` minimal (single-user):
```json
{
  "botToken": "ISI_TOKEN_BOTFATHER",
  "ownerUserId": "ISI_TELEGRAM_ID",
  "spreadsheetId": "ISI_SPREADSHEET_ID",
  "sheetName": "Rekap",
  "credentialsFile": "./rekap-credentials.json",
  "timezone": "Asia/Jakarta",
  "llmProvider": "openai",
  "openaiBaseUrl": "https://ai.sumopod.com/v1",
  "openaiApiKey": "ISI_API_KEY",
  "openaiModel": "gemini/gemini-2.5-flash"
}
```
> Pastikan email service account (di rekap-credentials.json) sudah jadi **Editor**
> di Google Sheet, dan **Google Sheets API** aktif. Untuk fitur `onboarding.js`,
> aktifkan juga **Google Drive API**.

### Mode multi-tenant (jual ke banyak pelanggan)
Tambahkan di `rekap.json`:
```json
  "multiTenant": true,
  "masterSpreadsheetId": "ISI_ID_SPREADSHEET_MASTER",
  "templateSpreadsheetId": "ISI_ID_SPREADSHEET_TEMPLATE",
  "adminUserIds": "ISI_TELEGRAM_ID_ADMIN",
  "groupLink": "https://t.me/+D5IRzFMN2mM5NzM1"
```
Sheet **Pelanggan** dibuat otomatis di spreadsheet master.

**Penting:** aktifkan **Google Drive API** (selain Sheets API), dan jadikan
service account **Editor** di spreadsheet *master* dan *template*. Lalu cukup
jalankan di bot:
```
/buatkan TelegramID; Nama; Email; 31/12/2026
```
Bot otomatis menyalin template, membagikan ke email pelanggan, dan mendaftarkan.
Bila service account biasa kena `storageQuotaExceeded`, tambahkan
`"sharedDriveId": "ID_SHARED_DRIVE"` di `rekap.json` (buat salinan di Shared Drive).

## 4. Jalankan dengan PM2 (auto-restart + auto-start saat reboot)
```bash
sudo npm install -g pm2
pm2 start rekap.js --name rekap-bot
pm2 save
pm2 startup        # jalankan perintah yang muncul (untuk auto-start saat reboot)
```

Cek status & log:
```bash
pm2 status
pm2 logs rekap-bot          # lihat log realtime (Ctrl+C untuk keluar)
pm2 logs rekap-bot --lines 100
```

## 5. Update bot ke versi terbaru
```bash
cd ~/keuangan
git pull
npm install          # kalau ada dependency baru
pm2 restart rekap-bot
```

## 6. Banyak bot dalam 1 VPS (model 1 bot/pelanggan, tanpa multi-tenant)
Salin folder per pelanggan dengan `rekap.json` (botToken & spreadsheetId beda):
```bash
cp -r ~/keuangan ~/bot-pelangganA
cd ~/bot-pelangganA && nano rekap.json   # ganti token & spreadsheetId
pm2 start rekap.js --name bot-pelangganA
pm2 save
```

## 7. Perintah PM2 berguna
```bash
pm2 restart rekap-bot      # restart
pm2 stop rekap-bot         # stop
pm2 delete rekap-bot       # hapus dari pm2
pm2 monit                  # monitor CPU/RAM
pm2 flush                  # bersihkan log lama
```

## 8. Tips produksi
- **Backup**: jadwalkan `/export` rutin, dan backup `rekap.json` + `rekap-credentials.json` ke tempat aman.
- **Keamanan**: jangan commit `rekap.json`/`rekap-credentials.json` (sudah di .gitignore). Batasi akses SSH (pakai SSH key, nonaktifkan login password).
- **Resource**: bot ini ringan; VPS 1 vCPU / 1 GB RAM cukup untuk puluhan user.
- **Zona waktu server** (opsional): `sudo timedatectl set-timezone Asia/Jakarta`.
- **Auto-restart kalau crash**: sudah ditangani PM2. Tambah `--max-memory-restart 300M` bila perlu:
  `pm2 start rekap.js --name rekap-bot --max-memory-restart 300M`

## 9. Error `ETIMEDOUT` / `getMe failed` saat start
Artinya VPS tidak bisa menjangkau `api.telegram.org` (Telegram diblokir
ISP/negara, firewall, atau DNS). Bot kini otomatis mencoba ulang, tapi tetap
butuh jalan keluar:
```bash
# 1) Tes koneksi dari VPS
curl -sS https://api.telegram.org/bot<TOKEN>/getMe   # harus balas JSON {"ok":true,...}
ping -c3 api.telegram.org

# 2) Jika diblokir, pakai proxy. Pasang paket lalu set proxyUrl di rekap.json:
npm install https-proxy-agent socks-proxy-agent
```
Tambahkan salah satu di `rekap.json`:
```json
  "proxyUrl": "http://user:pass@ip-proxy:port"     // proxy HTTP/HTTPS
  // atau
  "proxyUrl": "socks5://user:pass@ip-proxy:port"   // proxy SOCKS5
```
Alternatif tanpa proxy: pakai mirror/Local Bot API Server lalu set
`"telegramApiRoot": "https://alamat-mirror"` di `rekap.json`. Cara paling
sederhana biasanya **ganti/pindah VPS ke region yang tidak memblokir Telegram**
(mis. Singapura), atau aktifkan proxy/VPN di server.
