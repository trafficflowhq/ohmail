import { clearAllMirrors } from "@ohmail/client-engine";
import { auth } from "./api-client";
import { clearBootCaches } from "./shell/boot-cache";
import { forgetOwner } from "./shell/owner-cookie";

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
 * wired to something that is already correct — `test/sign-out.test.ts` asserts that any
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
    await clearAllMirrors(owner);
  }
}
