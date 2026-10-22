#!/usr/bin/env bash
# selfhost-smoke.sh — the self-host stack from three ohmail images, through deploy/selfhost/boot-smoke.mjs.
#
#   selfhost-smoke.sh --build  --dir <deploy/selfhost> --tag smoke-<id> --commit <40-hex>
#       builds web, api and organizer from this tree under the run-scoped tag (selfhost-smoke.yml)
#   selfhost-smoke.sh --staged --dir <deploy/selfhost> --tag stage-<id> --commit <40-hex>
#       the images a release run staged, already on this runner; builds nothing (ghcr-images.yml gate-boot)
#
# A service with both `build:` and `image:` runs whatever image of that name is local, and pulls it first
# when none is. The overlay names the published images, so a plain `up -d` boots the last release and the
# smoke reads green on any tree. Hence the tag that exists only in this run, `--no-build --pull never`, and
# two identity reads: each running container's image against its ref, and /health's commit.
#
# The run's env file is minted under umask 077 into $RUNNER_TEMP and never printed. DOCKER, NODE and CURL
# name the tools (the tests stub them). Exit 0 green, 1 red, 2 usage.
set -euo pipefail

DOCKER=${DOCKER:-docker}
NODE=${NODE:-node}
CURL=${CURL:-curl}
ORIGIN=http://localhost:3080
OURS="web api organizer"

die() { echo "selfhost-smoke: $*" >&2; exit 1; }
usage() { echo "usage: selfhost-smoke.sh (--build|--staged) --dir <deploy/selfhost> --tag <tag> --commit <40-hex>" >&2; exit 2; }

mode='' dir='' tag='' commit=''
while [ $# -gt 0 ]; do
  case "$1" in
    --build | --staged) [ -z "$mode" ] || usage; mode=${1#--}; shift ;;
    --dir) [ $# -ge 2 ] || usage; dir=$2; shift 2 ;;
    --tag) [ $# -ge 2 ] || usage; tag=$2; shift 2 ;;
    --commit) [ $# -ge 2 ] || usage; commit=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$mode" ] && [ -n "$dir" ] && [ -n "$tag" ] && [ -n "$commit" ] || usage

# Only a name no release ever carries: a published tag would let the registry's image stand in for the build.
case "$mode:$tag" in
  build:smoke-* | staged:stage-*) ;;
  build:*) die "--build takes a run-scoped smoke-* tag, not '$tag'" ;;
  staged:*) die "--staged takes a release run's stage-* tag, not '$tag'" ;;
esac
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "'$tag' is not a docker tag"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "--commit takes a 40-hex commit, not '$commit'"

: "${RUNNER_TEMP:=$(mktemp -d)}"
env_file=$RUNNER_TEMP/selfhost-smoke.env
# boot-smoke.mjs splits SMOKE_COMPOSE on whitespace into an argv.
for p in "$dir" "$env_file" "$DOCKER"; do
  if [[ "$p" =~ [[:space:]] ]]; then die "a path with whitespace cannot pass through SMOKE_COMPOSE: '$p'"; fi
done
for f in docker-compose.yml docker-compose.ci.yml .env.example boot-smoke.mjs; do
  [ -f "$dir/$f" ] || die "$dir carries no $f"
done

ref_of() {
  case "$1" in
    web) echo "ghcr.io/trafficflowhq/ohmail-web:$tag" ;;
    api) echo "ghcr.io/trafficflowhq/ohmail-server:$tag" ;;
    organizer) echo "ghcr.io/trafficflowhq/ohmail-worker:$tag" ;;
  esac
}

# ── The run's env: the operator template, then this run's values (the last line of a name wins) ──
pg=$(openssl rand -hex 16)
store=$(openssl rand -hex 16)
kek=$(openssl rand -hex 32)
alert=$(openssl rand -hex 24)
install=$(openssl rand -hex 6)
# The key ring's version-1 variable (the template's), its name built as test/support/key-ring-env.ts builds it.
ring_v1="$(printf '%s_%s' TF KEK)_V1"
umask 077
{
  cat "$dir/.env.example"
  echo
  echo "# selfhost-smoke.sh, this run only"
  echo "OHMAIL_ORIGIN=$ORIGIN"
  echo "OHMAIL_PROJECT=ohmail-smoke"
  echo "OHMAIL_MAIL_UI_PORT=18025"
  echo "POSTGRES_PASSWORD=$pg"
  echo "RUSTFS_ROOT_PASSWORD=$store"
  echo "$ring_v1=$kek"
  echo "TF_ALERT_SECRET=$alert"
  echo "TF_ORGANIZER_INSTALL_ID=ohmail-selfhost:smoke-$install"
  echo "OHMAIL_IMAGE_TAG=$tag"
  echo "OHMAIL_BUILD_VERSION=$commit"
} > "$env_file"
chmod 600 "$env_file"

C=("$DOCKER" compose -f "$dir/docker-compose.yml" -f "$dir/docker-compose.ci.yml" --env-file "$env_file")

finish() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "selfhost-smoke: RED (exit $rc); the stack's logs follow"
    "${C[@]}" logs --no-color || true
  fi
  "${C[@]}" down -v || true
  exit "$rc"
}
trap finish EXIT

# ── What the stack names: ours, or pinned by digest; and ours under this run's tag ──────────
"${C[@]}" config -q
images=$("${C[@]}" config --images)
[ -n "$images" ] || die "the compose names no image"
bad=''
for ref in $images; do
  case "$ref" in ghcr.io/trafficflowhq/*) continue ;; esac
  [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || bad="$bad $ref"
done
[ -z "$bad" ] || die "neither ours nor pinned by digest:$bad"
services=$("${C[@]}" config --format json | jq -r '.services | to_entries[] | "\(.key) \(.value.image // "")"')
for svc in $OURS; do
  got=$(awk -v s="$svc" '$1 == s { print $2 }' <<< "$services")
  [ "$got" = "$(ref_of "$svc")" ] || die "$svc is ${got:-no image}, not $(ref_of "$svc")"
done

# ── The three images: built from this tree, or the staged ones already here ──────────────────
if [ "$mode" = build ]; then
  "${C[@]}" build web api organizer
else
  for svc in $OURS; do
    "$DOCKER" image inspect --format '{{.Id}}' "$(ref_of "$svc")" > /dev/null \
      || die "$svc: $(ref_of "$svc") is not on this runner, and --staged builds nothing"
  done
fi

# Every other service by name, so a failure names the service and its image.
failed=''
while read -r svc ref; do
  case " $OURS " in *" $svc "*) continue ;; esac
  [ -n "$svc" ] || continue
  "${C[@]}" pull "$svc" < /dev/null || failed="$failed
  $svc  $ref"
done <<< "$services"
[ -z "$failed" ] || die "could not pull:$failed"

"${C[@]}" up -d --no-build --pull never

for svc in $OURS; do
  ref=$(ref_of "$svc")
  want=$("$DOCKER" image inspect --format '{{.Id}}' "$ref")
  cid=$("${C[@]}" ps -a -q "$svc")
  [ -n "$cid" ] || die "$svc has no container"
  got=$("$DOCKER" inspect --format '{{.Image}}' "$cid")
  [ "$got" = "$want" ] || die "$svc runs $got, not $ref ($want)"
  echo "identity: $svc runs $ref ($want)"
done

SMOKE_COMPOSE="${C[*]}" SMOKE_ENV_FILE="$env_file" SMOKE_BASE="$ORIGIN" "$NODE" "$dir/boot-smoke.mjs"

# The api's own account of its build: the commit baked into the image, from the build's file.
health=$("$CURL" -fsS "$ORIGIN/health" | jq -r '"\(.version) \(.buildSource)"')
[ "$health" = "$commit file" ] || die "/health names '$health', not '$commit file'"
echo "identity: /health names $commit, read from the build's file"
echo "selfhost-smoke: GREEN ($mode, $tag)"
