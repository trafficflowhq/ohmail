/**
 * WHOSE PER-ACCOUNT CLIENT STORAGE THIS IS — on every door, not only the one with a cookie.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────────────────────
 *
 * Four `localStorage` keys in this shell are built as `` `<prefix>${owner ?? "local"}` ``: the
 * compose scratch buffer, the durable send lanes, the Screener's intent journal and the Search
 * sort. Each of them was owner-keyed on purpose, and the purpose is stated the same way in all
 * four files — `localStorage` is per-ORIGIN, so one account's unfinished message, pending
 * decision or idempotency key must never be handed to the next account on the same browser.
 *
 * The owner came from ONE place: `readOwner()`, the `tf_owner` cookie the hosted API sets. Two
 * shipped surfaces have no such cookie and never will:
 *
 *  · **the desktop window** (`apps/desktop/src/DesktopGate.tsx`), which has no API and no
 *    session at all, and which mounts a DIFFERENT engine per mailbox the shell reports serving;
 *  · **the host door's client** (`apps/desktop/src/host-client/HostGate.tsx`), which is
 *    bearer-only in both directions and mints no cookie by construction.
 *
 * On both of them `owner ?? "local"` resolved to the literal `"local"`, so every mailbox and
 * every pairing shared one key. Switching mailboxes on a desktop install therefore restored the
 * previous mailbox's unfinished message into the next mailbox's composer, where autosave could
 * persist it as THAT mailbox's server draft and a send could deliver it under THAT identity;
 * a Screener decision armed against one mailbox was offered to the next one's replay; and a send
 * lane outlived the mailbox whose key it held. The account scoping three fixes rested on did not
 * exist on either door.
 *
 * ── WHY A HOST-SUPPLIED IDENTITY IS ENOUGH HERE, AND NOT ENOUGH FOR THE MIRROR ──────────────
 *
 * The mail mirror's name has to be an id the SERVER confirmed — `engine.tsx` says why, and the
 * host door's own header repeats it: a persistent IndexedDB mirror named from an unconfirmed id
 * is how one person's mail is opened under another person's name.
 *
 * This is a weaker question and it takes a weaker answer. Nothing here authorises a read or
 * names a database; it only PARTITIONS this browser's own scratch space. What it has to
 * guarantee is that two different mailboxes, or two different pairings, never land on the same
 * partition — and for that, any identity that differs between them will do. The desktop supplies
 * the mailbox id its shell is serving; the host client supplies a random per-pairing scope minted
 * when the pairing is established. Neither is a credential and neither is trusted for anything
 * else.
 *
 * ── THE ORDERING REQUIREMENT, WHICH IS THE WHOLE REASON THIS IS A MODULE VARIABLE ───────────
 *
 * `AppShell` reads the compose scratch in its own `useEffect`, and React runs a child's effects
 * BEFORE its parent's. So a gate that set the owner from an effect would set it after the shell
 * had already read the wrong key. The owner is therefore established during the gate's RENDER,
 * before `AppShell` is created — see {@link setStorageOwner} — which is why this is a module
 * variable with a setter rather than context or a prop. A prop would have to be threaded through
 * every one of the four builders' call sites, and forgetting one is silent.
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
 * host door's pairing scope, or `null` when the surface has stopped serving one.
 *
 * **Call it during render, above the `AppShell` this gate returns.** See the header: an effect is
 * too late by one commit, and the value the shell reads in that commit is the previous mailbox's.
 * The call is idempotent and side-effect-free beyond this one assignment, which is what makes a
 * render-phase write safe here; it is the same shape as the render-phase state adjustment the
 * desktop gate already performs one line away for its engine.
 *
 * A value that is not id-shaped is treated as ABSENT rather than repaired, for the reason
 * `readOwner` gives about the cookie: it is about to become part of a storage key, and guessing
 * at what a malformed one meant is how a partition becomes one nobody can find again. Absent is
 * always safe — it is exactly the state every surface was in before this module existed.
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
