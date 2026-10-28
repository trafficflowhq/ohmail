#!/usr/bin/env bash
# retry-infra.sh — one visible retry of a non-test CI step, on a named infrastructure fault.
#
#   bash .github/scripts/retry-infra.sh CLASS -- COMMAND [ARG...]
#
# Runs COMMAND with its output shown and kept. When it fails AND that output carries the CLASS's
# signature, it prints a ::warning:: naming the class and the matched line, appends
# OHMAIL_RETRIED_AT=<epoch> to $GITHUB_ENV (the build-time notes read it), waits the class's pause
# and runs COMMAND once more; that exit is final. Any other failure keeps its own status and runs
# once. A test is never run through this: the workflows-retry-only-infra test holds which commands
# each class may wrap.
#
#   npm-network      npm's own network error codes (a reset while a tarball streams is outside
#                    npm's fetch retries). Never EINTEGRITY, an HTTP status, ENOSPC or EACCES.
#   cargo-exec-126   a build script the runner's kernel would not execute (exit 126, "cannot
#                    execute binary file"); the scripts named are cleaned first so cargo relinks
#                    them instead of running the same files again.
#   hdiutil-busy     hdiutil: ... - Resource busy.
#   download-network curl's own transport errors (resolve, connect, timeout, TLS handshake, a
#                    reset or short read mid-body). Never an HTTP status (22) or a write error.
#
# Bash 3.2 (macOS) and Git Bash (Windows). Exit 2 on bad usage, without running anything.

usage() { echo "usage: retry-infra.sh npm-network|cargo-exec-126|hdiutil-busy|download-network -- COMMAND [ARG...]" >&2; exit 2; }

[ $# -ge 3 ] || usage
cls=$1
[ "$2" = "--" ] || usage
shift 2

case "$cls" in
  npm-network)
    sig='^npm (error|ERR!) code (ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ERR_SOCKET_TIMEOUT|ECONNECTIONTIMEOUT|EIDLETIMEOUT|ERESPONSETIMEOUT|ETRANSFERTIMEOUT)$'
    pause=5 ;;
  cargo-exec-126)
    sig="process didn't exit successfully: \`[^\`]*/build-script-build\` \\(exit status: 126\\)"
    pause=0 ;;
  hdiutil-busy)
    sig='hdiutil: .*- Resource busy'
    pause=5 ;;
  download-network)
    sig='^curl: \((6|7|18|28|35|52|56|92)\) '
    pause=5 ;;
  *) usage ;;
esac

out=$(mktemp "${TMPDIR:-/tmp}/retry-infra.XXXXXX") || { echo "retry-infra: no temporary file; running $1 without a retry" >&2; exec "$@"; }
trap 'rm -f "$out"' EXIT

"$@" 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] && exit 0

line=$(tr -d '\r' < "$out" | grep -E -m 1 -- "$sig")
[ -n "$line" ] || exit "$status"

# Workflow-command escaping, spelled for bash 3.2: % first, then CR and LF.
cr=$(printf '\r')
lf='
'
msg="$line (exit $status); running it once more"
msg=${msg//"%"/%25}
msg=${msg//"$cr"/%0D}
msg=${msg//"$lf"/%0A}
echo "::warning title=Retried once%3A $cls::$msg"
if [ -n "${GITHUB_ENV:-}" ]; then echo "OHMAIL_RETRIED_AT=$(date +%s)" >> "$GITHUB_ENV"; fi

if [ "$cls" = cargo-exec-126 ]; then
  pkgs=()
  while IFS= read -r spec; do
    [ -n "$spec" ] && pkgs+=(-p "$spec")
  done < <(tr -d '\r' < "$out" | sed -n -E 's/^.*failed to run custom build command for `([^ `]+) v([^ `]+)`.*$/\1@\2/p' | awk '!seen[$0]++')
  if [ ${#pkgs[@]} -gt 0 ]; then
    "$1" clean --locked "${pkgs[@]}" || echo "retry-infra: cargo clean failed (exit $?); retrying anyway"
  else
    echo "retry-infra: no build script named to clean; retrying anyway"
  fi
fi

[ "$pause" -gt 0 ] && sleep "$pause"
"$@"
