# -*- coding: utf-8 -*-
"""Generate a short promo video (vertical 1080x1920) for Rekap Uang."""
import os, math, shutil
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
FPS = 30
OUT_FRAMES = "promo_frames"
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

# Palette
TG_BG = (15, 22, 33)
TG_HEADER = (23, 33, 43)
TG_IN = (32, 44, 56)          # bot bubble
TG_OUT = (44, 95, 70)         # user bubble (green)
TG_TEXT = (236, 240, 243)
TG_SUB = (140, 158, 170)
GREEN = (46, 157, 107)
GREEN_D = (28, 106, 73)
GOLD = (255, 213, 79)

def F(size, bold=True):
    return ImageFont.truetype(DEJAVU_B if bold else DEJAVU, size)

def Fm(size):
    return ImageFont.truetype(MONO, size)

def wrap(draw, text, font, maxw):
    out = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            t = (cur + " " + w).strip()
            if not cur or draw.textlength(t, font=font) <= maxw:
                cur = t
            else:
                out.append(cur); cur = w
        out.append(cur)
    return out

def rrect(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

def header(img):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 150], fill=TG_HEADER)
    # avatar (logo)
    try:
        logo = Image.open("brand/logo.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
        mask = Image.new("L", (96, 96), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, 96, 96], fill=255)
        img.paste(logo, (40, 27), mask)
    except Exception:
        d.ellipse([40, 27, 136, 123], fill=GREEN)
    d.text((160, 45), "Rekap Uang", font=F(40), fill=TG_TEXT)
    d.text((160, 95), "bot", font=F(26, False), fill=TG_SUB)

def base():
    img = Image.new("RGB", (W, H), TG_BG)
    header(img)
    return img

def draw_bubbles(img, msgs, y0=190):
    """msgs: list of (who, text). Returns ending y."""
    d = ImageDraw.Draw(img)
    pad = 26
    maxw = int(W * 0.74)
    y = y0
    for who, text in msgs:
        font = Fm(30) if who == "user" else F(30, False)
        lines = wrap(d, text, font, maxw - 2 * pad)
        lh = font.size + 12
        bw = max([d.textlength(l, font=font) for l in lines] + [60]) + 2 * pad
        bh = 2 * pad + len(lines) * lh
        if who == "user":
            bx = W - bw - 40
            color = TG_OUT
        else:
            bx = 40
            color = TG_IN
        rrect(d, [bx, y, bx + bw, y + bh], 28, color)
        ty = y + pad
        for l in lines:
            d.text((bx + pad, ty), l, font=font, fill=TG_TEXT)
            ty += lh
        y += bh + 22
    return y

# ---------------- Scenes ----------------
# Each scene = (full image, focus_box) ; focus_box = (cx, cy) center to zoom toward.

def scene_intro():
    img = base()
    msgs = [
        ("bot", "Selamat datang di Rekap Uang!\nCatat keuangan cukup dari chat — otomatis rapi ke Google Sheets."),
        ("bot", "Coba ketik:\nkeluar makan 25rb\nmasuk gaji 5jt"),
    ]
    end = draw_bubbles(img, msgs)
    return img, (W // 2, 360)

def scene_expense():
    img = base()
    end = draw_bubbles(img, [
        ("bot", "Selamat datang di Rekap Uang!"),
        ("user", "keluar makan 25rb di warteg"),
        ("bot", "Sip, dicatat ya\npengeluaran | makan -> Makanan\ntoko: warteg | Rp25.000"),
    ])
    return img, (W // 2, 720)

def scene_income():
    img = base()
    end = draw_bubbles(img, [
        ("user", "keluar makan 25rb di warteg"),
        ("bot", "Sip, dicatat ya | Rp25.000"),
        ("user", "masuk gaji 5jt"),
        ("bot", "Mantap, tercatat\npemasukan | gaji -> Gaji | Rp5.000.000"),
    ])
    return img, (W // 2, 900)

def scene_target():
    img = base()
    end = draw_bubbles(img, [
        ("user", "target liburan 5jt"),
        ("bot", "Target \"liburan\" diset Rp5.000.000\nMulai: nabung liburan <nominal>"),
        ("user", "nabung liburan 500k"),
        ("bot", "Sip, nabung Rp500.000\nProgress: 500.000 / 5.000.000 (10%)\n[#---------] 10%"),
    ])
    return img, (W // 2, 980)

def scene_map():
    img = base()
    end = draw_bubbles(img, [
        ("user", "kategori map kopi Jajan"),
        ("bot", "Tersimpan: item \"kopi\" -> kategori Jajan."),
        ("user", "kategori unmap kopi"),
        ("bot", "Pemetaan \"kopi\" dihapus."),
        ("user", "budget makanan 1jt"),
        ("bot", "Budget Makanan: Rp1.000.000 / bulan. Kuingatkan kalau mepet."),
    ])
    return img, (W // 2, 760)

def scene_outro():
    img = Image.new("RGB", (W, H), GREEN_D)
    d = ImageDraw.Draw(img)
    # gradient-ish circles
    d.ellipse([-200, -200, 400, 400], fill=(40, 130, 95))
    d.ellipse([W - 300, H - 350, W + 250, H + 200], fill=(36, 118, 82))
    try:
        m = Image.open("brand/maskot.png").convert("RGBA")
        mw = 620
        mh = int(m.height * mw / m.width)
        m = m.resize((mw, mh), Image.LANCZOS)
        img.paste(m, ((W - mw) // 2, 430), m)
    except Exception:
        pass
    d.text((W // 2, 1180), "Rekap Uang", font=F(96), fill=(255, 255, 255), anchor="mm")
    # gold pill tagline
    tag = "Rapikan Keuanganmu"
    tf = F(46)
    tw = d.textlength(tag, font=tf)
    px = (W - (tw + 100)) // 2
    rrect(d, [px, 1260, px + tw + 100, 1350], 45, GOLD)
    d.text((W // 2, 1305), tag, font=tf, fill=(74, 52, 6), anchor="mm")
    d.text((W // 2, 1430), "@rekapuang.id", font=F(40), fill=(223, 243, 231), anchor="mm")
    return img, (W // 2, 740)

# ---------------- Ken Burns + assembly ----------------
def ken_burns(img, n, z0, z1, focus):
    """Yield n frames zooming from z0 to z1 toward focus center."""
    fx, fy = focus
    frames = []
    for i in range(n):
        t = i / max(1, n - 1)
        # ease in-out
        e = 0.5 - 0.5 * math.cos(math.pi * t)
        z = z0 + (z1 - z0) * e
        cw, ch = int(W / z), int(H / z)
        # clamp center so crop stays inside
        cx = min(max(fx, cw // 2), W - cw // 2)
        cy = min(max(fy, ch // 2), H - ch // 2)
        left = cx - cw // 2
        top = cy - ch // 2
        crop = img.crop((left, top, left + cw, top + ch)).resize((W, H), Image.LANCZOS)
        frames.append(crop)
    return frames

def main():
    if os.path.exists(OUT_FRAMES):
        shutil.rmtree(OUT_FRAMES)
    os.makedirs(OUT_FRAMES)

    scenes = [
        (scene_intro(),  2.2, 1.0, 1.06),   # (img,focus), seconds, zoom_start, zoom_end
        (scene_expense(),2.4, 1.12, 1.0),   # zoom OUT (reveal)
        (scene_income(), 2.4, 1.0, 1.1),    # zoom IN
        (scene_target(), 2.6, 1.12, 1.0),
        (scene_map(),    2.6, 1.0, 1.1),
        (scene_outro(),  2.8, 1.05, 1.0),
    ]

    all_frames = []
    for (img, focus), secs, z0, z1 in scenes:
        n = int(secs * FPS)
        all_frames.append(ken_burns(img, n, z0, z1, focus))

    # crossfade between consecutive scenes (12 frames)
    XF = 12
    seq = []
    for idx, frames in enumerate(all_frames):
        if idx == 0:
            seq.extend(frames)
        else:
            prev_tail = seq[-XF:]
            cur_head = frames[:XF]
            blended = []
            for a, b in zip(prev_tail, cur_head):
                blended.append(Image.blend(a, b, 0.5 if False else None) if False else None)
            # manual crossfade
            seq = seq[:-XF]
            for k in range(XF):
                alpha = (k + 1) / (XF + 1)
                seq.append(Image.blend(prev_tail[k], cur_head[k], alpha))
            seq.extend(frames[XF:])

    for i, fr in enumerate(seq):
        fr.save(os.path.join(OUT_FRAMES, f"f{i:05d}.png"))
    print("frames:", len(seq))

main()
