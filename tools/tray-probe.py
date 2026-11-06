#!/usr/bin/env python3
"""Deterministic helpers for the Task 6 G7 tray spike.

Subcommands:
  icon            locate the distinctive magenta tray icon in a screenshot
  snapshot-windows snapshot visible plasmashell windows (id + geometry)
  diff-windows    classify windows that appeared after an action
  event-count     print number of events in task-6-tray-events.json
  events          extract events since an index
  state           extract tray app PID / SNI / menu from event log
  sni-props       query a StatusNotifierItem's properties using gdbus
  combine-summary build task-6-tray-summary.json from raw evidence files

Run with the project venv: python3
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image
from scipy import ndimage


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


# ---------------------------------------------------------------------------
# icon
# ---------------------------------------------------------------------------

def cmd_icon(args) -> int:
    image = Image.open(args.image).convert("RGB")
    arr = np.asarray(image).astype(np.int32)
    target = np.array([0xFF, 0x00, 0xCC], dtype=np.int32)  # #ff00cc
    dist = np.sqrt(((arr - target) ** 2).sum(axis=2))
    mask = dist <= args.tolerance

    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=int))
    clusters = []
    for label_id in range(1, count + 1):
        ys, xs = np.nonzero(labels == label_id)
        if xs.size == 0:
            continue
        w = int(xs.max() - xs.min() + 1)
        h = int(ys.max() - ys.min() + 1)
        area = int(xs.size)
        if area < args.min_pixels:
            continue
        if w < args.min_size or h < args.min_size:
            continue
        if w > args.max_size or h > args.max_size:
            continue
        x0, y0 = int(xs.min()), int(ys.min())
        x1, y1 = int(xs.max()), int(ys.max())
        squareness = min(w, h) / max(w, h)
        clusters.append(
            {
                "bbox": {"x": x0, "y": y0, "width": w, "height": h},
                "center": {"x": int(round((x0 + x1) / 2)), "y": int(round((y0 + y1) / 2))},
                "pixels": area,
                "squareness": round(float(squareness), 3),
                "score": round(float(area * squareness), 3),
            }
        )

    clusters.sort(key=lambda c: c["score"], reverse=True)
    chosen = None
    reason = None
    if clusters:
        # Prefer a cluster in the panel strip if one exists.
        in_panel = [c for c in clusters if c["center"]["y"] < args.panel_height]
        if in_panel:
            chosen = in_panel[0]
            reason = "largest magenta cluster inside panel strip"
        else:
            chosen = clusters[0]
            reason = "largest magenta cluster anywhere on screen"

    result = {
        "ts": now_iso(),
        "image": os.path.abspath(args.image),
        "image_size": {"width": image.width, "height": image.height},
        "target": "#ff00cc",
        "tolerance": args.tolerance,
        "cluster_count": len(clusters),
        "clusters": clusters[:10],
        "chosen": chosen,
        "reason": reason,
        "found": bool(chosen),
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if chosen else 1


# ---------------------------------------------------------------------------
# windows
# ---------------------------------------------------------------------------

WININFO_RE = {
    "x": re.compile(r"Absolute upper-left X:\s+(-?\d+)"),
    "y": re.compile(r"Absolute upper-left Y:\s+(-?\d+)"),
    "width": re.compile(r"Width:\s+(\d+)"),
    "height": re.compile(r"Height:\s+(\d+)"),
    "map_state": re.compile(r"Map State:\s+(\w+)"),
    "override": re.compile(r"Override Redirect State:\s+(\w+)"),
}


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True)


def window_info(window_id: str) -> dict | None:
    proc = run(["xwininfo", "-id", window_id])
    if proc.returncode != 0:
        return None
    text = proc.stdout
    record = {"id": window_id}
    for key, regex in WININFO_RE.items():
        match = regex.search(text)
        if match:
            value = match.group(1)
            record[key] = value if key in ("map_state", "override") else int(value)
    title = run(["xprop", "-id", window_id, "_NET_WM_NAME", "WM_NAME"])
    name = ""
    for line in title.stdout.splitlines():
        if "=" in line:
            name = line.split("=", 1)[1].strip().strip('"')
            break
    record["name"] = name
    if record.get("map_state") != "IsViewable":
        return None
    return record


def cmd_snapshot_windows(args) -> int:
    proc = run(["xdotool", "search", "--onlyvisible", "--class", "plasmashell"])
    ids = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    # de-duplicate while preserving order
    seen = set()
    deduped = []
    for wid in ids:
        if wid not in seen:
            seen.add(wid)
            deduped.append(wid)
    windows = [w for w in (window_info(wid) for wid in deduped) if w]
    result = {
        "ts": now_iso(),
        "command": "xdotool search --onlyvisible --class plasmashell",
        "windows": windows,
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _screen_area(win: dict) -> int:
    return int(win.get("width", 0)) * int(win.get("height", 0))


def cmd_diff_windows(args) -> int:
    before = load_json(args.before)
    after = load_json(args.after)
    before_ids = {w["id"] for w in before.get("windows", [])}
    new_windows = [w for w in after.get("windows", []) if w["id"] not in before_ids]
    for win in new_windows:
        w = int(win.get("width", 0))
        h = int(win.get("height", 0))
        # A Plasma popup menu is a tall/narrow transient; tooltips are short.
        win["menu_like"] = bool(w >= 70 and h >= 80 and _screen_area(win) < 1920 * 1080 * 0.9)
        win["tooltip_like"] = bool(h <= 70)
    menu = next((w for w in new_windows if w.get("menu_like")), None)
    result = {
        "ts": now_iso(),
        "before_count": len(before.get("windows", [])),
        "after_count": len(after.get("windows", [])),
        "new_windows": new_windows,
        "menu_like": menu,
        "menu_shown": bool(menu),
        "tooltip_like": next((w for w in new_windows if w.get("tooltip_like")), None),
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# event log
# ---------------------------------------------------------------------------

def cmd_event_count(args) -> int:
    state = load_json(args.events)
    print(len(state.get("events", [])))
    return 0


def cmd_events(args) -> int:
    state = load_json(args.events)
    events = state.get("events", [])[args.since :]
    result = {
        "ts": now_iso(),
        "since_index": args.since,
        "count": len(events),
        "events": events,
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_state(args) -> int:
    state = load_json(args.events)
    result = {
        "ts": now_iso(),
        "pid": state.get("pid"),
        "started_at": state.get("started_at"),
        "electron": state.get("electron"),
        "node": state.get("node"),
        "display": state.get("display"),
        "tooltip": state.get("tooltip"),
        "menu_items": state.get("menu_items"),
        "sni": state.get("sni"),
        "event_count": len(state.get("events", [])),
        "event_types": sorted({e.get("type") for e in state.get("events", [])}),
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# SNI properties (Electron's DBus object has no Introspect; gdbus works)
# ---------------------------------------------------------------------------

SNI_PROPS = ["Id", "Title", "ToolTip", "Status", "Category", "IconName", "Menu", "ItemIsMenu"]


def parse_gdbus_string(raw: str) -> str | None:
    # (<'value'>,) or (<('icon', @a(iiay) [], 'title', 'sub')>,)
    # ToolTip starts with an empty icon-name string, so use the first
    # non-empty quoted value rather than blindly taking matches[0].
    matches = re.findall(r"'((?:[^'\\]|\\.)*)'", raw)
    for value in matches:
        if value:
            return value.replace("\\'", "'")
    return None


def cmd_sni_props(args) -> int:
    item = args.item.strip()
    if "/" not in item:
        print(f"sni-props: expected service/object-path, got {item!r}", file=sys.stderr)
        return 2
    service, object_path = item.split("/", 1)
    object_path = "/" + object_path
    props = {}
    raw = {}
    for prop in SNI_PROPS:
        proc = run(
            [
                "gdbus",
                "call",
                "--session",
                "--dest",
                service,
                "--object-path",
                object_path,
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.kde.StatusNotifierItem",
                prop,
            ]
        )
        raw[prop] = {
            "exit": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }
        props[prop] = parse_gdbus_string(proc.stdout) if proc.returncode == 0 else None
    result = {
        "ts": now_iso(),
        "item": item,
        "service": service,
        "object_path": object_path,
        "properties": props,
        "raw": raw,
    }
    save_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# combine summary
# ---------------------------------------------------------------------------

def _read_optional(path: str):
    if os.path.exists(path):
        try:
            return load_json(path)
        except Exception:
            return None
    return None


def cmd_combine_summary(args) -> int:
    d = args.dir
    events = load_json(os.path.join(d, "task-6-tray-events.json"))
    summary = {
        "ts": now_iso(),
        "app": {
            "pid": events.get("pid"),
            "started_at": events.get("started_at"),
            "electron": events.get("electron"),
            "node": events.get("node"),
            "display": events.get("display"),
            "tooltip": events.get("tooltip"),
            "menu_items": events.get("menu_items"),
            "sni": events.get("sni"),
            "event_count": len(events.get("events", [])),
            "event_types": sorted({e.get("type") for e in events.get("events", [])}),
        },
        "run_meta": _read_optional(os.path.join(d, "task-6-tray-run-meta.json")),
        "sni": _read_optional(os.path.join(d, "task-6-tray-sni.json")),
        "panel_state": _read_optional(os.path.join(d, "task-6-tray-panel-state.json")),
        "icon": _read_optional(os.path.join(d, "task-6-tray-icon-location.json")),
        "tests": {},
        "dbus": _read_optional(os.path.join(d, "task-6-tray-dbus-actions.json")),
    }
    for name in ("left", "right", "right-item", "double", "dbus-activate", "dbus-secondary", "dbus-contextmenu"):
        summary["tests"][name] = {
            "events": _read_optional(os.path.join(d, f"task-6-tray-{name}-events.json")),
            "windows": _read_optional(os.path.join(d, f"task-6-tray-{name}-windows.json")),
            "menu_click": _read_optional(os.path.join(d, f"task-6-tray-{name}-menu-click.json")),
            "screenshot": os.path.join(d, f"task-6-tray-{name}.png"),
        }
    save_json(args.out, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("icon")
    p.add_argument("--image", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tolerance", type=float, default=40.0)
    p.add_argument("--min-pixels", type=int, default=20)
    p.add_argument("--min-size", type=int, default=8)
    p.add_argument("--max-size", type=int, default=64)
    p.add_argument("--panel-height", type=int, default=60)
    p.set_defaults(func=cmd_icon)

    p = sub.add_parser("snapshot-windows")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_snapshot_windows)

    p = sub.add_parser("diff-windows")
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_diff_windows)

    p = sub.add_parser("event-count")
    p.add_argument("--events", required=True)
    p.set_defaults(func=cmd_event_count)

    p = sub.add_parser("events")
    p.add_argument("--events", required=True)
    p.add_argument("--since", type=int, required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_events)

    p = sub.add_parser("state")
    p.add_argument("--events", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_state)

    p = sub.add_parser("sni-props")
    p.add_argument("--item", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_sni_props)

    p = sub.add_parser("combine-summary")
    p.add_argument("--dir", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_combine_summary)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
