/**
 * A DURABLE WRITE THAT DID NOT LAND SAYS SO.
 *
 * Every store the durability slice added swallowed its own write failure, so in a private window
 * or against a full quota a "durable" decision silently became the in-memory one it replaced —
 * with the undo window still on offer over a record nobody holds. The class shares one property:
 * the caller could not tell "persisted" from "not". So a write answers, the caller degrades (see
 * the webapp's `screener-state.ts#decide` and `delete-undo.ts`), and the shell says once that
 * this browser is not keeping decisions between reloads.
 *
 * The signal is a `window` event rather than a callback set because a store here is a plain
 * function called from a key handler, with no React on either side; `window` is the one bus the
 * store and the shell both already reach. The NOTICE is once per session — a latch, not a
 * counter — while the event fires on every lost write, because each caller has its own
 * degradation to run.
 *
 * ── WHY IT LIVES IN THIS PACKAGE ────────────────────────────────────────────────────────────
 *
 * It was written in `apps/webapp/app/shell`, and three published roots outside that app went on
 * writing storage directly because no package may import from an app. This is the client's
 * storage layer and every one of those roots already reaches it, so the door sits here and the
 * webapp file is a re-export: one door, one latch, one event name, for the browser client, the
 * shared UI package (through the `StorageDoor` shape it declares itself) and the desktop window.
 */

/** Did the value reach the jar. */
export type DurableWrite = "stored" | "lost";

export const DURABILITY_LOST_EVENT = "ohmail:durability-lost";

/** Which store lost the write. For a log line, never for the sentence — see the notice's copy. */
export interface DurabilityLostDetail {
  store: string;
}

export class DurabilityLostEvent extends CustomEvent<DurabilityLostDetail> {
  constructor(detail: DurabilityLostDetail) {
    super(DURABILITY_LOST_EVENT, { detail });
  }
}

/** A write has been lost in this session. Never returns to false — see {@link durabilityLost}. */
let announced = false;
/** The reader has put the notice away. Only ever set once, and only by them. */
let dismissed = false;

/**
 * IS THERE A NOTICE TO DRAW. `announced && !dismissed`, which is what makes it once per session:
 * a dismissal cannot be undone by the next failed write, and a failed write before the shell
 * mounted is still on screen afterwards.
 */
export function durabilityLost(): boolean {
  return announced && !dismissed;
}

/** Put the notice away for the rest of this session. */
export function dismissDurabilityLost(): void {
  if (dismissed) return;
  dismissed = true;
  raise({ store: "dismissed" });
}

/** The notice rides `window`: the shell that draws it is a browser, and only a browser has one. */
function raise(detail: DurabilityLostDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new DurabilityLostEvent(detail));
}

function lost(store: string): DurableWrite {
  announced = true;
  raise({ store });
  return "lost";
}

/**
 * THE JARS COME OFF `globalThis`, NOT `window` — and the difference is not cosmetic here.
 *
 * In a browser they are the same object. This door is imported by the client engine now, whose
 * mirror-registry tests run on node and stand a `localStorage` up on `globalThis`: reading
 * `window` there would answer "lost" for every write and the registry would silently record
 * nothing, which is the state the registry exists to prevent.
 */

/** Write one key, and say whether it landed. */
export function durableSet(key: string, value: string, store: string): DurableWrite {
  try {
    globalThis.localStorage.setItem(key, value);
    return "stored";
  } catch {
    return lost(store);
  }
}

/**
 * Remove one key, and say whether it landed.
 *
 * A refused REMOVE is reported like a refused write: a jar that will not drop a spent record is
 * a jar whose next read offers it again, which is the same fact about the browser.
 */
export function durableRemove(key: string, store: string): DurableWrite {
  try {
    globalThis.localStorage.removeItem(key);
    return "stored";
  } catch {
    return lost(store);
  }
}

/**
 * THE SAME DOOR FOR THE PER-TAB JAR.
 *
 * `sessionStorage` holds the handles whose lifetime is one tab — an OAuth `state`'s owner, a
 * device-code ceremony, a pane height. A browser that refuses one jar refuses the other for the
 * same reasons (a private window, a profile with site data blocked, a full quota), so a refusal
 * here is the same fact about this browser and earns the same sentence. Two functions rather than
 * a store argument because the census reads the CALL: one door per jar is a thing a parse can
 * see, and a jar chosen by a variable is not.
 */
export function durableSessionSet(key: string, value: string, store: string): DurableWrite {
  try {
    globalThis.sessionStorage.setItem(key, value);
    return "stored";
  } catch {
    return lost(store);
  }
}

/** Remove one per-tab key, and say whether it landed. See {@link durableRemove}. */
export function durableSessionRemove(key: string, store: string): DurableWrite {
  try {
    globalThis.sessionStorage.removeItem(key);
    return "stored";
  } catch {
    return lost(store);
  }
}

/**
 * CAN THIS JAR HOLD A VALUE AT ALL — and a refusal here raises NO notice, deliberately.
 *
 * A probe writes a key it removes again and never reads back, so its refusal is not a lost
 * decision: it IS the answer the caller asked for, and the caller's own verdict carries it
 * (`idb.ts#registryReadable` turns a false here into `inventory: "partial"`, which is stricter
 * than the door's sentence). It is in the door rather than beside it so the jar is touched in
 * one file.
 */
export function durableProbe(key: string): boolean {
  try {
    globalThis.localStorage.setItem(key, "1");
    const ok = globalThis.localStorage.getItem(key) === "1";
    globalThis.localStorage.removeItem(key);
    return ok;
  } catch {
    return false;
  }
}

/**
 * THE DOOR AS AN OBJECT, over a jar the caller is HANDED.
 *
 * Two callers cannot use the functions above. `packages/ui` may not import this package at all —
 * `ThemeProvider` takes a door of this shape as a prop and so imports nothing — and the desktop's
 * host client is constructed with its jar (`BearerManager({ storage })`), which is the seam its
 * tests drive. Both get the same latch and the same event; the jar is a parameter, the ANSWER is
 * not.
 */
export interface StorageDoor {
  get(key: string): string | null;
  set(key: string, value: string): DurableWrite;
  remove(key: string): DurableWrite;
}

/**
 * A door over `jar`, labelling every loss `store`. A null jar is a browser that refused the jar
 * outright, and answers "lost" for every write rather than pretending there is nowhere to fail.
 */
export function storageDoor(jar: Storage | null, store: string): StorageDoor {
  return {
    get(key) {
      try {
        return jar?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (!jar) return lost(store);
        jar.setItem(key, value);
        return "stored";
      } catch {
        return lost(store);
      }
    },
    remove(key) {
      try {
        if (!jar) return lost(store);
        jar.removeItem(key);
        return "stored";
      } catch {
        return lost(store);
      }
    },
  };
}

/**
 * The door over this window's `localStorage` — what a host hands `ThemeProvider`.
 *
 * THE JAR IS RESOLVED PER CALL, not captured. Hosts build this at module scope so the prop has a
 * stable identity, and a client module is evaluated on the server too: a jar read once, there,
 * would be `null` for the life of the page and answer "lost" for every write after hydration.
 */
export function localStorageDoor(store: string): StorageDoor {
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null; // storage blocked — "no stored value" is the honest answer for a read
      }
    },
    set: (key, value) => durableSet(key, value, store),
    remove: (key) => durableRemove(key, store),
  };
}

/**
 * THE INDEXEDDB ARM: A TRANSACTION IS THE UNIT OF DURABILITY, so it is the transaction that
 * answers.
 *
 * A `put` or `delete` on an object store returns immediately and its request's error is only half
 * the story — a quota refusal, an `InvalidStateError` on a closing connection or an explicit
 * `abort()` all settle as the TRANSACTION aborting, and only a completed transaction means the
 * bytes are on disk. So the door is here rather than around each request: every write the caller
 * staged either landed together or did not land at all, which is the same all-or-nothing shape
 * the mirror's persistence contract already assumes.
 *
 * It ANSWERS and does not swallow: the caller still throws on "lost" (see `idb.ts#commit`), so
 * the recovery above it runs exactly as it did before this door existed. Nothing here retries.
 */
export function durableIdbCommit(tx: IDBTransaction, store: string): Promise<DurableWrite> {
  return new Promise((resolve) => {
    /* `onerror` and `onabort` BOTH fire for one failed transaction, so the verdict settles once —
       and the verdict is passed as a THUNK rather than a value. Measured: `done(lost(store))`
       evaluates `lost` before `done` can look at the latch, so one failed transaction raised two
       events while the promise resolved once. */
    let settled = false;
    const settle = (verdict: () => DurableWrite) => {
      if (settled) return;
      settled = true;
      resolve(verdict());
    };
    tx.oncomplete = () => settle(() => "stored");
    tx.onabort = () => settle(() => lost(store));
    tx.onerror = () => settle(() => lost(store));
  });
}

/** Test seam: forget this session's answer. Never called by product code. */
export function resetDurabilityForTest(): void {
  announced = false;
  dismissed = false;
}
