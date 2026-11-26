#!/usr/bin/env bash
set -euo pipefail
output="${1:?Supply the output path for bundletool}"
version=1.18.3
digest=a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
curl -sSfL --retry 3 -o "$output" \
  "https://github.com/google/bundletool/releases/download/${version}/bundletool-all-${version}.jar"
computed=$(sha256sum -- "$output" | cut -d' ' -f1)
test "$computed" = "$digest" \
  || { printf 'bundletool %s failed its pinned SHA-256 check\n' "$version" >&2; exit 1; }
