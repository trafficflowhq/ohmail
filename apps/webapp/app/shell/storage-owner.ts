/**
 * Whose per-account client storage this is — on every door, not only the one with a cookie. Four
 * `localStorage` keys are built as `` `<prefix>${owner ?? "local"}` `` (the compose scratch, the
 * send lanes, the Screener journal, the Search sort), each owner-keyed so one account's unfinished
 * message or idempotency key never reaches the next account on the same browser. The owner came
 * from `readOwner()` alone, and two shipped surfaces have no cookie: the desktop window (a
 * DIFFERENT engine per mailbox) and the host door's client (bearer-only). On both, `owner ??
 * "local"` collapsed every mailbox onto one key — the previous mailbox's unfinished message
 * restored into the next one's composer, where autosave could persist it as THAT mailbox's draft.
 */

/**
 * A host-supplied identity is enough here and not for the mirror: the mirror's name must be an id the SERVER
 * confirmed (a persistent mirror named from an unconfirmed id is how one person's mail opens under another's name).
 * This is a weaker question — nothing here authorises a read; it only PARTITIONS this browser's scratch space, and
 * any identity that differs between two mailboxes or two pairings will do: the desktop supplies its mounted mailbox
 * id, the host client a random per-pairing scope.
 */

/**
 * The ordering requirement is why this is a module variable: `AppShell` reads the compose scratch in its own
 * `useEffect`, and a child's effects run BEFORE the parent's — a gate setting the owner from an effect sets it after
 * the shell read the wrong key, so the owner is established during the gate's RENDER ({@link setStorageOwner}); a
 * prop would have to thread through all four builders' call sites, and forgetting one is silent.
 */

import { isOwnerShaped, readOwnerMarker, type OwnerMarker } from "./owner-cookie";

/**
 * The identity the HOST established for this surface, or `null` on a surface that has none.
 *
 * Module scope rather than state: it is read from inside plain functions (`composeDraftKey` and
 * its three siblings) that are called from effects, event handlers and other modules, none of
 * which is a React component.
 */
let hostOwner: string | null = null;

/**
 * IS THIS SURFACE THE DEMO? The landing page embeds the real client at `/demo` in an iframe on the
 * SAME ORIGIN, and `?demo=1` boots it in an ordinary tab — so `storageOwner()` resolved the
 * visitor's own account there and the fixture world read, overwrote and cleared the compose scratch
 * holding their unsent message. Module scope for the reason `hostOwner` is: the key builders are
 * plain functions, not components.
 */
let demoSurface = false;

/**
 * THE DEMO'S OWN OWNER — a value `isOwnerShaped` REFUSES, so neither the `tf_owner` cookie nor
 * {@link setStorageOwner} can ever produce it and the two key spaces are disjoint by construction
 * rather than by a guard each demo feature has to remember.
 */
export const DEMO_STORAGE_OWNER = "demo:fixtures";

/** Whether a key was built for the demo — the one question a product reader asks about an owner. */
export function isDemoOwned(owner: string | null): boolean {
  return owner === DEMO_STORAGE_OWNER;
}

/**
 * THIS SURFACE IS THE DEMO, OR IS NOT. Called during RENDER from `EngineProvider`, where the demo
 * is resolved, and re-derived on every render so a client-side navigation in either direction moves
 * it — {@link setStorageOwner}'s ordering rule for its reason: a child's effects run before its
 * parent's, and the shell reads the scratch buffer in one of them. Browser only, because this
 * module's state is per DOCUMENT in a browser and per PROCESS on a server, where concurrent renders
 * would share it; nothing on the server reads a storage key.
 */

/**
 * AND NOTHING CLEARS THE LATCH AT UNMOUNT, deliberately: a reset in a cleanup runs AFTER the
 * incoming shell's render has set the value for the door being navigated to, and would clobber
 * it. Unreachable in the product — nothing owner-keyed runs outside a shell's own tree — and
 * reachable only in a test that mounts a demo shell and then asserts on product keys, which is
 * what {@link resetStorageOwnerForTest} is for.
 */
export function setDemoStorage(on: boolean): void {
  if (typeof window === "undefined") return;
  demoSurface = on;
}

/**
 * The host says whose storage this window is now using — the desktop's mounted mailbox id, the
 * host door's pairing scope, or `null` when the surface has stopped serving one. Call it during
 * RENDER, above the `AppShell` this gate returns: an effect is too late by one commit, and the
 * value the shell reads in that commit is the previous mailbox's. The call is idempotent and
 * side-effect-free beyond this one assignment — the same shape as the render-phase adjustment the
 * desktop gate performs one line away. A value that is not id-shaped is treated as ABSENT rather
 * than repaired: it is about to become part of a storage key, and guessing at a malformed one is
 * how a partition becomes one nobody can find again. Absent is always safe.
 */
export function setStorageOwner(id: string | null): void {
  hostOwner = id !== null && isOwnerShaped(id) ? id : null;
}

/**
 * WHOSE STORAGE THIS IS — the cookie first, then the host's own answer, then nothing.
 *
 * The cookie wins where there is one, so a browser tab on `app.ohmail.app` behaves exactly as it
 * did: the server-confirmed account id is the strongest identity available and a host-supplied
 * one may not override it. `null` still means "no owner", and the four key builders still spell
 * that as their own `"local"` suffix rather than as a blank — a surface with no account is a real
 * situation, not a missing value.
 *
 * ONE ANSWER OUTRANKS THE COOKIE, and only one: the demo. A shop window may not resolve to the
 * account whose browser it happens to be running in ({@link DEMO_STORAGE_OWNER}).
 */
export function storageOwner(): string | null {
  return storageOwnerState().owner;
}

/**
 * WHICH of those answers it was, and — when it was none of them — what the marker actually said.
 *
 * `storageOwner()` answering `null` is read by four key builders as the `"local"` suffix, and
 * that suffix is a real key space holding real records: a browser's durable send lanes live in
 * it. Collapsing "no account on this surface" (the desktop, the host door) with "the marker has
 * gone" (a browser that lost the cookie) made the second look like the first, so a signed-in
 * window silently moved to `local` and its own send records became invisible to `holdOf`. Same
 * enum as the API gate and the sync gate read; the difference here is that it is NAMED.
 */
export type StorageOwnerSource = "demo" | "cookie" | "host" | "unowned";

export interface StorageOwnerState {
  /** What the key builders use. `null` spells itself `"local"` — see the header. */
  owner: string | null;
  source: StorageOwnerSource;
  /** What `tf_owner` said, from the one resolver. `"absent"` on a surface that has no cookie. */
  marker: OwnerMarker["kind"];
}

/** The last unowned state said out loud, so a render-path read cannot become a log flood. */
let saidUnowned: string | null = null;

export function storageOwnerState(): StorageOwnerState {
  const marker = readOwnerMarker();
  if (demoSurface) return { owner: DEMO_STORAGE_OWNER, source: "demo", marker: marker.kind };
  if (marker.kind === "account") return { owner: marker.id, source: "cookie", marker: marker.kind };
  if (hostOwner !== null) return { owner: hostOwner, source: "host", marker: marker.kind };
  // SAID ONCE PER STATE. A window that reaches here on a cookie surface has lost its marker and
  // is writing to the shared key space; the desktop and the host door reach it every time and
  // mean nothing by it, which is why the marker's own word is in the line.
  if (saidUnowned !== marker.kind) {
    saidUnowned = marker.kind;
    console.warn("ohmail: no owner for this browser's storage — using the shared key space", {
      marker: marker.kind,
    });
  }
  return { owner: null, source: "unowned", marker: marker.kind };
}

/** Test seam: forget the host's answer and the demo latch. Never called by product code. */
export function resetStorageOwnerForTest(): void {
  hostOwner = null;
  demoSurface = false;
  saidUnowned = null;
}
