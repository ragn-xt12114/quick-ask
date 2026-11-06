#!/usr/bin/env python3
"""Pixel statistics for Task 23 appearance/compositor evidence.

Usage:
  tools/appearance-pixels.py --image shot.png \
      --rect 620,130,680,48 --bg 28,30,32 \
      --rect 620,190,680,12

Prints one JSON object per --rect. Rectangles are absolute image pixels.
Exit 0 on success, 2 on invalid input or unreadable image.
"""

import argparse
import json
import math
import sys

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover
    print(f"appearance-pixels: PIL unavailable: {exc}", file=sys.stderr)
    sys.exit(2)


def parse_triplet(text):
    parts = [int(value) for value in text.split(",")]
    if len(parts) != 3:
        raise ValueError("expected r,g,b")
    return tuple(parts)


def parse_rect(text):
    parts = [int(value) for value in text.split(",")]
    if len(parts) != 4:
        raise ValueError("expected x,y,w,h")
    if parts[2] <= 0 or parts[3] <= 0:
        raise ValueError("rect width/height must be positive")
    return tuple(parts)


def luma(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def analyse(crop, background):
    flattened = getattr(crop, "get_flattened_data", None)
    pixels = list(flattened()) if callable(flattened) else list(crop.getdata())
    total = len(pixels) or 1
    bright = sum(1 for pixel in pixels if luma(pixel) > 120)
    dark = sum(1 for pixel in pixels if luma(pixel) < 40)
    black = sum(1 for pixel in pixels if max(pixel) < 8)
    if background is None:
        distance = None
        center_distance = None
    else:
        squared = 0.0
        for red, green, blue in pixels:
            squared += (
                (red - background[0]) ** 2
                + (green - background[1]) ** 2
                + (blue - background[2]) ** 2
            )
        distance = math.sqrt(squared / total)
        center = crop.getpixel((crop.size[0] // 2, crop.size[1] // 2))
        center_distance = math.sqrt(
            (center[0] - background[0]) ** 2
            + (center[1] - background[1]) ** 2
            + (center[2] - background[2]) ** 2
        )
    center = crop.getpixel((crop.size[0] // 2, crop.size[1] // 2))
    return {
        "size": list(crop.size),
        "pixels": total,
        "mean_rgb": [round(sum(pixel[i] for pixel in pixels) / total, 2) for i in range(3)],
        "center_rgb": list(center),
        "min_luma": round(min(luma(pixel) for pixel in pixels), 2),
        "max_luma": round(max(luma(pixel) for pixel in pixels), 2),
        "mean_luma": round(sum(luma(pixel) for pixel in pixels) / total, 2),
        "bright_ratio": round(bright / total, 6),
        "dark_ratio": round(dark / total, 6),
        "black_ratio": round(black / total, 6),
        "bg_distance": None if distance is None else round(distance, 3),
        "center_bg_distance": None if center_distance is None else round(center_distance, 3),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--rect", action="append", required=True)
    parser.add_argument("--bg", default=None)
    args = parser.parse_args()

    try:
        background = parse_triplet(args.bg) if args.bg else None
        rects = [parse_rect(value) for value in args.rect]
    except ValueError as exc:
        print(f"appearance-pixels: {exc}", file=sys.stderr)
        return 2

    try:
        image = Image.open(args.image).convert("RGB")
    except Exception as exc:
        print(f"appearance-pixels: cannot open {args.image}: {exc}", file=sys.stderr)
        return 2

    width, height = image.size
    results = []
    for x, y, rect_width, rect_height in rects:
        if x < 0 or y < 0 or x + rect_width > width or y + rect_height > height:
            print(
                f"appearance-pixels: rect {x},{y},{rect_width},{rect_height} "
                f"outside image {width}x{height}",
                file=sys.stderr,
            )
            return 2
        crop = image.crop((x, y, x + rect_width, y + rect_height))
        entry = {"rect": [x, y, rect_width, rect_height]}
        entry.update(analyse(crop, background))
        results.append(entry)

    print(
        json.dumps(
            {
                "image": args.image,
                "size": [width, height],
                "background": list(background) if background else None,
                "regions": results,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
