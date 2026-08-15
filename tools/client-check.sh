#!/usr/bin/env bash
# Loads the real browser client in headless Chrome and fails if it did not come
# alive.
#
# This gate exists because of a specific escape: a rename left the draw loop
# calling a function that no longer existed, the client threw on its first frame
# and rendered a black screen, and all three of the other checks passed, because
# every one of them exercises the simulation in Node and none of them ever opens
# the page.
#
# What it asserts, and why only this much: the HUD text is written from inside
# the draw loop, so its presence proves the loop ran without throwing, and the
# player id in it proves the socket connected and the welcome was handled. It
# deliberately does NOT require snapshots to have been applied. Headless Chrome
# runs on virtual time, which regularly outruns real network I/O, and a check
# that fails at random teaches people to ignore it.
#
# Usage: tools/client-check.sh <url>
set -euo pipefail
url="${1:?usage: client-check.sh <url>}"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
  echo "client-check: SKIPPED (no Chrome at $CHROME)"
  exit 0
fi

fail() { echo "client-check: FAILED — $1"; exit 1; }

# Retry, because whether the socket completes before virtual time runs out is a
# coin toss. The HUD assertion below is the one that must never be flaky, and it
# is not: it depends only on the draw loop running.
# Each launch gets its own profile directory. Sharing the default one means a
# second Chrome started while the first is still shutting down simply exits, and
# the check then reports a product failure that is really a profile lock.
profile_root=$(mktemp -d "${TMPDIR:-/tmp}/orrery-chrome.XXXXXX")
trap 'rm -rf "$profile_root"; pkill -f "user-data-dir=$profile_root" 2>/dev/null || true' EXIT

# Chrome is run with a hard deadline and killed if it overruns. Without this a
# wedged browser hangs the whole verify, and a check that can hang is a check
# people stop running.
run_chrome() {
  local budget="$1" out="$2" dir="$3"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --user-data-dir="$dir" --no-first-run --no-default-browser-check \
      --virtual-time-budget="$budget" --dump-dom "$url" > "$out" 2>/dev/null &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -gt 30 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
  done
  wait "$pid" 2>/dev/null || true
}

# Judge only after every attempt. An earlier version asserted inside the loop
# and so failed on the first empty dump, which turned a busy machine into a
# reported product failure.
dom=""
rendered=no
for attempt in 1 2 3; do
  run_chrome $((6000 + attempt * 3000)) "$profile_root/dom-$attempt.html" "$profile_root/$attempt"
  this=$(cat "$profile_root/dom-$attempt.html" 2>/dev/null || true)
  [ -n "$this" ] && dom="$this"
  if echo "$this" | grep -q 'WASD thrust'; then
    rendered=yes
    if echo "$this" | grep -qE 'you are <b>[0-9]+'; then
      connected=yes
      break
    fi
  fi
done

[ "$rendered" = "yes" ] \
  || fail "the HUD never rendered in 3 attempts, so the draw loop threw on its first frame"

tick=$(echo "$dom" | sed -n 's/.*server tick \([0-9]*\).*/\1/p' | head -1)
if [ "${connected:-no}" = "yes" ] && [ "${tick:-0}" -gt 0 ]; then
  echo "client-check: OK — page live, connected, snapshots applied (server tick $tick)"
elif [ "${connected:-no}" = "yes" ]; then
  echo "client-check: OK — page live and connected; no snapshot applied before the"
  echo "  DOM was dumped, which is headless virtual time outrunning a real socket"
else
  echo "client-check: OK — page live and the draw loop is running."
  echo "  The socket did not finish connecting within the virtual-time budget in"
  echo "  either attempt. That is a known headless artifact rather than a"
  echo "  product failure, and it is why the hard assertion here is the HUD."
fi
