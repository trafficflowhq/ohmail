#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════════
#  THE PUSH REGISTRATION IS NOT IN LOGCAT — asserted against the compiled dex
# ══════════════════════════════════════════════════════════════════════════════════════════
#
# `expo-unified-push`'s `ExpoUPService` logs the push registration at DEBUG level:
#
#     override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
#         val data = Bundle()
#         data.putString("url",    endpoint.url)
#         data.putString("pubKey", endpoint.pubKeySet?.pubKey)
#         data.putString("auth",   endpoint.pubKeySet?.auth)
#         Log.d(TAG, "sending \"registered\" action with data: $data")
#
# A Bundle's `toString()` prints its contents, so the device's distributor endpoint, its p256dh
# public key and — the one that matters — its RFC 8291 `auth` secret went to logcat on every
# registration, and into any bug report taken afterwards. `onMessage` has the same shape and logs
# the DECRYPTED payload.
#
# The library comes from npm and this APK is built with `npm ci`, which ignores
# `pnpm.patchedDependencies` — so a workspace patch would apply locally and silently NOT apply to
# the shipped binary. The fix is a build-time R8 strip (`assumenosideeffects` on `Log.d`/`Log.v`,
# apps/mobile/plugins/release-minification.js), and this is the check that it happened.
#
# ── WHY THE DEX, AND WHY STRINGS ──────────────────────────────────────────────────────────────
#
# The honest check would be "register a device and read logcat", and it is not available: the
# connector's `registerDevice` refuses on a machine with no UnifiedPush distributor installed, so
# an emulator cannot produce a real registration to leak. What CAN be asserted, and is stronger
# than one observed run, is that the call sites are not in the binary at all: R8 removes the
# `Log.d` invocation and then dead-code-eliminates the string concatenation that fed it, which
# takes the format literal out of the dex string pool with it. No call site, no leak, on any
# device, for any registration.
#
# ── THE GUARD ON THE GUARD, IN BOTH DIRECTIONS ────────────────────────────────────────────────
#
# A scan for an ABSENCE passes when the scan is broken, so two things must be PRESENT first, and
# they are chosen to fail on two different mistakes:
#
#  · `dev.djara.expounifiedpush.PAYLOAD_RENDERER` — a string constant inlined into
#    `ExpoUPService.resolvePayloadRenderer`. If this is missing, either the class is not in this
#    binary or the scan cannot see that class's strings, and every absence below would have
#    passed vacuously.
#
#  · `Error resolving custom PushPayloadRenderer: ` — a `Log.e` literal in the SAME CLASS as the
#    four stripped `Log.d` calls. This one is the check that the strip did not go too far. The
#    rule is deliberately scoped to DEBUG and VERBOSE so that warnings, errors and crash
#    diagnostics still reach logcat; widening it to all of `android.util.Log` would delete this
#    string too, and that is a silent loss of every error report the app can make. So it is red.
#
# Together they pin the rule at exactly the width it is supposed to have: `d` and `v` gone, `e`
# still there, both proven from the artifact rather than read off the rules file.
#
# ── NO `! producer | grep -q .` ───────────────────────────────────────────────────────────────
#
# That shape PASSES when the producer dies: `grep -q` exits the instant it has an answer, closing
# the pipe, the producer takes SIGPIPE, and under a leading `!` that death reads as "produced
# nothing". Every check here captures a COUNT into a variable and tests the variable.
set -euo pipefail

APK="${1:?usage: assert-log-hygiene.sh <path-to-apk>}"
test -f "$APK" || { echo "assert-log-hygiene: no APK at $APK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Portable file size. The workflow runs this on ubuntu (GNU `stat -c`), and it is also run by hand
# against a locally built APK on macOS (BSD `stat -f`) — which is the whole point of it being a
# script and not a workflow step. A guard nobody can run locally is a guard nobody watches fail.
fsize() {
  stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
}

# unzip's status is deliberately tolerated: it answers 11 for "no matching files", and under
# `set -e` that would abort with unzip's own `caution: filename not matched` as the only
# explanation. The extraction's success is established by the dex count, the size floor and the
# two canaries below, which say what is actually wrong.
unzip -o -q "$APK" 'classes*.dex' -d "$WORK" || true

DEX_COUNT=0
for f in "$WORK"/classes*.dex; do
  test -f "$f" || continue
  DEX_COUNT=$((DEX_COUNT + 1))
done
test "$DEX_COUNT" -ge 1 \
  || { echo "assert-log-hygiene: no classes*.dex came out of the APK — nothing was scanned" >&2; exit 1; }

cat "$WORK"/classes*.dex > "$WORK/all.dex"
DEX_BYTES=$(fsize "$WORK/all.dex")
test "$DEX_BYTES" -gt 1000000 \
  || { echo "assert-log-hygiene: only $DEX_BYTES bytes of dex — the extraction is not trustworthy" >&2; exit 1; }
echo "assert-log-hygiene: scanning $DEX_COUNT dex file(s), $DEX_BYTES bytes"

count_in_dex() {
  # `grep -c` prints a count and exits 1 on no match; `|| true` keeps `set -e` out of it so the
  # COUNT is what the assertion reads. `-a` because a dex is binary and this repository's `grep`
  # wrapper silently skips binary files otherwise — which is indistinguishable from "not found".
  /usr/bin/grep -a -c -F "$1" "$WORK/all.dex" || true
}

fail=0

# ── the two canaries: the scan works, and the strip is the right width ────────────────────────
require_present() {
  local label="$1" needle="$2" why="$3"
  local n
  n=$(count_in_dex "$needle")
  if [ "${n:-0}" -gt 0 ]; then
    echo "assert-log-hygiene: present — $label"
  else
    echo "assert-log-hygiene: MISSING $label" >&2
    echo "  looked for: $needle" >&2
    printf '  %s\n' "$why" >&2
    fail=1
  fi
}

require_present \
  "the connector's renderer meta-data key (the scan can see ExpoUPService's strings)" \
  'dev.djara.expounifiedpush.PAYLOAD_RENDERER' \
  "Either ExpoUPService is not in this binary or this scan cannot read its string pool. Every
  absence check below would have passed for the wrong reason. Fix the scan before trusting it."

require_present \
  "ExpoUPService's Log.e text (error logging SURVIVED the strip)" \
  'Error resolving custom PushPayloadRenderer: ' \
  "The strip is supposed to take DEBUG and VERBOSE only. This string is a Log.e in the same class
  as the four Log.d calls being removed, so its disappearance means the assumenosideeffects rule
  was widened past its scope — most likely to all of android.util.Log — and the app can no longer
  report its own errors or crashes to logcat. Narrow the rule in
  apps/mobile/plugins/release-minification.js back to d and v."

# ── and the absences: the leaking call sites ──────────────────────────────────────────────────
#
# All four `Log.d` literals from ExpoUPService. The first two are the leak — `registered` carries
# url/pubKey/auth, `message` carries the decrypted payload. The other two carry only a reason code
# and an instance id, and are asserted anyway: all four are the same rule's work, so a partial
# result means the strip did something other than what it says.
check_absent() {
  local label="$1" needle="$2"
  local n
  n=$(count_in_dex "$needle")
  if [ "${n:-0}" -gt 0 ]; then
    echo "assert-log-hygiene: FOUND $label — $n match line(s)" >&2
    echo "  the string is: $needle" >&2
    fail=1
  else
    echo "assert-log-hygiene: absent — $label"
  fi
}

check_absent "onNewEndpoint's Log.d (url + pubKey + the auth SECRET)" 'sending "registered" action with data: '
check_absent "onMessage's Log.d (the decrypted payload)"              'sending "message" action with data: '
check_absent "onUnregistered's Log.d"                                 'sending "unregistered" action with data: '
check_absent "onRegistrationFailed's Log.d"                           'sending "registrationFailed" action with data: '

test "$fail" -eq 0 || {
  echo "" >&2
  echo "Do not ship this APK." >&2
  echo "" >&2
  if [ "$(count_in_dex 'sending "registered" action with data: ')" != "0" ]; then
    echo "The connector's DEBUG log call sites are still in the binary, so a device's push" >&2
    echo "endpoint and its RFC 8291 auth secret reach logcat on every registration. The usual" >&2
    echo "cause is that minification is off: app/build.gradle reads" >&2
    echo "'android.enableMinifyInReleaseBuilds' and the strip rules do nothing without it." >&2
    echo "Check that apps/mobile/plugins/release-minification.js is listed in app.json's plugins" >&2
    echo "and that the generated android/gradle.properties carries the property as true." >&2
  fi
  exit 1
}

echo "assert-log-hygiene: OK — the connector's registration logging is not in this binary"
