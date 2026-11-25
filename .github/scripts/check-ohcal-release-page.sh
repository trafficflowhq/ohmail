#!/usr/bin/env bash
set -euo pipefail
tag="${1:?Supply the tag}"
mode="${2:-}"
[[ -z "$mode" || "$mode" == --repair ]] || exit 2
case "$tag" in ohcal-*) ;; *) exit 0 ;; esac
releases="repos/$GITHUB_REPOSITORY/releases"
read_release() {
  local response
  if response=$(gh api "$releases/$1" --jq "$2" 2>&1); then
    printf '%s' "$response"
  elif [[ "$response" == *'(HTTP 404)'* ]]; then
    printf absent
  else
    echo "Could not read GitHub release state." >&2
    return 1
  fi
}
prerelease=$(read_release "tags/$tag" .prerelease)
[[ "$prerelease" != absent ]] || exit 0
latest=$(read_release latest .tag_name)
[[ -n "$latest" ]] || { echo "GitHub did not report the Latest release state." >&2; exit 1; }
if node .github/scripts/check-release-page.mjs "$tag" "$prerelease" "$latest"; then
  exit 0
fi
[[ "$mode" == --repair ]] || exit 1

gh release edit "$tag" --prerelease --latest=false --repo "$GITHUB_REPOSITORY"
if [[ "$latest" == "$tag" ]]; then
  latest=$(read_release latest .tag_name)
  if [[ ! "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    stable=$(gh api "$releases" --paginate --jq \
      '.[] | select(.draft == false and .prerelease == false) | .tag_name')
    previous=$(grep -m 1 -Ex 'v[0-9]+\.[0-9]+\.[0-9]+' <<< "$stable") || {
      echo "Could not find an ohmail release to restore as Latest." >&2
      exit 1
    }
    gh release edit "$previous" --latest --repo "$GITHUB_REPOSITORY"
    latest=$(read_release latest .tag_name)
    [[ "$latest" == "$previous" ]] || { echo "Could not restore the ohmail Latest release." >&2; exit 1; }
  fi
  echo "The ohmail release is restored as Latest." >&2
fi
echo "The calendar release page has been changed to a prerelease. Check its publishing settings." >&2
exit 1
