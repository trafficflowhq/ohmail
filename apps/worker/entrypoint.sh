#!/bin/sh
# The organizer image's entrypoint: it sizes the JS heap from the memory this container may use, then
# runs the image's command. A heap flag already in NODE_OPTIONS or on the command is the person's own
# and is kept. Otherwise the heap is half of whichever binds, the cgroup v2 limit (memory.max), the
# cgroup v1 limit (memory.limit_in_bytes) or the machine's MemTotal, kept between 512 and 2048 MiB,
# and 512 when none can be read. A ceiling under the container's cap stops the process on a heap trace
# it can log, where the cap kills it without a word. One JSON line names the heap and its source.
# `--print` writes that line and exits; OHMAIL_CGROUP_ROOT and OHMAIL_MEMINFO name the files for tests.
set -eu

cgroup=${OHMAIL_CGROUP_ROOT:-/sys/fs/cgroup}
meminfo=${OHMAIL_MEMINFO:-/proc/meminfo}
floor_mb=512
ceiling_mb=2048

# A file's first line when it is a byte count. "max", no file or any other text is no limit, and so is
# a number past 18 digits: cgroup v1 writes its unlimited as 19, past this shell's arithmetic too. A
# leading zero is refused as well, which this shell's arithmetic would read as octal.
bytes_in() {
  v=""
  { [ -r "$1" ] && read -r v < "$1"; } 2>/dev/null || true
  case "$v" in '' | *[!0-9]* | 0?*) return 0 ;; esac
  if [ "${#v}" -le 18 ]; then printf '%s' "$v"; fi
}

# MemTotal in bytes, or nothing.
mem_total() {
  [ -r "$meminfo" ] || return 0
  while read -r key kb _; do
    [ "$key" = "MemTotal:" ] || continue
    case "$kb" in '' | *[!0-9]* | 0?*) return 0 ;; esac
    if [ "${#kb}" -le 15 ]; then printf '%s' "$((kb * 1024))"; fi
    return 0
  done < "$meminfo"
}

# The person's own flag, and its value in MiB when it is written `=<MiB>`.
own="" own_mb=""
flag() {
  case "$2" in
    --max[-_]old[-_]space[-_]size=*) own=$1 own_mb=${2#*=} ;;
    --max[-_]old[-_]space[-_]size*) own=$1 own_mb="" ;;
  esac
}
set -f
for word in ${NODE_OPTIONS:-}; do flag NODE_OPTIONS "$word"; done
set +f
for word in "$@"; do flag command "$word"; done
case "$own_mb" in '' | *[!0-9]* | 0?*) own_mb=null ;; esac

limit=""
if [ -n "$own" ]; then
  heap=$own_mb source=$own reason="the heap flag set for this container is kept as it is"
else
  v2=$(bytes_in "$cgroup/memory.max")
  v1=$(bytes_in "$cgroup/memory/memory.limit_in_bytes")
  total=$(mem_total)
  source=none
  if [ -n "$v2" ]; then limit=$v2 source=cgroup-v2
  elif [ -n "$v1" ]; then limit=$v1 source=cgroup-v1
  fi
  if [ -n "$total" ] && { [ -z "$limit" ] || [ "$total" -lt "$limit" ]; }; then limit=$total source=meminfo; fi
  if [ -n "$limit" ]; then
    heap=$((limit / 2097152))
    [ "$heap" -ge "$floor_mb" ] || heap=$floor_mb
    [ "$heap" -le "$ceiling_mb" ] || heap=$ceiling_mb
    reason="half the memory this container may use, kept between $floor_mb and $ceiling_mb MiB"
  else
    heap=$floor_mb reason="no memory figure could be read, so the heap is the $floor_mb MiB floor"
  fi
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
printf '{"ts":"%s","level":"info","service":"worker","event":"worker_heap_sized","heapMb":%s,"source":"%s"%s,"reason":"%s"}\n' \
  "$ts" "$heap" "$source" "${limit:+,\"memoryBytes\":$limit}" "$reason"

[ "${1:-}" != "--print" ] || exit 0
if [ -z "$own" ]; then
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$heap"
  export NODE_OPTIONS
fi
[ "$#" -gt 0 ] || set -- node /app/bin/ohmail-worker.mjs
exec "$@"
