#!/usr/bin/env bash
# A private Postgres database for one worktree — see scripts/lane-db.mjs for what it decides.
#
#   scripts/lane-db.sh <worktree>              create or reuse, write <worktree>/.lane-db.env (dialling as tf_l_<key>)
#   scripts/lane-db.sh --check <worktree>      does the database that file NAMES still exist? read only
#   scripts/lane-db.sh --reset-role <worktree> a rig's teardown: RESET the lane role's deadlines, read them back
#   scripts/lane-db.sh --drop <worktree>       drop it, its worker databases, its tf_l_ role and the file
#   scripts/lane-db.sh --drop --name <db>      drop one named lane database and its worker databases
#   scripts/lane-db.sh --list-invalid          the INVALID databases on the server, by name; drops nothing
#   scripts/lane-db.sh --list-legacy [--root <dir>]...   the env files still dialling as tf; read only
#
# A CHECK IS THE OTHER EXCEPTION, for the same reason a drop is: it migrates nothing, so it reads
# no journal and needs no built tree. The shared :5433 box is a compose service with NO `volumes:`
# key and its data lives in an anonymous volume; the host died at 11:56 on 2026-09-20, the
# container went with it, and every `.lane-db.env` written before then named a database that was
# gone. Nothing said so: `realPgAvailable` refused and 62 of 77 box files failed AT COLLECTION in
# three consecutive K53 gate passes, with the stage's red pinned on the two files that were
# genuinely red. A box-taking driver asks this FIRST, and the answer is `bash scripts/lane-db.sh
# <worktree>`. The tooling comes from THIS checkout, named on stderr, because a prerequisite that
# needs `pnpm install` in the tree it is about is not a prerequisite.
#
# Everything runs from the WORKTREE NAMED, not from the checkout this script sits in: its tsx, its
# scripts/lane-db.mjs, its packages/db. A tool that migrates one tree while reading another's
# journals is the box-files breach with a database attached.
#
# A DROP IS THE EXCEPTION, because a drop migrates nothing. The cleanup recipe removes worktrees,
# and this tool used to `cd` into the worktree to find its tooling — so a lane that removed its
# worktree first got `no such directory` and left the database behind for ever. That is where a
# large part of the 567 leftover databases on :5433 came from. With `--drop`, a worktree that is
# gone is resolved by path (never entered) and the tooling comes from THIS checkout, named on
# stderr so nobody has to guess which tree answered. The database key is unchanged: the sha256 of
# the worktree's absolute path, or `--name` when the caller already has the name from a census.
#
# ORDER, for anyone cleaning up: DROP FIRST, THEN REMOVE THE WORKTREE. Dropping afterwards works
# now, but it works by hashing a path nothing can check, and `--name` is the honest form there.
#
# AND THAT ORDER COULD NOT BE FOLLOWED (HOUSEKEEPING-020, 2026-09-18). A drop entered the worktree
# it is about to find ITS tsx, so a worktree that never had `pnpm install` died rc 2 and the lane
# that read the line above left its database behind — the defect the line exists to prevent, one
# step earlier. A drop MIGRATES NOTHING, so it now takes the first checkout that HAS the tooling,
# this one before the worktree, and says on stderr which answered. Everything else still runs from
# the worktree named: a create or a migrate reading another tree's journals is the box-files
# breach with a database attached, and the arm below keeps that half where it was.
#
# A DROP ALSO TAKES THE CHECKOUT'S `trafficflow_worker_*` DATABASES, by the same derivation the
# fixture names them with. That reaches further from INSIDE the worktree: a checkout that ran
# worker tests before it had a lane database keyed them on its PATH, and only a drop that still
# has the path can name those. `--name` alone reaches the lane key's half.
set -euo pipefail

SELF_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# THE LANDING KIT'S TWO TOOLS this reaches for — the box door and the box's shm reader — live under
# OHMAIL_KIT_DIR, this checkout's kit tree by default. A tree without the kit refuses the sweep by
# name (the shared box and its door are the kit's) and reads the box's shm as NOT READ, admitted.
KIT_DIR="${OHMAIL_KIT_DIR:-$SELF_ROOT/docs/handoff}"

# THE SWEEP: `--sweep [--apply --lane <LANE>] …` reads every database no live checkout names, by class
# (scripts/lane-db-sweep.mjs). Dry by default. --apply and --selftest-admit go through the box door —
# the priority claim, then flock -n -E 75 on the pg lock, rc 75 = report — and the sweep itself refuses
# to drop unless an ancestor process holds that lock.
if [ "${1:-}" = --sweep ]; then
  shift
  [ -f "$SELF_ROOT/scripts/lane-db-sweep.mjs" ] || { echo "lane-db: --sweep REFUSED — scripts/lane-db-sweep.mjs is not in this tree: the sweep is the shared box's, kept with the landing kit" >&2; exit 2; }
  SWEEP=("$SELF_ROOT/node_modules/.bin/tsx" --conditions=ohmail-source "$SELF_ROOT/scripts/lane-db-sweep.mjs")
  LANE=""; ACT=0; prev=""
  for a in "$@"; do
    case "$a" in --apply|--selftest-admit) ACT=1 ;; esac
    [ "$prev" = --lane ] && LANE=$a
    prev=$a
  done
  [ "$ACT" -eq 1 ] || exec "${SWEEP[@]}" "$@"
  [ -n "$LANE" ] || { echo "lane-db: --sweep --apply takes --lane <LANE>: the box door admits a lane by name" >&2; exit 2; }
  DOOR="$KIT_DIR/2026-09-25/kit/ops/box-lock.sh"
  [ -f "$DOOR" ] || { echo "lane-db: --sweep --apply REFUSED — the box door is not here ($DOOR): it is the landing kit's, and OHMAIL_KIT_DIR names the kit's root" >&2; exit 2; }
  exec bash "$DOOR" pg "$LANE" -- "${SWEEP[@]}" "$@"
fi

# THE BOX'S /dev/shm: the box came back at Docker's 64 MiB default from a checkout
# whose docker-compose.yml lacked `shm_size`. A check and a create ask the one reader, box-shm-check.sh, and
# refuse its BOX_SHM LOW with rc 2 — the box half OWED, which is how every driver reads rc 2 — naming the
# recreate. A box it cannot read (no container: a native box, or no docker) is said and admitted.
box_shm() {
  local reader="$KIT_DIR/2026-10-03/kit/ops/box-shm-check.sh" out rc=0
  [ -f "$reader" ] || { echo "lane-db: box shm NOT READ — $reader is missing (the landing kit's; OHMAIL_KIT_DIR names its root)" >&2; return 0; }
  out=$(bash "$reader" ${LANE_DB_BOX_CONTAINER:+--container "$LANE_DB_BOX_CONTAINER"} 2>&1) || rc=$?
  case "$rc" in
    0) echo "lane-db: ${out%%$'\n'*}" >&2 ;;
    4) echo "lane-db: BOX-SHM-TOO-SMALL ${out#BOX_SHM LOW } — the dispatcher recreates it from origin/main's compose, keeping its volume (no -V): git show origin/main:docker-compose.yml > <tmp>/docker-compose.yml && sg docker -c \"docker compose -p ohmail-monorepo -f <tmp>/docker-compose.yml up -d --no-deps --force-recreate db\"" >&2
       return 2 ;;
    *) echo "lane-db: box shm NOT READ — box-shm-check.sh rc $rc: $(printf '%s' "$out" | head -1 | cut -c1-160)" >&2 ;;
  esac
}
if [ "${1:-}" = --box-shm ]; then box_shm; exit $?; fi

# Every flag is carried through to lane-db.mjs unchanged — including one this script does not
# know, which that tool refuses by name. Only the worktree POSITIONAL is replaced, by the path
# this script resolved.
WT=""; DROP=0; CHECK=0; NAME=""; LIST=0; LEGACY=0; FLAGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --drop) DROP=1; FLAGS+=("$1"); shift ;;
    --list-invalid) LIST=1; FLAGS+=("$1"); shift ;;
    --list-legacy) LEGACY=1; FLAGS+=("$1"); shift ;;
    --root) [ $# -ge 2 ] || { echo "lane-db: --root takes a directory" >&2; exit 2; }
            FLAGS+=("$1" "$2"); shift 2 ;;
    --check) CHECK=1; FLAGS+=("$1"); shift ;;
    --name) NAME=${2:-}; [ $# -ge 2 ] || { echo "lane-db: --name takes a database name" >&2; exit 2; }
            FLAGS+=("$1" "$2"); shift 2 ;;
    --*) FLAGS+=("$1"); shift ;;
    *) if [ -n "$WT" ]; then
         echo "lane-db: one worktree at a time, got '$WT' and '$1'" >&2; exit 2
       fi
       WT="$1"; shift ;;
  esac
done

# A READ OF THE SERVER, or of the env files on this host, needs no worktree; lane-db.mjs refuses
# either beside anything else.
if { [ "$LIST" -eq 1 ] || [ "$LEGACY" -eq 1 ]; } && [ -z "$WT" ]; then
  exec "$SELF_ROOT/node_modules/.bin/tsx" --conditions=ohmail-source "$SELF_ROOT/scripts/lane-db.mjs" "${FLAGS[@]}"
fi

if [ -n "$NAME" ] && [ -z "$WT" ]; then
  [ "$DROP" -eq 1 ] || { echo "lane-db: --name is for --drop only" >&2; exit 2; }
  # No worktree is needed or read: the name IS the scope, and lane-db.mjs fences it to
  # trafficflow_l_<12 hex> before it opens a connection.
  echo "lane-db: dropping by name from $SELF_ROOT" >&2
  exec "$SELF_ROOT/node_modules/.bin/tsx" --conditions=ohmail-source "$SELF_ROOT/scripts/lane-db.mjs" "${FLAGS[@]}"
fi

if [ -z "$WT" ]; then
  echo "lane-db: accepted: <worktree> | --check <worktree> | --reset-role <worktree> | --drop <worktree> | --drop --name <db> | --list-invalid" >&2
  exit 2
fi

GIVEN="$WT"
if RESOLVED="$(cd "$WT" 2>/dev/null && pwd)"; then
  WT="$RESOLVED"
  ROOT="$WT"
elif [ "$DROP" -eq 1 ]; then
  # THE WORKTREE IS GONE AND THIS IS A DROP. Resolve the path without entering it — `realpath -m`
  # normalises a path whose last components do not exist — and answer from this checkout's tooling.
  WT="$(realpath -m "$GIVEN" 2>/dev/null)" || WT=""
  [ -n "$WT" ] || case "$GIVEN" in /*) WT="$GIVEN" ;; *) WT="$PWD/$GIVEN" ;; esac
  ROOT="$SELF_ROOT"
  echo "lane-db: $GIVEN is gone — dropping its database from $SELF_ROOT (path key $WT)" >&2
else
  echo "lane-db: no such directory: $GIVEN" >&2; exit 2
fi

# A DROP TAKES THE FIRST CHECKOUT THAT HAS THE TOOLING, and names it. The worktree is still the
# KEY — the database is the sha256 of the path given — so nothing about what is dropped moves.
if [ "$DROP" -eq 1 ] || [ "$CHECK" -eq 1 ]; then
  for cand in "$SELF_ROOT" "$ROOT"; do
    if [ -x "$cand/node_modules/.bin/tsx" ] && [ -f "$cand/scripts/lane-db.mjs" ]; then
      if [ "$cand" != "$ROOT" ]; then
        if [ "$CHECK" -eq 1 ]; then
          echo "lane-db: reading $GIVEN/.lane-db.env with $cand's tooling — its own tree has none" >&2
        else
          echo "lane-db: dropping $GIVEN's database from $cand — its own tree has no tooling (path key $WT)" >&2
        fi
      fi
      ROOT="$cand"
      break
    fi
  done
fi

# Every tsx run here names `--conditions=ohmail-source`: the workspace packages' exports name their
# compiled `dist/` under `node`, and this tool runs before anything is built, so it reads the source.
TSX="$ROOT/node_modules/.bin/tsx"
MJS="$ROOT/scripts/lane-db.mjs"
for needed in "$TSX" "$MJS"; do
  if [ ! -x "$needed" ] && [ ! -f "$needed" ]; then
    echo "lane-db: $needed is missing — install the workspace's dependencies in $ROOT first" >&2
    if [ "$DROP" -eq 1 ]; then
      echo "lane-db: neither $SELF_ROOT nor $GIVEN carries node_modules/.bin/tsx and scripts/lane-db.mjs, so this drop has no tooling at all" >&2
    fi
    exit 2
  fi
done

# The worktree's own copy of the tool, so the migrator and the journals are that tree's — except
# for a drop of a worktree that is gone, where this checkout's copy answers and says so above.
if [ "$DROP" -eq 0 ]; then box_shm || exit 2; fi
[ "$CHECK" -eq 1 ] && exec "$TSX" --conditions=ohmail-source "$MJS" ${FLAGS[@]+"${FLAGS[@]}"} "$WT"
# A CREATE OR REUSE mints the lane role's password, ALTERs the role and renames the env, and a DROP
# takes the database and the env: two at once over one worktree could leave the role and the env
# disagreeing, or an env naming a database the drop took. One per worktree, the drop included; a
# second is refused rc 75 and reported, never waited for.
LOCK="/tmp/ohmail-lane-db-$(printf '%s' "$WT" | sha256sum | cut -c1-16).lock"
rc=0
flock -n -E 75 "$LOCK" "$TSX" --conditions=ohmail-source "$MJS" ${FLAGS[@]+"${FLAGS[@]}"} "$WT" || rc=$?   # set -e: capture, never exit here
[ "$rc" -eq 75 ] && echo "lane-db: REFUSED rc 75 — another lane-db.sh is creating, re-keying or dropping $WT ($LOCK); report it, never wait" >&2
exit "$rc"
