import type { EntityReader } from "./store.js";
import type { EngineMessage, Folder } from "./types.js";

/**
 * A READER WITH SOME MESSAGES SHOWN SOMEWHERE ELSE — what makes a held routing press look filed.
 *
 * A row's place comes from its sender's RULE, not from a `move`, so a press whose rule is held
 * for the undo window would move nothing on screen. This carries it meanwhile, exactly as
 * `hideMessages` carries a held delete: over the PRESENTATION only, never over the mirror's own
 * reader. `presentationReader`'s rule holds — never open, search or mutate through this — because
 * the place it answers is a promise; `physicalFolder` still says where the mail is. The base
 * reader comes back unwrapped when nothing is held, so memos keep their inputs.
 */
export function presentAt(base: EntityReader, places: ReadonlyMap<string, Folder>): EntityReader {
  if (places.size === 0) return base;
  const project = (m: EngineMessage): EngineMessage => {
    const place = places.get(m.id);
    if (place === undefined || place === m.folder) return m;
    return { ...m, folder: place, physicalFolder: m.physicalFolder ?? m.folder };
  };
  return {
    version: () => base.version(),
    /* FORWARDED, and the overlay adds nothing of its own: it re-places messages a press already
       named, so it is stale exactly when its base reader is. `reader-stamp-forwarding.test.ts`
       refuses a wrapper that answers a stamp its base does not. */
    stampOf: (type) => base.stampOf(type),
    stampExcept: (ignore) => base.stampExcept(ignore),
    get<T = unknown>(type: string, id: string): T | undefined {
      const v = base.get<T>(type, id);
      if (type !== "message" || v === undefined) return v;
      return project(v as unknown as EngineMessage) as unknown as T;
    },
    list<T = unknown>(type: string): T[] {
      const rows = base.list<T>(type);
      if (type !== "message") return rows;
      return rows.map((r) => project(r as unknown as EngineMessage) as unknown as T);
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T; seq: number }> {
      const rows = base.entries<T>(type);
      if (type !== "message") return rows;
      return rows.map((r) => ({
        id: r.id,
        entity: project(r.entity as unknown as EngineMessage) as unknown as T,
        seq: r.seq,
      }));
    },
  };
}
