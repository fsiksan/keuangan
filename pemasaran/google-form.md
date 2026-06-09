# Template Google Form — Pendaftaran Rekap Uang

Dua cara membuat form ini:
- **Cara cepat (otomatis):** pakai script `buat-google-form.gs` (lihat di bawah / file terpisah).
- **Cara manual:** buat form baru di https://forms.google.com lalu salin struktur di bawah.

---

## Pengaturan Form
- **Judul:** Pendaftaran Rekap Uang
- **Deskripsi:**
  ```
  Terima kasih sudah memesan Rekap Uang 🎉
  Isi form singkat ini agar akun & Google Sheet kamu bisa kami siapkan.
  Pastikan email yang diisi benar (untuk akses Google Sheet).
  ```
- **Setelan disarankan:** aktifkan "Batasi 1 tanggapan" (opsional), dan
  "Lihat ringkasan tanggapan" agar mudah memproses pendaftar.

---

## 1. Langkah 1 — Join Grup Telegram  *(wajib dicentang)*
Tipe: **Kotak centang (Checkbox)** — Wajib diisi: **Ya**

**Judul pertanyaan:**
```
Langkah 1: Join grup Telegram, lalu ketik "DAFTAR" di chat grup
```
**Teks bantuan (deskripsi):**
```
Buka grup: https://t.me/+D5IRzFMN2mM5NzM1
Setelah masuk, ketik DAFTAR di chat grup untuk verifikasi.
Centang kotak di bawah bila sudah dilakukan.
```
**Opsi centang:**
- ✅ Saya sudah join grup dan menulis "DAFTAR" di chat

---

## 2. Nama Lengkap  *(wajib)*
Tipe: **Jawaban singkat (Short answer)** — Wajib diisi: **Ya**

**Judul pertanyaan:**
```
Nama lengkap
```
**Teks bantuan:**
```
Sesuai nama yang ingin dipakai pada akun.
```

---

## 3. Alamat Email  *(wajib, validasi email)*
Tipe: **Jawaban singkat (Short answer)** — Wajib diisi: **Ya**
Validasi jawaban: **Teks → Alamat email**

**Judul pertanyaan:**
```
Alamat email (untuk akses Google Sheet)
```
**Teks bantuan:**
```
Gunakan email Google/Gmail aktif. Google Sheet keuanganmu akan
dibagikan ke email ini sebagai Editor.
```

---

## Pesan Konfirmasi (setelah submit)
```
Pendaftaran diterima ✅
Akun & Google Sheet kamu sedang kami siapkan. Cek email & grup Telegram
untuk info selanjutnya. Terima kasih — Rekap Uang, Rapikan Keuanganmu ✨
```
