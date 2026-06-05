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

Setelah dikonfigurasi, kirim/foto struk ke bot; rincian akan dibaca dan dicatat
sebagai pengeluaran. Pastikan model yang dipilih mendukung input gambar (vision).
---
## Running
```
node rekap.js
```
---
## Available Commands

| Command | Description |
|----------|-------------|
| /start | Start bot and show examples |
| /help | Show transaction format |
| /hari | Show today's report |
| /hari DD MM YYYY | Show report for specific day |
| /bulan | Show current month report |
| /bulan MM YYYY | Show report for specific month |
| /analisa | Build & show financial analysis summary |

## Transaction Examples

* masuk airdrop 1.5 jt
* masuk 20 usdt airdrop
* masuk $10 freelance
* keluar wifi 250k
* keluar rokok 30k
* keluar bensin 50rb

## Foto Struk

Kirim atau upload foto struk ke bot. Bot akan otomatis membaca nama toko,
tanggal, kategori, dan total, lalu menyimpannya sebagai pengeluaran.

## Kolom Spreadsheet

| Tanggal | Kategori | Toko | Pemasukan | Pengeluaran |
|---------|----------|------|-----------|-------------|

Sheet **Analisa** dibuat otomatis dan berisi ringkasan total pemasukan,
pengeluaran, saldo, pengeluaran per kategori, per toko, dan ringkasan per bulan.
---
