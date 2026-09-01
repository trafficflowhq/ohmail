#!/usr/bin/env bash
#
# ══════════════════════════════════════════════════════════════════════════════════════════
#  EVERY COMMIT IN A PULL REQUEST CARRIES ITS AUTHOR'S Signed-off-by
# ══════════════════════════════════════════════════════════════════════════════════════════
#
#   bash .github/scripts/assert-dco.sh <base-sha> <head-sha>
#
# There is no contributor licence agreement on this project and there is not going to be one.
# CONTRIBUTING.md says so, and says what is asked instead: the Developer Certificate of Origin
# 1.1, one `Signed-off-by:` trailer per commit, which `git commit -s` writes for you. This is
# the check that makes that a requirement rather than a request.
#
# ── WHAT IT ACCEPTS ───────────────────────────────────────────────────────────────────────────
#
# A commit passes when it carries a `Signed-off-by:` trailer whose address matches its AUTHOR or
# its COMMITTER, compared case-insensitively. Both are accepted deliberately:
# `git rebase --signoff` — which CONTRIBUTING.md recommends for a branch you forgot to sign —
# rewrites the committer and leaves the author alone, and a maintainer who signs off on a patch
# they are landing for someone else is the ordinary case the DCO's clause (c) exists for.
#
# MERGE COMMITS ARE SKIPPED. A merge contributes no lines; requiring a sign-off on one would fail
# every branch that had `main` merged into it, which teaches people the check is noise.
#
# ── THE GUARD ON THE GUARD ────────────────────────────────────────────────────────────────────
#
# This is a check for the PRESENCE of something in a set of commits, so it passes trivially when
# the set is empty — a mistyped ref, a shallow clone with no merge base, an event payload whose
# shape changed. All three look exactly like a clean pull request. So the range is resolved first
# and an EMPTY range is a hard failure with its own message, never a pass. `assert-no-fcm.sh`
# states the same rule from the other direction: a scan for an absence passes when the scan is
# broken.
#
# ── NO `! producer | grep -q .`, AND NO `while read` IN A PIPELINE ────────────────────────────
#
# The first shape passes when the producer dies: `grep -q` exits the instant it has an answer,
# closing the pipe, the producer takes SIGPIPE, and under a leading `!` that death reads as
# "produced nothing" — size-dependent, so it looks like flakiness rather than a defect. The second
# runs the loop in a subshell, so the failure counter it increments is discarded and the script
# exits 0 having found every violation. Everything below captures into a variable and tests the
# variable, and every loop reads from a here-document.
#
set -euo pipefail

BASE="${1:-}"
HEAD="${2:-}"

if [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "assert-dco: usage: assert-dco.sh <base-sha> <head-sha>" >&2
  echo "assert-dco: the caller must resolve these from the event payload; guessing them here" >&2
  echo "assert-dco: would turn a changed payload shape into a silent pass." >&2
  exit 2
fi

for ref in "$BASE" "$HEAD"; do
  if ! git cat-file -e "${ref}^{commit}" 2>/dev/null; then
    echo "assert-dco: '$ref' is not a commit in this checkout." >&2
    echo "assert-dco: the workflow needs fetch-depth: 0, or the base branch fetched." >&2
    exit 2
  fi
done

# `--no-merges`: see the header. Captured whole rather than piped into the loop.
COMMITS="$(git rev-list --no-merges "${BASE}..${HEAD}")"

if [ -z "$COMMITS" ]; then
  echo "assert-dco: the range ${BASE}..${HEAD} contains no non-merge commits." >&2
  echo "assert-dco: refusing rather than passing — an empty range is indistinguishable from a" >&2
  echo "assert-dco: pull request whose every commit is signed, and this check exists to tell" >&2
  echo "assert-dco: those two apart." >&2
  exit 1
fi

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

failed=0
checked=0

while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  checked=$((checked + 1))

  author_email="$(lower "$(git show -s --format='%ae' "$sha")")"
  committer_email="$(lower "$(git show -s --format='%ce' "$sha")")"
  author_name="$(git show -s --format='%an' "$sha")"
  subject="$(git show -s --format='%s' "$sha")"

  # Every address inside a Signed-off-by trailer, one per line, lowercased. `sed -n s///p` prints
  # nothing when there is no trailer, which is the case this check is about; it is not an error.
  signoffs="$(git show -s --format='%B' "$sha" \
    | sed -n 's/^[[:space:]]*[Ss]igned-off-by:.*<\([^>]*\)>.*/\1/p' \
    | tr '[:upper:]' '[:lower:]')"

  matched=no
  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    if [ "$addr" = "$author_email" ] || [ "$addr" = "$committer_email" ]; then
      matched=yes
    fi
  done <<EOF
$signoffs
EOF

  if [ "$matched" != yes ]; then
    failed=$((failed + 1))
    echo ""
    echo "  ✗ ${sha}  ${subject}"
    echo "      author: ${author_name} <${author_email}>"
    if [ -z "$signoffs" ]; then
      echo "      no Signed-off-by trailer"
    else
      echo "      signed off by, but by nobody who wrote or landed it:"
      while IFS= read -r addr; do
        [ -n "$addr" ] || continue
        echo "        <${addr}>"
      done <<EOF
$signoffs
EOF
    fi
  fi
done <<EOF
$COMMITS
EOF

if [ "$failed" -ne 0 ]; then
  cat >&2 <<'MSG'

assert-dco: commits above are missing the Developer Certificate of Origin sign-off.

  There is no CLA on this project and no copyright assignment — you keep your
  copyright. The sign-off is the one thing asked instead, and it says you wrote
  the patch or otherwise have the right to send it. CONTRIBUTING.md has the full
  text of what you are certifying.

  To fix the last commit:      git commit -s --amend
  To fix a whole branch:       git rebase --signoff main
  Then force-push the branch.

MSG
  exit 1
fi

echo "assert-dco: OK — ${checked} commit(s), every one signed off by its author or its committer."
