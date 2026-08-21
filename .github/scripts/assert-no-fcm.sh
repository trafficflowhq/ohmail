#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════════
#  NO GOOGLE PUSH CODE IN THE APK — asserted against the compiled dex, not the configuration
# ══════════════════════════════════════════════════════════════════════════════════════════
#
# The app wakes through a UnifiedPush distributor the user chose. `expo-unified-push` also declares
# an EMBEDDED Firebase Cloud Messaging distributor, and a config plugin
# (apps/mobile/plugins/without-embedded-fcm.js) excludes that artifact at the Gradle level.
#
# This checks the RESULT. A build-time exclusion that silently stops applying — an Expo template
# change, a dependency bump, somebody deleting a plugin they did not recognise — would put an FCM
# client back inside a product whose central claim is that no Google or Apple push service stands
# between a person's mailbox and their phone. That is a claim about the binary, so the binary is what
# gets asked.
#
# ── WHY THE DEX AND NOT THE ZIP LISTING ───────────────────────────────────────────────────────
#
# `unzip -l app-release.apk | grep com/google/firebase` finds nothing on EVERY Android app ever
# built, because compiled classes do not appear as zip entries — they live inside `classes*.dex`. A
# zip-listing grep is therefore a guard that can never be red, which is worse than no guard: it
# reads as coverage. So the dex files are extracted and their bytes searched for the type
# descriptors themselves.
#
# ── THE GUARD ON THE GUARD ────────────────────────────────────────────────────────────────────
#
# A scan for an ABSENCE passes when the scan is broken. So before asserting that anything is
# missing, this asserts that the thing that MUST be present is findable by exactly the same method:
# the UnifiedPush connector's own descriptors. If the extraction produced nothing, or dex stores
# these strings differently than assumed, the connector check fails first and the absences are never
# reported as clean.
#
# ── NO `! producer | grep -q .` ───────────────────────────────────────────────────────────────
#
# That shape PASSES when the producer dies: `grep -q` exits the instant it has an answer, closing
# the pipe, the producer takes SIGPIPE, and under a leading `!` that death reads as "produced
# nothing". It is size-dependent, so it looks like flakiness rather than a defect. Every check here
# captures into a variable and tests the variable.
set -euo pipefail

APK="${1:?usage: assert-no-fcm.sh <path-to-apk>}"
test -f "$APK" || { echo "assert-no-fcm: no APK at $APK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# `-o` so a re-run overwrites, `-q` because the listing is noise.
#
# unzip's status is DELIBERATELY tolerated here — it answers 11 for "no matching files", and under
# `set -e` that would abort with unzip's own `caution: filename not matched` as the only explanation
# of a failed release build. The extraction's success is established by the checks below (a dex
# count, a size floor, and the connector's presence), which say what is actually wrong. Measured:
# an APK containing no dex exited 11 with no diagnostic of ours before this line tolerated it.
unzip -o -q "$APK" 'classes*.dex' -d "$WORK" || true

DEX_COUNT=0
for f in "$WORK"/classes*.dex; do
  test -f "$f" || continue
  DEX_COUNT=$((DEX_COUNT + 1))
done
test "$DEX_COUNT" -ge 1 \
  || { echo "assert-no-fcm: no classes*.dex came out of the APK — nothing was scanned" >&2; exit 1; }

cat "$WORK"/classes*.dex > "$WORK/all.dex"
DEX_BYTES=$(stat -c%s "$WORK/all.dex")
# A floor, so a truncated or empty extraction cannot pass the absence checks. A release APK's dex is
# several megabytes; one megabyte is a generous floor that still catches "nothing came out".
test "$DEX_BYTES" -gt 1000000 \
  || { echo "assert-no-fcm: only $DEX_BYTES bytes of dex — the extraction is not trustworthy" >&2; exit 1; }
echo "assert-no-fcm: scanning $DEX_COUNT dex file(s), $DEX_BYTES bytes"

# ── the guard on the guard: what we DO ship must be findable this way ─────────────────────────
# `grep -c` prints a count and exits 1 on no match, so `|| true` keeps `set -e` out of it and the
# COUNT is what the assertion reads.
CONNECTOR=$(/usr/bin/grep -a -c -F 'Lorg/unifiedpush/android/connector/' "$WORK/all.dex" || true)
test "${CONNECTOR:-0}" -gt 0 || {
  echo "assert-no-fcm: the UnifiedPush CONNECTOR was not found in the dex either." >&2
  echo "  This means the scan is broken, not that the APK is clean — every absence check below" >&2
  echo "  would have passed vacuously. Fix the scan before trusting it." >&2
  exit 1
}
echo "assert-no-fcm: connector present ($CONNECTOR match line(s)) — the scan works"

# ── and now the absences ──────────────────────────────────────────────────────────────────────
fail=0
check_absent() {
  local label="$1" needle="$2"
  local n
  n=$(/usr/bin/grep -a -c -F "$needle" "$WORK/all.dex" || true)
  if [ "${n:-0}" -gt 0 ]; then
    echo "assert-no-fcm: FOUND $label ($needle) in the APK's dex — $n match line(s)." >&2
    fail=1
  else
    echo "assert-no-fcm: absent — $label"
  fi
}

# The decisive one: firebase-messaging is what the embedded distributor pulls in.
check_absent "Firebase" 'Lcom/google/firebase/'
# The embedded distributor itself.
check_absent "the embedded UnifiedPush FCM distributor" 'Lorg/unifiedpush/android/embedded_fcm_distributor/'
# Play Services messaging, which firebase-messaging depends on. Scoped to the messaging package
# rather than all of `com/google/android/gms` — other Play Services artifacts can arrive through
# unrelated libraries and banning the whole namespace would be a rule about the wrong thing.
check_absent "Play Services messaging" 'Lcom/google/android/gms/cloudmessaging/'
check_absent "Firebase Installations" 'Lcom/google/firebase/installations/'

test "$fail" -eq 0 || {
  echo "" >&2
  echo "The Gradle exclusion in apps/mobile/plugins/without-embedded-fcm.js is not taking effect." >&2
  echo "Do not ship this APK: the app's copy and its privacy census both state that no Google" >&2
  echo "push service is in the path, and this binary would make that false." >&2
  exit 1
}

echo "assert-no-fcm: OK — no Google push code in the binary"
