/*
 * x11-grab-test — grab a key combination with XGrabKey and hold it.
 *
 * Usage: x11-grab-test 'ctrl+alt+space' [seconds]
 *
 * Prints GRABBED, holds the grab for the given number of seconds (default 5),
 * then prints UNGRABBED. Exits 2 (and prints an error) when the grab fails,
 * typically because another client already owns the combination (BadAccess).
 *
 * NumLock (Mod2Mask), CapsLock (LockMask) and both-lock variants are grabbed
 * alongside the base combination so the grab behaves like a real hotkey.
 */

#define _POSIX_C_SOURCE 200809L

#include <X11/Xlib.h>
#include <X11/keysym.h>

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#define EXIT_INTERNAL 1
#define EXIT_USAGE 2

static int x_error_seen;
static int x_error_code;

static int on_x_error(Display *dpy, XErrorEvent *event)
{
    (void)dpy;
    x_error_seen = 1;
    x_error_code = event->error_code;
    return 0;
}

static void usage(FILE *stream)
{
    fputs("Usage: x11-grab-test '<modifier>+<key>' [seconds]\n"
          "\n"
          "  Grabs the key combination with XGrabKey, prints GRABBED, holds for\n"
          "  [seconds] (default 5), then prints UNGRABBED.\n"
          "\n"
          "  Modifiers: ctrl/control, alt, shift, super/meta/win/logo.\n"
          "  Key names follow X keysym names, e.g. space, Return, F1, k.\n"
          "\n"
          "  Exit codes: 0 success, 1 internal failure, 2 usage or BadAccess.\n",
          stream);
}

static int parse_seconds(const char *text, int *seconds)
{
    char *end = NULL;
    long value;

    errno = 0;
    value = strtol(text, &end, 10);
    if (errno == ERANGE || end == text || *end != '\0' ||
        value < 0 || value > 86400) {
        return -1;
    }
    *seconds = (int)value;
    return 0;
}

static int parse_combo(const char *combo, unsigned int *modifiers, KeySym *key)
{
    char *copy = strdup(combo);
    char *save = NULL;
    char *token;
    unsigned int mask = 0;
    KeySym symbol = NoSymbol;

    if (copy == NULL) {
        return -1;
    }

    for (token = strtok_r(copy, "+", &save); token != NULL;
         token = strtok_r(NULL, "+", &save)) {
        if (strcasecmp(token, "ctrl") == 0 ||
            strcasecmp(token, "control") == 0) {
            mask |= ControlMask;
        } else if (strcasecmp(token, "alt") == 0) {
            mask |= Mod1Mask;
        } else if (strcasecmp(token, "shift") == 0) {
            mask |= ShiftMask;
        } else if (strcasecmp(token, "super") == 0 ||
                   strcasecmp(token, "meta") == 0 ||
                   strcasecmp(token, "win") == 0 ||
                   strcasecmp(token, "logo") == 0) {
            mask |= Mod4Mask;
        } else {
            if (symbol != NoSymbol) {
                free(copy);
                return -1;
            }
            symbol = XStringToKeysym(token);
            if (symbol == NoSymbol) {
                free(copy);
                return -1;
            }
        }
    }

    free(copy);

    if (symbol == NoSymbol) {
        return -1;
    }
    *modifiers = mask;
    *key = symbol;
    return 0;
}

int main(int argc, char **argv)
{
    const unsigned int lock_masks[] = {0, LockMask, Mod2Mask, LockMask | Mod2Mask};
    const size_t lock_mask_count = sizeof(lock_masks) / sizeof(lock_masks[0]);
    unsigned int modifiers = 0;
    KeySym symbol = NoSymbol;
    int seconds = 5;

    if (argc < 2 || strcmp(argv[1], "--help") == 0 ||
        strcmp(argv[1], "-h") == 0) {
        usage(argc < 2 ? stderr : stdout);
        return argc < 2 ? EXIT_USAGE : 0;
    }
    if (argc > 3) {
        usage(stderr);
        return EXIT_USAGE;
    }
    if (argc == 3 && parse_seconds(argv[2], &seconds) != 0) {
        fprintf(stderr, "x11-grab-test: invalid duration '%s'\n", argv[2]);
        return EXIT_USAGE;
    }
    if (parse_combo(argv[1], &modifiers, &symbol) != 0) {
        fprintf(stderr, "x11-grab-test: invalid key combination '%s'\n", argv[1]);
        return EXIT_USAGE;
    }

    Display *dpy = XOpenDisplay(NULL);
    if (dpy == NULL) {
        const char *display = getenv("DISPLAY");
        fprintf(stderr, "x11-grab-test: cannot open X display '%s'\n",
                display != NULL ? display : "");
        return EXIT_INTERNAL;
    }
    XSetErrorHandler(on_x_error);

    KeyCode keycode = XKeysymToKeycode(dpy, symbol);
    if (keycode == 0) {
        fprintf(stderr, "x11-grab-test: no keycode for keysym '%s'\n", argv[1]);
        XCloseDisplay(dpy);
        return EXIT_USAGE;
    }

    Window root = DefaultRootWindow(dpy);
    x_error_seen = 0;
    for (size_t i = 0; i < lock_mask_count; i++) {
        XGrabKey(dpy, keycode, modifiers | lock_masks[i], root, False,
                 GrabModeAsync, GrabModeAsync);
    }
    XSync(dpy, False);

    if (x_error_seen) {
        for (size_t i = 0; i < lock_mask_count; i++) {
            XUngrabKey(dpy, keycode, modifiers | lock_masks[i], root);
        }
        XSync(dpy, False);

        char error_text[128];
        XGetErrorText(dpy, x_error_code, error_text, (int)sizeof(error_text));
        fprintf(stderr,
                "x11-grab-test: could not grab '%s': X error %d (%s) — another"
                " client probably owns this combination\n",
                argv[1], x_error_code, error_text);
        XCloseDisplay(dpy);
        return EXIT_USAGE;
    }

    printf("GRABBED\n");
    fflush(stdout);

    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);

    for (;;) {
        while (XPending(dpy) > 0) {
            XEvent event;
            XNextEvent(dpy, &event);
        }

        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long elapsed_ms = (now.tv_sec - start.tv_sec) * 1000L +
                          (now.tv_nsec - start.tv_nsec) / 1000000L;
        long remaining_ms = (long)seconds * 1000L - elapsed_ms;
        if (remaining_ms <= 0) {
            break;
        }

        struct pollfd descriptor;
        descriptor.fd = ConnectionNumber(dpy);
        descriptor.events = POLLIN;
        descriptor.revents = 0;
        int polled = poll(&descriptor, 1, (int)remaining_ms);
        if (polled < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
    }

    for (size_t i = 0; i < lock_mask_count; i++) {
        XUngrabKey(dpy, keycode, modifiers | lock_masks[i], root);
    }
    XSync(dpy, False);

    printf("UNGRABBED\n");
    fflush(stdout);

    XCloseDisplay(dpy);
    return 0;
}
