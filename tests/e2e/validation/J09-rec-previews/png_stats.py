#!/usr/bin/env python3
"""Statistiques de pixels sans dependance externe (zlib + struct stdlib).

Sert de PREUVE OBJECTIVE pour J09 : une preview camera vivante produit une
image photographique (beaucoup de couleurs distinctes, variance non nulle),
alors que le fallback de fond est un aplat #111827 (une seule couleur).

Usage:
    python3 png_stats.py IMAGE.png [--region x0,y0,x1,y1]
"""
import struct
import sys
import zlib
from collections import Counter

FALLBACK = (0x11, 0x18, 0x27)


def read_png(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a png: " + path)
    pos = 8
    idat = bytearray()
    w = h = depth = color = None
    while pos < len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, color = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
    if depth != 8:
        raise SystemExit("unsupported bit depth: %r" % depth)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    raw = zlib.decompress(bytes(idat))
    stride = w * channels
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        filt = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            x = line[i]
            if filt == 1:
                x = (x + a) & 0xFF
            elif filt == 2:
                x = (x + b) & 0xFF
            elif filt == 3:
                x = (x + ((a + b) >> 1)) & 0xFF
            elif filt == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                x = (x + pr) & 0xFF
            elif filt != 0:
                raise SystemExit("bad filter %r" % filt)
            line[i] = x
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, channels, bytes(out)


def main():
    path = sys.argv[1]
    region = None
    if "--region" in sys.argv:
        region = tuple(int(v) for v in sys.argv[sys.argv.index("--region") + 1].split(","))
    w, h, ch, buf = read_png(path)
    x0, y0, x1, y1 = region or (0, 0, w, h)
    counter = Counter()
    rs = gs = bs = 0.0
    n = 0
    fallback_exact = 0
    for y in range(y0, y1, max(1, (y1 - y0) // 300)):
        row = y * w * ch
        for x in range(x0, x1, max(1, (x1 - x0) // 300)):
            i = row + x * ch
            r, g, b = buf[i], buf[i + 1] if ch >= 3 else buf[i], buf[i + 2] if ch >= 3 else buf[i]
            counter[(r // 16, g // 16, b // 16)] += 1
            rs += r
            gs += g
            bs += b
            n += 1
            if abs(r - FALLBACK[0]) <= 2 and abs(g - FALLBACK[1]) <= 2 and abs(b - FALLBACK[2]) <= 2:
                fallback_exact += 1
    mean = (rs / n, gs / n, bs / n)
    var = 0.0
    print("image      : %s (%dx%d, %d ch)" % (path, w, h, ch))
    print("region     : %s" % (region or "full",))
    print("sampled    : %d px" % n)
    print("mean RGB   : (%.1f, %.1f, %.1f)" % mean)
    print("distinct   : %d buckets (16-level)" % len(counter))
    top, topn = counter.most_common(1)[0]
    print("dominant   : bucket%s = %.1f%%" % (top, 100.0 * topn / n))
    for c in counter:
        var += (c[0] * 16 - mean[0]) ** 2 + (c[1] * 16 - mean[1]) ** 2
    flat = len(counter) <= 2
    near_fallback = all(abs(mean[i] - FALLBACK[i]) < 12 for i in range(3))
    fb_pct = 100.0 * fallback_exact / n
    print("VARIANCE   : %.0f" % (var / max(1, len(counter))))
    print("FALLBACK%%  : %.1f%%  (pixels == #111827)" % fb_pct)
    print("FLAT       : %s" % ("YES (fallback/dark)" if flat else "NO (photographic)"))
    print("NI_FALLBACK: %s" % ("YES" if near_fallback else "NO"))
    verdict = "CAMERA_LIVE" if (not flat and fb_pct < 10) else "NO_CAMERA"
    print("VERDICT    : %s" % verdict)
    return 0 if verdict == "CAMERA_LIVE" else 1


if __name__ == "__main__":
    sys.exit(main())
