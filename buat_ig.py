# -*- coding: utf-8 -*-
"""Generate ready-to-post Instagram images (PNG) for @rekapkeuangan."""
import re
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]+")
def clean(s): return EMOJI.sub("", s)

THEMES = {
    "dark":  dict(bg=(0.10,0.22,0.16), title=(1,1,1),       body=(0.86,0.92,0.88), accent=(0.55,0.84,0.62), pill=(0.55,0.84,0.62), pilltext=(0.06,0.16,0.11)),
    "cream": dict(bg=(0.96,0.94,0.86), title=(0.12,0.30,0.20), body=(0.25,0.30,0.27), accent=(0.18,0.49,0.36), pill=(0.18,0.49,0.36), pilltext=(1,1,1)),
    "white": dict(bg=(1,1,1),         title=(0.13,0.36,0.27), body=(0.30,0.33,0.30), accent=(0.18,0.49,0.36), pill=(0.18,0.49,0.36), pilltext=(1,1,1)),
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
    y=H-150
    if kicker:
        c.setFillColorRGB(*th["accent"]); c.setFont("Helvetica-Bold",30)
        c.drawString(M,y,clean(kicker).upper()); y-=70
    # title
    c.setFillColorRGB(*th["title"])
    for ln in wrap(clean(title),"Helvetica-Bold",tsize,W-2*M):
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
        px=M; py=170
        c.setFillColorRGB(*th["pill"]); c.roundRect(px,py,pw,72,36,fill=1,stroke=0)
        c.setFillColorRGB(*th["pilltext"]); c.drawString(px+35,py+24,clean(cta))
    # brand footer
    c.setFillColorRGB(*th["title"]); c.setFont("Helvetica-Bold",34)
    c.drawString(M,90,"@rekapkeuangan")
    c.setFillColorRGB(*th["body"]); c.setFont("Helvetica",24)
    c.drawString(M,60,"Asisten keuangan di Telegram")

# ---- FEED 1080x1350 ----
W,H=1080,1350
c=canvas.Canvas("ig_feed.pdf",pagesize=(W,H))

draw_post(c,W,H,"dark","Pernah ngerasa?",
    "Gaji habis, nggak tau ke mana?",
    ["Masalahnya bukan boros —", "tapi nggak kecatat.","",
     "Rekap Keuangan: cukup chat", "\"keluar makan 25rb\", langsung", "rapi ke Google Sheets + laporan."],
    "DM 'MAU' di sini", tsize=70); c.showPage()

draw_post(c,W,H,"cream","Semudah chat",
    "Catat keuangan cukup dari CHAT",
    ["- Ketik: keluar makan 25rb","- Otomatis masuk Google Sheets","- Laporan & grafik otomatis","- Tanpa install aplikasi baru"],
    "Coba sekarang -> DM", tsize=66); c.showPage()

draw_post(c,W,H,"white","Kenapa selalu gagal?",
    "3 alasan catatan keuanganmu gagal",
    ["- Aplikasinya ribet, nyerah di hari ke-3","- Lupa buka aplikasi","- Nggak ada laporan, jadi males","",
     "Solusi: catat lewat chat,","laporan otomatis."],
    "DM 'MAU'", tsize=58); c.showPage()

draw_post(c,W,H,"dark","Bukan sekadar pencatat",
    "Fitur Lengkap",
    ["- Foto struk auto-baca (AI)","- Catat pakai suara","- Budget + alarm boros","- Target nabung + progress","- Neraca: aset, utang, kekayaan","- Bisa berdua (suami-istri)"],
    "Mulai Rp99rb/tahun", tsize=72); c.showPage()

draw_post(c,W,H,"cream","Promo terbatas",
    "EARLY BIRD",
    ["Lifetime cuma Rp149.000","(normal Rp199.000)","","Sekali bayar, pakai selamanya.","Setup dibantu sampai jalan.","","Khusus 50 pembeli pertama."],
    "DM 'EARLYBIRD'", tsize=92); c.showPage()
c.save()

# ---- STORY 1080x1920 ----
Ws,Hs=1080,1920
cs=canvas.Canvas("ig_story.pdf",pagesize=(Ws,Hs))
draw_post(cs,Ws,Hs,"dark","Rekap Keuangan",
    "Atur uang tanpa ribet",
    ["- Catat lewat chat / suara","- Foto struk auto-baca","- Budget, target, neraca","- Laporan + grafik otomatis","","Mulai Rp99rb/tahun.","Setup dibantu sampai jalan."],
    "Geser / DM 'MAU'", tsize=80)
cs.save()
print("OK")
