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
    # NAME THE CLASSES, do not just count them. A count says "something is wrong" and leaves the
    # next person to rebuild a 137 MB APK to find out what; the descriptors say WHICH code it is,
    # which is the difference between deciding and guessing. Measured: the first real run of this
    # guard reported three matches for the Firebase prefix while the embedded distributor, Play
    # Services messaging and Firebase Installations were all absent — so the question was never
    # "is the exclusion working" but "what else in the graph names Firebase", and a count could not
    # answer it.
    local found
    found=$(/usr/bin/grep -a -o "${needle}[A-Za-z0-9_/$;]*" "$WORK/all.dex" | sort -u || true)
    if [ -n "$found" ]; then
      echo "  the descriptors present are:" >&2
      printf '    %s\n' $found >&2
    fi
    fail=1
  else
    echo "assert-no-fcm: absent — $label"
  fi
}

# ── THE FIREBASE NAMESPACE, BY ALLOW-LIST ────────────────────────────────────────────────────
#
# This was a blanket ban on `Lcom/google/firebase/`, and its first run against a real APK reported
# three matches. Naming them (the reason this script prints descriptors) showed what they are:
#
#   com/google/firebase/annotations     @DeferredApi — a marker annotation
#   com/google/firebase/components      the dependency-injection container: Component,
#                                       ComponentRuntime, ComponentDiscovery, CycleDetector, Lazy
#   com/google/firebase/dynamicloading  the ComponentLoader interface
#   com/google/firebase/encoders        the value/JSON encoder library
#   com/google/firebase/events          the in-process publisher/subscriber the container uses
#   com/google/firebase/inject          the Provider / Deferred interfaces
#   plus three exception types: FirebaseException, FirebaseApiNotAvailableException,
#   FirebaseExceptionMapper
#
# That is a DI container and a serialiser. There is no push client in it, no network client, and —
# the fact that settles it — **no `FirebaseApp`**, which is the class that initialises Firebase at
# all. Verified absent in the same scan. Without it these classes are never wired to anything; they
# are unreachable library code that an AndroidX/Expo transitive drags along. (Which artifact
# exactly is not pinned here, and the allow-list below is what makes that not matter.)
#
# So the ban is narrowed to an ALLOW-LIST rather than deleted, and the difference is the whole
# point: every `com/google/firebase/<package>` found in the dex must be one of the inert ones named
# above. A NEW Firebase package arriving — messaging, installations, iid, analytics, crashlytics,
# anything — is a failure, whatever it is called. That keeps this red on "Firebase grew" while not
# being permanently red on infrastructure that does nothing.
#
# The push-specific packages are ALSO checked individually below, so they fail twice: once here as
# unlisted, once by name with a message that says what they are. Belt and braces on the one thing
# this script exists for.
# ── EXACT CLASSES, NOT PACKAGES ──────────────────────────────────────────────────────────────
#
# The first version of this allow-list permitted whole PACKAGES, and review caught that it was
# weaker than the blanket ban it replaced in the one direction that matters: a new executable class
# inside an allowed package — `com/google/firebase/components/PushClient` — would have been waved
# through as inert. So the permitted set is the exact descriptor list measured from a real build,
# and anything outside it is red with its own name printed.
ALLOWLIST="$(dirname "$0")/firebase-inert-allowlist.txt"
test -f "$ALLOWLIST" || { echo "assert-no-fcm: missing $ALLOWLIST" >&2; exit 1; }
/usr/bin/grep '^Lcom/google/firebase/' "$ALLOWLIST" | sort -u > "$WORK/fb-allowed"
ALLOWED_N=$(wc -l < "$WORK/fb-allowed" | tr -d ' ')
# A floor, so a truncated or empty allow-list cannot silently permit nothing (which would be red
# on a clean APK and get "fixed" the wrong way) or, worse, be mistaken for a permissive one.
test "${ALLOWED_N:-0}" -ge 50 \
  || { echo "assert-no-fcm: the allow-list holds only $ALLOWED_N descriptors — it looks truncated" >&2; exit 1; }

/usr/bin/grep -a -o 'Lcom/google/firebase/[A-Za-z0-9_/$]*;' "$WORK/all.dex" | sort -u > "$WORK/fb-found"
fb_unexpected=$(comm -23 "$WORK/fb-found" "$WORK/fb-allowed")
if [ -n "$fb_unexpected" ]; then
  echo "assert-no-fcm: UNEXPECTED Firebase class(es) in the dex:" >&2
  printf '    %s\n' $fb_unexpected >&2
  echo "  The allow-list holds ${ALLOWED_N} exact descriptors, all inert: a DI container, encoders," >&2
  echo "  injection interfaces and exception types, reachable from nothing because FirebaseApp is" >&2
  echo "  absent. Anything else must be justified or removed. If a dependency bump merely renamed" >&2
  echo "  or added an equally inert class, read what arrived, satisfy yourself, and add the line to" >&2
  echo "  firebase-inert-allowlist.txt. Do NOT replace that file with a prefix." >&2
  fail=1
else
  echo "assert-no-fcm: the Firebase namespace matches the ${ALLOWED_N} allow-listed inert classes exactly"
fi

# And `FirebaseApp` itself: the class that initialises Firebase. Its ABSENCE is what makes the
# allow-list above safe, so it is asserted rather than assumed — if it ever appears, the inert
# infrastructure stops being inert and this script's reasoning no longer holds.
check_absent "FirebaseApp (Firebase initialisation)" 'Lcom/google/firebase/FirebaseApp;'
# The embedded distributor itself.
check_absent "the embedded UnifiedPush FCM distributor" 'Lorg/unifiedpush/android/embedded_fcm_distributor/'
# Play Services messaging, which firebase-messaging depends on. Scoped to the messaging package
# rather than all of `com/google/android/gms` — other Play Services artifacts can arrive through
# unrelated libraries and banning the whole namespace would be a rule about the wrong thing.
check_absent "Play Services messaging" 'Lcom/google/android/gms/cloudmessaging/'
check_absent "Firebase Installations" 'Lcom/google/firebase/installations/'

# ── AND THE THING THAT MUST BE PRESENT: the silent payload renderer ──────────────────────────
#
# `expo-unified-push`'s native service renders a notification from ANY decrypted payload carrying
# an `id`, using that payload's own title, body, image and a tap URL. The actor who could do that
# is the SERVER the phone paired with — it holds the device's push keys by design — so on a product
# built around pairing with anybody's server, that is a phishing primitive.
#
# It is closed by naming a no-op renderer in an AndroidManifest meta-data entry, which the service
# resolves reflectively. Both halves have to be in the binary: the meta-data AND the class it names.
# If the class is missing or does not implement the interface, `resolvePayloadRenderer` returns null
# and the service falls back to the DEFAULT renderer — a silent no-op that looks configured, which
# is exactly why this is asserted against the artifact rather than against `app.json`.
# BOTH HALVES ARE ASSERTED, and the first version of this check only did one of them — review
# caught it. The class being compiled in proves nothing on its own: the connector only looks the
# class up if the manifest carries the meta-data pointing at it, so an `app.json` that lost the
# `expo-unified-push` plugin entry would leave the class present, this check green, and the DEFAULT
# renderer quietly in force. That is the exact silent-fallback path the renderer exists to close.
RENDERER_FQCN='app.ohmail.push.SilentPushPayloadRenderer'
RENDERER_DESC='Lapp/ohmail/push/SilentPushPayloadRenderer;'
META_NAME='dev.djara.expounifiedpush.PAYLOAD_RENDERER'

n=$(/usr/bin/grep -a -c -F "$RENDERER_DESC" "$WORK/all.dex" || true)
if [ "${n:-0}" -gt 0 ]; then
  echo "assert-no-fcm: present — the silent push renderer class is compiled in"
else
  echo "assert-no-fcm: MISSING the silent push renderer class ($RENDERER_DESC)." >&2
  echo "  Check that plugins/silent-push-renderer.js wrote the class into the generated project." >&2
  fail=1
fi

# The manifest half. The binary AXML keeps its strings in a pool, so the name and the value are
# searched for as bytes in BOTH encodings the format uses — a UTF-8 pool and a UTF-16LE one are
# both legal and which one aapt emits is not ours to depend on. Verified against the shipped
# android-v0.10.1 APK, where both strings appear exactly once.
unzip -o -q "$APK" AndroidManifest.xml -d "$WORK" || true
if [ ! -f "$WORK/AndroidManifest.xml" ]; then
  echo "assert-no-fcm: no AndroidManifest.xml in the APK — cannot prove the renderer is wired" >&2
  fail=1
else
  for want in "$META_NAME" "$RENDERER_FQCN"; do
    hits=$(WANT="$want" python3 - "$WORK/AndroidManifest.xml" <<'PY'
import os, sys
data = open(sys.argv[1], "rb").read()
t = os.environ["WANT"]
print(data.count(t.encode("utf-8")) + data.count(t.encode("utf-16-le")))
PY
)
    if [ "${hits:-0}" -gt 0 ]; then
      echo "assert-no-fcm: manifest carries \"$want\""
    else
      echo "assert-no-fcm: the manifest does NOT carry \"$want\"." >&2
      echo "  The renderer class can be compiled in and still never be used: the connector reads" >&2
      echo "  this meta-data to find it, and falls back to its DEFAULT renderer when it is absent." >&2
      echo "  Check that app.json applies the expo-unified-push plugin with payloadRendererClass." >&2
      fail=1
    fi
  done
fi

test "$fail" -eq 0 || {
  echo "" >&2
  echo "Do not ship this APK. The app's copy and its privacy census both state that no Google" >&2
  echo "push service stands between a person's mailbox and their phone, and something in this" >&2
  echo "binary may make that false." >&2
  echo "" >&2
  # TWO DIFFERENT DIAGNOSES, and conflating them sent the first real failure down the wrong path.
  # The original message asserted "the Gradle exclusion is not taking effect" for ANY hit — but the
  # embedded distributor can be absent (exclusion working) while some unrelated part of the Expo
  # graph still names Firebase. A guard that misreports the cause costs more than one that only
  # reports the fact.
  if /usr/bin/grep -a -q -F 'Lorg/unifiedpush/android/embedded_fcm_distributor/' "$WORK/all.dex"; then
    echo "The embedded UnifiedPush FCM distributor IS present, so the Gradle exclusion in" >&2
    echo "apps/mobile/plugins/without-embedded-fcm.js is not taking effect. Fix the exclusion." >&2
  else
    echo "The embedded UnifiedPush FCM distributor is ABSENT, so the Gradle exclusion IS working." >&2
    echo "Something else in the dependency graph pulls in the descriptors listed above. Identify" >&2
    echo "what declares them before changing this script: if they are genuinely not a push client," >&2
    echo "narrow the check to the packages that are (messaging, iid, installations, cloudmessaging)" >&2
    echo "and record which dependency introduced them and why it is harmless. Do NOT simply drop a" >&2
    echo "check to make this pass." >&2
  fi
  exit 1
}

echo "assert-no-fcm: OK — no Google push code in the binary"
