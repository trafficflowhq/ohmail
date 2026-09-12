#!/usr/bin/env bash
# Copy every third-party image the self-host stack boots into our own registry, byte for byte.
#
# Reads deploy/selfhost/images.lock and, for each row, makes ghcr.io/trafficflowhq/<name> carry
# the image the row names. `crane copy` re-pushes the manifest UNCHANGED, so the copy answers to
# the same digest as the original — which is what lets one column in the lock be the identity of
# both, and what lets anyone check our mirror against upstream without trusting us.
#
# IDEMPOTENT, AND THAT IS THE POINT. The destination is asked first: a row already carrying the
# locked digest is verified and nothing is pushed, and — more importantly — upstream is never
# contacted for it. An image that is deleted upstream after we mirrored it cannot break a
# release or an install. That is not hypothetical; it is why this file exists.
#
# Env: MIRROR_REGISTRY (default ghcr.io/trafficflowhq), IMAGES_LOCK, CRANE (the crane command,
# flags included — the rehearsal passes a containerised crane pointed at a local registry).
set -euo pipefail

MIRROR_REGISTRY="${MIRROR_REGISTRY:-ghcr.io/trafficflowhq}"
IMAGES_LOCK="${IMAGES_LOCK:-deploy/selfhost/images.lock}"
CRANE="${CRANE:-crane}"
read -ra CRANE_CMD <<< "$CRANE"

if [ ! -f "$IMAGES_LOCK" ]; then
  echo "mirror-images: no lock at $IMAGES_LOCK" >&2
  exit 1
fi

crane_digest() { "${CRANE_CMD[@]}" digest "$1" 2>/dev/null; }

rows=0
verified=0
copied=0
failures=()

fail() {
  failures+=("$1")
  echo "  REFUSED  $1" >&2
}

while read -r name upstream digest license source rest; do
  # Comments and blank lines. A row with a sixth field is a malformed row, not a comment.
  case "$name" in ""|\#*) continue ;; esac
  rows=$((rows + 1))

  if [ -n "${rest:-}" ]; then
    fail "$name: the row has more than the five fields (name upstream digest license source)"
    continue
  fi
  if [ -z "${source:-}" ]; then
    fail "${name}: the row is short — every row needs name, upstream, digest, license and source"
    continue
  fi
  # THE DIGEST IS THE IDENTITY. A row without one names a moving tag, which is the shape that
  # lets an upstream change what an install boots without changing a line in this repository.
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "$name: '$digest' is not a sha256 digest — a row without one pins nothing"
    continue
  fi
  if [[ ! "$upstream" =~ ^[a-z0-9.-]+(:[0-9]+)?/[^:\ ]+:[^:\ ]+$ ]]; then
    fail "$name: '$upstream' is not a <registry>/<repository>:<tag> reference"
    continue
  fi
  if [[ ! "$source" =~ ^https:// ]]; then
    fail "$name: the source column must be the URL the licence obliges us to point at"
    continue
  fi

  tag="${upstream##*:}"
  dst="$MIRROR_REGISTRY/$name:$tag"

  # Ask the DESTINATION first: an already-mirrored row costs one read and no upstream contact.
  got="$(crane_digest "$dst" || true)"
  if [ "$got" = "$digest" ]; then
    verified=$((verified + 1))
    echo "  verified $dst"
    continue
  fi

  up="$(crane_digest "$upstream" || true)"
  if [ -z "$up" ]; then
    fail "$name: $upstream is not readable, and $dst does not carry $digest yet"
    continue
  fi
  if [ "$up" != "$digest" ]; then
    fail "$name: $upstream is $up, the lock says $digest — re-read the digest or fix the row"
    continue
  fi

  if ! "${CRANE_CMD[@]}" copy "$upstream" "$dst"; then
    fail "$name: copying $upstream to $dst failed"
    continue
  fi
  # What was pushed is read back. A copy that reported success and landed a different manifest
  # would otherwise be discovered by an operator, at a boot, as a digest that does not resolve.
  got="$(crane_digest "$dst" || true)"
  if [ "$got" != "$digest" ]; then
    fail "$name: $dst reads $got after the copy, expected $digest"
    continue
  fi
  copied=$((copied + 1))
  echo "  copied   $dst"
done < "$IMAGES_LOCK"

# An empty lock is a run that mirrored nothing and said so cheerfully. It is a defect in the
# lock or in the path this was pointed at, never a pass.
if [ "$rows" -eq 0 ]; then
  echo "mirror-images: $IMAGES_LOCK holds no rows" >&2
  exit 1
fi

echo "mirror-images: $rows row(s) — $verified verified, $copied copied, ${#failures[@]} refused"
if [ "${#failures[@]}" -ne 0 ]; then
  echo "mirror-images: the self-host stack is NOT fully served by $MIRROR_REGISTRY" >&2
  exit 1
fi
if [ "$((verified + copied))" -ne "$rows" ]; then
  echo "mirror-images: $rows rows but $((verified + copied)) accounted for" >&2
  exit 1
fi
