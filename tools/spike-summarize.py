#!/usr/bin/env python3
"""Aggregate Task-3 G1/G5 evidence into .omo/evidence/task-3-result.json."""

import glob
import json
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVID = os.path.join(ROOT, ".omo", "evidence")


def load(name, default=None):
    path = os.path.join(EVID, name)
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def read_text(name):
    path = os.path.join(EVID, name)
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def gpu_crash(name):
    text = read_text(name)
    patterns = [
        r"GPU process (?:isn't usable|crash)",
        r"FATAL:",
        r"Segmentation fault",
        r"Aborted \(core dumped\)",
        r"Renderer process crashed",
    ]
    for pat in patterns:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False


def variant_summary(variant):
    tag = f"cycle-{variant}"
    pixels = load(f"task-3-{tag}-pixels.json", {}) or {}
    gpu = load(f"task-3-{tag}-gpu.json", {}) or {}
    timings = load(f"task-3-cycle-timestamps-{variant}.json", {}) or {}
    frames = pixels.get("frames", {}) or {}
    screens = pixels.get("screens", {}) or {}
    cycles = timings.get("cycles", []) or []
    show_ok = sum(1 for c in cycles if c.get("map_state_after_show") == "IsViewable")
    hide_ok = sum(1 for c in cycles if c.get("map_state_after_hide") == "IsUnMapped")
    black = frames.get("black_frames", 0) or 0
    white = frames.get("white_frames", 0) or 0
    ghost = len(cycles) - hide_ok if cycles else None
    alpha_ok = bool(
        screens.get("alpha_transparent_gutter") and screens.get("alpha_card_opaque_enough")
    )
    crash = gpu_crash(f"task-3-{tag}.log") or gpu_crash(f"task-3-{tag}-electron.log")
    pass_ = bool(
        pixels.get("pass")
        and cycles
        and show_ok == len(cycles)
        and hide_ok == len(cycles)
        and black == 0
        and white == 0
        and not crash
    )
    return {
        "name": variant,
        "gpu_off": variant == "gpu-off",
        "transparent_visuals": variant == "transparent-visuals",
        "cycles": len(cycles),
        "show_viewable": show_ok,
        "hide_unmapped": hide_ok,
        "black_frames": black,
        "white_frames": white,
        "ghost_frames": ghost,
        "corner_ok": bool(screens.get("corner_ok")),
        "card_center_rgb": screens.get("card_center_rgb"),
        "card_alpha_ok": alpha_ok,
        "gutter_shows_desktop": bool(screens.get("gutter_shows_desktop")),
        "card_text_present": bool(screens.get("card_text_present")),
        "screen_capture_method": screens.get("capture_method"),
        "composite_kind": screens.get("composite_kind"),
        "gpu_crash": crash,
        "gpu_feature_status": gpu.get("gpu_feature_status"),
        "pass": pass_,
        "evidence": {
            "timings": f".omo/evidence/task-3-cycle-timestamps-{variant}.json",
            "xprop": f".omo/evidence/task-3-xprop-{variant}.txt",
            "pixels": f".omo/evidence/task-3-{tag}-pixels.json",
            "visible_png": f".omo/evidence/task-3-{tag}-visible.png",
            "baseline_png": f".omo/evidence/task-3-{tag}-baseline.png",
            "window_alpha_png": f".omo/evidence/task-3-{tag}-visible-window-alpha.png",
            "video": f".omo/evidence/task-3-{tag}.mp4",
            "log": f".omo/evidence/task-3-{tag}.log",
        },
    }


def main():
    variants = [variant_summary(v) for v in ("gpu-on", "gpu-off", "transparent-visuals")]
    g1_pass = all(v["pass"] for v in variants)

    sizes = load("task-3-sizes-pixels.json", {}) or {}
    sizes_frames = sizes.get("frames", {}) or {}
    blur = (load("task-3-blur-pixels.json", {}) or {}).get("blur", {}) or {}
    g5 = (load("task-3-g5-pixels.json", {}) or {}).get("g5", {}) or {}
    opaque = (load("task-3-opaque-pixels.json", {}) or {}).get("opaque", {}) or {}
    session = read_text("task-3-session-state.txt").strip()
    compositor_after = read_text("task-3-compositing-after.txt").strip()
    compositor_before = read_text("task-3-g5-compositing-before.txt").strip()
    transparent_info = g5.get("transparent_under_suspend", {}) or {}
    opaque_info = g5.get("opaque_fallback", {}) or {}

    g5_pass = bool(
        g5.get("pass")
        and g5.get("compositor_restored") is True
        and opaque_info.get("pass")
        and transparent_info.get("transparent_black_or_unusable") is True
    )

    result = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "task": "Task 3 — G1/G5 Electron transparency + NVIDIA 595 + compositor degrade spike",
        "environment": {
            "machine": "Debian 13, X11 DISPLAY=:0, KWin 6.3.6, NVIDIA RTX 5070 Ti driver 595.45.04",
            "kernel_kwin_screenshot2": "KWin ScreenShot2 works while the session is unlocked; times out while locked",
            "session_state_file": ".omo/evidence/task-3-session-state.txt",
            "session_state_snapshot": session,
        },
        "gates": {
            "G1": {
                "pass": g1_pass,
                "variants": variants,
                "black_frames": sum(v["black_frames"] for v in variants),
                "white_frames": sum(v["white_frames"] for v in variants),
                "ghost_frames": sum(v["ghost_frames"] or 0 for v in variants),
                "corner_ok": all(v["corner_ok"] for v in variants),
                "notes": (
                    "100 show/hide cycles per variant. Map state was IsViewable after every show and "
                    "IsUnMapped after every hide. Window alpha was read with xwd: card alpha=188 "
                    "(~0.72), gutter/rounded-corner alpha=0. Pixel verdicts use true KWin spectacle "
                    "composites when the session is unlocked; root x11grab/import only see the root "
                    "pixmap and miss composited windows on this KWin/NVIDIA setup."
                ),
                "sizes": {
                    "pass": bool(sizes.get("pass")),
                    "rounds": sizes_frames.get("rounds"),
                    "transitions": sizes_frames.get("transition_count"),
                    "black_frames": sizes_frames.get("black_frames"),
                    "white_frames": sizes_frames.get("white_frames"),
                    "screens": {
                        name: {
                            "pass": (sizes_frames.get("screens", {}).get(name, {}) or {}).get("pass"),
                            "capture_method": (sizes_frames.get("screens", {}).get(name, {}) or {}).get("capture_method"),
                        }
                        for name in ("S1", "S2", "S3")
                    },
                    "evidence": ".omo/evidence/task-3-sizes-pixels.json",
                },
                "blur": {
                    "pass": bool(blur.get("pass")),
                    "toggles": blur.get("toggle_count"),
                    "property_ok": blur.get("property_ok"),
                    "set_count": (blur.get("xprop", {}) or {}).get("set_count"),
                    "clear_count": (blur.get("xprop", {}) or {}).get("clear_count"),
                    "values_per_rect": (blur.get("xprop", {}) or {}).get("quad_counts"),
                    "kwin_blur_loaded": blur.get("kwin_blur_loaded"),
                    "kwin_blur_enabled_config": blur.get("kwin_blur_enabled_config"),
                    "visual_blur_testable": blur.get("visual_blur_testable"),
                    "full_rect_corner_diff": blur.get("full_rect_corner_diff_mean_abs"),
                    "inset2_corner_diff": blur.get("inset2_corner_diff_mean_abs"),
                    "recommended_rect_policy": blur.get("recommended_rect_policy"),
                    "notes": (
                        "KWin Blur effect is not loaded and blurEnabled=false on this machine; the "
                        "_KDE_NET_WM_BLUR_BEHIND_REGION property toggles are verified, but visual "
                        "corner bleed cannot be measured. Recommend the 2px inset policy defensively."
                    ),
                    "evidence": ".omo/evidence/task-3-blur-pixels.json",
                },
            },
            "G5": {
                "pass": g5_pass,
                "compositor_on_ok": compositor_before.strip() == "true",
                "compositor_off_transparent_black": bool(
                    transparent_info.get("transparent_black_or_unusable")
                ),
                "compositor_off_opaque_ok": bool(opaque_info.get("pass")),
                "restored": bool(g5.get("compositor_restored")),
                "compositor_after": compositor_after,
                "transparent_under_suspend": {
                    "screen_method": transparent_info.get("screen_method"),
                    "gutter_shows_desktop": transparent_info.get("gutter_shows_desktop"),
                    "card_center_rgb": transparent_info.get("card_center_rgb"),
                    "alpha_transparent_gutter": transparent_info.get("alpha_transparent_gutter"),
                    "expected": "black gutter rectangle without compositor blending",
                },
                "opaque_fallback": {
                    "pass": opaque_info.get("pass"),
                    "text_readable": opaque_info.get("text_readable"),
                    "card_center_rgb": opaque_info.get("card_center_rgb"),
                    "window_stats": opaque_info.get("window_stats"),
                },
                "opaque_self_test": {
                    "pass": opaque.get("pass"),
                    "text_readable": opaque.get("text_readable"),
                    "card_center_rgb": opaque.get("card_center_rgb"),
                },
                "notes": (
                    "KWin 6.3.6 does not expose org.kde.kwin.Compositing.suspend/resume over DBus; "
                    "the equivalent runtime toggle was invoked through kglobalaccel 'Suspend "
                    "Compositing' with a bash trap restoring it. Compositing.active was true -> false "
                    "-> true. Under suspend the transparent window shows a black gutter rectangle "
                    "(raw root capture); the opaque #1c1e20 fallback is readable with no black block."
                ),
                "evidence": {
                    "pixels": ".omo/evidence/task-3-g5-pixels.json",
                    "transparent_png": ".omo/evidence/task-3-g5-transparent.png",
                    "opaque_png": ".omo/evidence/task-3-g5-opaque.png",
                    "opaque_window_png": ".omo/evidence/task-3-g5-opaque-window.png",
                    "phases": ".omo/evidence/task-3-g5-phases.json",
                    "compositing_before": ".omo/evidence/task-3-g5-compositing-before.txt",
                    "compositing_suspended": ".omo/evidence/task-3-g5-compositing-suspended.txt",
                    "compositing_after": ".omo/evidence/task-3-compositing-after.txt",
                    "video": ".omo/evidence/task-3-g5.mp4",
                },
            },
        },
        "artifacts": [],
    }

    artifacts = [
        "docs/m0-spike-report.md",
        ".omo/evidence/task-3-result.json",
        ".omo/evidence/task-3-cycle-timestamps.json",
        ".omo/evidence/task-3-xprop-gpu-on.txt",
        ".omo/evidence/task-3-xprop-gpu-off.txt",
        ".omo/evidence/task-3-xprop-transparent-visuals.txt",
        ".omo/evidence/task-3-cycle-gpu-on-visible.png",
        ".omo/evidence/task-3-cycle-gpu-on-visible-crop.png",
        ".omo/evidence/task-3-cycle-gpu-on-baseline.png",
        ".omo/evidence/task-3-cycle-gpu-on-visible-window-alpha.png",
        ".omo/evidence/task-3-cycle-gpu-on-visible-alpha.json",
        ".omo/evidence/task-3-cycle-gpu-on-pixels.json",
        ".omo/evidence/task-3-cycle-gpu-off-pixels.json",
        ".omo/evidence/task-3-cycle-transparent-visuals-pixels.json",
        ".omo/evidence/task-3-cycle-gpu-on.mp4",
        ".omo/evidence/task-3-cycle-gpu-off.mp4",
        ".omo/evidence/task-3-cycle-transparent-visuals.mp4",
        ".omo/evidence/task-3-transparency.mp4",
        ".omo/evidence/task-3-sizes-pixels.json",
        ".omo/evidence/task-3-sizes.mp4",
        ".omo/evidence/task-3-sizes-S1.png",
        ".omo/evidence/task-3-sizes-S2.png",
        ".omo/evidence/task-3-sizes-S3.png",
        ".omo/evidence/task-3-blur-pixels.json",
        ".omo/evidence/task-3-blur-xprop.txt",
        ".omo/evidence/task-3-blur-kwin-state.txt",
        ".omo/evidence/task-3-blur.mp4",
        ".omo/evidence/task-3-g5-pixels.json",
        ".omo/evidence/task-3-g5-transparent.png",
        ".omo/evidence/task-3-g5-transparent-crop.png",
        ".omo/evidence/task-3-g5-opaque.png",
        ".omo/evidence/task-3-g5-opaque-crop.png",
        ".omo/evidence/task-3-g5.mp4",
        ".omo/evidence/task-3-compositing-after.txt",
        ".omo/evidence/task-3-opaque-pixels.json",
        ".omo/evidence/task-3-opaque.png",
        ".omo/evidence/task-3-session-state.txt",
        ".omo/evidence/task-3-compositor-window.txt",
    ]
    result["artifacts"] = [a for a in artifacts if os.path.exists(os.path.join(ROOT, a))]

    out = os.path.join(EVID, "task-3-result.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    print(json.dumps({"out": out, "G1": g1_pass, "G5": g5_pass}, indent=2))
    return 0 if (g1_pass and g5_pass) else 1


if __name__ == "__main__":
    sys.exit(main())
