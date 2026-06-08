# -*- coding: utf-8 -*-
"""Generate 5 ready-to-post Instagram feed images (1080x1350) for @rekapuang.id."""
import os, re
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]+")
def clean(s): return EMOJI.sub("", s).rstrip()

LOGO = "brand/logo.png"

THEMES = {
    "dark":  dict(bg=(0.10,0.22,0.16), title=(1,1,1),        body=(0.86,0.92,0.88), accent=(0.55,0.84,0.62), pill=(0.55,0.84,0.62), pilltext=(0.06,0.16,0.11)),
    "cream": dict(bg=(0.96,0.94,0.86), title=(0.12,0.30,0.20), body=(0.25,0.30,0.27), accent=(0.18,0.49,0.36), pill=(0.18,0.49,0.36), pilltext=(1,1,1)),
    "white": dict(bg=(1,1,1),          title=(0.13,0.36,0.27), body=(0.30,0.33,0.30), accent=(0.18,0.49,0.36), pill=(0.18,0.49,0.36), pilltext=(1,1,1)),
    "green": dict(bg=(0.16,0.43,0.31), title=(1,1,1),         body=(0.88,0.95,0.90), accent=(1.0,0.84,0.40),  pill=(1.0,0.84,0.40),  pilltext=(0.20,0.14,0.02)),
}

def wrap(text, font, size, maxw):
    out=[]
    for para in text.split("\n"):
        words=para.split(" "); cur=""
        for w in words:
            t=(cur+" "+w).strip()
            if not cur or stringWidth(t,font,size)<=maxw: cur=t
            else: out.append(cur); cur=w
        out.append(cur)
    return out

def draw_post(c, W, H, theme, kicker, title, body_lines, cta, tsize=72):
    th=THEMES[theme]; M=90
    c.setFillColorRGB(*th["bg"]); c.rect(0,0,W,H,fill=1,stroke=0)
    # top accent bar
    c.setFillColorRGB(*th["accent"]); c.rect(0,H-16,W,16,fill=1,stroke=0)
    # logo top-right
    c.drawImage(LOGO, W-90-96, H-110-96, 96, 96, mask='auto', preserveAspectRatio=True)
    y=H-150
    if kicker:
        c.setFillColorRGB(*th["accent"]); c.setFont("Helvetica-Bold",30)
        c.drawString(M,y,clean(kicker).upper()); y-=70
    # title
    c.setFillColorRGB(*th["title"])
    for ln in wrap(clean(title),"Helvetica-Bold",tsize,W-2*M-110):
        c.setFont("Helvetica-Bold",tsize); c.drawString(M,y,ln); y-=tsize+10
    y-=30
    # body
    for item in body_lines:
        bullet = item.startswith("- ")
        txt = clean(item[2:] if bullet else item)
        fs=38
        lines=wrap(txt,"Helvetica",fs,W-2*M-(40 if bullet else 0))
        for i,ln in enumerate(lines):
            if bullet and i==0:
                c.setFillColorRGB(*th["accent"]); c.circle(M+10,y+13,7,fill=1,stroke=0)
            c.setFillColorRGB(*th["body"]); c.setFont("Helvetica",fs)
            c.drawString(M+(40 if bullet else 0),y,ln); y-=fs+14
        y-=6
    # CTA pill near bottom
    if cta:
        c.setFont("Helvetica-Bold",36)
        pw=stringWidth(clean(cta),"Helvetica-Bold",36)+70
        px=M; py=190
        c.setFillColorRGB(*th["pill"]); c.roundRect(px,py,pw,72,36,fill=1,stroke=0)
        c.setFillColorRGB(*th["pilltext"]); c.drawString(px+35,py+24,clean(cta))
    # brand footer
    c.setFillColorRGB(*th["title"]); c.setFont("Helvetica-Bold",36)
    c.drawString(M,96,"@rekapuang.id")
    c.setFillColorRGB(*th["body"]); c.setFont("Helvetica",24)
    c.drawString(M,64,"Rekap Uang  -  Rapikan Keuanganmu")

W,H=1080,1350
os.makedirs("pemasaran/ig", exist_ok=True)

POSTS = [
    ("dark","Pernah ngerasa?","Gaji numpang lewat tiap bulan?",
     ["Bukan karena boros -", "tapi karena nggak pernah dicatat.","",
      "Rekap Uang bantu kamu catat tiap","pengeluaran cukup lewat chat.","Otomatis rapi ke Google Sheets."],
     "DM @rekapuang.id", 70),

    ("cream","Atur gaji","Rumus 50 / 30 / 20",
     ["- 50% Kebutuhan (makan, tagihan)","- 30% Keinginan (hiburan, jajan)","- 20% Tabungan & investasi","",
      "Pantau ketiganya otomatis lewat","Rekap Uang - lengkap dengan grafik."],
     "Coba sekarang -> DM", 64),

    ("white","Tantangan 30 hari","Catat 30 hari, kaget lihat hasilnya",
     ["Yang nggak kelihatan,","nggak akan bisa diatur.","",
      "Mulai hari ini, cukup ketik:","\"keluar kopi 20rb\"","langsung rapi + ada laporannya."],
     "DM 'MULAI'", 60),

    ("dark","Bocor halus","Kopi 25rb x 30 = Rp750.000",
     ["Pengeluaran kecil yang nggak kerasa","paling sering bikin dompet jebol.","",
      "Rekap Uang ingatkan budget kamu","sebelum kebablasan."],
     "DM @rekapuang.id", 62),

    ("green","Mulai hari ini","Asisten keuangan di Telegram",
     ["- Catat lewat chat / foto struk","- Budget, target, neraca, laporan","- Semua otomatis ke Google Sheets","",
      "Bisa berdua (suami-istri) - GRATIS."],
     "DM @rekapuang.id", 60),
]

for i,(theme,kicker,title,body,cta,ts) in enumerate(POSTS, 1):
    c=canvas.Canvas(f"pemasaran/ig/_post{i}.pdf", pagesize=(W,H))
    draw_post(c,W,H,theme,kicker,title,body,cta,tsize=ts)
    c.save()
print("OK 5 PDFs")
