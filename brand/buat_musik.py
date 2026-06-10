# -*- coding: utf-8 -*-
"""Synthesize a gentle royalty-free background music WAV for the promo.
Usage: python3 brand/buat_musik.py <duration_seconds> <out.wav>
"""
import sys, wave, struct
import numpy as np

SR = 44100
dur = float(sys.argv[1]) if len(sys.argv) > 1 else 16.0
out = sys.argv[2] if len(sys.argv) > 2 else "brand/promo-musik.wav"

N = int(SR * dur)
t = np.arange(N) / SR
mix = np.zeros(N)

def note(freq, start, length, amp=0.2, kind="sine"):
    """Add a note with soft attack/decay envelope."""
    i0 = int(start * SR); i1 = min(N, int((start + length) * SR))
    if i1 <= i0: return
    n = i1 - i0
    tt = np.arange(n) / SR
    if kind == "tri":
        # triangle-ish via summed harmonics
        w = (np.sin(2*np.pi*freq*tt)
             - 0.18*np.sin(2*np.pi*2*freq*tt)
             + 0.09*np.sin(2*np.pi*3*freq*tt))
    else:
        w = np.sin(2*np.pi*freq*tt) + 0.25*np.sin(2*np.pi*2*freq*tt)
    # envelope: quick attack, gentle release
    env = np.ones(n)
    a = int(0.02 * SR); r = int(min(length, 0.5) * SR)
    if a > 0: env[:a] = np.linspace(0, 1, a)
    if r > 0 and r < n: env[-r:] = np.linspace(1, 0, r)
    mix[i0:i1] += amp * w * env

# Notes (Hz)
NOTES = {
 'C3':130.81,'D3':146.83,'E3':164.81,'F3':174.61,'G3':196.00,'A3':220.00,'B3':246.94,
 'C4':261.63,'D4':293.66,'E4':329.63,'F4':349.23,'G4':392.00,'A4':440.00,'B4':493.88,
 'C5':523.25,'D5':587.33,'E5':659.25,'G5':783.99
}
# Progresi C - G - Am - F (hangat & ceria)
prog = [
    ('C4','E4','G4', 'C5'),
    ('G3','B3','D4', 'D5'),
    ('A3','C4','E4', 'E5'),
    ('F3','A3','C4', 'C5'),
]
BPM = 96
beat = 60.0 / BPM
bar = 4 * beat

tcur = 0.0
bi = 0
while tcur < dur:
    chord = prog[bi % len(prog)]
    # pad: tahan satu bar
    for f in chord[:3]:
        note(NOTES[f], tcur, bar*0.98, amp=0.12, kind="sine")
    # melodi arpeggio (8th notes) pakai nada chord + oktaf atas
    arp = [chord[0], chord[1], chord[2], chord[3], chord[2], chord[1], chord[2], chord[3]]
    for k, f in enumerate(arp):
        note(NOTES[f], tcur + k*(beat/2), beat/2*0.9, amp=0.10, kind="tri")
    # bass: root tiap setengah bar
    root = chord[0].replace('4', '3') if chord[0].endswith('4') else chord[0]
    note(NOTES.get(root, NOTES[chord[0]])/1, tcur, beat*1.8, amp=0.16, kind="sine")
    note(NOTES.get(root, NOTES[chord[0]])/1, tcur+2*beat, beat*1.8, amp=0.16, kind="sine")
    tcur += bar
    bi += 1

# Soft kick tiap beat 1 & 3 + hi-hat halus offbeat
nb = int(dur / beat)
for b in range(nb):
    bt = b * beat
    if b % 2 == 0:  # kick
        i0 = int(bt*SR); n = int(0.12*SR)
        if i0+n < N:
            tt = np.arange(n)/SR
            fr = 110*np.exp(-tt*30) + 45
            mix[i0:i0+n] += 0.5*np.sin(2*np.pi*fr*tt)*np.exp(-tt*14)
    # hi-hat
    i0 = int((bt+beat/2)*SR); n = int(0.05*SR)
    if i0+n < N:
        hh = (np.random.rand(n)*2-1) * np.exp(-np.arange(n)/SR*60)
        mix[i0:i0+n] += 0.06*hh

# Normalisasi + fade in/out
mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.85
fi = int(0.5*SR); fo = int(1.6*SR)
if fi < N: mix[:fi] *= np.linspace(0, 1, fi)
if fo < N: mix[-fo:] *= np.linspace(1, 0, fo)

data = (mix * 32767).astype(np.int16)
with wave.open(out, 'w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(data.tobytes())
print("musik:", out, round(dur, 2), "s")
