#!/usr/bin/env python3
"""PIL pixel/frame checker for the QuickAsk M0 G1/G5 spike.

Run with the project venv (PIL 12.1.1):
  python3 tools/spike-check.py ...

Inputs:
  --mode        cycle | sizes | blur | opaque | g5
  --tag         evidence tag (e.g. cycle-gpu-on)
  --frames-dir  extracted JPEG frames (f_00001.jpg ...)
  --meta        capture meta JSON (ffmpeg start, fps, screen size)
  --info        spike info JSON (window/card geometry/scale)
  --timings     optional cycle timings / sizes bounds JSON
  --evidence-dir .omo/evidence
  --out         output pixels JSON

The checker is intentionally read-only and prints one JSON document.
"""

import argparse
import glob
import json
import os
import re
import sys
from statistics import median

try:
    from PIL import Image, ImageChops, ImageStat
except Exception as exc:  # pragma: no cover
    print(f"FATAL: PIL unavailable: {exc}", file=sys.stderr)
    sys.exit(2)


# --------------------------------------------------------------------- helpers
def load_json(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"WARN: cannot read {path}: {exc}", file=sys.stderr)
        return None


def frame_paths(frames_dir):
    return sorted(glob.glob(os.path.join(frames_dir, "f_*.jpg")))


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)
        fh.write("\n")


def rgb_tuple(values):
    return tuple(int(round(v)) for v in values)


def is_pure_black(rgb):
    return all(c <= 2 for c in rgb)


def is_pure_white(rgb):
    return all(c >= 253 for c in rgb)


def color_distance(a, b):
    return (sum((int(x) - int(y)) ** 2 for x, y in zip(a, b))) ** 0.5


def patch_mean(img, cx, cy, radius=2):
    w, h = img.size
    box = (
        max(0, int(cx) - radius),
        max(0, int(cy) - radius),
        min(w, int(cx) + radius + 1),
        min(h, int(cy) + radius + 1),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return (0.0, 0.0, 0.0), (0, 0)
    crop = img.crop(box).convert("RGB")
    stat = ImageStat.Stat(crop)
    return tuple(round(v, 2) for v in stat.mean), (box[2] - box[0], box[3] - box[1])


def luma_stats(img, box=None):
    target = img.crop(box) if box else img
    gray = target.convert("L")
    stat = ImageStat.Stat(gray)
    hist = gray.histogram()
    total = sum(hist) or 1
    return {
        "mean": round(stat.mean[0], 3),
        "stddev": round(stat.stddev[0], 3),
        "black_ratio": round(sum(hist[0:4]) / total, 6),
        "white_ratio": round(sum(hist[252:256]) / total, 6),
        "bright_ratio": round(sum(hist[180:256]) / total, 6),
        "total_pixels": total,
    }


def mean_abs_diff_region(img_a, img_b, box):
    a = img_a.crop(box).convert("RGB")
    b = img_b.crop(box).convert("RGB")
    diff = ImageChops.difference(a, b).convert("L")
    hist = diff.histogram()
    total = sum(hist) or 1
    weighted = sum(i * hist[i] for i in range(256))
    return {
        "mean_abs": round(weighted / total, 3),
        "gt16_ratio": round(sum(hist[17:]) / total, 6),
        "gt32_ratio": round(sum(hist[33:]) / total, 6),
    }


def diff_fraction(img_a, img_b, box, threshold=24):
    a = img_a.crop(box).convert("RGB")
    b = img_b.crop(box).convert("RGB")
    diff = ImageChops.difference(a, b).convert("L")
    hist = diff.histogram()
    total = sum(hist) or 1
    above = sum(hist[threshold:])
    return round(above / total, 6), round(sum(i * hist[i] for i in range(256)) / total, 3)


# ------------------------------------------------------------------ geometry
class Geometry:
    def __init__(self, info, meta, img_size):
        screen = info.get("screen") or {}
        self.screen_w = int(meta.get("screen_width") or screen.get("width") or img_size[0])
        self.screen_h = int(meta.get("screen_height") or screen.get("height") or img_size[1])
        win = info.get("window_dip") or {"x": 100, "y": 100, "width": 760, "height": 128}
        self.win_x = float(win.get("x", 100))
        self.win_y = float(win.get("y", 100))
        self.win_w = float(win.get("width", 760))
        self.win_h = float(win.get("height", 128))
        card = info.get("card_device") or {"x": 40, "y": 28, "w": 680, "h": 48}
        self.card_x = float(card.get("x", 40))
        self.card_y = float(card.get("y", 28))
        self.card_w = float(card.get("w", 680))
        self.card_h = float(card.get("h", 48))
        self.scale_factor = float(info.get("scale_factor", 1))
        self.frame_w, self.frame_h = img_size
        self.sx = self.frame_w / self.screen_w if self.screen_w else 1.0
        self.sy = self.frame_h / self.screen_h if self.screen_h else 1.0

    def card_screen_box(self):
        return (
            self.win_x + self.card_x,
            self.win_y + self.card_y,
            self.win_x + self.card_x + self.card_w,
            self.win_y + self.card_y + self.card_h,
        )

    def card_screen_box_padded(self, pad):
        l, t, r, b = self.card_screen_box()
        return (l - pad, t - pad, r + pad, b + pad)

    def to_frame_box(self, screen_box, clamp=True):
        l, t, r, b = screen_box
        box = (
            int(round(l * self.sx)),
            int(round(t * self.sy)),
            int(round(r * self.sx)),
            int(round(b * self.sy)),
        )
        if clamp:
            l2 = max(0, min(box[0], self.frame_w - 1))
            t2 = max(0, min(box[1], self.frame_h - 1))
            r2 = max(l2 + 1, min(box[2], self.frame_w))
            b2 = max(t2 + 1, min(box[3], self.frame_h))
            box = (l2, t2, r2, b2)
        return box

    def card_center_screen(self):
        return (
            self.win_x + self.card_x + self.card_w / 2.0,
            self.win_y + self.card_y + self.card_h / 2.0,
        )

    def window_screen_box(self):
        return (self.win_x, self.win_y, self.win_x + self.win_w, self.win_y + self.win_h)


# ------------------------------------------------------------------ frame scan
def scan_frames(paths, geom, card_pad=10):
    frames = []
    baseline = None
    for idx, path in enumerate(paths):
        try:
            img = Image.open(path).convert("RGB")
        except Exception as exc:
            print(f"WARN: skip frame {path}: {exc}", file=sys.stderr)
            continue
        full = luma_stats(img)
        card_box = geom.to_frame_box(geom.card_screen_box())
        padded_box = geom.to_frame_box(geom.card_screen_box_padded(card_pad))
        card_luma = luma_stats(img, card_box)
        cx, cy = geom.card_center_screen()
        center_rgb, _ = patch_mean(
            img, int(cx * geom.sx), int(cy * geom.sy), radius=2
        )
        frames.append(
            {
                "index": idx,
                "path": os.path.basename(path),
                "full": full,
                "card_luma": card_luma,
                "card_center_rgb": rgb_tuple(center_rgb),
                "card_box": card_box,
                "padded_box": padded_box,
                "_img": img,
            }
        )
    return frames


def analyze_cycle(frames, geom, meta, timings):
    out = {
        "frame_count": len(frames),
        "black_frames": 0,
        "white_frames": 0,
        "card_center_black_frames": 0,
        "card_center_white_frames": 0,
        "max_full_black_ratio": 0.0,
        "max_full_white_ratio": 0.0,
    }
    if not frames:
        out.update({"error": "no frames"})
        return out

    for fr in frames:
        full = fr["full"]
        if full["black_ratio"] > 0.995 or (full["mean"] < 3 and full["stddev"] < 2):
            out["black_frames"] += 1
        if full["white_ratio"] > 0.995 or (full["mean"] > 252 and full["stddev"] < 2):
            out["white_frames"] += 1
        if is_pure_black(fr["card_center_rgb"]):
            out["card_center_black_frames"] += 1
        if is_pure_white(fr["card_center_rgb"]):
            out["card_center_white_frames"] += 1
        out["max_full_black_ratio"] = max(out["max_full_black_ratio"], full["black_ratio"])
        out["max_full_white_ratio"] = max(out["max_full_white_ratio"], full["white_ratio"])

    # Primary ghost evidence: X11 map state per cycle. The full-screen video on
    # this machine captures the real desktop background window, not the
    # always-on-top spike (and the session was locked during the run), so frame
    # diffs alone cannot prove visibility. An unmapped window cannot be drawn.
    if timings and timings.get("cycles") and all(
        "map_state_after_hide" in c for c in timings["cycles"]
    ):
        cycles = timings["cycles"]
        hide_ok = sum(1 for c in cycles if c.get("map_state_after_hide") == "IsUnMapped")
        show_ok = sum(1 for c in cycles if c.get("map_state_after_show") == "IsViewable")
        out.update(
            {
                "ghost_detection": "x11_map_state",
                "map_state_hide_unmapped": hide_ok,
                "map_state_show_viewable": show_ok,
                "map_state_cycles": len(cycles),
                "ghost_frames": len(cycles) - hide_ok,
                "ghost_ok": bool(hide_ok == len(cycles) and show_ok == len(cycles)),
                "no_full_black_white": out["black_frames"] == 0 and out["white_frames"] == 0,
                "card_center_ok": None,
                "screen_video_note": (
                    "Full-screen video captures the KWin background window (real "
                    "desktop) but not always-on-top spike windows on this setup; "
                    "card/alpha verdicts come from xwd/window captures."
                ),
            }
        )
        return out

    # Ghost detection needs the show/hide timing map.
    if not timings or not timings.get("cycles"):
        out["ghost_detection"] = "no_timings"
        out["ghost_frames"] = None
        out["ghost_ok"] = None
        return out

    cycles = timings["cycles"]
    fps = float(meta.get("extract_fps") or 30)
    ff_start = float(meta.get("ffmpeg_start_ms") or 0)
    if not ff_start:
        out["ghost_detection"] = "no_ffmpeg_start"
        out["ghost_frames"] = None
        out["ghost_ok"] = None
        return out

    frame_times = [ff_start + (fr["index"] * 1000.0 / fps) for fr in frames]
    first_show = timings.get("first_show_ms") or cycles[0]["show_ms"]

    # Baseline = a hidden frame a little before the first show.
    baseline_idx = 0
    for i, t in enumerate(frame_times):
        if t <= first_show - 250:
            baseline_idx = i
        else:
            break
    baseline = frames[baseline_idx]["_img"]

    diff_fracs = []
    for fr in frames:
        frac, mad = diff_fraction(fr["_img"], baseline, fr["padded_box"], threshold=24)
        fr["baseline_diff_frac"] = frac
        fr["baseline_mean_abs"] = mad
        diff_fracs.append(frac)

    visible_vals = []
    hidden_vals = []
    hidden_frames = 0
    for fr, t in zip(frames, frame_times):
        for ci, cyc in enumerate(cycles):
            show_ms = cyc["show_ms"]
            hide_ms = cyc["hide_ms"]
            next_show = cycles[ci + 1]["show_ms"] if ci + 1 < len(cycles) else None
            if show_ms + 80 <= t <= hide_ms - 30:
                visible_vals.append(fr["baseline_diff_frac"])
                break
            if next_show is not None and hide_ms + 50 <= t <= next_show - 30:
                hidden_vals.append(fr["baseline_diff_frac"])
                hidden_frames += 1
                break

    med_visible = median(visible_vals) if visible_vals else 0.0
    med_hidden = median(hidden_vals) if hidden_vals else 0.0
    ghost_threshold = max(0.20, 0.60 * med_visible)
    if med_visible < 0.05:
        ghost_threshold = 0.15
    ghost_frames = sum(1 for v in hidden_vals if v > ghost_threshold)
    ghost_ratio = (med_hidden / med_visible) if med_visible > 1e-6 else None

    out.update(
        {
            "ghost_detection": "timed",
            "baseline_frame": frames[baseline_idx]["path"],
            "baseline_index": baseline_idx,
            "visible_frames_sampled": len(visible_vals),
            "hidden_frames_sampled": hidden_frames,
            "median_visible_diff_frac": round(med_visible, 6),
            "median_hidden_diff_frac": round(med_hidden, 6),
            "ghost_threshold": round(ghost_threshold, 6),
            "ghost_ratio": round(ghost_ratio, 6) if ghost_ratio is not None else None,
            "ghost_frames": ghost_frames,
            "ghost_ok": bool(hidden_frames > 0 and ghost_frames == 0),
        }
    )

    out["card_center_ok"] = (
        out["card_center_black_frames"] == 0 and out["card_center_white_frames"] == 0
    )
    out["no_full_black_white"] = out["black_frames"] == 0 and out["white_frames"] == 0

    # Per-frame verdicts for the first/last visible frames (raw evidence).
    out["sample_frames"] = [
        {
            "path": fr["path"],
            "card_center_rgb": fr["card_center_rgb"],
            "card_luma": fr["card_luma"],
            "baseline_diff_frac": fr.get("baseline_diff_frac"),
        }
        for fr in frames[:: max(1, len(frames) // 12)]
    ]
    return out


def unpremultiply(img):
    """Chromium/XWD ARGB data is premultiplied; convert to straight alpha."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                px[x, y] = (0, 0, 0, 0)
            elif a < 255:
                px[x, y] = (
                    min(255, int(round(r * 255.0 / a))),
                    min(255, int(round(g * 255.0 / a))),
                    min(255, int(round(b * 255.0 / a))),
                    a,
                )
    return img


def compose_window(bg_path, rgba_path, x, y, out_path):
    bg = Image.open(bg_path).convert("RGBA")
    win = unpremultiply(Image.open(rgba_path))
    layer = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    layer.paste(win, (int(round(x)), int(round(y))), win)
    comp = Image.alpha_composite(bg, layer).convert("RGB")
    comp.save(out_path)
    return comp


def analyze_window_composite(geom, evidence_dir, tag, bg_path, window_alpha_path, alpha_json_path, prefix, true_composite=False):
    """Composite the real XWD window alpha over the real KWin background."""
    result = {
        "background_png": bg_path if os.path.exists(bg_path) else None,
        "window_alpha_png": window_alpha_path if os.path.exists(window_alpha_path) else None,
        "alpha_json": alpha_json_path if os.path.exists(alpha_json_path) else None,
        "composite_png": None,
    }
    alpha_info = load_json(alpha_json_path) if alpha_json_path else None
    if alpha_info:
        # xwd-alpha.py prints a JSON line possibly followed by [stderr] text.
        if "transparent_gutter" not in alpha_info:
            for line in (open(alpha_json_path, "r", encoding="utf-8", errors="replace").read().splitlines() if alpha_json_path and os.path.exists(alpha_json_path) else []):
                line = line.strip()
                if line.startswith("{"):
                    try:
                        alpha_info = json.loads(line)
                        break
                    except Exception:
                        pass
    result["alpha"] = alpha_info

    if not os.path.exists(bg_path) or not os.path.exists(window_alpha_path):
        result["error"] = "missing background or window alpha capture"
        result["pass"] = False
        return result

    if true_composite:
        # spectacle/KWin ScreenShot2 captured the real composited screen already.
        comp_path = bg_path
        comp = Image.open(bg_path).convert("RGB")
        result["composite_kind"] = "true-spectacle"
    else:
        comp_path = os.path.join(evidence_dir, f"task-3-{tag}-{prefix}-composite.png")
        comp = compose_window(bg_path, window_alpha_path, geom.win_x, geom.win_y, comp_path)
        result["composite_kind"] = "reconstructed-real-background+real-window-alpha"
    result["composite_png"] = comp_path

    card_l, card_t, card_r, card_b = geom.card_screen_box()
    win_l, win_t, win_r, win_b = geom.window_screen_box()
    center = geom.card_center_screen()

    gutter_points = {
        "top_left": (win_l + 4, win_t + 4),
        "top_right": (win_r - 5, win_t + 4),
        "bottom_left": (win_l + 4, win_b - 5),
        "bottom_right": (win_r - 5, win_b - 5),
    }
    corner_points = {
        "card_top_left": (card_l + 2, card_t + 2),
        "card_top_right": (card_r - 3, card_t + 2),
        "card_bottom_left": (card_l + 2, card_b - 3),
        "card_bottom_right": (card_r - 3, card_b - 3),
    }

    def sample(img, point):
        rgb, size = patch_mean(img, point[0], point[1], radius=2)
        return {"rgb": rgb_tuple(rgb), "sample_size": size}

    baseline = None
    baseline_path = os.path.join(evidence_dir, f"task-3-{tag}-baseline.png")
    if os.path.exists(baseline_path):
        baseline = Image.open(baseline_path).convert("RGB")

    gutter = {}
    for name, pt in gutter_points.items():
        entry = {"composite": sample(comp, pt)}
        if baseline:
            entry["baseline"] = sample(baseline, pt)
            entry["distance_to_baseline"] = round(
                color_distance(entry["composite"]["rgb"], entry["baseline"]["rgb"]), 3
            )
        gutter[name] = entry

    corners = {name: {"composite": sample(comp, pt)} for name, pt in corner_points.items()}
    card_center = sample(comp, center)
    bg_center = sample(Image.open(bg_path).convert("RGB"), center)

    card_box = (
        max(0, int(round(card_l))),
        max(0, int(round(card_t))),
        min(comp.width, int(round(card_r))),
        min(comp.height, int(round(card_b))),
    )
    card_stats = luma_stats(comp, card_box)
    corner_stats = [luma_stats(comp, (max(0, int(x) - 12), max(0, int(y) - 12), min(comp.width, int(x) + 12), min(comp.height, int(y) + 12))) for x, y in corner_points.values()]

    for name, entry in corners.items():
        rgb = entry["composite"]["rgb"]
        entry["pure_black"] = is_pure_black(rgb)
        entry["pure_white"] = is_pure_white(rgb)
        if baseline:
            # compare the same rounded-corner location on the background
            bx, by = corner_points[name]
            entry["baseline"] = sample(baseline, (bx, by))
            entry["distance_to_baseline"] = round(
                color_distance(rgb, entry["baseline"]["rgb"]), 3
            )
        entry["distance_to_card_center"] = round(color_distance(rgb, card_center["rgb"]), 3)

    corner_not_bw = all(not e["pure_black"] and not e["pure_white"] for e in corners.values())
    gutter_ok_points = sum(
        1
        for e in gutter.values()
        if ("distance_to_baseline" in e and e["distance_to_baseline"] <= 12)
        or (not is_pure_black(e["composite"]["rgb"]) and not is_pure_white(e["composite"]["rgb"]))
    )
    gutter_shows_desktop = gutter_ok_points >= 3
    card_text_present = card_stats["bright_ratio"] > 0.002
    # Dark-on-dark desktops make card-vs-gutter distances small; the alpha proof
    # and text presence are the stronger signals.
    card_visible = card_text_present or color_distance(card_center["rgb"], bg_center["rgb"]) > 4

    result.update(
        {
            "card_center_rgb": card_center["rgb"],
            "background_center_rgb": bg_center["rgb"],
            "card_center_not_pure_bw": not is_pure_black(card_center["rgb"])
            and not is_pure_white(card_center["rgb"]),
            "card_stats": card_stats,
            "corner_stats": corner_stats,
            "card_text_present": card_text_present,
            "card_visible": card_visible,
            "gutter": gutter,
            "gutter_ok_points": gutter_ok_points,
            "gutter_shows_desktop": gutter_shows_desktop,
            "rounded_corners": corners,
            "corner_not_black_white": corner_not_bw,
            "alpha_transparent_gutter": bool(alpha_info and alpha_info.get("transparent_gutter")),
            "alpha_card_opaque_enough": bool(alpha_info and alpha_info.get("card_opaque_enough")),
            "corner_ok": bool(
                corner_not_bw
                and gutter_shows_desktop
                and not is_pure_black(card_center["rgb"])
                and not is_pure_white(card_center["rgb"])
                and card_visible
            ),
        }
    )
    result["pass"] = bool(
        result["corner_ok"]
        and result["alpha_transparent_gutter"]
        and result["alpha_card_opaque_enough"]
    )
    return result


def analyze_screens(geom, evidence_dir, tag):
    """Corner/gutter analysis: real background + real XWD window alpha."""
    baseline_path = os.path.join(evidence_dir, f"task-3-{tag}-baseline.png")
    visible_bg = os.path.join(evidence_dir, f"task-3-{tag}-visible.png")
    hidden_path = os.path.join(evidence_dir, f"task-3-{tag}-hidden.png")
    window_alpha = os.path.join(evidence_dir, f"task-3-{tag}-visible-window-alpha.png")
    alpha_json = os.path.join(evidence_dir, f"task-3-{tag}-visible-alpha.json")
    method = ""
    method_path = visible_bg + ".method"
    if os.path.exists(method_path):
        try:
            method = open(method_path, "r", encoding="utf-8").read().strip()
        except Exception:
            method = ""
    result = analyze_window_composite(
        geom, evidence_dir, tag, visible_bg, window_alpha, alpha_json, "visible",
        true_composite=(method == "spectacle"),
    )
    result["capture_method"] = method or "unknown"
    result["baseline_png"] = baseline_path if os.path.exists(baseline_path) else None
    result["background_png"] = visible_bg if os.path.exists(visible_bg) else None
    result["hidden_png"] = hidden_path if os.path.exists(hidden_path) else None

    if os.path.exists(hidden_path) and os.path.exists(baseline_path):
        hidden = Image.open(hidden_path).convert("RGB")
        baseline = Image.open(baseline_path).convert("RGB")
        card_l, card_t, card_r, card_b = geom.card_screen_box()
        raw_box = (int(round(card_l)), int(round(card_t)), int(round(card_r)), int(round(card_b)))
        diff = mean_abs_diff_region(hidden, baseline, raw_box)
        result["hidden_background"] = {
            "card_region_vs_baseline": diff,
            "note": "spike is not part of the background capture; map-state evidence is authoritative for ghosts",
        }
    return result


# ---------------------------------------------------------------- mode checkers
def check_sizes(frames, geom, meta, bounds, evidence_dir):
    out = {
        "frame_count": len(frames),
        "black_frames": 0,
        "white_frames": 0,
        "card_center_black_frames": 0,
        "card_center_white_frames": 0,
        "max_full_black_ratio": 0.0,
        "max_full_white_ratio": 0.0,
        "card_center_samples": [],
    }
    for fr in frames:
        full = fr["full"]
        if full["black_ratio"] > 0.995 or (full["mean"] < 3 and full["stddev"] < 2):
            out["black_frames"] += 1
        if full["white_ratio"] > 0.995 or (full["mean"] > 252 and full["stddev"] < 2):
            out["white_frames"] += 1
        if is_pure_black(fr["card_center_rgb"]):
            out["card_center_black_frames"] += 1
        if is_pure_white(fr["card_center_rgb"]):
            out["card_center_white_frames"] += 1
        out["max_full_black_ratio"] = max(out["max_full_black_ratio"], full["black_ratio"])
        out["max_full_white_ratio"] = max(out["max_full_white_ratio"], full["white_ratio"])
    step = max(1, len(frames) // 16)
    out["card_center_samples"] = [
        {"path": fr["path"], "rgb": fr["card_center_rgb"], "luma": fr["card_luma"]["mean"]}
        for fr in frames[::step]
    ]
    out["transition_count"] = len(bounds.get("entries", [])) if bounds else 0
    out["rounds"] = bounds.get("rounds") if bounds else None
    out["no_black_white"] = out["black_frames"] == 0 and out["white_frames"] == 0
    out["card_center_ok"] = (
        out["card_center_black_frames"] == 0 and out["card_center_white_frames"] == 0
    )

    screens = {}
    for name in ("S1", "S2", "S3"):
        bg = os.path.join(evidence_dir, f"task-3-sizes-{name}.png")
        method = ""
        if os.path.exists(bg + ".method"):
            try:
                method = open(bg + ".method", "r", encoding="utf-8").read().strip()
            except Exception:
                method = ""
        screens[name] = analyze_window_composite(
            geom,
            evidence_dir,
            "sizes",
            bg,
            os.path.join(evidence_dir, f"task-3-sizes-{name}-window-alpha.png"),
            os.path.join(evidence_dir, f"task-3-sizes-{name}-alpha.json"),
            name,
            true_composite=(method == "spectacle"),
        )
        screens[name]["capture_method"] = method or "unknown"
    out["screens"] = screens
    out["pass"] = bool(
        out["no_black_white"]
        and out["card_center_ok"]
        and all(sc.get("pass") for sc in screens.values())
    )
    return out


def parse_blur_xprop(path):
    set_values = []
    clear_count = 0
    set_count = 0
    if not os.path.exists(path):
        return {"error": "missing xprop file", "set_count": 0, "clear_count": 0}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    for match in re.finditer(
        r"_KDE_NET_WM_BLUR_BEHIND_REGION\(CARDINAL\)\s*=\s*([0-9][0-9, \t]*)", text
    ):
        values = [int(v) for v in re.findall(r"\d+", match.group(1))]
        set_values.append(values)
        set_count += 1
    clear_count = len(
        re.findall(r"_KDE_NET_WM_BLUR_BEHIND_REGION[^\n]*not found", text)
    )
    return {
        "set_count": set_count,
        "clear_count": clear_count,
        "set_values": set_values,
        "all_multiples_of_four": all(len(v) % 4 == 0 for v in set_values),
        "quad_counts": sorted({len(v) // 4 for v in set_values}),
    }


def corner_diff_between(path_a, path_b, geom, patch=24):
    if not os.path.exists(path_a) or not os.path.exists(path_b):
        return None
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    card_l, card_t, card_r, card_b = geom.card_screen_box()
    points = [
        (card_l + 2, card_t + 2),
        (card_r - 3, card_t + 2),
        (card_l + 2, card_b - 3),
        (card_r - 3, card_b - 3),
    ]
    vals = []
    for x, y in points:
        box = (
            max(0, int(x) - patch),
            max(0, int(y) - patch),
            min(a.width, int(x) + patch),
            min(a.height, int(y) + patch),
        )
        d = mean_abs_diff_region(a, b, box)
        vals.append(d["mean_abs"])
    return {
        "per_corner_mean_abs": vals,
        "mean_abs": round(sum(vals) / len(vals), 3) if vals else None,
        "max_abs": round(max(vals), 3) if vals else None,
    }


def corner_diff_window(path_a, path_b, card_css, patch=24):
    if not os.path.exists(path_a) or not os.path.exists(path_b):
        return None
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    cx, cy, cw, ch = card_css
    points = [
        (cx + 2, cy + 2),
        (cx + cw - 3, cy + 2),
        (cx + 2, cy + ch - 3),
        (cx + cw - 3, cy + ch - 3),
    ]
    vals = []
    for x, y in points:
        box = (
            max(0, int(x) - patch),
            max(0, int(y) - patch),
            min(a.width, int(x) + patch),
            min(a.height, int(y) + patch),
        )
        d = mean_abs_diff_region(a, b, box)
        vals.append(d["mean_abs"])
    return {
        "per_corner_mean_abs": vals,
        "mean_abs": round(sum(vals) / len(vals), 3) if vals else None,
        "max_abs": round(max(vals), 3) if vals else None,
    }


def check_blur(evidence_dir, geom, tag):
    xprop_file = os.path.join(evidence_dir, "task-3-blur-xprop.txt")
    toggles_file = os.path.join(evidence_dir, "task-3-blur-toggles.json")
    kwin_file = os.path.join(evidence_dir, "task-3-blur-kwin-state.txt")
    toggles = load_json(toggles_file) or {}
    props = parse_blur_xprop(xprop_file)

    kwin_text = ""
    if os.path.exists(kwin_file):
        with open(kwin_file, "r", encoding="utf-8", errors="replace") as fh:
            kwin_text = fh.read()
    blur_loaded = bool(re.search(r"isEffectLoaded blur\s*\n\[exit 0\]\s*\nstdout: true", kwin_text))
    blur_enabled = bool(re.search(r"blurEnabled\s*\n\[exit 0\]\s*\nstdout: true", kwin_text))

    pairs = []
    for entry in toggles.get("entries", []):
        i = entry["iteration"]
        kind = entry["rect_kind"]
        suffix = "inset" if kind == "inset2" else "full"
        set_png = os.path.join(evidence_dir, f"task-3-blur-set-{i}-{suffix}-window.png")
        clear_png = os.path.join(evidence_dir, f"task-3-blur-clear-{i}-window.png")
        card_css = (
            int(round(geom.card_x)),
            int(round(geom.card_y)),
            int(round(geom.card_w)),
            int(round(geom.card_h)),
        )
        diff = corner_diff_window(set_png, clear_png, card_css)
        pairs.append({"iteration": i, "rect_kind": kind, "set_vs_clear": diff, "source": "window-capture"})

    full_diffs = [p["set_vs_clear"]["mean_abs"] for p in pairs if p["rect_kind"] == "full" and p["set_vs_clear"]]
    inset_diffs = [p["set_vs_clear"]["mean_abs"] for p in pairs if p["rect_kind"] == "inset2" and p["set_vs_clear"]]

    property_ok = props.get("set_count", 0) >= 10 and props.get("clear_count", 0) >= 10
    visual_testable = blur_loaded and blur_enabled
    if visual_testable:
        recommendation = "inset2" if (inset_diffs and full_diffs and median(inset_diffs) <= median(full_diffs)) else "full"
    else:
        recommendation = "inset2"

    return {
        "xprop": props,
        "kwin_blur_loaded": blur_loaded,
        "kwin_blur_enabled_config": blur_enabled,
        "visual_blur_testable": visual_testable,
        "toggle_count": len(toggles.get("entries", [])),
        "set_vs_clear_corner_diff": pairs,
        "full_rect_corner_diff_mean_abs": round(median(full_diffs), 3) if full_diffs else None,
        "inset2_corner_diff_mean_abs": round(median(inset_diffs), 3) if inset_diffs else None,
        "recommended_rect_policy": recommendation,
        "recommendation_reason": (
            "KWin Blur effect not loaded/enabled on this machine: property toggling is "
            "verified but visual bleed is not measurable. 2px inset is the defensive "
            "policy because it clips blur inside the rounded card edge."
            if not visual_testable
            else "Chosen from measured corner diff (lower bleed wins)."
        ),
        "property_ok": property_ok,
        "pass": bool(property_ok),
    }


def check_opaque(evidence_dir, geom, tag, prefix="opaque"):
    """Analyze the opaque window's own capture (fallback must be readable)."""
    win_png = os.path.join(evidence_dir, f"task-3-{prefix}-window.png")
    bg_png = os.path.join(evidence_dir, f"task-3-{prefix}.png")
    out = {
        "window_png": win_png if os.path.exists(win_png) else None,
        "background_png": bg_png if os.path.exists(bg_png) else None,
    }
    if os.path.exists(win_png):
        img = Image.open(win_png).convert("RGB")
        # The opaque fallback window is the whole card; text sits at (40,28).
        stats = luma_stats(img)
        cx, cy = img.width // 2, img.height // 2
        center_rgb, _ = patch_mean(img, cx, cy, radius=3)
        fill_ok = 10 <= stats["mean"] <= 90
        # bright text pixels against the dark #1c1e20 fill
        text_readable = stats["bright_ratio"] > 0.002 and (255 - stats["mean"]) > 100
        black_block = stats["black_ratio"] > 0.8
        white_block = stats["white_ratio"] > 0.8
        out.update(
            {
                "analysis_source": "opaque-window-capture",
                "window_stats": stats,
                "card_center_rgb": rgb_tuple(center_rgb),
                "card_center_not_pure_bw": not is_pure_black(rgb_tuple(center_rgb))
                and not is_pure_white(rgb_tuple(center_rgb)),
                "fill_ok": fill_ok,
                "text_readable": text_readable,
                "black_block": black_block,
                "white_block": white_block,
                "pass": bool(
                    fill_ok
                    and text_readable
                    and not black_block
                    and not white_block
                    and not is_pure_black(rgb_tuple(center_rgb))
                    and not is_pure_white(rgb_tuple(center_rgb))
                ),
            }
        )
        return out

    if not os.path.exists(bg_png):
        out["error"] = "missing opaque capture"
        out["pass"] = False
        return out

    # Fallback: analyze the cropped screen background.
    img = Image.open(bg_png).convert("RGB")
    win_box = (
        max(0, int(geom.win_x)),
        max(0, int(geom.win_y)),
        min(img.width, int(geom.win_x + geom.win_w)),
        min(img.height, int(geom.win_y + geom.win_h)),
    )
    full = luma_stats(img)
    win_stats = luma_stats(img, win_box)
    cx, cy = geom.card_center_screen()
    center_rgb, _ = patch_mean(img, cx, cy, radius=3)
    fill_ok = 10 <= win_stats["mean"] <= 90
    text_readable = win_stats["bright_ratio"] > 0.005 and (255 - win_stats["mean"]) > 100
    out.update(
        {
            "analysis_source": "screen-background-crop",
            "full_frame": full,
            "window": {"box": win_box, **win_stats},
            "card_center_rgb": rgb_tuple(center_rgb),
            "fill_ok": fill_ok,
            "text_readable": text_readable,
            "pass": bool(fill_ok and text_readable),
        }
    )
    return out


def check_g5(frames, evidence_dir, geom, meta):
    # Transparent window under a suspended compositor: capture its real alpha
    # and composite it over the real background; classify black/unusable instead
    # of failing the gate on it.
    t_bg = os.path.join(evidence_dir, "task-3-g5-transparent.png")
    t_method = ""
    if os.path.exists(t_bg + ".method"):
        try:
            t_method = open(t_bg + ".method", "r", encoding="utf-8").read().strip()
        except Exception:
            t_method = ""
    transparent = analyze_window_composite(
        geom,
        evidence_dir,
        "g5",
        t_bg,
        os.path.join(evidence_dir, "task-3-g5-transparent-window-alpha.png"),
        os.path.join(evidence_dir, "task-3-g5-transparent-alpha.json"),
        "transparent",
        true_composite=(t_method in ("spectacle", "root")),
    )
    transparent["screen_method"] = t_method or "unknown"
    alpha = transparent.get("alpha") or {}
    # Under a suspended compositor the transparent window has no blending; the
    # raw root capture should show a black/unusable rectangle. Treat that as
    # expected evidence, not a gate failure.
    transparent_black = bool(
        (not transparent.get("pass", False))
        or (transparent.get("card_center_rgb") and is_pure_black(transparent["card_center_rgb"]))
        or not alpha.get("transparent_gutter", False)
    )
    transparent["transparent_black_or_unusable"] = transparent_black
    transparent["expected_under_compositor_off"] = True

    opaque = check_opaque(evidence_dir, geom, "g5", prefix="g5-opaque")
    opaque_bg = os.path.join(evidence_dir, "task-3-g5-opaque.png")
    opaque["screen_png"] = opaque_bg if os.path.exists(opaque_bg) else None
    if os.path.exists(opaque_bg + ".method"):
        try:
            opaque["screen_method"] = open(opaque_bg + ".method", "r", encoding="utf-8").read().strip()
        except Exception:
            opaque["screen_method"] = "unknown"

    black_frames = 0
    white_frames = 0
    for fr in frames:
        full = fr["full"]
        if full["black_ratio"] > 0.995 or (full["mean"] < 3 and full["stddev"] < 2):
            black_frames += 1
        if full["white_ratio"] > 0.995 or (full["mean"] > 252 and full["stddev"] < 2):
            white_frames += 1

    restored = None
    after_file = os.path.join(evidence_dir, "task-3-compositing-after.txt")
    if os.path.exists(after_file):
        with open(after_file, "r", encoding="utf-8", errors="replace") as fh:
            restored = "true" in fh.read().lower()

    return {
        "frame_count": len(frames),
        "video_black_frames": black_frames,
        "video_white_frames": white_frames,
        "transparent_under_suspend": transparent,
        "opaque_fallback": opaque,
        "compositor_restored": restored,
        "compositor_off_opaque_ok": bool(opaque.get("pass")),
        "pass": bool(opaque.get("pass") and restored is not False),
    }


# ----------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--info", required=True)
    ap.add_argument("--timings", default=None)
    ap.add_argument("--evidence-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    meta = load_json(args.meta) or {}
    info = load_json(args.info) or {}
    timings = load_json(args.timings) if args.timings else None

    paths = frame_paths(args.frames_dir)
    if paths:
        probe = Image.open(paths[0])
        img_size = probe.size
    else:
        img_size = (
            int(meta.get("frame_width") or 640),
            int(meta.get("frame_height") or 360),
        )
    geom = Geometry(info, meta, img_size)
    frames = scan_frames(paths, geom)

    result = {
        "generated_at": None,
        "mode": args.mode,
        "tag": args.tag,
        "frames_dir": args.frames_dir,
        "frame_count": len(frames),
        "meta": meta,
        "geometry": {
            "screen": [geom.screen_w, geom.screen_h],
            "window_dip": [geom.win_x, geom.win_y, geom.win_w, geom.win_h],
            "card_device": [geom.card_x, geom.card_y, geom.card_w, geom.card_h],
            "scale_factor": geom.scale_factor,
            "frame_scale": [round(geom.sx, 6), round(geom.sy, 6)],
        },
    }

    if args.mode == "cycle":
        result["frames"] = analyze_cycle(frames, geom, meta, timings)
        result["screens"] = analyze_screens(geom, args.evidence_dir, args.tag)
        fr = result["frames"]
        sc = result["screens"]
        result["pass"] = bool(
            fr.get("no_full_black_white")
            and fr.get("ghost_ok")
            and sc.get("pass")
        )
        result["verdicts"] = {
            "no_full_black_white_video": fr.get("no_full_black_white"),
            "ghost_ok_map_state": fr.get("ghost_ok"),
            "screen_composite_ok": sc.get("pass"),
            "screen_composite_kind": "real KWin background + real XWD window alpha (reconstructed because KWin ScreenShot2/root capture cannot read composited always-on-top windows here)",
        }
    elif args.mode == "sizes":
        result["frames"] = check_sizes(frames, geom, meta, timings, args.evidence_dir)
        result["pass"] = bool(result["frames"].get("pass"))
    elif args.mode == "blur":
        result["blur"] = check_blur(args.evidence_dir, geom, args.tag)
        result["pass"] = bool(result["blur"].get("pass"))
    elif args.mode == "opaque":
        result["opaque"] = check_opaque(args.evidence_dir, geom, args.tag)
        result["pass"] = bool(result["opaque"].get("pass"))
    elif args.mode == "g5":
        result["g5"] = check_g5(frames, args.evidence_dir, geom, meta)
        result["pass"] = bool(result["g5"].get("pass"))
    else:
        result["error"] = f"unknown mode {args.mode}"
        result["pass"] = False

    from datetime import datetime

    result["generated_at"] = datetime.now().astimezone().isoformat()
    save_json(args.out, result)
    print(json.dumps({"out": args.out, "pass": result.get("pass"), "frame_count": len(frames)}))
    return 0 if result.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())
