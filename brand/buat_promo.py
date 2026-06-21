# -*- coding: utf-8 -*-
"""Generate a short promo video (vertical 1080x1920) for Rekap Uang,
with opening animation, animated captions, Ken Burns zoom, and music."""
import os, math, shutil
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
FPS = 30
OUT_FRAMES = "promo_frames"
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

TG_BG = (15, 22, 33)
TG_HEADER = (23, 33, 43)
TG_IN = (32, 44, 56)
TG_OUT = (44, 95, 70)
TG_TEXT = (236, 240, 243)
TG_SUB = (140, 158, 170)
GREEN = (46, 157, 107)
GREEN_D = (28, 106, 73)
GOLD = (255, 213, 79)

def F(size, bold=True):
    return ImageFont.truetype(DEJAVU_B if bold else DEJAVU, size)
def Fm(size):
    return ImageFont.truetype(MONO, size)

def ease_out(t):  return 1 - (1 - t) ** 3
def ease_inout(t): return 0.5 - 0.5 * math.cos(math.pi * t)

def wrap(draw, text, font, maxw):
    out = []
    for para in text.split("\n"):
        words = para.split(" "); cur = ""
        for w in words:
            tt = (cur + " " + w).strip()
            if not cur or draw.textlength(tt, font=font) <= maxw: cur = tt
            else: out.append(cur); cur = w
        out.append(cur)
    return out

def rrect(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)

# ---------- backgrounds ----------
def header(img):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 150], fill=TG_HEADER)
    try:
        logo = Image.open("brand/logo.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
        m = Image.new("L", (96, 96), 0); ImageDraw.Draw(m).ellipse([0, 0, 96, 96], fill=255)
        img.paste(logo, (40, 27), m)
    except Exception:
        d.ellipse([40, 27, 136, 123], fill=GREEN)
    d.text((160, 45), "Rekap Uang", font=F(40), fill=TG_TEXT)
    d.text((160, 95), "bot", font=F(26, False), fill=TG_SUB)

def base():
    img = Image.new("RGB", (W, H), TG_BG); header(img); return img

def green_bg():
    img = Image.new("RGB", (W, H), GREEN_D)
    d = ImageDraw.Draw(img)
    d.ellipse([-220, -220, 380, 380], fill=(40, 130, 95))
    d.ellipse([W - 280, H - 360, W + 240, H + 200], fill=(36, 118, 82))
    d.ellipse([W - 180, -160, W + 160, 180], fill=(38, 124, 88))
    return img

def draw_bubbles(img, msgs, y0=190):
    d = ImageDraw.Draw(img); pad = 26; maxw = int(W * 0.74); y = y0
    for who, text in msgs:
        font = Fm(30) if who == "user" else F(30, False)
        lines = wrap(d, text, font, maxw - 2 * pad); lh = font.size + 12
        bw = max([d.textlength(l, font=font) for l in lines] + [60]) + 2 * pad
        bh = 2 * pad + len(lines) * lh
        bx = W - bw - 40 if who == "user" else 40
        rrect(d, [bx, y, bx + bw, y + bh], 28, TG_OUT if who == "user" else TG_IN)
        ty = y + pad
        for l in lines:
            d.text((bx + pad, ty), l, font=font, fill=TG_TEXT); ty += lh
        y += bh + 22
    return y

# ---------- scenes ----------
def scene_intro():
    img = base()
    draw_bubbles(img, [
        ("bot", "Selamat datang di Rekap Uang!\nCatat keuangan cukup dari chat — otomatis rapi ke Google Sheets."),
        ("bot", "Coba ketik:\nkeluar makan 25rb\nmasuk gaji 5jt"),
    ])
    return img, (W // 2, 360)

def scene_expense():
    img = base()
    draw_bubbles(img, [
        ("bot", "Selamat datang di Rekap Uang!"),
        ("user", "keluar makan 25rb di warteg"),
        ("bot", "Sip, dicatat ya\npengeluaran | makan -> Makanan\ntoko: warteg | Rp25.000"),
    ])
    return img, (W // 2, 720)

def scene_income():
    img = base()
    draw_bubbles(img, [
        ("user", "keluar makan 25rb di warteg"),
        ("bot", "Sip, dicatat ya | Rp25.000"),
        ("user", "masuk gaji 5jt"),
        ("bot", "Mantap, tercatat\npemasukan | gaji -> Gaji | Rp5.000.000"),
    ])
    return img, (W // 2, 900)

def scene_target():
    img = base()
    draw_bubbles(img, [
        ("user", "target liburan 5jt"),
        ("bot", "Target \"liburan\" diset Rp5.000.000\nMulai: nabung liburan <nominal>"),
        ("user", "nabung liburan 500k"),
        ("bot", "Sip, nabung Rp500.000\nProgress: 500.000 / 5.000.000 (10%)\n[#---------] 10%"),
    ])
    return img, (W // 2, 980)

def scene_map():
    img = base()
    draw_bubbles(img, [
        ("user", "kategori map kopi Jajan"),
        ("bot", "Tersimpan: item \"kopi\" -> kategori Jajan."),
        ("user", "kategori unmap kopi"),
        ("bot", "Pemetaan \"kopi\" dihapus."),
        ("user", "budget makanan 1jt"),
        ("bot", "Budget Makanan: Rp1.000.000 / bulan."),
    ])
    return img, (W // 2, 760)

def scene_struk():
    img = base()
    draw_bubbles(img, [
        ("user", "[ Foto struk belanja ]"),
        ("bot", "Hasil baca struk\nTotal struk: Rp117.500"),
        ("bot", "Pilih bagianmu (split bill):\n[x] Lunch Box   Rp24.500\n[x] Cup 4 pcs    Rp17.000\n[ ] Cloth Peg    Rp14.500\n\nBagianmu: Rp41.500"),
    ])
    return img, (W // 2, 760)

def scene_voice():
    img = base()
    draw_bubbles(img, [
        ("user", "[ Pesan suara  0:03 ]"),
        ("bot", "\"masuk gaji 5 juta\""),
        ("bot", "Mantap, tercatat\npemasukan | gaji -> Gaji | Rp5.000.000"),
    ])
    return img, (W // 2, 540)

# ---------- caption banner overlay ----------
def caption_overlay(text):
    """Return RGBA overlay (full canvas) with a rounded caption banner near bottom."""
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    font = F(44)
    tw = d.textlength(text, font=font)
    bw = min(W - 80, tw + 90); bh = 104
    bx = (W - bw) // 2; by = 1600
    rrect(d, [bx, by, bx + bw, by + bh], 52, (28, 106, 73, 235))
    rrect(d, [bx, by, bx + bw, by + 6], 3, (255, 213, 79, 255))
    d.text((W // 2, by + bh // 2 + 2), text, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return ov

def ken_burns_frame(img, t, z0, z1, focus):
    e = ease_inout(t); z = z0 + (z1 - z0) * e
    cw, ch = int(W / z), int(H / z)
    fx, fy = focus
    cx = min(max(fx, cw // 2), W - cw // 2); cy = min(max(fy, ch // 2), H - ch // 2)
    left = cx - cw // 2; top = cy - ch // 2
    return img.crop((left, top, left + cw, top + ch)).resize((W, H), Image.LANCZOS)

def scene_frames(img, focus, secs, z0, z1, caption=None):
    n = int(secs * FPS); frames = []
    ov = caption_overlay(caption) if caption else None
    fin = 12; fout = 10
    for i in range(n):
        t = i / max(1, n - 1)
        fr = ken_burns_frame(img, t, z0, z1, focus).convert("RGBA")
        if ov is not None:
            if i < fin: a = i / fin
            elif i > n - fout: a = max(0.0, (n - i) / fout)
            else: a = 1.0
            dy = int((1 - ease_out(min(1, i / fin))) * 45) if i < fin else 0
            tmp = ov.copy()
            if a < 1.0:
                al = tmp.split()[3].point(lambda p: int(p * a)); tmp.putalpha(al)
            if dy:
                shifted = Image.new("RGBA", (W, H), (0, 0, 0, 0)); shifted.paste(tmp, (0, dy)); tmp = shifted
            fr = Image.alpha_composite(fr, tmp)
        frames.append(fr.convert("RGB"))
    return frames

# ---------- opening animation ----------
def opening_frames(secs=2.6):
    n = int(secs * FPS); frames = []
    logo = Image.open("brand/logo.png").convert("RGBA")
    for i in range(n):
        t = i / max(1, n - 1)
        img = green_bg().convert("RGBA")
        d = ImageDraw.Draw(img)
        # logo pop-in (scale + fade)
        le = ease_out(min(1, t / 0.55))
        ls = int(120 + 300 * le)
        if ls > 0:
            lg = logo.resize((ls, ls), Image.LANCZOS)
            la = int(255 * min(1, t / 0.4))
            al = lg.split()[3].point(lambda p: int(p * la / 255))
            lg.putalpha(al)
            img.alpha_composite(lg, ((W - ls) // 2, 560 - ls // 2 + 60))
        # title fade/slide
        if t > 0.35:
            tt = ease_out(min(1, (t - 0.35) / 0.45))
            ty = int(60 * (1 - tt))
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            ld.text((W // 2, 880 + ty), "Rekap Uang", font=F(104), fill=(255, 255, 255, int(255 * tt)), anchor="mm")
            img = Image.alpha_composite(img, layer)
        # tagline fade
        if t > 0.62:
            tt = min(1, (t - 0.62) / 0.38)
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            tag = "Rapikan Keuanganmu"; tf = F(46)
            tw = ld.textlength(tag, font=tf); px = (W - (tw + 90)) // 2
            ld.rounded_rectangle([px, 960, px + tw + 90, 1046], radius=43, fill=(255, 213, 79, int(255 * tt)))
            ld.text((W // 2, 1003), tag, font=tf, fill=(74, 52, 6, int(255 * tt)), anchor="mm")
            img = Image.alpha_composite(img, layer)
        frames.append(img.convert("RGB"))
    return frames

# ---------- outro animation (mascot bounce-in) ----------
def outro_frames(secs=3.0):
    n = int(secs * FPS); frames = []
    mask = Image.open("brand/maskot.png").convert("RGBA")
    for i in range(n):
        t = i / max(1, n - 1)
        img = green_bg().convert("RGBA")
        e = ease_out(min(1, t / 0.5))
        mw = int(300 + 360 * e); mh = int(mask.height * mw / mask.width)
        mg = mask.resize((mw, mh), Image.LANCZOS)
        ma = int(255 * min(1, t / 0.35)); al = mg.split()[3].point(lambda p: int(p * ma / 255)); mg.putalpha(al)
        img.alpha_composite(mg, ((W - mw) // 2, 470 - (mh - 700) // 2))
        if t > 0.4:
            tt = min(1, (t - 0.4) / 0.45)
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0)); ld = ImageDraw.Draw(layer)
            ld.text((W // 2, 1235), "Rekap Uang", font=F(98), fill=(255, 255, 255, int(255 * tt)), anchor="mm")
            tag = "Rapikan Keuanganmu"; tf = F(46)
            tw = ld.textlength(tag, font=tf); px = (W - (tw + 100)) // 2
            ld.rounded_rectangle([px, 1300, px + tw + 100, 1392], radius=46, fill=(255, 213, 79, int(255 * tt)))
            ld.text((W // 2, 1346), tag, font=tf, fill=(74, 52, 6, int(255 * tt)), anchor="mm")
            ld.text((W // 2, 1470), "@rekapuang.id", font=F(40), fill=(223, 243, 231, int(255 * tt)), anchor="mm")
            img = Image.alpha_composite(img, layer)
        frames.append(img.convert("RGB"))
    return frames

def crossfade(seq, frames, xf=12):
    if not seq: seq.extend(frames); return
    prev = seq[-xf:]; head = frames[:xf]; del seq[-xf:]
    for k in range(xf):
        seq.append(Image.blend(prev[k], head[k], (k + 1) / (xf + 1)))
    seq.extend(frames[xf:])

# ---------- Google Sheets mockup ----------
SH_W = 1000
CARD_TOP = 380
CHROME_H = 58

def _sheet_chart(d, x, y, w, h, values, labels, colors):
    mx = max(values) or 1
    n = len(values); gap = 24
    bw = (w - gap * (n + 1)) / n
    base = y + h - 34
    for i, (v, lb, co) in enumerate(zip(values, labels, colors)):
        bx = x + gap + i * (bw + gap)
        bh = (h - 64) * (v / mx)
        d.rounded_rectangle([bx, base - bh, bx + bw, base], radius=8, fill=co)
        d.text((bx + bw / 2, base + 16), lb, font=F(20, False), fill=(90, 100, 95), anchor="ma")

def render_sheet(headers, rows, colws, money_cols, tabs, active, title, chart=None):
    gutter = 70; colhdr = 44; title_h = 74; header_h = 60; rowh = 58; tab_h = 84
    width = gutter + sum(colws)
    chart_h = chart["h"] if chart else 0
    height = colhdr + title_h + header_h + rowh * len(rows) + chart_h + tab_h
    img = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, colhdr], fill=(248, 249, 250))
    d.rectangle([0, 0, gutter, height - tab_h], fill=(248, 249, 250))
    cx = gutter
    for i, cw in enumerate(colws):
        d.text((cx + cw / 2, colhdr / 2), chr(65 + i), font=F(20, False), fill=(120, 124, 130), anchor="mm"); cx += cw
    ty = colhdr
    d.rectangle([gutter, ty, width, ty + title_h], fill=(46, 125, 92))
    d.text((width - 20, ty + title_h / 2), title, font=F(34), fill=(255, 255, 255), anchor="rm")
    hy = ty + title_h
    d.rectangle([gutter, hy, width, hy + header_h], fill=(214, 237, 222))
    cx = gutter
    for hd, cw in zip(headers, colws):
        d.text((cx + 14, hy + header_h / 2), hd, font=F(24), fill=(20, 40, 30), anchor="lm"); cx += cw
    ry = hy + header_h
    for ri, row in enumerate(rows):
        d.rectangle([gutter, ry, width, ry + rowh], fill=(255, 255, 255) if ri % 2 == 0 else (246, 250, 247))
        cx = gutter
        for ci, cw in enumerate(colws):
            val = str(row[ci]) if ci < len(row) else ""
            if ci in money_cols and val:
                d.text((cx + cw - 14, ry + rowh / 2), val, font=F(24, False), fill=(20, 40, 30), anchor="rm")
            else:
                d.text((cx + 14, ry + rowh / 2), val, font=F(24, False), fill=(40, 44, 48), anchor="lm")
            cx += cw
        ry += rowh
    d.text((gutter / 2, colhdr + title_h / 2), "1", font=F(18, False), fill=(150, 154, 160), anchor="mm")
    d.text((gutter / 2, colhdr + title_h + header_h / 2), "2", font=F(18, False), fill=(150, 154, 160), anchor="mm")
    for ri in range(len(rows)):
        yy = colhdr + title_h + header_h + ri * rowh + rowh / 2
        d.text((gutter / 2, yy), str(ri + 3), font=F(18, False), fill=(150, 154, 160), anchor="mm")
    if chart:
        _sheet_chart(d, gutter + 30, ry + 14, width - gutter - 60, chart["h"] - 34, chart["values"], chart["labels"], chart["colors"])
        ry += chart["h"]
    cx = gutter
    for cw in colws:
        cx += cw; d.line([cx, colhdr, cx, ry], fill=(228, 230, 233), width=1)
    yy = colhdr
    for hh in [title_h, header_h] + [rowh] * len(rows):
        yy += hh; d.line([gutter, yy, width, yy], fill=(228, 230, 233), width=1)
    d.line([gutter, colhdr, gutter, height - tab_h], fill=(218, 220, 224), width=1)
    by = height - tab_h
    d.rectangle([0, by, width, height], fill=(241, 243, 244))
    tx = 30
    for tb in tabs:
        tf = F(26) if tb == active else F(26, False)
        tw = d.textlength(tb, font=tf)
        d.text((tx, by + tab_h / 2), tb, font=tf, fill=(46, 125, 92) if tb == active else (95, 99, 104), anchor="lm")
        if tb == active:
            d.rectangle([tx - 6, by, tx + tw + 6, by + 5], fill=(46, 125, 92))
        tx += tw + 50
    return img

def browser_card(viewport):
    base = green_bg()
    d = ImageDraw.Draw(base)
    vw, vh = viewport.size
    card_x = (W - vw) // 2; card_y = CARD_TOP
    d.rounded_rectangle([card_x + 10, card_y - CHROME_H + 16, card_x + vw + 10, card_y + vh + 16], radius=24, fill=(18, 78, 54))
    d.rounded_rectangle([card_x, card_y - CHROME_H, card_x + vw, card_y + vh], radius=22, fill=(255, 255, 255))
    d.rounded_rectangle([card_x, card_y - CHROME_H, card_x + vw, card_y - CHROME_H + 46], radius=22, fill=(236, 238, 240))
    d.rectangle([card_x, card_y - 24, card_x + vw, card_y], fill=(236, 238, 240))
    for k, co in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 108)]):
        cxx = card_x + 26 + k * 34
        d.ellipse([cxx, card_y - CHROME_H + 18, cxx + 20, card_y - CHROME_H + 38], fill=co)
    d.rounded_rectangle([card_x + 130, card_y - CHROME_H + 13, card_x + vw - 26, card_y - CHROME_H + 43], radius=15, fill=(255, 255, 255))
    d.text((card_x + 150, card_y - CHROME_H + 28), "docs.google.com/spreadsheets", font=F(19, False), fill=(120, 124, 130), anchor="lm")
    base.paste(viewport.convert("RGB"), (card_x, card_y))
    return base

def apply_caption(fr_rgba, ov, i, n):
    fin = 12; fout = 10
    if i < fin: a = i / fin
    elif i > n - fout: a = max(0.0, (n - i) / fout)
    else: a = 1.0
    dy = int((1 - ease_out(min(1, i / fin))) * 45) if i < fin else 0
    tmp = ov.copy()
    if a < 1.0:
        al = tmp.split()[3].point(lambda p: int(p * a)); tmp.putalpha(al)
    if dy:
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sh.paste(tmp, (0, dy)); tmp = sh
    return Image.alpha_composite(fr_rgba, tmp)

def sheet_pan_scene(sheet_img, secs, caption, vh=1080):
    n = int(secs * FPS); frames = []
    sw, sh = sheet_img.size
    sc = sheet_img.resize((int(sw * vh / sh), vh), Image.LANCZOS)
    vw = SH_W; maxpan = max(0, sc.width - vw)
    ov = caption_overlay(caption) if caption else None
    for i in range(n):
        e = ease_inout(i / max(1, n - 1)); x = int(maxpan * e)
        base = browser_card(sc.crop((x, 0, x + vw, vh)))
        if ov is not None: base = apply_caption(base.convert("RGBA"), ov, i, n).convert("RGB")
        frames.append(base)
    return frames

def sheet_fit_scene(sheet_img, secs, caption, vh=1080, z0=1.0, z1=1.06):
    n = int(secs * FPS); frames = []
    sw, sh = sheet_img.size
    fit = sheet_img.resize((SH_W, int(sh * SH_W / sw)), Image.LANCZOS)
    canvas = Image.new("RGB", (SH_W, vh), (255, 255, 255)); canvas.paste(fit, (0, 0))
    ov = caption_overlay(caption) if caption else None
    for i in range(n):
        z = z0 + (z1 - z0) * ease_inout(i / max(1, n - 1))
        cw, ch = int(SH_W / z), int(vh / z)
        crop = canvas.crop((0, 0, cw, ch)).resize((SH_W, vh), Image.LANCZOS)
        base = browser_card(crop)
        if ov is not None: base = apply_caption(base.convert("RGBA"), ov, i, n).convert("RGB")
        frames.append(base)
    return frames

def sheet_rekap_img():
    return render_sheet(
        ["Tanggal", "Item", "Kategori", "Toko", "Pemasukan", "Pengeluaran", "Catatan", "Pencatat", "Akun", "ID"],
        [
            ["9/6/2026", "Gaji", "Gaji", "", "Rp5.000.000", "", "", "Suami", "Kas", "TRX-9A1"],
            ["9/6/2026", "makan", "Makanan", "warteg", "", "Rp25.000", "makan siang", "Suami", "Gopay", "TRX-9A2"],
            ["9/6/2026", "bensin", "Transportasi", "SPBU", "", "Rp50.000", "", "Istri", "Bank BCA", "TRX-9A3"],
            ["10/6/2026", "belanja", "Kebutuhan Pokok", "Indomaret", "", "Rp120.000", "", "Istri", "Bank BCA", "TRX-9A4"],
            ["10/6/2026", "kopi", "Jajan", "Kopi Kenangan", "", "Rp22.000", "", "Suami", "Gopay", "TRX-9A5"],
            ["11/6/2026", "bonus", "Gaji", "", "Rp1.000.000", "", "THR", "Suami", "Kas", "TRX-9A6"],
        ],
        [150, 210, 200, 190, 200, 200, 210, 150, 150, 220], {4, 5},
        ["Rekap", "Analisa", "Neraca", "Budget", "Langganan", "Target"], "Rekap",
        "Rekap Uang by Ikhsan Abdul Nafi'u")

def sheet_analisa_img():
    g = [(46, 125, 92), (70, 157, 107), (110, 190, 140), (160, 214, 180)]
    return render_sheet(
        ["Keterangan", "Nilai", "Persentase"],
        [
            ["Total Pemasukan", "Rp6.000.000", ""],
            ["Total Pengeluaran", "Rp217.000", ""],
            ["Saldo", "Rp5.783.000", ""],
            ["Kebutuhan Pokok", "Rp120.000", "55%"],
            ["Transportasi", "Rp50.000", "23%"],
            ["Makanan", "Rp25.000", "12%"],
            ["Jajan", "Rp22.000", "10%"],
        ],
        [430, 270, 200], {1},
        ["Rekap", "Analisa", "Neraca", "Budget", "Langganan", "Target"], "Analisa",
        "Analisa - Rekap Uang",
        chart={"h": 300, "values": [120, 50, 25, 22],
               "labels": ["Pokok", "Transp", "Makan", "Jajan"], "colors": g})

def main():
    if os.path.exists(OUT_FRAMES): shutil.rmtree(OUT_FRAMES)
    os.makedirs(OUT_FRAMES)

    seq = []
    crossfade(seq, opening_frames(3.6))
    img, foc = scene_intro();   crossfade(seq, scene_frames(img, foc, 2.1, 1.0, 1.06, "Catat keuangan cukup dari chat"))
    img, foc = scene_expense(); crossfade(seq, scene_frames(img, foc, 2.2, 1.12, 1.0, "Tinggal ketik pengeluaranmu"))
    img, foc = scene_income();  crossfade(seq, scene_frames(img, foc, 2.2, 1.0, 1.1, "Pemasukan pun otomatis tercatat"))
    img, foc = scene_struk();   crossfade(seq, scene_frames(img, foc, 2.7, 1.1, 1.0, "Foto struk + pilih bagianmu (split bill)"))
    img, foc = scene_voice();   crossfade(seq, scene_frames(img, foc, 2.4, 1.0, 1.1, "Atau cukup catat lewat suara"))
    img, foc = scene_target();  crossfade(seq, scene_frames(img, foc, 2.3, 1.12, 1.0, "Bikin target & pantau nabung"))
    img, foc = scene_map();     crossfade(seq, scene_frames(img, foc, 2.3, 1.0, 1.1, "Atur kategori & budget sesukamu"))
    crossfade(seq, sheet_pan_scene(sheet_rekap_img(), 4.2, "Semua tercatat lengkap di Google Sheets"))
    crossfade(seq, sheet_fit_scene(sheet_analisa_img(), 3.2, "Lengkap dengan analisa & grafik"))
    crossfade(seq, outro_frames(3.0))

    for i, fr in enumerate(seq):
        fr.save(os.path.join(OUT_FRAMES, f"f{i:05d}.png"))
    print("frames:", len(seq), "dur:", round(len(seq) / FPS, 2), "s")

main()
