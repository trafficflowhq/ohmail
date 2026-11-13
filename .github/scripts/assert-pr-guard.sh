#!/usr/bin/env bash
# assert-pr-guard.sh — the workflows, their tools and the gate change only on a maintainer branch of
# this repository.
#
#   bash .github/scripts/assert-pr-guard.sh <base sha> <head sha> <pull request json>
#
# Every pull request is refused when (c) a file of a font kind is in its tree, or any commit it would
# merge adds or changes one, unless `.github/scripts/admitted-fonts.tsv` admits it. A maintainer's
# `publish/<utc>-<sha12>` branch is otherwise admitted as it is. Any other pull request is refused when
# (a) it changes `.github/`, `scripts/` or `.gate/` and is not a maintainer's `pr/<name>` branch (a name
# of letters, digits, `.`, `_` and `-`), or (b) it carries a `Monorepo-Commit:` line in a commit message,
# its title or its description (the merge message is the description). A maintainer's branch is a branch
# of THIS repository, which only write access can push (a MEMBER association alone is membership of the
# organization, not write access), whose pull request a person opened (`user.type` User, never an app's
# Bot) as OWNER, MEMBER or COLLABORATOR; a field the pull request lacks counts as none.
#
# The admitted typefaces. The list is read from the BASE commit, never from the head and never from a
# checked-out file, so no pull request admits its own font. A header line, then one row a file: its path
# (`.woff2` alone), the sha256 of its bytes, the path of its licence text. A font file is admitted when
# its path and its sha256 are one row's, it is a regular file, and that row's licence text is a regular
# file of the head's tree. The rows are a set of pairs: a new version of a file is a second row for the
# same path, and the old row leaves in or after the pull request that removes the old bytes. So the
# order is: the row lands first, in a pull request of its own; then the file. A row taken out while its
# file is still in the tree refuses every pull request until the file is gone, and once an old row has
# left, a branch whose tree still carries the old bytes is refused until it merges the base. A base with no list
# admits none; a list that cannot be read whole is a failed premise (exit 2), never an empty list.
# Rule (c) reads names: a font renamed `.bin` is not seen.
#
# It reads git objects and JSON and compares strings; nothing from the pull request is run.
set -euo pipefail
export LC_ALL=C

say() { printf '%s\n' "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
fail() { say "guard: $*"; exit 2; }

[ $# -eq 3 ] || fail "usage: assert-pr-guard.sh <base sha> <head sha> <pull request json>"
base=$1 head=$2 json=$3
repo=${GUARD_REPO:-${GITHUB_REPOSITORY:-}}
[ -n "$repo" ] || fail "no repository named (GITHUB_REPOSITORY)"
[ -f "$json" ] || fail "no pull request at $json"
jq -e 'type == "object"' "$json" > /dev/null 2>&1 || fail "the pull request at $json is not a JSON object"
git cat-file -e "$base^{commit}" 2>/dev/null || fail "the base $base is not a commit here"
git cat-file -e "$head^{commit}" 2>/dev/null || fail "the head $head is not a commit here"

head_repo=$(jq -r '.head.repo.full_name // "a deleted fork"' "$json") || fail "the head's repository could not be read"
head_ref=$(jq -r '.head.ref // ""' "$json") || fail "the head's branch could not be read"
opener=$(jq -r '.user.type // "none"' "$json") || fail "the opener could not be read"
association=$(jq -r '.author_association // "NONE"' "$json") || fail "the opener's association could not be read"
maintainer=no
if [ "$head_repo" = "$repo" ] && [ "$opener" = "User" ]; then
  case "$association" in OWNER | MEMBER | COLLABORATOR) maintainer=yes ;; esac
fi
who="$head_repo:${head_ref:-?}"

commits=$(git rev-list "$base..$head") || fail "the commits $base..$head could not be listed"

refusals=0
# (c) before any admission. The head's TREE: a rename cannot carry a font past it, and one already on the
# base that no row admits refuses every pull request until it is removed. And every commit in base..head,
# which a merge keeps in the history even when a later commit deletes or replaces the file: the paths each
# adds or changes, a merge's against each parent. What a merge only brings from one of its parents is not
# the merge's own: that parent's commits are on the base, or are read here each on its own. So a branch that
# merged the base while it carried an earlier version of a typeface is not refused for that merge.
font_re='\.(ttf|otf|ttc|woff2?|eot|pfa|pfb|dfont)"?$'
is_font() { local rc=0; shopt -s nocasematch; [[ $1 =~ $font_re ]] || rc=1; shopt -u nocasematch; return $rc; }
if command -v sha256sum > /dev/null 2>&1; then sum256() { sha256sum; }
elif command -v shasum > /dev/null 2>&1; then sum256() { shasum -a 256; }
else fail "neither sha256sum nor shasum is here"; fi

# The admitted set: the rows of the BASE's list, each kept as "<path>\t<sha256>\t<licence>" between line feeds.
list=.github/scripts/admitted-fonts.tsv
row_re=$'^([A-Za-z0-9][A-Za-z0-9._/-]*\\.woff2)\t([0-9a-f]{64})\t([A-Za-z0-9][A-Za-z0-9._/-]*)$'
rows=$'\n' known=$'\n' count=0 listed=no
if git cat-file -e "$base:$list" 2>/dev/null; then
  listed=yes
  text=$(git cat-file blob "$base:$list" && printf .) || fail "${base:0:12}:$list could not be read"
  text=${text%.}
  n=0
  while IFS= read -r line; do
    n=$((n + 1))
    at="${base:0:12}:$list, line $n"
    if [ "$n" -eq 1 ]; then
      [ "$line" = $'path\tsha256\tlicence' ] || fail "$at: the header is not path, sha256 and licence with a tab between"
      continue
    fi
    [[ $line =~ $row_re ]] || fail "$at: not a row (the path of a .woff2, the sha256 of its bytes in 64 lower-case digits and the path of its licence text, a tab between)"
    p=${BASH_REMATCH[1]} sum=${BASH_REMATCH[2]} lic=${BASH_REMATCH[3]}
    case "/$p/$lic/" in */../*) fail "$at: a path with a .. segment" ;; esac
    if is_font "$lic"; then fail "$at: the licence text is itself a file of a font kind"; fi
    case "$rows" in *$'\n'"$p"$'\t'"$sum"$'\t'*) fail "$at: this path and sha256 are a row already" ;; esac
    rows="$rows$p"$'\t'"$sum"$'\t'"$lic"$'\n' known="$known$p"$'\n' count=$((count + 1))
  done <<< "${text%$'\n'}"
  say "guard: admitted typefaces: $count row(s) read from ${base:0:12}:$list"
else
  say "guard: admitted typefaces: none (the base carries no list)"
fi

# Whether the entry (mode $1, object $2) at the path $3 is admitted. If so `lic` is its row's licence text; if
# not `why` says why, and says nothing while the base carries no list: every entry is then refused bare, as
# before. A row's path is letters, digits, `.`, `_`, `/` and `-`, so a name that carries anything else has no row.
judge() {
  admitted=no why="" lic=""
  [ "$listed" = yes ] || return 0
  case "$known" in *$'\n'"$3"$'\n'*) ;; *) why=" — not admitted"; return 0 ;; esac
  if [ "$1" != 100644 ] && [ "$1" != 100755 ]; then why=" — not a regular file"; return 0; fi
  local sum rest
  sum=$(git cat-file blob "$2" | sum256) || fail "the object $2 could not be read"
  sum=${sum%% *}
  rest=${rows#*$'\n'"$3"$'\t'"$sum"$'\t'}
  if [ "$rest" = "$rows" ]; then why=" — other bytes than admitted (sha256 ${sum:0:12}…)"; return 0; fi
  admitted=yes lic=${rest%%$'\n'*}
}
# The font-kind entries of a NUL-separated listing on standard input, one a line as "<mode> <object>\t<name>":
# of `ls-tree -r -z`, and of `diff-tree --raw -z` (the entry a change leaves). A control character in a name is
# printed as "?", which no listed path carries: such a name is never admitted and never breaks a line.
tree_fonts() {
  local rec p mode kind oid
  while IFS= read -r -d '' rec; do
    p=${rec#*$'\t'}
    is_font "$p" || continue
    read -r mode kind oid <<< "${rec%%$'\t'*}"
    printf '%s %s\t%s\n' "$mode" "$oid" "${p//[[:cntrl:]]/?}"
  done
}
change_fonts() {
  local meta p was mode from oid status
  while IFS= read -r -d '' meta && IFS= read -r -d '' p; do
    is_font "$p" || continue
    read -r was mode from oid status <<< "$meta"
    printf '%s %s\t%s\n' "$mode" "$oid" "${p//[[:cntrl:]]/?}"
  done
}

entries=$(git ls-tree -r -z --full-tree "$head" | tree_fonts) || fail "the tree of $head could not be listed"
fonts="" shown="" earlier=no
while IFS=$'\t' read -r meta p; do
  [ -n "$meta" ] || continue
  judge "${meta% *}" "${meta#* }" "$p"
  if [ "$admitted" = no ]; then
    fonts="$fonts$p"$'\n' shown="$shown$p$why"$'\n'
    case "$why" in *"other bytes"*) earlier=yes ;; esac
  else
    entry=$(git ls-tree --full-tree "$head" -- "$lic") || fail "the tree of $head could not be searched for $lic"
    case "$entry" in
      "100644 blob "* | "100755 blob "*) ;;
      *) shown="$shown$lic — the licence text of $p is not in the tree"$'\n' ;;
    esac
  fi
done <<< "$entries"
# Whether a parent of the commit $1 carries the entry $2 ("<mode> <object>") at the path $3. Only a merge can
# show such an entry as a change, against its other parent.
from_parent() {
  local parents q entry mode kind oid
  parents=$(git log -1 --format=%P "$1") || fail "the parents of $1 could not be read"
  for q in $parents; do
    entry=$(git ls-tree --full-tree "$q" -- "$3") || fail "the tree of $q could not be searched for $3"
    read -r mode kind oid <<< "${entry%%$'\t'*}"
    if [ "$mode $oid" = "$2" ]; then return 0; fi
  done
  return 1
}
history=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  entries=$(git diff-tree -r -m --root --no-commit-id --raw --no-abbrev -z --no-renames --diff-filter=d "$c" | change_fonts) || fail "the change of $c could not be listed"
  while IFS=$'\t' read -r meta p; do
    [ -n "$meta" ] || continue
    if from_parent "$c" "$meta" "$p"; then continue; fi
    judge "${meta% *}" "${meta#* }" "$p"
    if [ "$admitted" = no ] && ! grep -qxF -- "$p" <<< "$fonts"; then history="$history$p, in commit ${c:0:12}$why"$'\n'; fi
  done <<< "$entries"
done <<< "$commits"
history=$(sort -u <<< "${history%$'\n'}")
shown=${shown%$'\n'}
if [ -n "$shown" ] || [ -n "$history" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ this pull request carries a file of a font kind:"
  if [ -n "$shown" ]; then while IFS= read -r p; do say "    $p"; done <<< "$shown"; fi
  if [ -n "$history" ]; then while IFS= read -r p; do say "    $p"; done <<< "$history"; fi
  say '  This repository carries only the typefaces `.github/scripts/admitted-fonts.tsv` names, by path and sha256, each'
  say "  with its licence text in the tree; a maintainer adds the row in a pull request of its own, which lands"
  say "  before the file does."
  if [ "$earlier" = yes ]; then
    say "  A branch that does not change a listed file can still carry a version the base has replaced: merge"
    say "  the base branch into it, or rebase on it, and push."
  fi
  if [ -n "$history" ]; then
    say "  A merge keeps every commit's files in the history, so deleting one later does not remove it: take"
    say "  it out of the commit that adds it (git rebase -i) and push."
  fi
fi

# A maintainer's publish is admitted as it is, (c) apart.
if [ "$maintainer" = yes ] && [[ "$head_ref" =~ ^publish/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; then
  if [ "$refusals" -eq 0 ]; then say "guard: ADMITTED — $who is a publish"; exit 0; fi
  say "guard: REFUSED — $who, $refusals reason(s) above"
  exit 1
fi
door=no
if [ "$maintainer" = yes ] && [[ "$head_ref" =~ ^pr/[A-Za-z0-9._-]+$ ]]; then door=yes; fi

# (a) the change, as the pull request shows it: the merge base to the head. A maintainer's pr/ branch may make it.
machinery=""
if [ "$door" = no ]; then
  mb=$(git merge-base "$base" "$head") || fail "no merge base between $base and $head"
  machinery=$(git diff --name-only --no-renames "$mb" "$head" -- .github scripts .gate) || fail "the change $mb..$head could not be listed"
fi
if [ -n "$machinery" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ this pull request changes the workflows, the tools they run or the push gate's baseline:"
  while IFS= read -r p; do say "    $p"; done <<< "$machinery"
  say "  Those files change only on a maintainer branch of this repository. Please leave them out, and"
  say "  describe the change you need in an issue or in this pull request; a maintainer carries it."
fi

# (b) a Monorepo-Commit line, in any spelling, anywhere a merge message or a reader could take it.
# Each text is captured first and searched from a here-string: under pipefail a producer piped into
# `grep -q` can die of SIGPIPE at the first match and report the match as a miss.
line_re='monorepo[-_ ]?commit[[:space:]]*:'
carries() { grep -qiE "$line_re" <<< "${1//$'\r'/}"; }
where="" text=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  text=$(git log -1 --format=%B "$c") || fail "the message of $c could not be read"
  if carries "$text"; then where="$where commit ${c:0:12},"; fi
done <<< "$commits"
text=$(jq -r '.title // ""' "$json"); if carries "$text"; then where="$where the title,"; fi
text=$(jq -r '.body // ""' "$json"); if carries "$text"; then where="$where the description,"; fi
if [ -n "$where" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ a Monorepo-Commit: line in${where%,}."
  say "  That line belongs to the repository's publishing history, and only a maintainer's publish branch"
  say "  carries it. Remove it: amend the commit message (git commit --amend, or git rebase -i), edit the"
  say "  title or the description, and push."
fi

if [ "$refusals" -gt 0 ]; then
  say "guard: REFUSED — $who, $refusals reason(s) above"
  exit 1
fi
what="changes none of .github/, scripts/ and .gate/"
if [ "$door" = yes ]; then what="is a maintainer branch of this repository"; fi
say "guard: ADMITTED — $who $what, and carries no Monorepo-Commit: line and no font file beyond the admitted"
