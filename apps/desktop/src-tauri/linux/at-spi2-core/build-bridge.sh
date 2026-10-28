#!/usr/bin/env bash
#
# build-bridge.sh <work-dir> [--tarball <at-spi2-core-2.52.0.tar.xz>]
#
# Builds the AT-SPI bridge the Linux AppImage carries: libatk-bridge-2.0.so.0 from at-spi2-core
# 2.52.0, the version the build runner (Ubuntu 24.04) ships, with the patches beside this script.
#
#   0001-0003  upstream's cache fixes (2.56.0, 2.60.0, 2.62.0). On 2.52.0 an object that is queued
#             for the bridge's cache, goes defunct and is cached again from the queue keeps a cache
#             entry nothing watches; once the object is finalized, every Cache.GetItems call (each AT
#             client that discovers the app makes one) refs and unrefs freed memory, and the app
#             dies on SIGSEGV. The class of at-spi2-core #178.
#   0004      upstream's release of departed peer-to-peer connections (2.62.0), backported.
#   0005      the regression tests for both, run here before anything is printed.
#
# Only the bridge changes: the AppImage keeps the runner's libatk and libatspi, so the build is
# refused unless the runner's at-spi2-core is 2.52.0, and unless the built library needs the same
# libraries and exports the same symbols as the runner's own bridge. The .deb and the .rpm use the
# distribution's bridge and never see this file.
#
# Without --tarball the source is downloaded; either way it is refused unless its digest is the
# pinned one (GNOME's .sha256sum and Ubuntu's .dsc agree on it). The last two lines printed are
#   OHMAIL_ATK_BRIDGE=<absolute path of the built library>
#   OHMAIL_ATK_BRIDGE_BUILD_ID=<its GNU build-id>
# which the AppImage's GTK plugin and the workflow's inspection read.
#
# Needs: meson, ninja, pkg-config, dpkg-buildflags, patch, readelf, nm, dbus-run-session, the
# at-spi2-core bus launcher (the upstream direct-connection test asks the session bus for it), and
# the -dev packages of glib, dbus, libxml2, libx11, libxtst and libxi.
set -euo pipefail

VERSION=2.52.0
URL=https://download.gnome.org/sources/at-spi2-core/2.52/at-spi2-core-$VERSION.tar.xz
SHA256=0ac3fc8320c8d01fa147c272ba7fa03806389c6b03d3c406d0823e30e35ff5ab
SIZE=574684
HERE=$(cd "$(dirname "$0")" && pwd -P)

refuse() { echo "build-bridge: REFUSED: $*" >&2; exit 1; }

[ $# -ge 1 ] || { echo "usage: build-bridge.sh <work-dir> [--tarball <path>]" >&2; exit 2; }
WORK=$1; shift
TARBALL=""
if [ $# -gt 0 ]; then
  [ "$1" = --tarball ] && [ $# -eq 2 ] || { echo "usage: build-bridge.sh <work-dir> [--tarball <path>]" >&2; exit 2; }
  TARBALL=$2
fi
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd -P)

# The runner's own stack: the bridge is built against it and swapped into it.
RUNNER_ATSPI=$(pkg-config --modversion atspi-2) || refuse "pkg-config knows no atspi-2 (libatspi2.0-dev)"
[ "$RUNNER_ATSPI" = "$VERSION" ] \
  || refuse "the runner's at-spi2-core is $RUNNER_ATSPI, not $VERSION: the patches and the bundled libatspi would no longer match"
RUNNER_BRIDGE="$(pkg-config --variable=libdir atk-bridge-2.0)/libatk-bridge-2.0.so.0"
[ -f "$RUNNER_BRIDGE" ] || refuse "the runner has no $RUNNER_BRIDGE to compare against"

if [ -z "$TARBALL" ]; then
  TARBALL=$WORK/at-spi2-core-$VERSION.tar.xz
  curl -fsSL -o "$TARBALL" "$URL"
fi
[ -f "$TARBALL" ] || refuse "no source tarball at $TARBALL"
GOT_SIZE=$(stat -c %s "$TARBALL")
GOT_SHA=$(sha256sum "$TARBALL" | cut -d' ' -f1)
[ "$GOT_SIZE" = "$SIZE" ] && [ "$GOT_SHA" = "$SHA256" ] \
  || refuse "$TARBALL is $GOT_SIZE bytes, sha256 $GOT_SHA; the pinned source is $SIZE bytes, sha256 $SHA256"
echo "build-bridge: source $URL, sha256 $GOT_SHA"

SRC=$(mktemp -d "$WORK/src-XXXXXX")
tar -xJf "$TARBALL" -C "$SRC"
SRC=$SRC/at-spi2-core-$VERSION
for p in "$HERE"/0*.patch; do
  # --fuzz=0: a hunk that only applies with fuzz is refused, not guessed at.
  patch -d "$SRC" -p1 --fuzz=0 --forward --batch --no-backup-if-mismatch < "$p" \
    || refuse "$(basename "$p") does not apply to $VERSION without fuzz"
  echo "build-bridge: applied $(basename "$p")"
done

BUILD=$(mktemp -d "$WORK/build-XXXXXX")
# The distribution's hardening flags, as Ubuntu builds its own bridge (BIND_NOW included).
eval "$(DEB_BUILD_MAINT_OPTIONS=hardening=+all dpkg-buildflags --export=sh)"
meson setup "$BUILD" "$SRC" --buildtype=release \
  -Ddocs=false -Dintrospection=disabled -Dgtk2_atk_adaptor=false
ninja -C "$BUILD"
# The tests run on their own session bus; the upstream case starts the bus launcher there.
dbus-run-session -- meson test -C "$BUILD" --no-rebuild --print-errorlogs cache-departed direct-connection \
  || refuse "a bridge test is red"

LIB=$(readlink -f "$BUILD/atk-adaptor/libatk-bridge-2.0.so.0")
needed() { readelf -d "$1" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort; }
exported() { nm -D --defined-only "$1" | awk '{print $NF}' | sort; }
[ "$(needed "$LIB")" = "$(needed "$RUNNER_BRIDGE")" ] \
  || refuse "the built bridge needs other libraries than $RUNNER_BRIDGE: $(needed "$LIB" | tr '\n' ' ')"
[ "$(exported "$LIB")" = "$(exported "$RUNNER_BRIDGE")" ] \
  || refuse "the built bridge exports other symbols than $RUNNER_BRIDGE"

OUT=$WORK/libatk-bridge-2.0.so.0
install -m 0644 "$LIB" "$OUT"
BUILD_ID=$(readelf -n "$OUT" | awk '/Build ID/ {print $3}')
[ -n "$BUILD_ID" ] || refuse "the built bridge carries no GNU build-id"
echo "OHMAIL_ATK_BRIDGE=$OUT"
echo "OHMAIL_ATK_BRIDGE_BUILD_ID=$BUILD_ID"
