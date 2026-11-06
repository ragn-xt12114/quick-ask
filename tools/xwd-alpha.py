#!/usr/bin/env python3
"""Read a 32-bit XWD capture and report the real alpha channel.

`import -window <wid>` flattens alpha and `ffmpeg -window_id` reports alpha=255
for every pixel. `xwd -id <wid>` preserves the ARGB data, which is the only way
to prove that the transparent gutter/rounded corners are alpha=0 while the card
is alpha=184 (~0.72) on this setup.

Usage:
  tools/xwd-alpha.py --xwd file.xwd [--png out.png]
  tools/xwd-alpha.py --wid 0x123456 [--png out.png]

Prints one JSON object. Exit 0 on success, 2 on error.
"""

import argparse
import json
import os
import struct
import subprocess
import sys

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover
    print(
        "xwd-alpha: 缺 Pillow：请安装 Pillow（python3 -m pip install Pillow），"
        "或设置 PYTHON 指向带 Pillow 的解释器",
        file=sys.stderr,
    )
    print(f"xwd-alpha: import error: {exc}", file=sys.stderr)
    sys.exit(2)

HEADER_FIELDS = [
    "header_size",
    "file_version",
    "pixmap_format",
    "pixmap_depth",
    "pixmap_width",
    "pixmap_height",
    "xoffset",
    "byte_order",
    "bitmap_unit",
    "bitmap_bit_order",
    "bitmap_pad",
    "bits_per_pixel",
    "bytes_per_line",
    "visual_class",
    "red_mask",
    "green_mask",
    "blue_mask",
    "bits_per_rgb",
    "colormap_entries",
    "ncolors",
    "window_width",
    "window_height",
    "window_x",
    "window_y",
    "window_bdrwidth",
]


def read_xwd(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 100:
        raise ValueError("file too short for XWD header")
    values = struct.unpack(">25I", data[:100])
    header = dict(zip(HEADER_FIELDS, values))
    if header["header_size"] < 100 or header["header_size"] > len(data):
        raise ValueError(f"invalid header_size {header['header_size']}")
    bpp = header["bits_per_pixel"] // 8
    if bpp != 4:
        raise ValueError(f"expected 32-bit XWD, got {header['bits_per_pixel']} bpp")
    offset = header["header_size"] + header["ncolors"] * 12
    w, h, stride = header["pixmap_width"], header["pixmap_height"], header["bytes_per_line"]
    if offset + stride * h > len(data):
        raise ValueError("pixel data truncated")
    return header, data[offset:offset + stride * h], w, h, stride


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--xwd")
    src.add_argument("--wid")
    ap.add_argument("--png")
    ap.add_argument("--card", default="40,28,680,48", help="card x,y,w,h in window pixels")
    args = ap.parse_args()
    try:
        card = tuple(int(v) for v in args.card.split(","))
        if len(card) != 4:
            raise ValueError
    except ValueError:
        print("xwd-alpha: --card must be x,y,w,h", file=sys.stderr)
        return 2

    xwd_path = args.xwd
    if args.wid:
        xwd_path = f"/tmp/quickask-xwd-{os.getpid()}.xwd"
        r = subprocess.run(["xwd", "-id", args.wid, "-silent", "-out", xwd_path])
        if r.returncode != 0:
            print(json.dumps({"error": "xwd failed", "exit": r.returncode}))
            return 2

    try:
        header, raw, w, h, stride = read_xwd(xwd_path)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2

    # XWD on this LSBFirst machine stores B,G,R,A per pixel.
    img = Image.frombytes("RGBA", (w, h), raw, "raw", "BGRA")
    alpha = img.getchannel("A")
    hist = alpha.histogram()
    total = w * h or 1
    alpha_min, alpha_max = alpha.getextrema()

    cx, cy, cw, ch = card
    samples = {}
    points = {
        "card_center": (cx + cw // 2, cy + ch // 2),
        "card_near_topleft": (cx + 5, cy + 5),
        "gutter_topleft": (5, 5),
        "gutter_topright": (w - 6, 5),
        "gutter_bottomright": (w - 6, h - 6),
        "rounded_corner_topleft": (cx + 2, cy + 2),
        "rounded_corner_bottomright": (cx + cw - 3, cy + ch - 3),
    }
    for name, (x, y) in points.items():
        if 0 <= x < w and 0 <= y < h:
            r, g, b, a = img.getpixel((x, y))
            samples[name] = {"x": x, "y": y, "rgba": [r, g, b, a], "alpha": a}

    if args.png:
        img.save(args.png)

    if args.wid and os.path.exists(xwd_path):
        try:
            os.unlink(xwd_path)
        except OSError:
            pass

    print(
        json.dumps(
            {
                "xwd": xwd_path if args.xwd else None,
                "png": args.png,
                "width": w,
                "height": h,
                "card": list(card),
                "pixmap_depth": header["pixmap_depth"],
                "bits_per_pixel": header["bits_per_pixel"],
                "alpha_min": alpha_min,
                "alpha_max": alpha_max,
                "alpha_zero_ratio": round(hist[0] / total, 6),
                "alpha_255_ratio": round(hist[255] / total, 6),
                "alpha_184_ratio": round(hist[184] / total, 6),
                "alpha_histogram_peaks": sorted(
                    [(a, c) for a, c in enumerate(hist) if c], key=lambda p: -p[1]
                )[:8],
                "samples": samples,
                "transparent_gutter": all(
                    samples.get(k, {}).get("alpha", 255) == 0
                    for k in ("gutter_topleft", "gutter_topright", "gutter_bottomright")
                ),
                "card_opaque_enough": samples.get("card_center", {}).get("alpha", 0) >= 160,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
