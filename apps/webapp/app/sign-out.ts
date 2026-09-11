import { clearAllMirrors } from "@ohmail/client-engine";
import { auth } from "./api-client";
import { clearBootCaches, dropLocalStorageKeys } from "./shell/boot-cache";
import {
  COMPOSE_DRAFT_PREFIX, COMPOSE_ROW_PREFIX, COMPOSE_SESSION_PREFIX, forgetComposeRows,
  LEGACY_COMPOSE_DRAFT_KEY,
} from "./shell/compose";
import { REPLY_DRAFT_PREFIX, REPLY_META_PREFIX } from "./shell/mail-send";
import {
  NOTIFICATION_SUBSCRIPTION_PREFIX, revokeWakeRegistration,
} from "./shell/notification-settings";
import { bindApiOwner, blockApiOwner } from "./api-client";
import { forgetOwner, markSignedOutPending } from "./shell/owner-cookie";
import { SCREENER_INTENTS_PREFIX } from "./shell/screener-intents";
import { DELETE_INTENTS_PREFIX } from "./shell/delete-intents";
import { SEND_LOCKS_PREFIX } from "./shell/send-lock";

/**
 * The one correct way to sign out of the web client. `POST /auth/logout` revokes the session and clears
 * cookies; the browser is where the mail is, and a sign-out that leaves the mirror behind leaves a
 * readable mailbox on a machine the user just said they are done with. The server call goes first (the
 * failure worth reporting) and the wipe runs REGARDLESS. The name goes with the mail in one act:
 * the `tf_owner` cookie is cleared in the same `finally` as the wipe. It reports what it could not take back: an
 * IndexedDB delete is BLOCKED while another tab holds the database, so tab A once said "signed out"
 * leaving the mirror on disk while tab B was open — the result names what survived and the pane says so.
 * The sign-out guard asserts every `auth.logout` call goes through here.
 */
export interface SignOutResult {
  /** True only when this browser is verifiably holding no mirror any more. */
  cleared: boolean;
  /**
   * The mirror databases still on this origin. Non-empty means another TAB of this origin is
   * holding one open — an IndexedDB delete is blocked, not failed, while any connection lives
   * — so the mail is still here and the caller must say so rather than navigating away.
   */
  remaining: string[];
  /**
   * FALSE means this browser could not be asked what it holds — no `IDBFactory.databases()` and
   * no usable storage for the mirror registry — so an empty `remaining` proves only that the two
   * names we already knew are gone. It is a different sentence from a blocked wipe, with a
   * different remedy, and it must not read as a clean browser.
   */
  inventoryComplete: boolean;
  /** The server refused or was unreachable. The local half ran anyway; the caller is told. */
  serverRefused: string | null;
}

/**
 * EVERYTHING THIS BROWSER HOLDS FOR AN ACCOUNT, removed and read back — the local half on its
 * own, so the two acts that need it cannot drift apart.
 *
 * It was inline in `signOut`, and account ERASURE — which reaches the same browser state by a
 * different door — cleared only the mirror and the `tf_owner` cookie. Every durable store the
 * durability slice added was left behind after an irreversible deletion, on the one screen with
 * no session left to retry from. Two callers, one implementation, and the census in
 * `sign-out-clears-durable-stores.test.ts` reads this list.
 */
export async function forgetThisBrowser(
  owner?: string,
  /**
   * `revokeWake: false` says the CALLER has already taken the wake registration down while it
   * still had a session to do it with. Only `signOut` passes it, and only because it must: see
   * the block below.
   */
  opts: {
    revokeWake?: boolean;
    /**
     * TRUE when the server may still hold this session — the logout was refused or never reached anybody;
     * only `signOut` passes it. It changes what is WRITTEN, not whether: the local half runs whatever the
     * server said. Erasing the `tf_owner` marker was the mistake, in this one case: the marker is the one
     * thing on this origin saying whose session the browser holds, absence is read as silence, and
     * clearing it while an HttpOnly session was live handed a window open for a DIFFERENT account
     * permission to keep syncing through the unrevoked session. This path writes {@link OWNER_SIGNED_OUT}
     * instead: "a session may still exist and it is not this browser's to use" — read as a contradiction
     * by the sync gate. Not an account id; `readOwner` never hands it back as one.
     */
    serverHeld?: boolean;
  } = {},
): Promise<{
  remaining: string[];
  inventoryComplete: boolean;
}> {
  if (opts.serverHeld) markSignedOutPending();
  else forgetOwner();
  /*
   * And the Cloud client, which is where this got it exactly backwards. A CONFIRMED sign-out
   * returns the client to public: no session is left to be wrong about, and a standing binding
   * would refuse every read the next sign-in needs. A REFUSED one is the opposite, and this line
   * used to do the same for both: sign-out wrote the safe marker — whose whole point is that
   * another window stops trusting the unrevoked session — and then unbound the client one line
   * later, turning the boundary off for every pane mounted afterwards. So a refused sign-out
   * BLOCKS: account surfaces refuse, only the ceremony still goes out — the logout stays retryable
   * and the front door open.
   */
  if (opts.serverHeld) blockApiOwner();
  else bindApiOwner(null);
  /*
   * The wake registration goes first, before the id that names it is swept. This browser is the only party that knows
   * which push row is its own (the server's prune is device-scoped and a browser ceremony mints no device row), and
   * the id lives in the very keys swept below — so the revoke runs while it is still readable
   * (`revokeWakeRegistration` for the three halves). On the erasure door the server rows went with the account, so
   * this drops the browser's own subscription. `signOut` opts out (found by review): by here `auth.logout()` has
   * revoked the session, so running the revoke again would issue a DELETE against a dead credential — and the client
   * reads the 401 as recoverable, burning an `/auth/refresh` round trip on the flaky-network sign-out. The second
   * call is skipped rather than the site removed, so the erasure door keeps its own revoke.
   */
  if (opts.revokeWake !== false) await revokeWakeRegistration();
  // The boot caches: the account's dormancy window, screening baseline and own addresses,
  // remembered so the next boot can paint the partitioned piles before the server answers
  // (`shell/boot-cache.ts`). Cleared by prefix, not by owner — this browser forgets, including
  // whatever an earlier account left behind.
  const boot = clearBootCaches();
  const survivors = [...boot.survivors];
  // The durable-decision stores, which are mail and are NOT in the mirror:
  // the send lanes, the Screener's intent journal, and the compose scratch
  // buffer — all `localStorage`, all owner-keyed, none under the boot-cache
  // prefix, so that sweep never touched them. An unfinished message is mail
  // text readable on a shared machine; a journalled Screener decision would
  // replay on a later sign-in; a send lane would outlive the session whose
  // key it holds. Scoping a key to an account is not what makes a sign-out
  // reach it: the compose scratch was account-scoped and the sweep was
  // simply never told; the reply buffers are keyed by message id and lane.
  const durable = dropLocalStorageKeys([
    SEND_LOCKS_PREFIX,
    SCREENER_INTENTS_PREFIX,
    // The DELETE journal, for the Screener journal's reason exactly: it is a scheduled write
    // against a mailbox, owner-keyed, and left behind it would be replayed by whoever signs in
    // next on this browser — a message deleted out of somebody else's mailbox because a previous
    // account pressed Backspace and closed the tab. See `delete-intents.ts`.
    DELETE_INTENTS_PREFIX,
    COMPOSE_DRAFT_PREFIX,
    LEGACY_COMPOSE_DRAFT_KEY,
    // The compose session id, which names the message the scratch buffer holds. It goes with the
    // buffer: left behind, it would still name a message-in-progress that has been swept, so the
    // next sign-in could inherit an identity for mail that is no longer there.
    COMPOSE_SESSION_PREFIX,
    // And the draft row that session was holding, for the same reason and one step further: it is
    // an id on the DEPARTED ACCOUNT. Left behind, the next sign-in's composer would ask the mirror
    // about a row belonging to somebody else's account — which answers nothing, so the visible
    // cost is small, but a stale account id surviving a sign-out is the thing this sweep exists to
    // refuse, and the composer is the one reader that would act on it.
    COMPOSE_ROW_PREFIX,
    // The reply scratch buffers, which are the same thing one surface along and are WORSE:
    // keyed by message id and lane only, never by owner, so unlike the compose buffer they were
    // never account-scoped in the first place. They hold the reply body.
    REPLY_DRAFT_PREFIX,
    REPLY_META_PREFIX,
    // The FACE's account-derived pair (OHMARCHY-PLAN.md §3a). `ohmail.face.account` is the
    // DEVICE'S MIRROR OF THE ACCOUNT'S ANSWER — cached so the next boot's pre-paint stamp can
    // wear it before `GET /consent` lands — which makes it account data in the only sense this
    // sweep cares about: left behind, it re-skins the NEXT account's first paint from the
    // departed account's preference. `ohmail.faceOffer` is the Option B offer's dismissal,
    // answered in the context of the signed-in account; the next account on this device gets
    // its own offer. The device's own pins (`ohmail.face`, `ohmail.layout`) SURVIVE beside
    // `ohmail.theme` — a browser's look, not account data (the census names them).
    "ohmail.face.account",
    "ohmail.faceOffer",
    // The push row's id and the endpoint it was minted for, both
    // session-bound. Swept UNCONDITIONALLY, even when the revoke could not
    // delete the row — deliberate: after a sign-out there is no credential
    // to retry the delete with (the account-scoped DELETE would 404 for the
    // next signer-in), so keeping the id buys no retry and costs the next
    // account its notifications — `syncWebPush` reads a stored id as
    // "already registered" and never announces the new endpoint. The row a
    // failed delete leaves is collected by the sender's prune-on-404/410
    // once the local unsubscribe kills the endpoint. The SWITCHES are not
    // here: a per-install preference, like `ohmail.theme`.
    NOTIFICATION_SUBSCRIPTION_PREFIX,
  ]);
  survivors.push(...durable.survivors);
  // The mirror-name registry is swept BY `clearAllMirrors` itself (it removes the names it proved
  // gone and keeps the ones it did not), so it is deliberately NOT in the prefix sweep above —
  // dropping it there would throw away the only record of a mirror this browser could not delete.
  /*
   * The first `sessionStorage` entry this sweep covers: the in-flight Microsoft device-code
   * ceremony keeps its HANDLE there — per tab, matching a fifteen-minute grant far better than a
   * store that outlives the browser — so no prefix sweep reaches it, and a tab reused by another
   * account within the window still held the previous account's record. The record carries no
   * credential (the `device_code` never leaves the server) and the reader refuses a record whose
   * account id is not the signed-in one — that check, not this line, makes another account's code
   * unrenderable; this is the tidy-up. Wrapped like every accessor here: a private window can make
   * the accessor itself throw, and a sign-out must not fail on a storage read.
   */
  /*
   * AND THE HALF OF `COMPOSE_ROW_PREFIX` THAT IS NOT IN A JAR. A browser refusing this app its
   * storage remembers the row the composer opened in memory for the life of the tab
   * (`forgetComposeRows`), and every reason the key above is swept applies to it: left behind, the
   * next sign-in's composer would be holding a row on the departed account. Unconditional and
   * unwrapped — it touches no storage, so nothing here can throw.
   */
  forgetComposeRows();
  let deviceCeremonySwept = true;
  try {
    sessionStorage.removeItem("ohmail.deviceCeremony");
  } catch {
    deviceCeremonySwept = false;
    survivors.push("ohmail.deviceCeremony");
  }
  const wipe = await clearAllMirrors(owner);
  return {
    remaining: [...survivors, ...wipe.remaining].sort(),
    // EVERY store has to be answerable, not just the mirrors. A jar that could not be walked
    // names no survivors and proves nothing by it — see `dropLocalStorageKeys`'s catch.
    inventoryComplete: wipe.inventory === "complete" && boot.enumerated && durable.enumerated
      && deviceCeremonySwept,
  };
}

export async function signOut(owner?: string): Promise<SignOutResult> {
  // NEVER THROWS, and the refusal rides the result instead. A `return` inside a `finally`
  // would have silently swallowed this exception, which is the same shape of quiet loss the
  // rest of this file exists to stop; and throwing would throw away `remaining`, which is the
  // one thing the caller cannot find out any other way.
  let serverRefused: string | null = null;
  /*
   * Before `auth.logout()`, and the order is the whole fix:
   * `DELETE /push/subscriptions/:id` is authenticated by the session this
   * call is about to revoke. After the logout it answers 401 for ever: the
   * row stays, the sender keeps POSTing wakes, and — because the endpoint
   * answers 2xx while the subscription lives — the prune-on-404/410 never
   * fires. So the registration is taken down while a credential still can.
   * It runs before the logout, and the logout runs regardless of how it
   * went — a browser asking to be signed out is asking either way.
   */
  await revokeWakeRegistration();
  try {
    await auth.logout();
  } catch (err) {
    /**
     * 401 and 403 are "already gone", not "refused" — without this the retry the copy asks for
     * could never succeed: a blocked wipe keeps the pane up AFTER the logout landed and cleared the
     * cookies, so the second `auth.logout()` answers 401 — the session it would revoke is gone.
     * Read as a refusal, that turned a completed sign-out into a permanent "the session may still
     * be live". The outcome asked for is "this session no longer exists", and a 401 says exactly
     * that. 403 is NOT in the set (it was): this API answers 403 for refusals that leave the
     * session alive — a step-up gate, a suspension — so accepting it would report a completed
     * sign-out over a live credential. Only 401.
     */
    // A STRUCTURAL READ OF `status`, not `err instanceof ApiError`, and the difference is not
    // style. Callers' tests mock `./api-client` — one of them supplies `{ auth }` and nothing
    // else — so `ApiError` can be `undefined` at runtime, and `x instanceof undefined` THROWS
    // from inside this catch: the whole local cleanup would be skipped and the sign-out would
    // leave the name and the mail on the machine, which is the exact failure this file exists
    // to prevent. Reading the field cannot throw, and `ApiError` is the only thing that sets it.
    const status = (err as { status?: unknown } | null)?.status;
    const alreadyGone = status === 401;
    serverRefused = alreadyGone ? null : err instanceof Error ? err.message : String(err);
  }
  {
    // `revokeWake: false` — already done above, with the session that authorized it.
    // `serverHeld` carries the one fact the marker has to reflect: whether a session may still
    // be alive on the other end. See the parameter's own note.
    const local = await forgetThisBrowser(owner, {
      revokeWake: false,
      serverHeld: serverRefused !== null,
    });
    // `cleared` needs BOTH: nothing left, and a browser that could actually be asked. Where
    // neither `databases()` nor a usable registry exists, an empty list only means "the two
    // names I already knew are gone" — see `clearAllMirrors`'s own header.
    return {
      cleared: local.remaining.length === 0 && local.inventoryComplete,
      remaining: local.remaining,
      inventoryComplete: local.inventoryComplete,
      serverRefused,
    };
  }
}
