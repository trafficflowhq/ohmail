#!/usr/bin/env bash
# Decide what the image workflow may tag, from its inputs alone.
#
# Two kinds of run reach this file:
#
#   a RELEASE run   — a `v*` tag push, or a dispatch naming the tree's own version. It ends with
#                     the public `<version>` and `latest` tags moved.
#   a CANDIDATE run — a dispatch naming a COMMIT. It builds and pushes exactly one tag per image,
#                     `rc-<40 hex>`, and moves no public tag at all. A release candidate needs
#                     images an operator can boot before the release exists; moving `latest` to
#                     one would serve an unreleased build to every unpinned install.
#
# The decision is here rather than in a `run:` block because it is the thing a test can execute:
# a workflow's YAML can be read, and a workflow's shell can only be run by GitHub.
#
# Inputs (environment): EVENT_NAME, REF_NAME, DISPATCH_VERSION, DISPATCH_CANDIDATE, TREE_VERSION
# Output: `key=value` lines — version, candidate, image_tag, promote_public — on stdout, which the
# caller appends to $GITHUB_OUTPUT.
#
# Exit 0 decided · 1 refused (the message says why).
set -euo pipefail

EVENT_NAME=${EVENT_NAME:-}
REF_NAME=${REF_NAME:-}
DISPATCH_VERSION=${DISPATCH_VERSION:-}
DISPATCH_CANDIDATE=${DISPATCH_CANDIDATE:-}
TREE_VERSION=${TREE_VERSION:-}

# ── THE CANDIDATE, FIRST: it is the narrower run and it forbids the wider one ──────────────────
if [ -n "$DISPATCH_CANDIDATE" ]; then
  if [ "$EVENT_NAME" != "workflow_dispatch" ]; then
    echo "refusing: a candidate is a manual act; a tag push is a release"; exit 1
  fi
  case "$DISPATCH_CANDIDATE" in
    ([0-9a-f]*) : ;;
    (*) echo "refusing candidate: '$DISPATCH_CANDIDATE' is not a lower-case commit sha"; exit 1 ;;
  esac
  if [ "${#DISPATCH_CANDIDATE}" -ne 40 ] || [ -n "${DISPATCH_CANDIDATE//[0-9a-f]/}" ]; then
    echo "refusing candidate: '$DISPATCH_CANDIDATE' is not 40 lower-case hex"; exit 1
  fi
  # A candidate names a commit, so the tag names the commit and nothing else. `rc-` is the prefix
  # that keeps it out of docker's version grammar by eye as well as by rule.
  echo "version=$TREE_VERSION"
  echo "candidate=$DISPATCH_CANDIDATE"
  echo "image_tag=rc-$DISPATCH_CANDIDATE"
  echo "promote_public=no"
  exit 0
fi

# ── THE RELEASE RUN, unchanged: the version is data, validated against docker's tag grammar and
# against the tree it is built from. An image labeled 0.9.7 built from a 0.9.8 tree is a lie the
# compose's tag pinning would then serve to operators.
if [ "$EVENT_NAME" = "workflow_dispatch" ]; then V="$DISPATCH_VERSION"; else V="${REF_NAME#v}"; fi
case "$V" in
  ("" | .* | -* | *[!A-Za-z0-9._-]* ) echo "refusing version tag: $V"; exit 1 ;;
esac
if [ "${#V}" -gt 100 ] || [ "$V" = "latest" ]; then echo "refusing version tag: $V"; exit 1; fi
case "$V" in
  (rc-*) echo "refusing version tag: $V — rc-* belongs to a candidate run, which moves no public tag"; exit 1 ;;
esac
if [ "$V" != "$TREE_VERSION" ]; then
  echo "refusing: the requested image version ($V) is not this tree's version ($TREE_VERSION)."
  echo "Images are built from the checked-out source and must be labeled as what they are."
  exit 1
fi
echo "version=$V"
echo "candidate="
echo "image_tag=$V"
echo "promote_public=yes"
