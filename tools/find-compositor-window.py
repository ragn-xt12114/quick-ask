#!/usr/bin/env python3
"""Find the KWin compositor output window used for screen captures.

On this machine `import -window root` / `ffmpeg -f x11grab` (root) capture only
the root pixmap and MISS all composited windows (verified with xclock). KWin
renders the current desktop into a full-screen depth-32 top-level window; that
window is the correct capture target.

This helper prints the window id as 0x... on stdout. Exit 0 on success, 2 on
failure.

Requires python-xlib (available in the project venv).
"""

import sys

try:
    from Xlib import X, display
except Exception as exc:  # pragma: no cover
    print(f"find-compositor-window: python-xlib unavailable: {exc}", file=sys.stderr)
    sys.exit(2)


def main():
    d = display.Display()
    root = d.screen().root
    screen = d.screen()
    rw, rh = screen.width_in_pixels, screen.height_in_pixels

    fullscreen = []
    for win in root.query_tree().children:
        try:
            attr = win.get_attributes()
            geo = win.get_geometry()
        except Exception:
            continue
        if attr.map_state != X.IsViewable:
            continue
        if attr.override_redirect:
            continue
        if geo.width != rw or geo.height != rh:
            continue
        fullscreen.append((win, geo, attr))

    # KWin's workspace window is depth 32 and has a child inset below the
    # Plasma top panel (e.g. 1920x1057+0+23).
    def has_panel_inset(win):
        try:
            for child in win.query_tree().children:
                ca = child.get_attributes()
                cg = child.get_geometry()
                if ca.map_state == X.IsViewable and cg.y == 23 and cg.width == rw:
                    return True
        except Exception:
            return False
        return False

    preferred = [w for w, g, a in fullscreen if g.depth == 32 and has_panel_inset(w)]
    if preferred:
        win = preferred[0]
    else:
        depth32 = [w for w, g, a in fullscreen if g.depth == 32]
        if depth32:
            win = depth32[0]
        elif fullscreen:
            # Last-resort: the widest/tallest full-screen window.
            win = max(fullscreen, key=lambda item: (item[1].width * item[1].height, item[1].depth))[0]
        else:
            print("0x0")
            d.close()
            return 2

    print(hex(win.id))
    d.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
