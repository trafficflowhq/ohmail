import { dropLocalStorageKeys, readBootCache, bootCacheKey, writeBootCache } from "@ohmail/app-logic/session";
import { readStoredVerdict } from "@ohmail/app-logic/doors/wall-lift";
import type { OhboxStartup, SavedOhbox } from "@ohmail/app/mail";

const cache = "desktop-list";
const owner = "window";
let revision = 0;
let onClose: (() => void) | null = null;

export function saveStartListOnClose(): void {
  onClose?.();
}

export function forgetStartList(): void {
  revision++;
  dropLocalStorageKeys([bootCacheKey(cache, owner)]);
}

type StoredOhbox = SavedOhbox & { door: string; scope: string; wall?: string };

function accepts(value: unknown): StoredOhbox | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as StoredOhbox;
  if (typeof v.door !== "string" || typeof v.scope !== "string"
    || (v.wall !== undefined && typeof v.wall !== "string")
    || (v.atTop !== undefined && v.atTop !== true)
    || !Array.isArray(v.groups) || v.groups.length > 3
    || typeof v.anchor?.id !== "string" || !Number.isFinite(v.anchor.offset)
    || (v.top !== undefined && (!Number.isFinite(v.top) || v.top < 0))
    || (v.bottom !== undefined && (!Number.isFinite(v.bottom) || v.bottom < 0))) return null;
  return v.groups.every((group) => typeof group?.label === "string" && Array.isArray(group.rows)
    && group.rows.length <= 40 && group.rows.every((row) => row != null
      && (row.offset === undefined || Number.isFinite(row.offset))
      && [row.id, row.who, row.subject, row.preview, row.when].every((word) => typeof word === "string"))) ? v : null;
}

export function openStartList(door: string) {
  const value = readBootCache(cache, owner, accepts);
  if (value?.door !== door) return null;
  if (value.wall === undefined || readStoredVerdict(value.wall) === "open") return value;
  forgetStartList();
  return null;
}

export function keepStartList(door: string, scope: string, wall: string | null, held: OhboxStartup | null): OhboxStartup {
  const at = revision;
  return {
    launch: held?.launch ?? { saved: null, pressed: null },
    onLeave(save) {
      onClose = save;
      return () => { if (onClose === save) onClose = null; };
    },
    save(value) {
      if (at !== revision) return;
      if (value === null || (wall !== null && readStoredVerdict(wall) !== "open")) {
        dropLocalStorageKeys([bootCacheKey(cache, owner)]);
      } else {
        writeBootCache(cache, owner, { ...value, door, scope, wall: wall ?? undefined });
      }
    },
  };
}
