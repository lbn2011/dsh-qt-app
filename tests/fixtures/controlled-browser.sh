#!/bin/sh
# Isolated browser used only by tests/webengine-chromium.e2e.ts.
#
# xdg-open (reached through the real QDesktopServices dispatch) launches this
# script via a throw-away desktop entry. It navigates the authenticated URL in
# a real Chromium, dumps the post-JavaScript DOM to DSH_E2E_DOM and exits. The
# URL is passed as a process argument and is never written to a file; only the
# rendered page (which does not echo the token) is persisted.
set -eu

: "${DSH_E2E_PROFILE:?DSH_E2E_PROFILE is required}"
: "${DSH_E2E_DOM:?DSH_E2E_DOM is required}"

browser="${DSH_E2E_BROWSER:-}"
if [ -z "$browser" ]; then
    for candidate in chromium google-chrome chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
            browser="$(command -v "$candidate")"
            break
        fi
    done
fi
[ -n "$browser" ] || { echo "no test browser found" >&2; exit 127; }

exec "$browser" \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --log-level=3 \
    --user-data-dir="$DSH_E2E_PROFILE" \
    --dump-dom "$1" >"$DSH_E2E_DOM" 2>/dev/null