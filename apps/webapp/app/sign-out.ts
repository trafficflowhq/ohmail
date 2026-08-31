import { clearAllMirrors } from "@ohmail/client-engine";
import { auth } from "./api-client";
import { clearBootCaches, dropLocalStorageKeys } from "./shell/boot-cache";
import { COMPOSE_DRAFT_PREFIX, LEGACY_COMPOSE_DRAFT_KEY } from "./shell/compose";
import { REPLY_DRAFT_PREFIX, REPLY_META_PREFIX } from "./shell/mail-send";
import { forgetOwner } from "./shell/owner-cookie";
import { SCREENER_INTENTS_PREFIX } from "./shell/screener-intents";
import { SEND_LOCKS_PREFIX } from "./shell/send-lock";

/**
 * THE ONE CORRECT WAY TO SIGN OUT OF THE WEB CLIENT.
 *
 * `POST /auth/logout` revokes the session server-side and clears the cookies. It does NOT
 * touch the browser, and the browser is where the mail is: `IndexedDbMirrorStore` has
 * persisted every message, thread, tag and screener decision that ever came down `/sync`
 * into a database on this origin. A sign-out that leaves it there leaves a readable copy of
 * the mailbox on a machine the user has just declared they are done with — which on a
 * shared or borrowed computer is the whole point of signing out.
 *
 * The mirror being account-scoped (see `packages/client-engine/src/idb.ts`) closes the
 * cross-account READ: the next person to sign in opens a different database. This closes
 * the other half — what is left behind at rest.
 *
 * ── ORDER, AND WHY IT IS THIS WAY ROUND ─────────────────────────────────────────────────
 *
 * The server call goes first because it is the one that can fail in a way worth reporting,
 * and the wipe runs REGARDLESS of whether it succeeded. A logout whose network call failed
 * is still a user who asked to be signed out of this browser; refusing to clear local mail
 * because the server was unreachable would be the wrong way round.
 *
 * ── THE NAME GOES WITH THE MAIL, IN ONE ACT ─────────────────────────────────────────────
 *
 * The shell opens a mirror on its first render from a remembered account id in a cookie, before
 * the server has confirmed anything (`shell/owner-cookie.ts`). That is safe precisely because
 * the two facts stay together: the name is only ever present while the mail it names is.
 *
 * Splitting them is what would be unsafe, and only one of the two halves is under our control
 * here. `POST /auth/logout` clears the cookie server-side, and that is the authoritative clear —
 * but it is also the half that fails when the network does, and a person on a borrowed machine
 * asking to be signed out is asking whether or not the server answers. So the cookie is cleared
 * in the same `finally` as the wipe: after this returns, this browser holds neither the mail nor
 * the name, however the request went.
 *
 * The order inside the `finally` does not matter — nothing renders between them — but the
 * pairing does, and it is why both live on this one line rather than at two call sites.
 *
 * There is no sign-out control in the UI yet. This exists so that when there is one, it is
 * wired to something that is already correct — the sign-out guard asserts that any
 * call to `auth.logout` in this app goes through here.
 */
export async function signOut(owner?: string): Promise<void> {
  try {
    await auth.logout();
  } finally {
    forgetOwner();
    // The boot caches go in the same act, for the same reason the cookie does: they are the
    // account's dormancy window, screening baseline and own addresses, remembered so the next
    // boot can paint the partitioned piles before the server answers (`shell/boot-cache.ts`).
    // Cleared by prefix, not by owner — sign-out means this browser forgets, including whatever
    // an earlier account left behind.
    clearBootCaches();
    // THE DURABLE-DECISION STORES, which are mail and are NOT in the mirror.
    //
    // The durability slice moved three user decisions out of memory and onto disk so they
    // survive a crash — the send lanes, the Screener's intent journal, and the compose scratch
    // buffer. All three are `localStorage`, all three are owner-keyed, and none of them starts
    // with the boot-cache prefix, so the sweep above never touched them. This file's own header
    // claims sign-out "closes the other half — what is left behind at rest", and for these three
    // it did not: an unfinished message is mail text, readable on a shared machine after the
    // person signing out believed they had left nothing; a journalled Screener decision would
    // replay on a later sign-in; a send lane would outlive the session whose key it holds.
    //
    // Scoping a key to an account is not by itself what makes sign-out reach it. The compose
    // scratch was already account-scoped for exactly this purpose, and this sweep was simply
    // never told about it; the reply buffers are keyed by message id and lane, so they were
    // never account-scoped at all.
    //
    // By prefix and not by owner, for the reason `clearBootCaches` gives: sign-out means this
    // browser forgets, including whatever an earlier account left behind. The legacy un-owned
    // compose key goes in the same pass — an exact key is a prefix of itself.
    dropLocalStorageKeys([
      SEND_LOCKS_PREFIX,
      SCREENER_INTENTS_PREFIX,
      COMPOSE_DRAFT_PREFIX,
      LEGACY_COMPOSE_DRAFT_KEY,
      // The reply scratch buffers, which are the same thing one surface along and are WORSE:
      // keyed by message id and lane only, never by owner, so unlike the compose buffer they
      // were never account-scoped in the first place. They hold the reply body.
      REPLY_DRAFT_PREFIX,
      REPLY_META_PREFIX,
    ]);
    await clearAllMirrors(owner);
  }
}
