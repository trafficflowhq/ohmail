#!/bin/sh
# The proxy's entrypoint. On the external-TLS door OHMAIL_TLS_TERMINATOR must say whose X-Forwarded-For to
# believe: unset, it exits 78 with the sentence the api refuses with. Exactly `gateway` trusts this
# container's network gateway, read from the IPv4 default route, because a terminator on the same box reaches
# the proxy from there; with no default route that exits 78 too. One line says what is trusted, then the
# image's own command runs: compose's `entrypoint:` clears it, so it is repeated below and pinned against the
# image by a test, with `--config` naming the door. `:+` as compose spells it, so OHMAIL_EXTERNAL_TLS chooses
# a file and never names one. `--resolve` prints and exits; OHMAIL_PROC_NET_ROUTE names a route file for tests.
set -eu

route_file=${OHMAIL_PROC_NET_ROUTE:-/proc/net/route}

# The default route's gateway as /proc/net/route prints it: the host's 32-bit word in hex, so on a
# little-endian host the first octet is the last byte. ohmail's images ship for amd64 and arm64, both
# little-endian; the pinned proxy image also lists s390x, which is big-endian and not shipped here.
gateway_hex() {
  awk 'NR > 1 && $2 == "00000000" && $8 == "00000000" && $3 != "00000000" { print $3; exit }' "$route_file" 2>/dev/null || true
}
octet() { printf '%d' "0x$(printf '%s' "$1" | cut -c"$2")"; }

if [ -n "${OHMAIL_EXTERNAL_TLS:-}" ]; then
  # Set means a byte beyond space, tab, LF, CR, VT, FF and U+00A0 (bytes 302 240): the api's
  # UNSET_TLS_TERMINATOR, so the two never disagree on unset. LC_ALL=C: bytes in every awk.
  if ! LC_ALL=C awk 'BEGIN { v = ENVIRON["OHMAIL_TLS_TERMINATOR"]; gsub(/\302\240/, "", v); exit !(v ~ /[^ \t\n\r\v\f]/) }'; then
    printf '%s\n' "proxy: OHMAIL_TLS_TERMINATOR is unset on the external door, so nothing says whose X-Forwarded-For to believe: set it to gateway for a terminator on this box that sets that header (OHMAIL_BIND left at 127.0.0.1), to your terminator's addresses or CIDRs separated by single spaces, or to 0.0.0.0/32 for a relay that adds none." >&2
    exit 78
  fi
  how="set"
  if [ "$OHMAIL_TLS_TERMINATOR" = gateway ]; then
    hex=$(gateway_hex)
    case "$hex" in
      [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]) ;;
      *)
        printf '%s\n' "proxy: the external door found no IPv4 default route, so it cannot trust this network's gateway as the terminator. Set OHMAIL_TLS_TERMINATOR to your terminator's address, or to 0.0.0.0/32 for a relay that adds no X-Forwarded-For." >&2
        exit 78
        ;;
    esac
    OHMAIL_TLS_TERMINATOR="$(octet "$hex" 7-8).$(octet "$hex" 5-6).$(octet "$hex" 3-4).$(octet "$hex" 1-2)/32"
    export OHMAIL_TLS_TERMINATOR
    how="gateway: this network's gateway"
  fi
  printf 'proxy: external door honours X-Forwarded-For from %s (OHMAIL_TLS_TERMINATOR %s)\n' "$OHMAIL_TLS_TERMINATOR" "$how"
fi

if [ "${1:-}" = "--resolve" ]; then exit 0; fi
exec caddy run --config "/etc/caddy/Caddyfile${OHMAIL_EXTERNAL_TLS:+.external-tls}" --adapter caddyfile
