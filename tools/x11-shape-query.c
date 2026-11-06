/*
 * x11-shape-query — read-only ShapeInput/ShapeBounding inspector.
 *
 * xwininfo -shape does NOT report ShapeInput; this small tool calls
 * XShapeGetRectangles directly so Task-3 evidence can assert the input
 * shape equals the card rectangle.
 *
 * Build:
 *   gcc -O2 -Wall -Wextra -o .omo/evidence/x11-shape-query \
 *       tools/x11-shape-query.c -lX11 -lXext
 */

#include <X11/Xlib.h>
#include <X11/extensions/shape.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

static int dump_rects(Display *dpy, Window window, int kind, const char *name)
{
    int count = 0;
    int ordering = 0;
    XRectangle *rects = XShapeGetRectangles(dpy, window, kind, &count, &ordering);
    if (rects == NULL) {
        printf("%s_ERROR=query-failed\n", name);
        return -1;
    }
    printf("%s_COUNT=%d\n", name, count);
    printf("%s_ORDERING=%d\n", name, ordering);
    for (int i = 0; i < count; i++) {
        printf("%s_RECT=%d,%d,%u,%u\n", name, rects[i].x, rects[i].y,
               rects[i].width, rects[i].height);
    }
    XFree(rects);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s <wid>\n", argv[0]);
        return 2;
    }

    char *end = NULL;
    errno = 0;
    unsigned long wid = strtoul(argv[1], &end, 0);
    if (errno != 0 || end == argv[1] || *end != '\0' || wid == 0) {
        fprintf(stderr, "x11-shape-query: invalid window id '%s'\n", argv[1]);
        return 2;
    }

    Display *dpy = XOpenDisplay(NULL);
    if (dpy == NULL) {
        fprintf(stderr, "x11-shape-query: cannot open DISPLAY\n");
        return 1;
    }

    int event_base = 0;
    int error_base = 0;
    if (!XShapeQueryExtension(dpy, &event_base, &error_base)) {
        fprintf(stderr, "x11-shape-query: SHAPE extension unavailable\n");
        XCloseDisplay(dpy);
        return 1;
    }

    Window window = (Window)wid;
    XWindowAttributes attr;
    if (!XGetWindowAttributes(dpy, window, &attr)) {
        fprintf(stderr, "x11-shape-query: cannot read window 0x%lx\n", wid);
        XCloseDisplay(dpy);
        return 2;
    }

    printf("WID=0x%lx\n", wid);
    printf("GEOMETRY=%dx%d+%d+%d\n", attr.width, attr.height, attr.x, attr.y);
    printf("MAP_STATE=%d\n", attr.map_state);
    printf("OVERRIDE_REDIRECT=%d\n", attr.override_redirect);

    dump_rects(dpy, window, ShapeBounding, "SHAPE_BOUNDING");
    dump_rects(dpy, window, ShapeInput, "SHAPE_INPUT");

    XCloseDisplay(dpy);
    return 0;
}
