#!/usr/bin/env python3
"""PIL checks for NFR-05 cards, shadows and the transparent gutter.

Each spec names a card rectangle in an existing RGBA screenshot. The script
reports the alpha at the rounded corner and at the radius inset, plus the
gutter distance to every image edge and the amount of shadow alpha outside
the card.
"""

import json
import sys
from pathlib import Path

try:
    from PIL import Image
except Exception as exc:  # pragma: no cover
    print(f"nfr05-pixels: PIL unavailable: {exc}", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
EVID = ROOT / ".omo" / "evidence" / "m1"

SPECS = [
    {
        "image": "nfr05-s1.png",
        "regions": [{"name": "bar", "x": 40, "y": 28, "w": 680, "h": 48, "r": 24}],
        "gutter": {"top": 28, "left": 40, "right": 40, "bottom": 52},
    },
    {
        "image": "nfr05-s2.png",
        "regions": [
            {"name": "bar", "x": 40, "y": 28, "w": 680, "h": 48, "r": 24},
            {"name": "panel", "x": 40, "y": 88, "w": 680, "h": 120, "r": 16},
        ],
        "gutter": {"top": 28, "left": 40, "right": 40, "bottom": 52},
    },
    {
        "image": "nfr05-s3.png",
        "regions": [
            {"name": "sidebar", "x": 40, "y": 28, "w": 260, "h": 180, "r": 16},
            {"name": "bar", "x": 312, "y": 28, "w": 680, "h": 48, "r": 24},
            {"name": "panel", "x": 312, "y": 88, "w": 680, "h": 120, "r": 16},
        ],
        "gutter": {"top": 28, "left": 40, "right": 40, "bottom": 52},
    },
    {
        "image": "nfr05-barwidth.png",
        "regions": [{"name": "bar-900", "x": 40, "y": 28, "w": 900, "h": 48, "r": 24}],
        "gutter": {"top": 28, "left": 40, "right": 40, "bottom": 52},
    },
]


def mean_alpha(alpha, x, y, size=3):
    values = []
    for yy in range(y, min(y + size, alpha.height)):
        for xx in range(x, min(x + size, alpha.width)):
            values.append(alpha.getpixel((xx, yy)))
    return round(sum(values) / len(values), 2) if values else 0


def region_metrics(alpha, rgb, region):
    x, y, w, h, radius = region["x"], region["y"], region["w"], region["h"], region["r"]
    center = mean_alpha(alpha, x + w // 2, y + h // 2, 2)
    corner = mean_alpha(alpha, x + 1, y + 1, 2)
    inset_top = mean_alpha(alpha, x + radius, y + 1, 2)
    inset_left = mean_alpha(alpha, x + 1, y + radius, 2)
    inset_diag = mean_alpha(alpha, x + radius, y + radius, 2)

    shadow_values = []
    for yy in range(max(0, y - 30), min(alpha.height, y + h + 30)):
        for xx in range(max(0, x - 30), min(alpha.width, x + w + 30)):
            if x <= xx < x + w and y <= yy < y + h:
                continue
            value = alpha.getpixel((xx, yy))
            if 0 < value < 255:
                shadow_values.append(value)

    return {
        "rect": [x, y, w, h],
        "radius": radius,
        "center_alpha": center,
        "corner_alpha": corner,
        "inset_top_alpha": inset_top,
        "inset_left_alpha": inset_left,
        "inset_diag_alpha": inset_diag,
        "rounded_corner": bool(
            center > 100
            and corner < center * 0.35
            and min(inset_top, inset_left) > center * 0.55
            and inset_diag > center * 0.4
        ),
        "shadow_alpha_samples": len(shadow_values),
        "shadow_alpha_max": max(shadow_values) if shadow_values else 0,
        "shadow_present": bool(shadow_values and max(shadow_values) < 255),
        "center_rgb": list(rgb.getpixel((x + w // 2, y + h // 2))),
    }


def main():
    report = {"method": "PIL RGBA alpha crops at the card corner, radius inset, center and gutter", "images": []}
    ok = True
    for spec in SPECS:
        path = EVID / spec["image"]
        if not path.exists():
            report["images"].append({"image": spec["image"], "error": "missing"})
            ok = False
            continue
        image = Image.open(path).convert("RGBA")
        alpha = image.getchannel("A")
        rgb = image.convert("RGB")
        width, height = image.size
        regions = []
        for region in spec["regions"]:
            metrics = region_metrics(alpha, rgb, region)
            metrics["name"] = region["name"]
            regions.append(metrics)
            if not metrics["rounded_corner"] or not metrics["shadow_present"]:
                ok = False
        left = spec["regions"][0]["x"]
        top = spec["regions"][0]["y"]
        right = width - (spec["regions"][-1]["x"] + spec["regions"][-1]["w"])
        bottom = height - (spec["regions"][-1]["y"] + spec["regions"][-1]["h"])
        measured = {"top": top, "left": left, "right": right, "bottom": bottom}
        gutter_ok = measured == spec["gutter"]
        if not gutter_ok:
            ok = False
        report["images"].append(
            {
                "image": spec["image"],
                "size": [width, height],
                "regions": regions,
                "gutter_expected": spec["gutter"],
                "gutter_measured": measured,
                "gutter_ok": gutter_ok,
            }
        )
    report["pass"] = ok
    (EVID / "nfr05-pixels.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"pass": ok, "out": ".omo/evidence/m1/nfr05-pixels.json", "images": len(report["images"])}))


if __name__ == "__main__":
    main()
