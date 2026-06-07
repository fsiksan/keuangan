# -*- coding: utf-8 -*-
"""Generate a complete PDF user guide for the Rekap Keuangan Telegram bot,
including simulated Telegram chat 'screenshots' (dark-theme bubbles)."""

import re
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

W, H = A4
MARGIN = 48
TOP = H - 54
BOTTOM = 56
CONTENT_W = W - 2 * MARGIN

# Palette
TEAL = (0.18, 0.49, 0.36)
TEAL_D = (0.13, 0.36, 0.27)
INK = (0.13, 0.15, 0.18)
GRAY = (0.40, 0.43, 0.47)
LIGHT = (0.95, 0.96, 0.95)

# Telegram dark theme
TG_BG = (0.055, 0.086, 0.13)
TG_HEADER = (0.09, 0.13, 0.18)
TG_IN = (0.12, 0.18, 0.24)     # bot bubble
TG_OUT = (0.17, 0.32, 0.47)    # user bubble
TG_TEXT = (0.93, 0.95, 0.97)
TG_SUB = (0.55, 0.62, 0.68)

EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF←-⇿⌀-⏿■-◿⬀-⯿️‍]+"
)

def clean(s):
    # reportlab base fonts can't render emoji glyphs; strip them for clean output
    return EMOJI.sub("", s).replace("  ", " ").rstrip()

def wrap(text, font, size, maxw):
    lines = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            t = (cur + " " + w).strip()
            if not cur or stringWidth(t, font, size) <= maxw:
                cur = t
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


class Guide:
    def __init__(self, path):
        self.c = canvas.Canvas(path, pagesize=A4)
        self.y = TOP
        self.page = 1

    def _footer(self):
        self.c.setFont("Helvetica", 8)
        self.c.setFillColorRGB(*GRAY)
        self.c.drawCentredString(W / 2, 30, "Panduan Bot Rekap Keuangan  •  halaman %d" % self.page)

    def newpage(self):
        self._footer()
        self.c.showPage()
        self.page += 1
        self.y = TOP

    def need(self, h):
        if self.y - h < BOTTOM:
            self.newpage()

    def h1(self, text):
        self.need(40)
        self.y -= 8
        self.c.setFillColorRGB(*TEAL)
        self.c.rect(MARGIN, self.y - 22, CONTENT_W, 26, fill=1, stroke=0)
        self.c.setFillColorRGB(1, 1, 1)
        self.c.setFont("Helvetica-Bold", 13)
        self.c.drawString(MARGIN + 10, self.y - 16, clean(text))
        self.y -= 36

    def h2(self, text):
        self.need(28)
        self.y -= 4
        self.c.setFillColorRGB(*TEAL_D)
        self.c.setFont("Helvetica-Bold", 11.5)
        self.c.drawString(MARGIN, self.y - 12, clean(text))
        self.y -= 22

    def para(self, text, size=10, color=INK, gap=6):
        text = clean(text)
        for line in wrap(text, "Helvetica", size, CONTENT_W):
            self.need(size + 4)
            self.c.setFillColorRGB(*color)
            self.c.setFont("Helvetica", size)
            self.c.drawString(MARGIN, self.y - size, line)
            self.y -= size + 3
        self.y -= gap

    def bullet(self, text, size=10):
        text = clean(text)
        indent = 14
        lines = wrap(text, "Helvetica", size, CONTENT_W - indent)
        for i, line in enumerate(lines):
            self.need(size + 4)
            self.c.setFillColorRGB(*INK)
            self.c.setFont("Helvetica", size)
            if i == 0:
                self.c.setFillColorRGB(*TEAL)
                self.c.drawString(MARGIN, self.y - size, "•")
                self.c.setFillColorRGB(*INK)
            self.c.drawString(MARGIN + indent, self.y - size, line)
            self.y -= size + 3
        self.y -= 2

    def code(self, text):
        text = clean(text)
        font, size = "Courier", 9.5
        lines = []
        for ln in text.split("\n"):
            lines += wrap(ln, font, size, CONTENT_W - 16) or [""]
        h = 10 + len(lines) * (size + 3)
        self.need(h + 6)
        self.c.setFillColorRGB(0.95, 0.96, 0.94)
        self.c.roundRect(MARGIN, self.y - h, CONTENT_W, h, 5, fill=1, stroke=0)
        ty = self.y - 12
        for ln in lines:
            self.c.setFillColorRGB(0.12, 0.30, 0.20)
            self.c.setFont(font, size)
            self.c.drawString(MARGIN + 8, ty, ln)
            ty -= size + 3
        self.y -= h + 8

    # ---- Telegram chat mockup ----
    def chat(self, title, messages, width=360):
        font, size, pad, lh, gap = "Helvetica", 9.5, 8, 12.5, 7
        header_h = 30
        bub_w_max = width * 0.74

        prepared = []
        total = header_h + 12
        for who, txt in messages:
            txt = clean(txt)
            lines = wrap(txt, font, size, bub_w_max - 2 * pad)
            bw = max([stringWidth(l, font, size) for l in lines] + [40]) + 2 * pad
            bh = 2 * pad + len(lines) * lh
            prepared.append((who, lines, bw, bh))
            total += bh + gap
        total += 6

        self.need(total + 8)
        x = MARGIN + (CONTENT_W - width) / 2
        top = self.y
        # panel
        self.c.setFillColorRGB(*TG_BG)
        self.c.roundRect(x, top - total, width, total, 10, fill=1, stroke=0)
        # header
        self.c.setFillColorRGB(*TG_HEADER)
        self.c.roundRect(x, top - header_h, width, header_h, 10, fill=1, stroke=0)
        self.c.setFillColorRGB(*TG_HEADER)
        self.c.rect(x, top - header_h, width, header_h - 8, fill=1, stroke=0)
        self.c.setFillColorRGB(*TEAL)
        self.c.circle(x + 18, top - header_h / 2, 9, fill=1, stroke=0)
        self.c.setFillColorRGB(*TG_TEXT)
        self.c.setFont("Helvetica-Bold", 9.5)
        self.c.drawString(x + 33, top - 13, clean(title))
        self.c.setFillColorRGB(*TG_SUB)
        self.c.setFont("Helvetica", 7.5)
        self.c.drawString(x + 33, top - 23, "bot")

        cy = top - header_h - 10
        for who, lines, bw, bh in prepared:
            if who == "user":
                bx = x + width - bw - 10
                self.c.setFillColorRGB(*TG_OUT)
            else:
                bx = x + 10
                self.c.setFillColorRGB(*TG_IN)
            self.c.roundRect(bx, cy - bh, bw, bh, 8, fill=1, stroke=0)
            ty = cy - pad - size + 2
            self.c.setFillColorRGB(*TG_TEXT)
            self.c.setFont(font, size)
            for l in lines:
                self.c.drawString(bx + pad, ty, l)
                ty -= lh
            cy -= bh + gap
        self.y = top - total - 10

    def save(self):
        self._footer()
        self.c.save()


g = Guide("panduan-bot-rekap-keuangan.pdf")
c = g.c

# ---------------- COVER ----------------
c.setFillColorRGB(*TG_BG)
c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColorRGB(*TEAL)
c.rect(0, H - 250, W, 250, fill=1, stroke=0)
c.setFillColorRGB(1, 1, 1)
c.setFont("Helvetica-Bold", 30)
c.drawCentredString(W / 2, H - 150, "Bot Rekap Keuangan")
c.setFont("Helvetica", 15)
c.drawCentredString(W / 2, H - 178, "Panduan Lengkap Penggunaan")
c.setFillColorRGB(*TG_SUB)
c.setFont("Helvetica", 11)
c.drawCentredString(W / 2, 120, "Catat keuangan langsung dari Telegram - otomatis ke Google Sheets")
c.setFillColorRGB(0.8, 0.85, 0.9)
c.setFont("Helvetica", 10)
c.drawCentredString(W / 2, H - 300, "Pemasukan - Pengeluaran - Struk - Budget - Target - Neraca")
# little mock bubbles on cover
g.y = H - 340
g.chat("Rekap Keuangan", [
    ("user", "keluar makan 25000 di warung agam pakai gopay"),
    ("bot", "Sip, dicatat ya\npengeluaran | makan -> Makanan | toko: warung agam | Gopay | Rp25.000"),
], width=420)
c.showPage()
g.page = 2
g.y = TOP

# ---------------- 1. PENGANTAR ----------------
g.h1("1. Pengantar")
g.para("Bot ini membantu kamu mencatat keuangan langsung dari chat Telegram. "
       "Setiap transaksi otomatis tersimpan ke Google Sheets, lengkap dengan kategori, "
       "toko, akun/dompet, catatan, dan analisa. Kamu cukup mengetik seperti bicara biasa, "
       "atau bahkan memotret struk dan mengirim pesan suara.")
g.h2("Cara membuka")
g.bullet("Buka chat bot di Telegram, lalu ketik /start untuk melihat panduan singkat dan tombol pintasan.")
g.bullet("Ketik /help kapan saja untuk bantuan lengkap.")
g.bullet("Tombol menu (garis tiga / Menu) menampilkan semua perintah.")

# ---------------- 2. MENCATAT ----------------
g.h1("2. Mencatat Transaksi")
g.para("Format paling mudah:")
g.code("keluar <item> <nominal>\nmasuk <item> <nominal>")
g.para("\"item\" adalah nama/jenisnya (mis. bensin, makan, gaji). Bot otomatis "
       "mengelompokkannya ke kategori induk (bensin -> Transportasi, makan -> Makanan).")
g.chat("Rekap Keuangan", [
    ("user", "keluar bensin 50000"),
    ("bot", "Sip, dicatat ya\npengeluaran | bensin -> Transportasi | Rp50.000"),
    ("user", "masuk gaji 5jt"),
    ("bot", "Mantap, tercatat\npemasukan | gaji -> Gaji | Rp5.000.000"),
])
g.h2("Tambahan opsional")
g.bullet("di <toko>  ->  mengisi kolom Toko. Contoh: keluar makan 30rb di warteg")
g.bullet("pakai <akun>  ->  memilih dompet/akun. Contoh: keluar kopi 20rb pakai gopay")
g.bullet("#catatan  ->  menambah catatan. Contoh: keluar wifi 150rb #bayar bulanan")
g.bullet("tgl <tanggal>  ->  mencatat untuk tanggal lampau. Contoh: keluar makan 25rb tgl 3/6/2026")
g.para("Semua bisa digabung dalam satu pesan, urutannya bebas:", gap=3)
g.chat("Rekap Keuangan", [
    ("user", "keluar makan 25000 di warung agam pakai gopay #makan siang"),
    ("bot", "Beres! Dicatat ya\npengeluaran | makan -> Makanan | toko: warung agam | Gopay | Rp25.000 | #makan siang"),
])
g.h2("Format nominal")
g.bullet("Angka biasa: 25000  /  25.000")
g.bullet("Singkatan: 25rb, 25k, 1,5jt, 5jt")
g.bullet("Mata uang asing (dikonversi otomatis): 20 usdt, $10")
g.h2("Banyak transaksi sekaligus")
g.para("Kirim beberapa baris dalam satu pesan; tiap baris dicatat terpisah.")

# ---------------- 3. STRUK ----------------
g.h1("3. Foto Struk (otomatis dibaca AI)")
g.para("Foto atau upload struk belanja. Bot membaca toko, tanggal, kategori, dan total, "
       "lalu menampilkan ringkasan dengan tombol konfirmasi sebelum disimpan.")
g.chat("Rekap Keuangan", [
    ("user", "[ Foto struk Indomaret ]"),
    ("bot", "Sebentar ya, lagi baca strukmu ..."),
    ("bot", "Hasil baca struk\nTanggal: 16/5/2026\nItem: Belanja harian\nKategori: Kebutuhan Pokok\nToko: Indomaret\nTotal: Rp25.000\n\nKategorinya pas? Kalau perlu ganti dulu, lalu tekan Simpan"),
])
g.para("Di bawah pesan muncul tombol: pilihan kategori, [ Simpan ] dan [ Batal ]. "
       "Tekan Simpan untuk mencatat. Butuh model AI yang mendukung gambar (vision), "
       "mis. Gemini Flash, GPT-4o mini, atau Claude.")

# ---------------- 4. SUARA ----------------
g.h1("4. Pesan Suara")
g.para("Kirim voice note, bot akan mengetik ulang lalu mencatatnya seperti teks biasa. "
       "(Butuh layanan transkripsi/STT yang diaktifkan di konfigurasi.)")
g.chat("Rekap Keuangan", [
    ("user", "[ Pesan suara 0:03 ]"),
    ("bot", "\"keluar kopi 20 ribu pakai gopay\""),
    ("bot", "Sip, dicatat ya\npengeluaran | kopi -> Minuman | Gopay | Rp20.000"),
])

# ---------------- 5. BUDGET ----------------
g.h1("5. Budget & Peringatan")
g.para("Atur batas pengeluaran bulanan per kategori. Bot otomatis mengingatkan saat "
       "pemakaian mendekati (80%) atau melebihi batas.")
g.code("budget makanan 1jt        (atur budget)\nbudget hapus makanan      (hapus budget)")
g.chat("Rekap Keuangan", [
    ("user", "budget makanan 1jt"),
    ("bot", "Sip Budget Makanan diset Rp1.000.000 / bulan. Nanti kuingatkan kalau mepet ya."),
    ("user", "keluar makan 900rb"),
    ("bot", "Sip, dicatat ya\npengeluaran | makan -> Makanan | Rp900.000\n\nBudget Makanan hampir habis: Rp900.000 / Rp1.000.000 (90%)"),
])
g.para("Lihat ringkasan budget + grafik di sheet dengan perintah /budget. "
       "Sheet Budget menampilkan kolom Terpakai & Sisa serta grafik Budget vs Terpakai.")

# ---------------- 6. TARGET ----------------
g.h1("6. Target Tabungan")
g.code("target liburan 5jt        (buat target)\nnabung liburan 500k       (tambah tabungan)\ntarget hapus liburan      (hapus)")
g.chat("Rekap Keuangan", [
    ("user", "target liburan 5jt"),
    ("bot", "Mantap, target \"liburan\" diset Rp5.000.000\nMulai nabung: nabung liburan <nominal>"),
    ("user", "nabung liburan 500k"),
    ("bot", "Sip, nabung Rp500.000 ke \"liburan\"\nProgress: Rp500.000 / Rp5.000.000 (10%)\n[#---------] 10%\nMantap, nabung terus ya"),
])
g.para("Lihat semua target dengan /target.")

# ---------------- 7. LANGGANAN ----------------
g.h1("7. Langganan / Rutin (pengeluaran & pemasukan)")
g.para("Catat tagihan atau pemasukan berulang; bot mencatatnya otomatis tiap tanggal tertentu.")
g.code("/langganan tambah Netflix; Hiburan; 54000; 1\n"
       "/langganan tambah Gaji; Gaji; 5jt; 25; ; masuk\n"
       "/langganan            (lihat daftar)\n"
       "/langganan jalan      (proses yang jatuh tempo hari ini)\n"
       "/langganan hapus Netflix")
g.para("Format: Nama; Kategori; Nominal; Hari; [Toko]; [masuk/keluar]. "
       "Tambahkan 'masuk' di akhir untuk pemasukan rutin (mis. gaji).")

# ---------------- 8. HUTANG ----------------
g.h1("8. Hutang & Piutang")
g.code("hutang budi 200000     (kamu pinjam uang dari Budi)\n"
       "piutang andi 150000    (Andi pinjam ke kamu)\n"
       "lunas budi             (tandai lunas)\n"
       "/hutang                (ringkasan + posisi bersih)")

# ---------------- 9. NERACA & AKUN ----------------
g.h1("9. Neraca & Akun/Dompet")
g.para("Setiap transaksi bisa menyebut akun (pakai <akun>). Saldo tiap akun (Kas, GoPay, "
       "Bank, dst.) dihitung otomatis dan menjadi aset di Neraca. Tambahkan aset/liabilitas "
       "lain secara manual.")
g.code("aset Bank BCA 5jt\naset Emas 10jt\nliabilitas KPR 100jt\naset hapus Emas")
g.chat("Rekap Keuangan", [
    ("user", "/akun"),
    ("bot", "Saldo per Akun/Dompet\n- Kas: Rp1.200.000\n- Bank Bca: Rp5.000.000\n- Gopay: Rp300.000\n\nTotal: Rp6.500.000"),
    ("user", "/neraca"),
    ("bot", "NERACA (Balance Sheet)\nAKUN/DOMPET: Kas, Bank Bca, Gopay ...\nTotal Aset: Rp16.500.000\nLIABILITAS: KPR Rp100.000.000\nEKUITAS (kekayaan bersih): -Rp83.500.000"),
])
g.para("Sheet Neraca dipercantik dengan warna + grafik Aset vs Liabilitas vs Ekuitas.")

# ---------------- 10. LAPORAN ----------------
g.h1("10. Laporan & Analisa")
g.bullet("/saldo - saldo total & ringkasan bulan ini")
g.bullet("/hari [DD MM YYYY] - rekap harian")
g.bullet("/minggu - rekap 7 hari terakhir")
g.bullet("/bulan [MM YYYY] - rekap bulanan")
g.bullet("/laporan [MM YYYY] - laporan + grafik + perbandingan bulan lalu + proyeksi")
g.bullet("/analisa - analisa lengkap + grafik di sheet Analisa")
g.bullet("/kategori - rincian item per kategori bulan ini")
g.bullet("/ringkasan - dashboard: saldo, top kategori, status budget, target, hutang")
g.bullet("/tips - saran hemat dari AI berdasarkan data bulan ini")
g.para("Sheet Analisa otomatis berisi ringkasan, tabel per kategori/toko/pencatat, "
       "pemasukan per kategori, ringkasan per bulan, dan beberapa grafik (pie & bar).")

# ---------------- 11. KATEGORI CUSTOM ----------------
g.h1("11. Atur Kategori Sendiri")
g.para("Kalau pengelompokan otomatis kurang pas, ajari botnya:")
g.code("kategori map rokok Pribadi    (item 'rokok' -> kategori Pribadi)\n"
       "kategori unmap rokok          (hapus pemetaan)\n"
       "kategori map                  (lihat semua pemetaan)")

# ---------------- 12. EDIT/HAPUS ----------------
g.h1("12. Koreksi Data")
g.bullet("/edit kategori <baru> | /edit toko <baru> | /edit nominal <baru> | /edit item <baru> | /edit akun <baru> | /edit catatan <baru>  - edit transaksi terakhir")
g.bullet("/hapus - hapus transaksi terakhir (dengan konfirmasi tombol)")
g.bullet("/batal - kembalikan transaksi yang baru saja dihapus")
g.bullet("/export [MM YYYY] - unduh data CSV (semua / per bulan)")
g.bullet("/migrasi - rapikan data lama (normalisasi kategori, isi Item kosong)")

# ---------------- 13. MULTI USER ----------------
g.h1("13. Multi-user (suami-istri / keluarga)")
g.para("Beberapa orang bisa memakai bot yang sama dan menulis ke satu Google Sheet. "
       "Setiap transaksi mencatat kolom 'Pencatat' sehingga terlihat siapa yang input. "
       "Atur daftar user yang diizinkan (dan pemetaan namanya) di konfigurasi.")

# ---------------- 14. DAFTAR PERINTAH ----------------
g.h1("14. Daftar Perintah Lengkap")
cmds = [
    ("/start", "Mulai & petunjuk"),
    ("/help", "Bantuan lengkap"),
    ("/menu", "Tombol pintasan"),
    ("/saldo", "Saldo total & bulan ini"),
    ("/hari", "Rekap harian"),
    ("/minggu", "Rekap 7 hari"),
    ("/bulan", "Rekap bulanan"),
    ("/laporan", "Laporan + grafik"),
    ("/analisa", "Analisa + grafik"),
    ("/kategori", "Item per kategori"),
    ("/tips", "Saran hemat AI"),
    ("/ringkasan", "Dashboard"),
    ("/budget", "Budget & pemakaian"),
    ("/target", "Target tabungan"),
    ("/langganan", "Tagihan/pemasukan rutin"),
    ("/hutang", "Hutang & piutang"),
    ("/neraca", "Aset, liabilitas, ekuitas"),
    ("/akun", "Saldo per dompet"),
    ("/cari", "Cari transaksi"),
    ("/export", "Unduh CSV"),
    ("/edit", "Edit transaksi terakhir"),
    ("/hapus", "Hapus transaksi terakhir"),
    ("/batal", "Kembalikan yang dihapus"),
    ("/migrasi", "Rapikan data lama"),
]
# two-column table
g.need(20)
col_w = CONTENT_W / 2
rowh = 16
i = 0
import math
rows = math.ceil(len(cmds) / 2)
for r in range(rows):
    g.need(rowh)
    for col in range(2):
        idx = r + col * rows
        if idx >= len(cmds):
            continue
        cmd, desc = cmds[idx]
        x = MARGIN + col * col_w
        g.c.setFillColorRGB(*TEAL_D)
        g.c.setFont("Helvetica-Bold", 9.5)
        g.c.drawString(x, g.y - 11, cmd)
        g.c.setFillColorRGB(*INK)
        g.c.setFont("Helvetica", 9)
        g.c.drawString(x + 78, g.y - 11, desc)
    g.y -= rowh

# ---------------- 15. TIPS ----------------
g.h1("15. Tips & Catatan")
g.bullet("Pencatatan terasa seperti chat biasa - tidak perlu format kaku.")
g.bullet("Kategori 'makan'/'makanan'/'warung' otomatis jadi satu: Makanan. Gunakan kategori map untuk menyesuaikan.")
g.bullet("Untuk struk, gunakan model AI yang mendukung gambar (vision).")
g.bullet("Jaga kerahasiaan token bot & API key - jangan dibagikan atau di-commit ke repo publik.")
g.bullet("Jalankan /export secara berkala sebagai cadangan data.")

g.save()
print("PDF dibuat: panduan-bot-rekap-keuangan.pdf")
