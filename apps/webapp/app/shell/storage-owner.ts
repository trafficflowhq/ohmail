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

import { isOwnerShaped, readOwner } from "./owner-cookie";

/**
 * The identity the HOST established for this surface, or `null` on a surface that has none.
 *
 * Module scope rather than state: it is read from inside plain functions (`composeDraftKey` and
 * its three siblings) that are called from effects, event handlers and other modules, none of
 * which is a React component.
 */
let hostOwner: string | null = null;

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
 */
export function storageOwner(): string | null {
  return readOwner() ?? hostOwner;
}

/** Test seam: forget the host's answer. Never called by product code. */
export function resetStorageOwnerForTest(): void {
  hostOwner = null;
}
