#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════════
#  THE PHONE'S BACKGROUND ORGANIZER IS IN THE APK — asserted against the binary, not the tree
# ══════════════════════════════════════════════════════════════════════════════════════════
#
# On Android the app keeps organizing a mailbox while it is not in front of you, and it does that
# in a foreground service behind a notification you can see and dismiss. The service is a local
# Expo module (`apps/mobile/modules/organizer-service`): Kotlin that ships inside the APK, and an
# AndroidManifest fragment that declares it and asks for the two permissions Android 14 requires
# for a `dataSync` foreground service.
#
# MEASURED, which is why this exists. A release APK was built and installed with none of it: the
# module was in the repository the app is developed in and absent from the one it is BUILT from, so
# the binary carried no service at all. Nothing failed. The app started, synced, organized while it
# was on screen, and the moment it went to the background it filed nothing, lost its connection,
# failed to hand the mailbox back and left its claim standing against the person's other machines —
# under a panel saying it organizes while its notification is shown. The only surface that could
# notice was somebody installing the artifact and watching for half a minute.
#
# So the claim is a claim about the BINARY, and the binary is what gets asked. Two halves, because
# either alone is satisfiable while the feature is dead:
#
#   · the DEX — the service classes are compiled in. Read from `classes*.dex` rather than the zip
#     listing: compiled classes are not zip entries, so a listing grep is a check that can never be
#     red. The release build is minified, and these two survive R8 by NAME because the manifest
#     declares them — which is also why the Expo module class beside them is not asserted here, R8
#     renames it and an absence check that cannot see its subject passes.
#
#   · the MERGED MANIFEST — the declaration itself. A class can be compiled in and never be a
#     component: without the declaration `startForegroundService` fails on a component the system
#     does not know, which is the same silent shape.
#
# Each half opens with a canary that must be PRESENT, so a broken extraction or a wrong encoding
# reports the scan rather than the APK. The manifest canary is `android.permission.INTERNET`, which
# does not move with the application id — a throwaway build uses a different one, and a canary that
# tracked the id would fail on exactly the builds this is rehearsed against.
#
# ENCODING: binary AndroidManifest keeps its strings in a pool that is legally UTF-8 or UTF-16LE.
# Measured on two real APKs, every string here lives in the UTF-16LE table and none in the UTF-8
# one — so both tables are counted and a 0 is only reported after both were asked.
#
# The APP BUNDLE is not read here, for the reason the workflow gives beside its own scans: a
# bundle keeps its manifest as protobuf under `base/manifest/`, where this parser cannot see it.
# The dex half is covered for the bundle by the workflow's dex-identity step.
set -euo pipefail

APK="${1:?usage: assert-organizer-service.sh <path-to-apk>}"
test -f "$APK" || { echo "assert-organizer-service: no APK at $APK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# unzip answers 11 for "no matching files" and would abort under `set -e` with its own caution as
# the only diagnostic; the checks below say what is actually wrong.
unzip -o -q "$APK" 'classes*.dex' AndroidManifest.xml -d "$WORK" || true

DEX_COUNT=0
for f in "$WORK"/classes*.dex; do
  test -f "$f" || continue
  DEX_COUNT=$((DEX_COUNT + 1))
done
test "$DEX_COUNT" -ge 1 \
  || { echo "assert-organizer-service: no classes*.dex came out of the APK — nothing was scanned" >&2; exit 1; }

cat "$WORK"/classes*.dex > "$WORK/all.dex"
# Portable size: GNU on the runner, BSD when this is run by hand against a local build.
fsize() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }
DEX_BYTES=$(fsize "$WORK/all.dex")
test "$DEX_BYTES" -gt 1000000 \
  || { echo "assert-organizer-service: only $DEX_BYTES bytes of dex — the extraction is not trustworthy" >&2; exit 1; }
echo "assert-organizer-service: scanning $DEX_COUNT dex file(s), $DEX_BYTES bytes"

# ── the canary on the dex half ────────────────────────────────────────────────────────────────
# `grep -c` prints a count and exits 1 on no match, so `|| true` keeps `set -e` out of it and the
# COUNT is what the assertion reads.
CONNECTOR=$(/usr/bin/grep -a -c -F 'Lorg/unifiedpush/android/connector/' "$WORK/all.dex" || true)
test "${CONNECTOR:-0}" -gt 0 || {
  echo "assert-organizer-service: the UnifiedPush connector was not found in the dex either." >&2
  echo "  The scan is broken, not the APK — every check below would have failed for the wrong" >&2
  echo "  reason. Fix the scan before trusting it." >&2
  exit 1
}

fail=0
check_dex_present() {
  local label="$1" desc="$2" n
  n=$(/usr/bin/grep -a -c -F "$desc" "$WORK/all.dex" || true)
  if [ "${n:-0}" -gt 0 ]; then
    echo "assert-organizer-service: present in the dex — $label"
  else
    echo "assert-organizer-service: MISSING from the dex — $label ($desc)" >&2
    fail=1
  fi
}
check_dex_present "the organizer's foreground service" 'Lapp/ohmail/organizer/OrganizerService;'
check_dex_present "the headless task host" 'Lapp/ohmail/organizer/OrganizerHeadlessService;'

# ── the manifest half ─────────────────────────────────────────────────────────────────────────
if [ ! -f "$WORK/AndroidManifest.xml" ]; then
  echo "assert-organizer-service: no AndroidManifest.xml in the APK — the declaration cannot be read" >&2
  exit 1
fi

count_in_manifest() {
  WANT="$1" python3 - "$WORK/AndroidManifest.xml" <<'PY'
import os, sys
data = open(sys.argv[1], "rb").read()
t = os.environ["WANT"]
print(data.count(t.encode("utf-8")) + data.count(t.encode("utf-16-le")))
PY
}

canary=$(count_in_manifest 'android.permission.INTERNET')
test "${canary:-0}" -gt 0 || {
  echo "assert-organizer-service: the manifest does not even carry android.permission.INTERNET." >&2
  echo "  The manifest read is broken — probably the string encoding. Fix it before trusting it." >&2
  exit 1
}

check_manifest_carries() {
  local label="$1" want="$2" hits
  hits=$(count_in_manifest "$want")
  if [ "${hits:-0}" -gt 0 ]; then
    echo "assert-organizer-service: the manifest declares $label"
  else
    echo "assert-organizer-service: the manifest does NOT carry \"$want\" — $label" >&2
    fail=1
  fi
}
check_manifest_carries "the foreground service" 'app.ohmail.organizer.OrganizerService'
check_manifest_carries "the headless task host" 'app.ohmail.organizer.OrganizerHeadlessService'
check_manifest_carries "the service's dataSync type" 'foregroundServiceType'
check_manifest_carries "the typed foreground-service permission" 'android.permission.FOREGROUND_SERVICE_DATA_SYNC'

test "$fail" -eq 0 || {
  echo "" >&2
  echo "Do not ship this APK. It says it keeps organizing your mailbox while the app is not in" >&2
  echo "front of you, and this binary cannot: with no service the app files nothing once it is" >&2
  echo "backgrounded, and the claim it already holds on the mailbox is left standing." >&2
  echo "" >&2
  echo "The usual cause is that the module is in the tree the app is developed in and not in the" >&2
  echo "one this build ran from. Check that apps/mobile/modules/organizer-service is present here" >&2
  echo "with its expo-module.config.json, its android/build.gradle and its AndroidManifest.xml," >&2
  echo "and that the prebuild autolinked it." >&2
  exit 1
}

echo "assert-organizer-service: OK — the organizer service is compiled in and declared"
