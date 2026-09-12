#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════════
#  THE APK CARRIES THE COMMIT IT WAS BUILT FROM — asserted against the shipped bundle
# ══════════════════════════════════════════════════════════════════════════════════════════
#
# The About block on the phone names the build: `EXPO_PUBLIC_COMMIT` is inlined into the
# JavaScript bundle by Expo at bundle time, and the app renders it. That is the only way a
# device run can say which build it is looking at — the version line names a RELEASE, and two
# builds of one release are the same sentence.
#
# A bake is exactly the kind of thing that stops applying silently: an env name that moves, a
# step that loses its `env:`, an Expo change to which prefix is inlined. The result is not a
# build failure. It is an app that says `dev` on a release phone, which reads as a local build
# and is how a rig ends up testing the wrong artifact. So the artifact is what gets asked.
#
# ── BOTH STRING TABLES, ALWAYS ────────────────────────────────────────────────────────────
#
# The release bundle is Hermes bytecode, and Hermes keeps its ASCII and its UTF-16 strings in
# two separate tables. One string lives in exactly ONE of them, and which one is not something
# a caller can predict — a needle asked of the wrong table reads zero, which is indistinguishable
# from a bake that did not happen. So both are asked, every time, and the report says which
# table answered. A zero is only reported after both have been asked.
#
# ── THE GUARD ON THE GUARD ────────────────────────────────────────────────────────────────
#
# A scan that cannot see its subject passes for the wrong reason. Before asserting the commit is
# present, this asserts that a string which MUST be there is findable by exactly the same method:
# the word the About block puts in front of the value. If that canary is missing, the scan is
# broken and says so, rather than reporting the commit as absent.
#
# ── NO `! producer | grep -q .` ───────────────────────────────────────────────────────────
#
# That shape passes when the producer dies of SIGPIPE. Every count below is captured into a
# variable and the variable is tested.
#
# Usage: assert-baked-commit.sh <apk> <expected-commit>
set -euo pipefail

APK="${1:?usage: assert-baked-commit.sh <apk> <expected-commit>}"
WANT="${2:?usage: assert-baked-commit.sh <apk> <expected-commit>}"

if ! printf '%s' "$WANT" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "assert-baked-commit: the expected value is not a full commit id" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The one asset the app's JavaScript ships as. Extracted by name: a listing grep would match the
# zip entry and prove nothing about its contents.
unzip -o -q "$APK" 'assets/index.android.bundle' -d "$WORK"
BUNDLE="$WORK/assets/index.android.bundle"
if [ ! -s "$BUNDLE" ]; then
  echo "assert-baked-commit: the APK carries no JavaScript bundle — the scan is broken, not the bake" >&2
  exit 1
fi

# ASCII and UTF-16LE forms of one needle. `iconv` writes the wide form; the bytes are what is
# searched, so `grep -a` on both, never on text.
wide() { printf '%s' "$1" | iconv -f UTF-8 -t UTF-16LE; }

count_ascii() { printf '%s' "$1" > "$WORK/needle"; grep -a -c -F -f "$WORK/needle" "$BUNDLE" || true; }
count_wide()  { wide "$1" > "$WORK/needle16"; grep -a -c -F -f "$WORK/needle16" "$BUNDLE" || true; }

# THE CANARY FIRST. The word the About block prints in front of the value is in the bundle on
# every build, baked or not, so a zero from both tables here means the method is wrong.
CANARY="Build "
CAN_A="$(count_ascii "$CANARY")"
CAN_W="$(count_wide "$CANARY")"
if [ "$CAN_A" = "0" ] && [ "$CAN_W" = "0" ]; then
  echo "assert-baked-commit: neither string table answers for a string that is always present —" >&2
  echo "  the scan is broken (bundle format changed, or the About copy moved), not the bake" >&2
  exit 1
fi
echo "assert-baked-commit: scan is live (canary: ascii=$CAN_A utf16=$CAN_W)"

GOT_A="$(count_ascii "$WANT")"
GOT_W="$(count_wide "$WANT")"
if [ "$GOT_A" = "0" ] && [ "$GOT_W" = "0" ]; then
  echo "assert-baked-commit: the bundle does not carry the commit it was built from" >&2
  echo "  asked both Hermes string tables: ascii=0 utf16=0" >&2
  echo "  the phone will call this build 'dev', and a device run cannot name it" >&2
  exit 1
fi
echo "assert-baked-commit: the bundle names its build (ascii=$GOT_A utf16=$GOT_W)"
