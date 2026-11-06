#!/usr/bin/env python3
"""App icons for the installable Tendly (PWA), drawn from apps/web/public/favicon.svg.

The favicon is three rounded rectangles, so this draws them directly (signed
distance, anti-aliased) and writes PNGs with the standard library alone: no
image tool has to be installed. Re-run after changing the favicon:

    python3 replica/design/gen_icons.py

Writes apps/web/public/icons/:
    icon-192.png, icon-512.png            the favicon, rounded corners, for "any"
    icon-maskable-192.png, -512.png       full-bleed background; the mark sits in the safe zone
    apple-touch-icon.png (180)            full-bleed (iOS rounds it itself and has no transparency)
    badge-96.png                          the mark alone in white, for Android's status bar
"""
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SVG = ROOT / "apps/web/public/favicon.svg"
OUT = ROOT / "apps/web/public/icons"


def parse(svg: str):
    """The viewBox size, the background (rect, radius, colour) and the white mark's rects."""
    box = float(re.search(r'viewBox="0 0 ([\d.]+) [\d.]+"', svg).group(1))
    rects = []
    for tag in re.findall(r"<rect\b[^>]*>", svg):
        get = lambda name, default=0.0: float(m.group(1)) if (m := re.search(rf'\b{name}="([\d.]+)"', tag)) else default
        fill = re.search(r'fill="(#[0-9a-fA-F]{6})"', tag)
        rects.append({"x": get("x"), "y": get("y"), "w": get("width"), "h": get("height"), "r": get("rx"), "fill": fill.group(1) if fill else None})
    background, mark = rects[0], rects[1:]
    if not background["fill"] or len(mark) != 2:
        sys.exit("favicon.svg no longer has the shape this script draws; update gen_icons.py")
    return box, background, mark


def rgb(colour: str):
    return tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))


def coverage(px: float, py: float, rect, scale: float) -> float:
    """How much of the pixel centred at (px, py) a rounded rectangle covers (0..1)."""
    cx, cy = (rect["x"] + rect["w"] / 2) * scale, (rect["y"] + rect["h"] / 2) * scale
    hw, hh, r = rect["w"] / 2 * scale, rect["h"] / 2 * scale, rect["r"] * scale
    qx, qy = abs(px - cx) - (hw - r), abs(py - cy) - (hh - r)
    outside = (max(qx, 0.0) ** 2 + max(qy, 0.0) ** 2) ** 0.5
    distance = outside + min(max(qx, qy), 0.0) - r
    return min(1.0, max(0.0, 0.5 - distance))


def over(base, colour, alpha: float):
    """Source-over of an opaque colour at `alpha` onto an RGBA float pixel."""
    r, g, b, a = base
    out_a = alpha + a * (1 - alpha)
    if out_a == 0:
        return (0.0, 0.0, 0.0, 0.0)
    mix = lambda top, bottom: (top * alpha + bottom * a * (1 - alpha)) / out_a
    return (mix(colour[0], r), mix(colour[1], g), mix(colour[2], b), out_a)


def draw(size: int, box: float, layers) -> bytes:
    """`layers`: (rects in viewBox units, colour) drawn in order onto transparency.
    The rects of one layer are a single shape (their union), so where two of
    them overlap an edge is not painted twice."""
    scale = size / box
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter: none
        for x in range(size):
            pixel = (0.0, 0.0, 0.0, 0.0)
            for rects, colour in layers:
                alpha = max(coverage(x + 0.5, y + 0.5, rect, scale) for rect in rects)
                if alpha > 0:
                    pixel = over(pixel, colour, alpha)
            rows.extend(round(channel) for channel in pixel[:3])
            rows.append(round(pixel[3] * 255))
    return bytes(rows)


def png(size: int, raw: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    box, background, mark = parse(SVG.read_text())
    brand, white = rgb(background["fill"]), (255, 255, 255)
    full = {"x": -1.0, "y": -1.0, "w": box + 2, "h": box + 2, "r": 0.0}

    # The mark must stay inside the maskable safe zone: a circle of 40% of the side.
    corners = [(r["x"] + dx * r["w"], r["y"] + dy * r["h"]) for r in mark for dx in (0, 1) for dy in (0, 1)]
    reach = max(((x - box / 2) ** 2 + (y - box / 2) ** 2) ** 0.5 for x, y in corners)
    if reach > box * 0.4:
        sys.exit("the mark leaves the maskable safe zone; scale it down for the maskable icons")

    # The badge: the mark alone, enlarged to fill a 96px square with a small margin.
    left, top = min(r["x"] for r in mark), min(r["y"] for r in mark)
    right, bottom = max(r["x"] + r["w"] for r in mark), max(r["y"] + r["h"] for r in mark)
    extent = max(right - left, bottom - top) / 0.84
    shift_x, shift_y = (extent - (right - left)) / 2 - left, (extent - (bottom - top)) / 2 - top
    badge_mark = [{**r, "x": r["x"] + shift_x, "y": r["y"] + shift_y} for r in mark]

    rounded = [([background], brand), (mark, white)]
    bleed = [([full], brand), (mark, white)]
    files = {
        "icon-192.png": (192, box, rounded),
        "icon-512.png": (512, box, rounded),
        "icon-maskable-192.png": (192, box, bleed),
        "icon-maskable-512.png": (512, box, bleed),
        "apple-touch-icon.png": (180, box, bleed),
        "badge-96.png": (96, extent, [(badge_mark, white)]),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (size, view, layers) in files.items():
        data = png(size, draw(size, view, layers))
        (OUT / name).write_bytes(data)
        print(f"{name}: {size}x{size}, {len(data)} bytes")


if __name__ == "__main__":
    main()
