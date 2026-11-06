/*
 * quickask-x11 — minimal X11 helper for QuickAsk (KDE Plasma 6 / X11).
 *
 * Subcommands:
 *   set-states <wid> [--dry-run]
 *   set-blur <wid> x,y,w,h[,x,y,w,h...] [--dry-run]
 *   clear-blur <wid> [--dry-run]
 *   set-input-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]
 *   query-input-shape <wid>
 *   set-bounding-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]
 *   query-bounding-shape <wid>
 *   remap-states <wid> [rects] [--dry-run]
 *   activate <wid> [timestamp] [--dry-run]
 *   query-compositing
 *
 * Exit codes: 0 success, 1 unexpected internal failure, 2 usage or X error.
 */

#define _POSIX_C_SOURCE 200809L

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/extensions/shape.h>

#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define EXIT_INTERNAL 1
#define EXIT_USAGE 2

#define PROP_STATE "_NET_WM_STATE"
#define PROP_BLUR "_KDE_NET_WM_BLUR_BEHIND_REGION"
#define PROP_ACTIVE_WINDOW "_NET_ACTIVE_WINDOW"
#define SELECTION_COMPOSITING "_NET_WM_CM_S0"

static int x_error_count;

static int on_x_error(Display *dpy, XErrorEvent *event)
{
    char error_text[256];
    char request_code[16];
    char request_text[128];
    char *space;

    XGetErrorText(dpy, event->error_code, error_text, (int)sizeof(error_text));
    space = strchr(error_text, ' ');
    if (space != NULL) {
        *space = '\0';
    }

    snprintf(request_code, sizeof(request_code), "%d", event->request_code);
    XGetErrorDatabaseText(dpy, "XRequest", request_code, "unknown request",
                          request_text, (int)sizeof(request_text));

    fprintf(stderr,
            "quickask-x11: X error %d (%s) on %s (resource 0x%lx)\n",
            event->error_code, error_text, request_text,
            (unsigned long)event->resourceid);

    x_error_count++;
    return 0;
}

static void *xmalloc(size_t size)
{
    void *ptr = malloc(size == 0 ? 1 : size);
    if (ptr == NULL) {
        fputs("quickask-x11: out of memory\n", stderr);
        exit(EXIT_INTERNAL);
    }
    return ptr;
}

static void *xrealloc(void *ptr, size_t size)
{
    void *resized = realloc(ptr, size == 0 ? 1 : size);
    if (resized == NULL) {
        fputs("quickask-x11: out of memory\n", stderr);
        exit(EXIT_INTERNAL);
    }
    return resized;
}

static char *xstrdup(const char *text)
{
    size_t length = strlen(text) + 1;
    char *copy = xmalloc(length);
    memcpy(copy, text, length);
    return copy;
}

struct name_list {
    char **items;
    size_t count;
    size_t capacity;
};

static void name_list_free(struct name_list *list)
{
    for (size_t i = 0; i < list->count; i++) {
        free(list->items[i]);
    }
    free(list->items);
    list->items = NULL;
    list->count = 0;
    list->capacity = 0;
}

static int name_list_contains(const struct name_list *list, const char *name)
{
    for (size_t i = 0; i < list->count; i++) {
        if (strcmp(list->items[i], name) == 0) {
            return 1;
        }
    }
    return 0;
}

static void name_list_add(struct name_list *list, const char *name)
{
    if (name_list_contains(list, name)) {
        return;
    }
    if (list->count == list->capacity) {
        size_t capacity = list->capacity == 0 ? 8 : list->capacity * 2;
        list->items = xrealloc(list->items, capacity * sizeof(*list->items));
        list->capacity = capacity;
    }
    list->items[list->count++] = xstrdup(name);
}

struct long_list {
    long *items;
    size_t count;
    size_t capacity;
};

static void long_list_free(struct long_list *list)
{
    free(list->items);
    list->items = NULL;
    list->count = 0;
    list->capacity = 0;
}

static void long_list_add(struct long_list *list, long value)
{
    if (list->count == list->capacity) {
        size_t capacity = list->capacity == 0 ? 16 : list->capacity * 2;
        list->items = xrealloc(list->items, capacity * sizeof(*list->items));
        list->capacity = capacity;
    }
    list->items[list->count++] = value;
}

/* Parses a comma/whitespace separated list of decimal integers. */
static int parse_int_argument(const char *argument, struct long_list *values)
{
    const char *cursor = argument;

    while (*cursor != '\0') {
        char *end = NULL;
        long value;

        while (*cursor == ',' || isspace((unsigned char)*cursor)) {
            cursor++;
        }
        if (*cursor == '\0') {
            break;
        }

        errno = 0;
        value = strtol(cursor, &end, 10);
        if (end == cursor || errno == ERANGE) {
            return -1;
        }
        if (*end != '\0' && *end != ',' && !isspace((unsigned char)*end)) {
            return -1;
        }
        long_list_add(values, value);
        cursor = end;
    }
    return 0;
}

static void print_long_values(const char *label, const long *values, size_t count)
{
    printf("%s=", label);
    for (size_t i = 0; i < count; i++) {
        if (i != 0) {
            putchar(',');
        }
        printf("%ld", values[i]);
    }
    putchar('\n');
}

static void usage(FILE *stream)
{
    fputs("Usage:\n"
          "  quickask-x11 set-states <wid> [--dry-run]\n"
          "  quickask-x11 set-blur <wid> x,y,w,h[,x,y,w,h...] [--dry-run]\n"
          "  quickask-x11 clear-blur <wid> [--dry-run]\n"
          "  quickask-x11 set-input-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "  quickask-x11 query-input-shape <wid>\n"
          "  quickask-x11 set-bounding-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "  quickask-x11 query-bounding-shape <wid>\n"
          "  quickask-x11 remap-states <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "  quickask-x11 activate <wid> [timestamp] [--dry-run]\n"
          "  quickask-x11 set-wm-class <wid> [instance] [class] [--dry-run]\n"
          "  quickask-x11 query-compositing\n"
          "  quickask-x11 --help\n"
          "\n"
          "Exit codes: 0 success, 1 internal failure, 2 usage or X error.\n",
          stream);
}

static void help(FILE *stream)
{
    fputs("quickask-x11 — native X11 helper for QuickAsk\n"
          "\n"
          "Subcommands:\n"
          "  set-states <wid> [--dry-run]\n"
          "      Merge _NET_WM_STATE_SKIP_TASKBAR, _NET_WM_STATE_SKIP_PAGER,\n"
          "      _KDE_NET_WM_STATE_SKIP_SWITCHER and _NET_WM_STATE_ABOVE into\n"
          "      _NET_WM_STATE (ATOM/32), preserving any existing atoms.\n"
          "      Prints: STATES=SKIP_TASKBAR,SKIP_PAGER,SKIP_SWITCHER,ABOVE\n"
          "\n"
          "  set-blur <wid> x,y,w,h[,x,y,w,h...] [--dry-run]\n"
          "      Replace _KDE_NET_WM_BLUR_BEHIND_REGION (CARDINAL/32) with one or\n"
          "      more window-relative device-pixel rectangles.\n"
          "      Prints: BLUR_REGION=<count> values\n"
          "\n"
          "  clear-blur <wid> [--dry-run]\n"
          "      Delete _KDE_NET_WM_BLUR_BEHIND_REGION (absent property is fine).\n"
          "      Prints: BLUR_REGION=cleared\n"
          "\n"
          "  set-input-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "      Set the X Shape input region to the union of the rectangles.\n"
          "      With no rectangles, reset the input shape to whole-window.\n"
          "      Prints: INPUT_SHAPE=<count> rects\n"
          "\n"
          "  query-input-shape <wid>\n"
          "      Read the ShapeInput rectangles with XShapeGetRectangles().\n"
          "      Prints: INPUT_SHAPE=<count> and RECTS=x,y,w,h;...\n"
          "      Exits 0 even when the input shape is empty (INPUT_SHAPE=0).\n"
          "\n"
          "  set-bounding-shape <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "      Set the X Shape bounding region (visibility and input clipping).\n"
          "      With no rectangles, reset ShapeBounding to the whole window.\n"
          "      Used by the compositor-off opaque fallback so 12px card gaps\n"
          "      are neither visible nor clickable.\n"
          "      Prints: BOUNDING_SHAPE=<count> rects\n"
          "\n"
          "  query-bounding-shape <wid>\n"
          "      Read ShapeBounding with XShapeGetRectangles().\n"
          "      Prints: BOUNDING_SHAPE=<count> and RECTS=x,y,w,h;...\n"
          "      Exits 0 even when the shape is the default (BOUNDING_SHAPE=0).\n"
          "\n"
          "  remap-states <wid> [x,y,w,h[,x,y,w,h...]] [--dry-run]\n"
          "      Force KWin to re-manage the window so it re-reads the skip atoms:\n"
          "      XUnmapWindow -> XSync -> merge _NET_WM_STATE -> XSync ->\n"
          "      XMapWindow -> XSync -> re-assert the property -> XSync.\n"
          "      KWin 6.3.6 reads skipTaskbar/skipPager/skipSwitcher only while\n"
          "      managing a window, so this is required after Electron maps it.\n"
          "      Optional rectangles also set the ShapeInput region in the same\n"
          "      helper invocation (fewer process launches on the show path).\n"
          "      Prints: REMAP_STATES=<atoms> and INPUT_SHAPE=<count>\n"
          "\n"
          "  activate <wid> [timestamp] [--dry-run]\n"
          "      Send _NET_ACTIVE_WINDOW to the root window with source=2 (pager).\n"
          "      Timestamp defaults to CurrentTime (0) with a warning; pass a real\n"
          "      X server timestamp (e.g. from xdotool) to satisfy focus stealing\n"
          "      prevention.\n"
          "      Prints: ACTIVATED=<wid> timestamp=<ts> source=2\n"
          "\n"
          "  set-wm-class <wid> [instance] [class] [--dry-run]\n"
          "      Write WM_CLASS (STRING/8) as instance\\0class\\0. Defaults to\n"
          "      quickask/quickask. Needed because Electron sets BrowserWindow\n"
          "      WM_CLASS from the executable name regardless of app.setName().\n"
          "      Prints: WM_CLASS=<instance>,<class>\n"
          "\n"
          "  query-compositing\n"
          "      Print COMPOSITING=1 when a compositing manager owns _NET_WM_CM_S0.\n"
          "      Always exits 0.\n"
          "\n"
          "Options:\n"
          "  --dry-run   Validate arguments and print resolved values without\n"
          "              writing any property or shape.\n"
          "  --help      Show this help.\n"
          "\n"
          "Window ids accept base-0 notation (e.g. 0x3a00007 or 60817415).\n",
          stream);
}

static int parse_window_id(const char *text, Window *window)
{
    char *end = NULL;
    unsigned long value;

    if (text == NULL || *text == '\0') {
        return -1;
    }

    errno = 0;
    value = strtoul(text, &end, 0);
    if (errno == ERANGE || end == text || *end != '\0') {
        return -1;
    }
    if (value == 0 || value > UINT32_MAX) {
        return -1;
    }

    *window = (Window)value;
    return 0;
}

static int check_window(Display *dpy, Window window)
{
    XWindowAttributes attributes;

    if (window == DefaultRootWindow(dpy)) {
        fputs("quickask-x11: refusing to operate on the root window\n", stderr);
        return -1;
    }

    XSync(dpy, False);
    x_error_count = 0;
    if (!XGetWindowAttributes(dpy, window, &attributes)) {
        fprintf(stderr, "quickask-x11: window 0x%lx does not exist or is not accessible\n",
                (unsigned long)window);
        return -1;
    }
    XSync(dpy, False);
    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: window 0x%lx does not exist or is not accessible\n",
                (unsigned long)window);
        return -1;
    }
    return 0;
}

/* Reads an ATOM/32 window property. Returns 0 (success/absent), -1 (bad type). */
static int read_atom_list(Display *dpy, Window window, Atom property,
                          Atom **out_atoms, unsigned long *out_count)
{
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long items = 0;
    unsigned long bytes_after = 0;
    unsigned char *data = NULL;
    int status;

    *out_atoms = NULL;
    *out_count = 0;
    if (property == None) {
        return 0;
    }

    status = XGetWindowProperty(dpy, window, property, 0, 0, False, XA_ATOM,
                                &actual_type, &actual_format, &items,
                                &bytes_after, &data);
    if (data != NULL) {
        XFree(data);
    }
    if (status != Success) {
        return -1;
    }
    if (actual_type == None) {
        return 0;
    }
    if (actual_type != XA_ATOM || actual_format != 32) {
        return -1;
    }

    if (bytes_after == 0) {
        return 0;
    }

    status = XGetWindowProperty(dpy, window, property, 0, (long)(bytes_after / 4),
                                False, XA_ATOM, &actual_type, &actual_format,
                                &items, &bytes_after, &data);
    if (status != Success) {
        if (data != NULL) {
            XFree(data);
        }
        return -1;
    }
    if (actual_type != XA_ATOM || actual_format != 32) {
        if (data != NULL) {
            XFree(data);
        }
        return -1;
    }

    Atom *atoms = xmalloc((items == 0 ? 1 : items) * sizeof(*atoms));
    long *raw = (long *)data;
    for (unsigned long i = 0; i < items; i++) {
        atoms[i] = (Atom)raw[i];
    }
    if (data != NULL) {
        XFree(data);
    }

    *out_atoms = atoms;
    *out_count = items;
    return 0;
}

static const char *display_state_name(const char *atom_name)
{
    static const char net_prefix[] = "_NET_WM_STATE_";
    static const char kde_prefix[] = "_KDE_NET_WM_STATE_";

    if (strncmp(atom_name, net_prefix, sizeof(net_prefix) - 1) == 0) {
        return atom_name + sizeof(net_prefix) - 1;
    }
    if (strncmp(atom_name, kde_prefix, sizeof(kde_prefix) - 1) == 0) {
        return atom_name + sizeof(kde_prefix) - 1;
    }
    return atom_name;
}

static void print_state_names(const char *label, const struct name_list *names)
{
    fputs(label, stdout);
    putchar('=');
    for (size_t i = 0; i < names->count; i++) {
        if (i != 0) {
            putchar(',');
        }
        fputs(display_state_name(names->items[i]), stdout);
    }
    putchar('\n');
}

/* Merge the four required atoms with whatever the window already carries. */
static int merge_state_names(Display *dpy, Window window, struct name_list *names)
{
    static const char *const desired[] = {
        "_NET_WM_STATE_SKIP_TASKBAR",
        "_NET_WM_STATE_SKIP_PAGER",
        "_KDE_NET_WM_STATE_SKIP_SWITCHER",
        "_NET_WM_STATE_ABOVE",
    };
    const size_t desired_count = sizeof(desired) / sizeof(desired[0]);
    Atom *existing = NULL;
    unsigned long existing_count = 0;
    Atom property = XInternAtom(dpy, PROP_STATE, True);

    if (property != None &&
        read_atom_list(dpy, window, property, &existing, &existing_count) != 0) {
        fprintf(stderr, "quickask-x11: failed to read %s: not an ATOM/32 property\n",
                PROP_STATE);
        return -1;
    }

    for (size_t i = 0; i < desired_count; i++) {
        name_list_add(names, desired[i]);
    }
    for (unsigned long i = 0; i < existing_count; i++) {
        char *atom_name = XGetAtomName(dpy, existing[i]);
        if (atom_name == NULL) {
            continue;
        }
        name_list_add(names, atom_name);
        XFree(atom_name);
    }

    free(existing);
    return 0;
}

static int write_state_names(Display *dpy, Window window,
                             const struct name_list *names)
{
    long *values = xmalloc(names->count * sizeof(*values));

    for (size_t i = 0; i < names->count; i++) {
        Atom atom = XInternAtom(dpy, names->items[i], False);
        if (atom == None) {
            fprintf(stderr, "quickask-x11: cannot intern atom %s\n",
                    names->items[i]);
            free(values);
            return -1;
        }
        values[i] = (long)atom;
    }

    x_error_count = 0;
    XChangeProperty(dpy, window, XInternAtom(dpy, PROP_STATE, False),
                    XA_ATOM, 32, PropModeReplace,
                    (unsigned char *)values, (int)names->count);
    XSync(dpy, False);
    free(values);

    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: failed to write %s on window 0x%lx\n",
                PROP_STATE, (unsigned long)window);
        return -1;
    }
    return 0;
}

static int cmd_set_states(Display *dpy, Window window, int dry_run)
{
    struct name_list names = {0};
    int result = EXIT_INTERNAL;

    if (merge_state_names(dpy, window, &names) != 0) {
        goto out;
    }
    if (!dry_run && write_state_names(dpy, window, &names) != 0) {
        goto out;
    }

    print_state_names("STATES", &names);

    if (dry_run) {
        fprintf(stderr,
                "quickask-x11: dry-run, would write %zu atoms to %s on window 0x%lx\n",
                names.count, PROP_STATE, (unsigned long)window);
    }
    result = EXIT_SUCCESS;

out:
    name_list_free(&names);
    return result;
}

static int client_list_contains(Display *dpy, Window target)
{
    Atom property = XInternAtom(dpy, "_NET_CLIENT_LIST", True);
    if (property == None) return -1;

    Atom actual_type = None;
    int actual_format = 0;
    unsigned long items = 0;
    unsigned long bytes_after = 0;
    unsigned char *data = NULL;
    int status = XGetWindowProperty(dpy, DefaultRootWindow(dpy), property, 0,
                                    4096, False, XA_WINDOW, &actual_type,
                                    &actual_format, &items, &bytes_after, &data);
    if (status != Success) {
        if (data != NULL) XFree(data);
        return -1;
    }

    int found = 0;
    if (actual_type == XA_WINDOW && actual_format == 32 && data != NULL) {
        Window *windows = (Window *)data;
        for (unsigned long i = 0; i < items; i++) {
            if (windows[i] == target) {
                found = 1;
                break;
            }
        }
    }
    if (data != NULL) XFree(data);
    return found;
}

static int wait_client_list(Display *dpy, Window target, int present, int timeout_ms)
{
    for (int elapsed = 0; elapsed <= timeout_ms; elapsed++) {
        int state = client_list_contains(dpy, target);
        if (state < 0) return -1;
        if ((present && state == 1) || (!present && state == 0)) return 1;
        struct timespec pause = {0, 1000000L};
        nanosleep(&pause, NULL);
    }
    return 0;
}

static int cmd_remap_states(Display *dpy, Window window, int dry_run)
{
    struct name_list names = {0};
    int result = EXIT_INTERNAL;

    if (merge_state_names(dpy, window, &names) != 0) {
        goto out;
    }

    if (dry_run) {
        print_state_names("REMAP_STATES", &names);
        fprintf(stderr,
                "quickask-x11: dry-run, would unmap/map window 0x%lx and re-assert"
                " %zu atoms in %s\n",
                (unsigned long)window, names.count, PROP_STATE);
        result = EXIT_SUCCESS;
        goto out;
    }

    /*
     * KWin only reads skipSwitcher/skipTaskbar/skipPager while managing the
     * window. Wait until KWin has actually managed this map (visible in
     * _NET_CLIENT_LIST); unmapping before that races Electron's own map and
     * the later manage pass reads a state without the skip atoms.
     */
    if (wait_client_list(dpy, window, 1, 100) < 0) {
        for (int attempt = 0; attempt < 50; attempt++) {
            XWindowAttributes attributes;
            if (!XGetWindowAttributes(dpy, window, &attributes) ||
                attributes.map_state != IsUnmapped) {
                break;
            }
            struct timespec pause = {0, 1000000L};
            nanosleep(&pause, NULL);
        }
    }

    /* 1. Unmap so KWin releases the managed client. */
    x_error_count = 0;
    XUnmapWindow(dpy, window);
    XSync(dpy, False);
    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: remap-states: XUnmapWindow failed for"
                        " window 0x%lx\n",
                (unsigned long)window);
        result = EXIT_USAGE;
        goto out;
    }

    /*
     * Wait for KWin to release the client before writing the atoms; a fixed
     * small settle is the fallback when _NET_CLIENT_LIST is unavailable.
     */
    if (wait_client_list(dpy, window, 0, 100) != 1) {
        long settle_ms = 10;
        const char *override = getenv("QUICKASK_REMAP_UNMAP_DELAY_MS");
        if (override != NULL) {
            long parsed = strtol(override, NULL, 10);
            if (parsed >= 0) settle_ms = parsed;
        }
        if (settle_ms > 0) {
            struct timespec settle = {settle_ms / 1000, (settle_ms % 1000) * 1000000L};
            nanosleep(&settle, NULL);
        }
    }

    /* 2. Merge/write while unmapped; KWin will read this during re-manage. */
    name_list_free(&names);
    if (merge_state_names(dpy, window, &names) != 0) {
        goto out;
    }
    if (write_state_names(dpy, window, &names) != 0) {
        result = EXIT_USAGE;
        goto out;
    }

    /* 3. Map again: KWin re-manages and reads the skip atoms. */
    x_error_count = 0;
    XMapWindow(dpy, window);
    XSync(dpy, False);
    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: remap-states: XMapWindow failed for"
                        " window 0x%lx\n",
                (unsigned long)window);
        result = EXIT_USAGE;
        goto out;
    }

    /* 4. Re-assert after map (Chromium/KWin may have rewritten the property). */
    name_list_free(&names);
    if (merge_state_names(dpy, window, &names) != 0) {
        goto out;
    }
    if (write_state_names(dpy, window, &names) != 0) {
        result = EXIT_USAGE;
        goto out;
    }

    print_state_names("REMAP_STATES", &names);
    result = EXIT_SUCCESS;

out:
    name_list_free(&names);
    return result;
}

static int parse_rectangles(char **arguments, int argument_count,
                            struct long_list *values, const char *command)
{
    for (int i = 0; i < argument_count; i++) {
        if (parse_int_argument(arguments[i], values) != 0) {
            fprintf(stderr, "quickask-x11: %s: invalid number in '%s'\n",
                    command, arguments[i]);
            return -1;
        }
    }
    if (values->count % 4 != 0) {
        fprintf(stderr, "quickask-x11: %s: %zu values is not a multiple of 4\n",
                command, values->count);
        return -1;
    }
    return 0;
}

static int cmd_set_blur(Display *dpy, Window window, char **arguments,
                        int argument_count, int dry_run)
{
    struct long_list values = {0};
    int result = EXIT_USAGE;

    if (parse_rectangles(arguments, argument_count, &values, "set-blur") != 0) {
        goto out;
    }
    if (values.count == 0) {
        fputs("quickask-x11: set-blur: expected at least one x,y,w,h quadruple\n",
              stderr);
        goto out;
    }

    for (size_t i = 0; i < values.count; i += 4) {
        for (size_t j = 0; j < 4; j++) {
            if (values.items[i + j] < 0) {
                fprintf(stderr,
                        "quickask-x11: set-blur: negative value %ld in quadruple %zu"
                        " (w/h must be non-negative)\n",
                        values.items[i + j], i / 4);
                goto out;
            }
            if ((unsigned long)values.items[i + j] > UINT32_MAX) {
                fprintf(stderr,
                        "quickask-x11: set-blur: value %ld in quadruple %zu exceeds"
                        " 32-bit CARDINAL range\n",
                        values.items[i + j], i / 4);
                goto out;
            }
        }
    }

    if (dry_run) {
        printf("BLUR_REGION=%zu values\n", values.count);
        print_long_values("BLUR_VALUES", values.items, values.count);
        fprintf(stderr,
                "quickask-x11: dry-run, would write %zu CARDINAL values to %s"
                " on window 0x%lx\n",
                values.count, PROP_BLUR, (unsigned long)window);
        result = EXIT_SUCCESS;
        goto out;
    }

    long *property_values = xmalloc(values.count * sizeof(*property_values));
    for (size_t i = 0; i < values.count; i++) {
        property_values[i] = (long)(uint32_t)values.items[i];
    }

    x_error_count = 0;
    XChangeProperty(dpy, window, XInternAtom(dpy, PROP_BLUR, False),
                    XA_CARDINAL, 32, PropModeReplace,
                    (unsigned char *)property_values, (int)values.count);
    XSync(dpy, False);
    free(property_values);

    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: failed to write %s on window 0x%lx\n",
                PROP_BLUR, (unsigned long)window);
        goto out;
    }

    printf("BLUR_REGION=%zu values\n", values.count);
    print_long_values("BLUR_VALUES", values.items, values.count);
    result = EXIT_SUCCESS;

out:
    long_list_free(&values);
    return result;
}

static int cmd_clear_blur(Display *dpy, Window window, int dry_run)
{
    Atom property = XInternAtom(dpy, PROP_BLUR, True);

    if (dry_run) {
        printf("BLUR_REGION=would-clear\n");
        fprintf(stderr, "quickask-x11: dry-run, would delete %s on window 0x%lx\n",
                PROP_BLUR, (unsigned long)window);
        return EXIT_SUCCESS;
    }

    if (property != None) {
        x_error_count = 0;
        XDeleteProperty(dpy, window, property);
        XSync(dpy, False);
        if (x_error_count != 0) {
            fprintf(stderr, "quickask-x11: failed to delete %s on window 0x%lx\n",
                    PROP_BLUR, (unsigned long)window);
            return EXIT_USAGE;
        }
    }

    printf("BLUR_REGION=cleared\n");
    return EXIT_SUCCESS;
}

static int cmd_set_input_shape(Display *dpy, Window window, char **arguments,
                               int argument_count, int dry_run)
{
    struct long_list values = {0};
    int result = EXIT_USAGE;
    int event_base = 0;
    int error_base = 0;

    if (parse_rectangles(arguments, argument_count, &values,
                         "set-input-shape") != 0) {
        goto out;
    }

    for (size_t i = 0; i < values.count; i++) {
        if (values.items[i] < 0 || values.items[i] > 32767) {
            fprintf(stderr,
                    "quickask-x11: set-input-shape: rectangle value %ld must be"
                    " within 0..32767\n",
                    values.items[i]);
            goto out;
        }
    }

    size_t rectangle_count = values.count / 4;

    if (dry_run) {
        printf("INPUT_SHAPE=%zu rects\n", rectangle_count);
        if (rectangle_count != 0) {
            print_long_values("INPUT_RECTS", values.items, values.count);
        }
        fprintf(stderr,
                "quickask-x11: dry-run, would %s the ShapeInput region on window"
                " 0x%lx with %zu rect(s)\n",
                rectangle_count == 0 ? "reset" : "set", (unsigned long)window,
                rectangle_count);
        result = EXIT_SUCCESS;
        goto out;
    }

    if (!XShapeQueryExtension(dpy, &event_base, &error_base)) {
        fputs("quickask-x11: X server does not support the Shape extension\n",
              stderr);
        result = EXIT_INTERNAL;
        goto out;
    }

    x_error_count = 0;
    if (rectangle_count == 0) {
        XShapeCombineMask(dpy, window, ShapeInput, 0, 0, None, ShapeSet);
    } else {
        XRectangle *rectangles =
            xmalloc(rectangle_count * sizeof(*rectangles));
        for (size_t i = 0; i < rectangle_count; i++) {
            rectangles[i].x = (short)values.items[4 * i];
            rectangles[i].y = (short)values.items[4 * i + 1];
            rectangles[i].width = (unsigned short)values.items[4 * i + 2];
            rectangles[i].height = (unsigned short)values.items[4 * i + 3];
        }
        XShapeCombineRectangles(dpy, window, ShapeInput, 0, 0, rectangles,
                                (int)rectangle_count, ShapeSet, Unsorted);
        free(rectangles);
    }
    XSync(dpy, False);

    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: failed to set ShapeInput on window 0x%lx\n",
                (unsigned long)window);
        goto out;
    }

    printf("INPUT_SHAPE=%zu rects\n", rectangle_count);
    if (rectangle_count != 0) {
        print_long_values("INPUT_RECTS", values.items, values.count);
    }
    result = EXIT_SUCCESS;

out:
    long_list_free(&values);
    return result;
}

static int cmd_query_input_shape(Display *dpy, Window window)
{
    int event_base = 0;
    int error_base = 0;
    int rectangle_count = 0;
    int ordering = 0;
    XRectangle *rectangles = NULL;

    if (!XShapeQueryExtension(dpy, &event_base, &error_base)) {
        fputs("quickask-x11: X server does not support the Shape extension\n",
              stderr);
        fputs("INPUT_SHAPE=0\nRECTS=\n", stdout);
        return EXIT_SUCCESS;
    }

    x_error_count = 0;
    rectangles = XShapeGetRectangles(dpy, window, ShapeInput, &rectangle_count,
                                     &ordering);
    XSync(dpy, False);

    if (rectangles == NULL) {
        printf("INPUT_SHAPE=0\nRECTS=\n");
        return EXIT_SUCCESS;
    }

    printf("INPUT_SHAPE=%d\n", rectangle_count);
    fputs("RECTS=", stdout);
    for (int i = 0; i < rectangle_count; i++) {
        if (i != 0) {
            putchar(';');
        }
        printf("%d,%d,%d,%d", rectangles[i].x, rectangles[i].y,
               rectangles[i].width, rectangles[i].height);
    }
    putchar('\n');

    XFree(rectangles);
    return EXIT_SUCCESS;
}

static int cmd_set_bounding_shape(Display *dpy, Window window, char **arguments,
                                  int argument_count, int dry_run)
{
    struct long_list values = {0};
    int result = EXIT_USAGE;
    int event_base = 0;
    int error_base = 0;

    if (parse_rectangles(arguments, argument_count, &values,
                         "set-bounding-shape") != 0) {
        goto out;
    }

    for (size_t i = 0; i < values.count; i++) {
        if (values.items[i] < 0 || values.items[i] > 32767) {
            fprintf(stderr,
                    "quickask-x11: set-bounding-shape: rectangle value %ld must be"
                    " within 0..32767\n",
                    values.items[i]);
            goto out;
        }
    }

    size_t rectangle_count = values.count / 4;

    if (dry_run) {
        printf("BOUNDING_SHAPE=%zu rects\n", rectangle_count);
        if (rectangle_count != 0) {
            print_long_values("BOUNDING_RECTS", values.items, values.count);
        }
        fprintf(stderr,
                "quickask-x11: dry-run, would %s the ShapeBounding region on"
                " window 0x%lx with %zu rect(s)\n",
                rectangle_count == 0 ? "reset" : "set", (unsigned long)window,
                rectangle_count);
        result = EXIT_SUCCESS;
        goto out;
    }

    if (!XShapeQueryExtension(dpy, &event_base, &error_base)) {
        fputs("quickask-x11: X server does not support the Shape extension\n",
              stderr);
        result = EXIT_INTERNAL;
        goto out;
    }

    x_error_count = 0;
    if (rectangle_count == 0) {
        XShapeCombineMask(dpy, window, ShapeBounding, 0, 0, None, ShapeSet);
    } else {
        XRectangle *rectangles =
            xmalloc(rectangle_count * sizeof(*rectangles));
        for (size_t i = 0; i < rectangle_count; i++) {
            rectangles[i].x = (short)values.items[4 * i];
            rectangles[i].y = (short)values.items[4 * i + 1];
            rectangles[i].width = (unsigned short)values.items[4 * i + 2];
            rectangles[i].height = (unsigned short)values.items[4 * i + 3];
        }
        XShapeCombineRectangles(dpy, window, ShapeBounding, 0, 0, rectangles,
                                (int)rectangle_count, ShapeSet, Unsorted);
        free(rectangles);
    }
    XSync(dpy, False);

    if (x_error_count != 0) {
        fprintf(stderr,
                "quickask-x11: failed to set ShapeBounding on window 0x%lx\n",
                (unsigned long)window);
        goto out;
    }

    printf("BOUNDING_SHAPE=%zu rects\n", rectangle_count);
    if (rectangle_count != 0) {
        print_long_values("BOUNDING_RECTS", values.items, values.count);
    }
    result = EXIT_SUCCESS;

out:
    long_list_free(&values);
    return result;
}

static int cmd_query_bounding_shape(Display *dpy, Window window)
{
    int event_base = 0;
    int error_base = 0;
    int rectangle_count = 0;
    int ordering = 0;
    XRectangle *rectangles = NULL;

    if (!XShapeQueryExtension(dpy, &event_base, &error_base)) {
        fputs("quickask-x11: X server does not support the Shape extension\n",
              stderr);
        fputs("BOUNDING_SHAPE=0\nRECTS=\n", stdout);
        return EXIT_SUCCESS;
    }

    x_error_count = 0;
    rectangles = XShapeGetRectangles(dpy, window, ShapeBounding,
                                     &rectangle_count, &ordering);
    XSync(dpy, False);

    if (rectangles == NULL) {
        printf("BOUNDING_SHAPE=0\nRECTS=\n");
        return EXIT_SUCCESS;
    }

    printf("BOUNDING_SHAPE=%d\n", rectangle_count);
    fputs("RECTS=", stdout);
    for (int i = 0; i < rectangle_count; i++) {
        if (i != 0) {
            putchar(';');
        }
        printf("%d,%d,%d,%d", rectangles[i].x, rectangles[i].y,
               rectangles[i].width, rectangles[i].height);
    }
    putchar('\n');

    XFree(rectangles);
    return EXIT_SUCCESS;
}

static int parse_timestamp(const char *argument, unsigned long *timestamp,
                           int *timestamp_missing)
{
    char *end = NULL;
    unsigned long value;

    *timestamp = 0;
    *timestamp_missing = 0;

    if (argument == NULL || strcmp(argument, "-1") == 0) {
        *timestamp_missing = 1;
        return 0;
    }
    if (argument[0] == '-') {
        return -1;
    }

    errno = 0;
    value = strtoul(argument, &end, 0);
    if (errno == ERANGE || end == argument || *end != '\0' ||
        value > UINT32_MAX) {
        return -1;
    }
    *timestamp = value;
    return 0;
}

static int cmd_activate(Display *dpy, Window window, const char *timestamp_text,
                        int dry_run)
{
    unsigned long timestamp = 0;
    int timestamp_missing = 0;
    XEvent event;

    if (parse_timestamp(timestamp_text, &timestamp, &timestamp_missing) != 0) {
        fprintf(stderr,
                "quickask-x11: activate: invalid timestamp '%s' (expected"
                " unsigned 32-bit, base 0, or -1)\n",
                timestamp_text);
        return EXIT_USAGE;
    }
    if (timestamp_missing) {
        fputs("quickask-x11: warning: no X server timestamp supplied, using"
              " CurrentTime (0); window managers may reject the activation"
              " request\n",
              stderr);
    }

    if (dry_run) {
        printf("ACTIVATE=0x%lx timestamp=%lu source=2\n",
               (unsigned long)window, timestamp);
        fprintf(stderr,
                "quickask-x11: dry-run, would send _NET_ACTIVE_WINDOW for window"
                " 0x%lx with timestamp %lu\n",
                (unsigned long)window, timestamp);
        return EXIT_SUCCESS;
    }

    Atom message_type = XInternAtom(dpy, PROP_ACTIVE_WINDOW, False);
    if (message_type == None) {
        fprintf(stderr, "quickask-x11: cannot intern atom %s\n",
                PROP_ACTIVE_WINDOW);
        return EXIT_USAGE;
    }

    memset(&event, 0, sizeof(event));
    event.xclient.type = ClientMessage;
    event.xclient.send_event = True;
    event.xclient.display = dpy;
    event.xclient.window = window;
    event.xclient.message_type = message_type;
    event.xclient.format = 32;
    event.xclient.data.l[0] = 2; /* source: pager */
    event.xclient.data.l[1] = (long)timestamp;
    event.xclient.data.l[2] = CurrentTime;
    event.xclient.data.l[3] = 0;
    event.xclient.data.l[4] = 0;

    x_error_count = 0;
    XSendEvent(dpy, DefaultRootWindow(dpy), False,
               SubstructureRedirectMask | SubstructureNotifyMask, &event);
    XSync(dpy, False);

    if (x_error_count != 0) {
        fprintf(stderr, "quickask-x11: failed to send %s for window 0x%lx\n",
                PROP_ACTIVE_WINDOW, (unsigned long)window);
        return EXIT_USAGE;
    }

    printf("ACTIVATED=0x%lx timestamp=%lu source=2\n",
           (unsigned long)window, timestamp);
    return EXIT_SUCCESS;
}

static int cmd_set_wm_class(Display *dpy, Window window, char **arguments,
                            int argument_count, int dry_run)
{
    const char *instance = argument_count >= 1 ? arguments[0] : "quickask";
    const char *klass = argument_count >= 2 ? arguments[1] : instance;
    size_t instance_length = strlen(instance);
    size_t class_length = strlen(klass);
    size_t total = instance_length + 1 + class_length + 1;
    unsigned char *buffer = xmalloc(total);

    memcpy(buffer, instance, instance_length);
    buffer[instance_length] = '\0';
    memcpy(buffer + instance_length + 1, klass, class_length);
    buffer[instance_length + 1 + class_length] = '\0';

    if (!dry_run) {
        x_error_count = 0;
        XChangeProperty(dpy, window, XInternAtom(dpy, "WM_CLASS", False),
                        XA_STRING, 8, PropModeReplace, buffer, (int)total);
        XSync(dpy, False);
        if (x_error_count != 0) {
            fprintf(stderr,
                    "quickask-x11: failed to write WM_CLASS on window 0x%lx\n",
                    (unsigned long)window);
            free(buffer);
            return EXIT_USAGE;
        }
    }

    printf("WM_CLASS=%s,%s\n", instance, klass);
    if (dry_run) {
        fprintf(stderr,
                "quickask-x11: dry-run, would write WM_CLASS on window 0x%lx\n",
                (unsigned long)window);
    }
    free(buffer);
    return EXIT_SUCCESS;
}

static int cmd_query_compositing(Display *dpy)
{
    Atom selection = XInternAtom(dpy, SELECTION_COMPOSITING, True);
    int compositing = 0;

    if (selection != None) {
        x_error_count = 0;
        Window owner = XGetSelectionOwner(dpy, selection);
        XSync(dpy, False);
        if (x_error_count == 0 && owner != None) {
            compositing = 1;
        }
    }

    printf("COMPOSITING=%d\n", compositing);
    return EXIT_SUCCESS;
}

static int command_kind(const char *name)
{
    static const char *const commands[] = {
        "set-states", "set-blur", "clear-blur",
        "set-input-shape", "activate", "query-compositing",
        "set-wm-class", "remap-states", "query-input-shape",
        "set-bounding-shape", "query-bounding-shape",
    };
    const size_t count = sizeof(commands) / sizeof(commands[0]);

    for (size_t i = 0; i < count; i++) {
        if (strcmp(name, commands[i]) == 0) {
            return (int)i;
        }
    }
    return -1;
}

int main(int argc, char **argv)
{
    int dry_run = 0;
    int remaining_count = 0;
    char **remaining = xmalloc((size_t)(argc > 0 ? argc : 1) * sizeof(*remaining));
    int result;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help(stdout);
            free(remaining);
            return EXIT_SUCCESS;
        }
        if (strcmp(argv[i], "--dry-run") == 0) {
            dry_run = 1;
            continue;
        }
        remaining[remaining_count++] = argv[i];
    }

    if (remaining_count == 0) {
        usage(stderr);
        free(remaining);
        return EXIT_USAGE;
    }

    const char *command = remaining[0];
    int kind = command_kind(command);
    if (kind < 0) {
        fprintf(stderr, "quickask-x11: unknown command '%s'\n", command);
        usage(stderr);
        free(remaining);
        return EXIT_USAGE;
    }

    if (kind == 5) { /* query-compositing */
        if (remaining_count != 1) {
            fputs("quickask-x11: query-compositing takes no arguments\n", stderr);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
    } else {
        if (remaining_count < 2) {
            fprintf(stderr, "quickask-x11: %s: missing <wid>\n", command);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
        if ((strcmp(command, "set-states") == 0 ||
             strcmp(command, "clear-blur") == 0 ||
             strcmp(command, "query-input-shape") == 0 ||
             strcmp(command, "query-bounding-shape") == 0) &&
            remaining_count != 2) {
            fprintf(stderr, "quickask-x11: %s: expected exactly one <wid>\n",
                    command);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
        if (strcmp(command, "set-blur") == 0 && remaining_count < 3) {
            fputs("quickask-x11: set-blur: missing rectangle list\n", stderr);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
        if (strcmp(command, "activate") == 0 && remaining_count > 3) {
            fputs("quickask-x11: activate: too many arguments\n", stderr);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
        if (strcmp(command, "set-wm-class") == 0 && remaining_count > 4) {
            fputs("quickask-x11: set-wm-class: too many arguments\n", stderr);
            usage(stderr);
            free(remaining);
            return EXIT_USAGE;
        }
    }

    Display *dpy = XOpenDisplay(NULL);
    if (dpy == NULL) {
        const char *display = getenv("DISPLAY");
        fprintf(stderr, "quickask-x11: cannot open X display '%s'\n",
                display != NULL ? display : "");
        free(remaining);
        return EXIT_INTERNAL;
    }
    XSetErrorHandler(on_x_error);

    if (kind == 5) {
        result = cmd_query_compositing(dpy);
    } else {
        Window window = None;
        if (parse_window_id(remaining[1], &window) != 0) {
            fprintf(stderr,
                    "quickask-x11: invalid window id '%s' (expected unsigned"
                    " 32-bit, base 0, non-zero)\n",
                    remaining[1]);
            XCloseDisplay(dpy);
            free(remaining);
            return EXIT_USAGE;
        }
        if (check_window(dpy, window) != 0) {
            XCloseDisplay(dpy);
            free(remaining);
            return EXIT_USAGE;
        }

        switch (kind) {
        case 0:
            result = cmd_set_states(dpy, window, dry_run);
            break;
        case 1:
            result = cmd_set_blur(dpy, window, &remaining[2],
                                  remaining_count - 2, dry_run);
            break;
        case 2:
            result = cmd_clear_blur(dpy, window, dry_run);
            break;
        case 3:
            result = cmd_set_input_shape(dpy, window, &remaining[2],
                                         remaining_count - 2, dry_run);
            break;
        case 4:
            result = cmd_activate(dpy, window,
                                  remaining_count >= 3 ? remaining[2] : NULL,
                                  dry_run);
            break;
        case 6:
            result = cmd_set_wm_class(dpy, window, &remaining[2],
                                      remaining_count - 2, dry_run);
            break;
        case 7:
            result = cmd_remap_states(dpy, window, dry_run);
            if (result == EXIT_SUCCESS && remaining_count > 2) {
                result = cmd_set_input_shape(dpy, window, &remaining[2],
                                             remaining_count - 2, dry_run);
            }
            break;
        case 8:
            result = cmd_query_input_shape(dpy, window);
            break;
        case 9:
            result = cmd_set_bounding_shape(dpy, window, &remaining[2],
                                            remaining_count - 2, dry_run);
            break;
        case 10:
            result = cmd_query_bounding_shape(dpy, window);
            break;
        default:
            result = EXIT_INTERNAL;
            break;
        }
    }

    XCloseDisplay(dpy);
    free(remaining);
    return result;
}
