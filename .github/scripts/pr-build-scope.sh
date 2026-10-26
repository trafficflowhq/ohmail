#!/usr/bin/env bash
# pr-build-scope.sh — which platform builds does a pull request need?
#
#   bash .github/scripts/pr-build-scope.sh --base <rev> --head <rev>         the diff between two commits here
#   bash .github/scripts/pr-build-scope.sh --files <list> [--changelog <diff>] a file list, one path a line
#
# Prints `desktop=<true|false>`, `android=<true|false>` and `selfhost=<true|false>` on stdout, and appends the
# same three lines to $GITHUB_OUTPUT when it is set. build.yml's platform jobs (macOS, Windows, Linux x64 and
# arm64, the rpm install, the flatpak), android.yml's APK build and selfhost-smoke.yml's boot smoke read them on
# a full-build pull request (the batch, the release bump, a fork's or a bot's), and only there: a tag, the
# nightly and a dispatch build without asking this, and a maintainer's other pull requests build none.
#
# A SCOPE IS THE TREE ITS BUILD READS. The desktop app bundles the engine (apps/sidecar, which imports
# apps/worker and every package) and renders a window made of apps/webapp's views and catalogues; the phone
# bundles the same engine beside apps/mobile. Both install the root lockfile, apply patches/ and run
# scripts/, and .gitattributes sets the bytes every checkout gets (LF on Windows too). A workflow, the scripts it
# names under .github/scripts and this file belong to their scope;
# Cargo files count for the desktop wherever they sit, and the version files a release bump writes count for
# the build that ships them (the root manifests for both, Resources/ for the desktop). A test directory at the top of an
# app or a package is read by the suite and by no build, so it needs no build, except under apps/desktop,
# where every file counts. CHANGELOG.md needs the desktop build only when it gains a released version's
# heading: the flatpak job derives the metainfo's releases from it.
#
# The self-host images read what their three recipes' dockerignores admit (apps/server/Dockerfile,
# apps/worker/Dockerfile.selfhost, apps/webapp/Dockerfile), and the smoke reads deploy/selfhost.
#
# Whatever cannot be read needs every build: a diff that fails prints every scope true and says why.
set -uo pipefail
export LC_ALL=C

say() { printf '%s\n' "$*" >&2; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
usage() { printf 'usage: pr-build-scope.sh --base <rev> --head <rev> | --files <list> [--changelog <diff>]\n' >&2; exit 2; }

# A path no build reads: a test directory at the top of an app or a package outside the desktop app.
inert() {
  case "$1" in apps/desktop/*) return 1 ;; esac
  [[ "$1" =~ ^(apps|packages)/[^/]+/(test|tests|__tests__)/ ]]
}

# What both builds read: the engine and its packages, the install, the patches, the build scripts.
shared() {
  case "$1" in
    apps/sidecar/* | apps/worker/* | packages/* | patches/* | scripts/*) return 0 ;;
    package.json | package-lock.json | tsconfig*.json) return 0 ;;
    .github/scripts/pr-build-scope.sh | .github/scripts/retry-infra.sh | .gitattributes) return 0 ;;
  esac
  return 1
}

desktop() {
  case "$1" in
    .github/workflows/build.yml | apps/desktop/* | apps/webapp/* | Resources/*) return 0 ;;
    Cargo.toml | Cargo.lock | */Cargo.toml | */Cargo.lock) return 0 ;;
  esac
  shared "$1"
}

android() {
  case "$1" in
    .github/workflows/android.yml | apps/mobile/*) return 0 ;;
    .github/scripts/assert-*.sh | .github/scripts/firebase-inert-allowlist.txt) return 0 ;;
  esac
  shared "$1"
}

selfhost() {
  case "$1" in
    package.json | package-lock.json | apps/*/package.json | packages/*/package.json) return 0 ;;
    patches/* | scripts/apply-patches.mjs | scripts/bundle-host.mjs | scripts/engine-bundle.mjs) return 0 ;;
    apps/server/* | apps/worker/* | apps/webapp/*) return 0 ;;
    packages/core/* | packages/db/* | packages/db-mail/* | packages/services/* | packages/api/*) return 0 ;;
    packages/client-engine/* | packages/fixtures/* | packages/tokens/* | packages/ui/*) return 0 ;;
    deploy/selfhost/* | .github/workflows/selfhost-smoke.yml | .github/scripts/selfhost-smoke.sh | .github/scripts/pr-build-scope.sh) return 0 ;;
  esac
  return 1
}

answer() {
  printf 'desktop=%s\nandroid=%s\nselfhost=%s\n' "$1" "$2" "$3"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'desktop=%s\nandroid=%s\nselfhost=%s\n' "$1" "$2" "$3" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

base='' head='' files='' changelog=''
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base=${2:-}; shift 2 || usage ;;
    --head) head=${2:-}; shift 2 || usage ;;
    --files) files=${2:-}; shift 2 || usage ;;
    --changelog) changelog=${2:-}; shift 2 || usage ;;
    *) usage ;;
  esac
done

work=$(mktemp -d) || { say "scope: no scratch directory, so every build runs"; answer true true true; }
trap 'rm -rf "$work"' EXIT

if [ -n "$files" ]; then
  [ -z "$base$head" ] || usage
  cp "$files" "$work/files" 2> /dev/null || { say "scope: the list $files could not be read, so every build runs"; answer true true true; }
  if [ -n "$changelog" ]; then
    cp "$changelog" "$work/changelog" 2> /dev/null || { say "scope: the diff $changelog could not be read, so every build runs"; answer true true true; }
  else
    : > "$work/changelog"
  fi
else
  [ -n "$base" ] && [ -n "$head" ] || usage
  # --no-renames: a moved file is its old path and its new one, and either may be a build's.
  git diff --name-only --no-renames "$base" "$head" > "$work/files" 2> "$work/err" \
    || { say "scope: the diff $base..$head could not be read ($(head -c 300 "$work/err")), so every build runs"; answer true true true; }
  git diff -U0 --no-renames "$base" "$head" -- CHANGELOG.md > "$work/changelog" 2> "$work/err" \
    || { say "scope: CHANGELOG.md's diff could not be read ($(head -c 300 "$work/err")), so every build runs"; answer true true true; }
fi

need_desktop=false need_android=false need_selfhost=false
why_desktop='' why_android='' why_selfhost=''
count=0
while IFS= read -r p || [ -n "$p" ]; do
  [ -n "$p" ] || continue
  count=$((count + 1))
  inert "$p" && continue
  if [ "$need_desktop" = false ] && desktop "$p"; then need_desktop=true why_desktop=$p; fi
  if [ "$need_android" = false ] && android "$p"; then need_android=true why_android=$p; fi
  if [ "$need_selfhost" = false ] && selfhost "$p"; then need_selfhost=true why_selfhost=$p; fi
done < "$work/files"

# The release bump folds `## [Unreleased]` into `## [<V>] — <date>`: a new released heading.
if [ "$need_desktop" = false ] && grep -Eq '^\+## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$work/changelog"; then
  need_desktop=true why_desktop='CHANGELOG.md (a released version heading)'
fi

say "scope: $count changed path(s)"
say "scope: desktop=$need_desktop${why_desktop:+ — first: $why_desktop}"
say "scope: android=$need_android${why_android:+ — first: $why_android}"
say "scope: selfhost=$need_selfhost${why_selfhost:+ — first: $why_selfhost}"
answer "$need_desktop" "$need_android" "$need_selfhost"
