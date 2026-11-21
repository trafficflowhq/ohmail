import { clearAllMirrors, mirrorDbName } from "@ohmail/client-engine";
import { auth } from "./api-client";
import { signOutTrouble } from "./sign-out-trouble";
import { clearBootCaches, dropLocalStorageKeys, dropLocalStorageKeysWhere, type LocalSweep } from "@ohmail/app-logic/session/boot-cache";
import {
  COMPOSE_DRAFT_PREFIX, COMPOSE_ROW_PREFIX, COMPOSE_SESSION_PREFIX, forgetComposeRows,
  LEGACY_COMPOSE_DRAFT_KEY,
} from "@ohmail/app-logic/writing/compose";
import { FACE_ACCOUNT_KEY, FACE_ACCOUNT_OWNER_KEY } from "./shell/face-mirror";
import {
  OWNED_REPLY_DRAFT_PREFIX, OWNED_REPLY_META_PREFIX, REPLY_DRAFT_PREFIX, REPLY_META_PREFIX, SENT_COPY_NOTES_PREFIX,
} from "@ohmail/app-logic/writing/mail-send";
import {
  NOTIFICATION_SUBSCRIPTION_PREFIX, SUBSCRIPTION_OWNER_KEY, clearBrowserWakeNotices, revokeWakeRegistration,
} from "./shell/notification-settings";
import { bindApiOwner, blockApiOwner, boundApiFamily, boundApiOwner } from "./api-client";
import { DEVICE_SIGN_IN_KEY, retireDeviceSignIn } from "./(product)/mailbox/device-sign-in";
import { forgetOwner, markSignedOutPending, readOwner, readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { durableRemove, durableSet } from "@ohmail/app-logic/storage/durable";
import { namesOwner } from "@ohmail/app-logic/storage/storage-owner";
import { RETIRED_ID_SETS, SUBJECT_DISPLAY_PREFIX } from "@ohmail/app-logic/storage/persisted-ui";
import { SCREENER_INTENTS_PREFIX } from "@ohmail/app-logic/screener/screener-intents";
import { DELETE_INTENTS_PREFIX } from "@ohmail/app-logic/press/delete-intents";
import { ROUTING_INTENTS_PREFIX } from "@ohmail/client-engine";
import { READING_ALONG_PREFIX } from "@ohmail/app-logic/reading/reading-along";
import { TOLD_DEVICES_PREFIX } from "@ohmail/app-logic/notices/use-notices";
import { ACCESS_VERDICT_PREFIX, HANDOFF_KEY } from "@ohmail/app-logic/doors/wall-lift";
import { SEND_LOCKS_PREFIX } from "@ohmail/app-logic/writing/send-lock";
import {
  SESSION_ANSWER_KEY, SESSION_ATTEMPT_KEY, SESSION_MINTED_KEY, forgetLateAnswerWatch, forgetRenewalName,
  forgetSplashPresentation, purgeSiteCache, withSessionCookieLock,
} from "./session-refresh";
import { ERASED_KEY } from "@ohmail/app-logic/session/account-erased";
import { REVOKE_OWED_PREFIX, SHARED_NOTE_KEY } from "./(product)/resume/signed-out-note";
import { postLocalSignOut, postSessionChange, postSignedOut, readSessionFamily, thisTabName } from "./signed-out-signal";
import { forgetMailDocs } from "@ohmail/letter-body/cache";
import {
  PENDING_SIGN_OUT_KEY, readPendingSignOut, accountCleanup, clearAccountCleanup, confirmAccountCleanup,
  otherAccountCleanup, readIsolatedScope, retainAccountCleanup, retainRetiredCleanup,
  finishRetiredComposeCleanup, retainRetiredComposeCleanup, type PendingSignOut,
} from "./pending-sign-out-storage";
export { PENDING_SIGN_OUT_KEY, readPendingSignOut };


/** Capture the current confirmed session for a sign-out that has no Settings account read. */
export function confirmedSignOutSession(): { account: string; family: string } | null {
  const account = readOwner();
  const family = readSessionFamily();
  return account !== null && family !== null && boundApiOwner() === account && boundApiFamily(account) === family
    ? { account, family }
    : null;
}

/**
 * The server revokes the departed family without writing cookies. The browser retires its local copy
 * even on a refusal. Cookie clearing and shared cleanup require the exclusive lock and the pending
 * operation that owns the jar. The HTTP cache result settles separately from the sign-out press.
 */
export interface SignOutResult {
  /** Whether the browser stores were verified. A confirmed exit also requires serverRefused to be null. */
  cleared: boolean;
  /**
   * The mirror databases still on this origin. Non-empty means another TAB of this origin is
   * holding one open — an IndexedDB delete is blocked, not failed, while any connection lives
   * — so the mail is still here and the caller must say so rather than navigating away.
   */
  remaining: string[];
  /**
   * FALSE means a cleanup step was skipped or this browser could not be asked what it holds. Without `IDBFactory.databases()` and
   * no usable storage for the mirror registry — so an empty `remaining` proves only that the two
   * names we already knew are gone. It is a different sentence from a blocked wipe, with a
   * different remedy, and it must not read as a clean browser.
   */
  inventoryComplete: boolean;
  /** The server refused or was unreachable. The local half ran anyway; the caller is told. */
  serverRefused: string | null;
  replaced?: true;
  cacheCleanup?: {
    readonly state: "pending" | "complete" | "failed";
    readonly settled: Promise<void>;
  };
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
   * `revokeWake: false` leaves the shared browser wake subscription alone. Explicit sign-out's
   * server revocation removes the family's wake registration.
   */
  opts: {
    revokeWake?: boolean;
    /** Keep the pending marker and blocked binding until revocation and cleanup both finish. */
    serverHeld?: boolean;
    /**
     * TRUE: forget `owner` and nothing of anybody else — the erased-account door. Its mirror, its
     * boot caches and every store keyed to it go, its reply text included; another account's mirror
     * and keys on this browser stay. The jar-wide stores (reply buffers that name no account, the
     * session stamp, the wake registration, the face mirror) go as on sign-out: they belong to the
     * jar's session, which was this account's. The marker and this client's binding are touched only
     * when they name `owner`.
     */
    only?: boolean;
    /**
     * With `only`: the account was ERASED, so every other key naming it goes too, its preferences and this tab's
     * notes included ({@link forgetEveryKeyOf}). The erased doors pass it; a revoke keeps them, as a sign-out does.
     */
    erased?: boolean;
    /** How far the wipe may still reach, checked before each step. */
    reach?: () => WipeReach;
  } = {},
): Promise<{
  remaining: string[];
  inventoryComplete: boolean;
}> {
  const only = opts.only === true && owner !== undefined;
  /** May a step of this scope run against this browser now? */
  const may = (scope: "jar" | "account"): boolean => {
    const reach = opts.reach?.() ?? "jar";
    return reach === "jar" || (reach === "account" && scope === "account");
  };
  if (only) {
    if (readOwner() === owner && may("jar")) forgetOwner();
  } else if (opts.serverHeld) markSignedOutPending();
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
  if (only) { /* the binding is the erased door's wall, not a sign-out's */ }
  else if (opts.serverHeld) blockApiOwner();
  else bindApiOwner(null);
  /*
   * EVERY OTHER TAB OF THIS ACCOUNT LEAVES TOO, told once the marker has stopped naming it (a
   * receiving tab obeys only a jar that no longer does) and before the wipe, so no tab keeps
   * painting mail the next person at this browser would read. See `signed-out-signal.ts`.
   */
  if (may("account")) {
    postSignedOut(owner ?? null);
  }
  /* The sanitized documents this window kept per engine (`mail-doc-cache.ts`): mail, in memory. */
  if (may("jar")) forgetMailDocs();
  /*
   * The wake registration goes first, before the id that names it is swept. This browser is the only party that knows
   * which push row is its own (the server's prune is device-scoped and a browser ceremony mints no device row), and
   * the id lives in the very keys swept below — so the revoke runs while it is still readable
   * (`revokeWakeRegistration` for the three halves). On the erasure door the server rows went with the account, so
   * this drops the browser's own subscription. Explicit sign-out's server revocation prunes the
   * family's wake rows. Its serialized cleanup separately closes the browser's notices.
   */
  if (may("jar")) {
    if (opts.revokeWake !== false) await revokeWakeRegistration();
  }
  // The boot caches: the account's dormancy window, screening baseline and own addresses,
  // remembered so the next boot can paint the partitioned piles before the server answers
  // (`shell/boot-cache.ts`). Cleared by prefix, not by owner — this browser forgets, including
  // whatever an earlier account left behind.
  const boot = may("account")
    ? clearBootCaches(only ? owner : undefined, () => may("account"))
    : { survivors: [], enumerated: true };
  const survivors = [...boot.survivors];
  // The durable-decision stores, which are mail and are NOT in the mirror:
  // the send lanes, the Screener's intent journal, and the compose scratch
  // buffer — all `localStorage`, all owner-keyed, none under the boot-cache
  // prefix, so that sweep never touched them. An unfinished message is mail
  // text readable on a shared machine; a journalled Screener decision would
  // replay on a later sign-in; a send lane would outlive the session whose
  // key it holds. Scoping a key to an account is not what makes a sign-out
  // reach it: the compose scratch was account-scoped and the sweep was
  // simply never told. What it does is let a one-account wipe reach it.
  const durable = sweepFor(only ? owner! : null, [
    SEND_LOCKS_PREFIX,
    SUBJECT_DISPLAY_PREFIX,
    // The letters' Sent copy notes on the foot line: each names a recipient and a subject.
    SENT_COPY_NOTES_PREFIX,
    SCREENER_INTENTS_PREFIX,
    // The DELETE journal, for the Screener journal's reason exactly: it is a scheduled write
    // against a mailbox, owner-keyed, and left behind it would be replayed by whoever signs in
    // next on this browser — a message deleted out of somebody else's mailbox because a previous
    // account pressed Backspace and closed the tab. See `delete-intents.ts`.
    DELETE_INTENTS_PREFIX,
    // The ROUTING journal, for both of theirs: a held Move is a scheduled write against a
    // mailbox — a rule that files a sender's future mail — and left behind it would be made on
    // whoever signs in next. See `routing-intents.ts`.
    ROUTING_INTENTS_PREFIX,
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
    // The reply scratch buffers, which are the same thing one surface along: they hold the reply
    // body. A key that names no account (written before the keys named their owner, or with no
    // storage owner) is the jar's; one that does, `<prefix><owner>:<lane>`, is that account's.
    REPLY_DRAFT_PREFIX,
    REPLY_META_PREFIX,
    OWNED_REPLY_DRAFT_PREFIX,
    OWNED_REPLY_META_PREFIX,
    // The FACE's account-derived pair (OHMARCHY-PLAN.md §3a). `ohmail.face.account` is the
    // DEVICE'S MIRROR OF THE ACCOUNT'S ANSWER — cached so the next boot's pre-paint stamp can
    // wear it before `GET /consent` lands — which makes it account data in the only sense this
    // sweep cares about: left behind, it re-skins the NEXT account's first paint from the
    // departed account's preference; the account it names goes with it (`face-mirror.ts`).
    // `ohmail.faceOffer` is the Option B offer's dismissal, answered in the context of the
    // signed-in account; the next account on this device gets its own offer. The device's own
    // pins (`ohmail.face`, `ohmail.layout`) SURVIVE beside `ohmail.theme` — a browser's look,
    // not account data (the census names them).
    FACE_ACCOUNT_KEY,
    "ohmail.faceOffer",
    // The push row's id, the endpoint and the account it was minted for, all
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
    // `ohmail.notices.devices.told.<owner>`: the two numbers of the account's devices this browser
    // has told (`told-devices.ts`). They go with the account: kept, its next sign-in here would be
    // told of the device that sign-in itself made, and the key's name would hold an account's id
    // for the next person at this browser.
    TOLD_DEVICES_PREFIX,
    // `ohmail.ui.readingAlong.<owner>` — which mailboxes this install was told it is reading
    // along on purpose. Its `ohmail.ui.` siblings all survive a sign-out, and this one does not:
    // the VALUE carries the holder's own machine name, which is the account's (it is on the admin
    // DTO's deny-list for that reason), so leaving it behind would leave somebody's machine name
    // in a shared browser's jar. The intention costs one press to state again.
    READING_ALONG_PREFIX,
    // When this jar last received a session: it goes with the session it describes.
    SESSION_MINTED_KEY,
    // The name of a renewal whose answer never landed, which belongs to the same session.
    SESSION_ATTEMPT_KEY,
    // The mark of the last answer a live page received, which the late-answer watch reads.
    SESSION_ANSWER_KEY,
    // `ohmail.access.<owner>` — where the service last found this account. Left behind it would
    // decide the next account's first paint on this browser from somebody else's standing.
    ACCESS_VERDICT_PREFIX,
    // Why the splash sent a tab to the sign-in form, left for the other tabs: it goes with the session.
    SHARED_NOTE_KEY,
    // The erased-account word, which names an erased account's id (`shell/account-erased.ts`).
    // The erased door writes it after this sweep, so its own sweep never removes it.
    ERASED_KEY,
    // A revoke's wipe still owed (`revoked-door.ts`): a sign-out takes every one; the door drops its own.
    REVOKE_OWED_PREFIX,
  ], may);
  survivors.push(...durable.survivors);
  // The mirror-name registry is swept BY `clearAllMirrors` itself (it removes the names it proved
  // gone and keeps the ones it did not), so it is deliberately NOT in the prefix sweep above —
  // dropping it there would throw away the only record of a mirror this browser could not delete.
  /*
   * AND THE HALF OF `COMPOSE_ROW_PREFIX` THAT IS NOT IN A JAR. A browser refusing this app its
   * storage remembers the row the composer opened in memory for the life of the tab
   * (`forgetComposeRows`), and every reason the key above is swept applies to it: left behind, the
   * next sign-in's composer would be holding a row on the departed account. Unwrapped — it
   * touches no storage, so nothing here can throw.
   */
  let deviceCeremonySwept = true;
  if (may("jar")) {
    forgetComposeRows();
    const tab = forgetThisTab();
    deviceCeremonySwept = tab.deviceCeremonySwept;
    survivors.push(...tab.survivors);
    // The renewal name's durable copy, its own IndexedDB database (`session-refresh.ts`): it goes whole.
    survivors.push(...await forgetRenewalName());
  }
  const wipe = !may("account") ? { remaining: [], inventory: "complete" as const }
    : only ? await clearAllMirrors(owner, undefined, { only: true, mayDelete: () => may("account") })
      : await clearAllMirrors(owner);
  // Last: the mirror's own sweep has decided its registry record by now.
  const named = only && opts.erased === true && may("account") ? forgetEveryKeyOf(owner!) : null;
  return {
    remaining: [...survivors, ...wipe.remaining, ...(named?.survivors ?? [])].sort(),
    // EVERY store has to be answerable, not just the mirrors. A jar that could not be walked
    // names no survivors and proves nothing by it — see `dropLocalStorageKeys`'s catch.
    inventoryComplete: wipe.inventory === "complete" && boot.enumerated && durable.enumerated
      && deviceCeremonySwept && (named?.enumerated ?? true),
  };
}

/**
 * EVERY KEY NAMING AN ERASED ACCOUNT ({@link namesOwner}), in the jar and in this tab. Two records stay, each a
 * wipe still owed: the registry name of a mirror still on disk (`clearAllMirrors` drops it once the mirror is gone),
 * and a revoke's owed record, which its door drops itself. The id sets earlier builds kept device-wide go whole:
 * their values hold the account's folder paths and message ids under a key that names nobody.
 */
function forgetEveryKeyOf(owner: string): LocalSweep {
  const mirror = mirrorDbName(owner);
  const sweeps = [
    dropLocalStorageKeysWhere((k) => RETIRED_ID_SETS.includes(k)
      || (namesOwner(k, owner) && !k.endsWith(mirror) && !k.startsWith(REVOKE_OWED_PREFIX))),
    dropLocalStorageKeysWhere((k) => namesOwner(k, owner, true), "sessionStorage"),
  ];
  return { survivors: sweeps.flatMap((s) => s.survivors), enumerated: sweeps.every((s) => s.enumerated) };
}

/**
 * THIS TAB'S OWN NOTES, which no other tab's sweep can reach (`sessionStorage` is per tab): the
 * device-code handle, the wall's hand-off note, the late-answer watch and the splash's presentation
 * note. The sign-out's local half takes them, and so does a tab that leaves because another tab
 * signed out (`useSignedOutElsewhere`). Answers what could not be removed.
 */
export function forgetThisTab(): { survivors: string[]; deviceCeremonySwept: boolean } {
  retireTabWork();
  const survivors: string[] = [];
  const handleRemoved = retireDeviceSignIn();
  /*
   * The in-flight Microsoft device-code ceremony keeps its HANDLE in `sessionStorage` — per tab,
   * matching a fifteen-minute grant far better than a store that outlives the browser — so no
   * prefix sweep reaches it, and a tab reused by another account within the window still held the
   * previous account's record. The record carries no credential (the `device_code` never leaves
   * the server) and the reader refuses a record whose account id is not the signed-in one — that
   * check, not this line, makes another account's code unrenderable; this is the tidy-up. Wrapped
   * like every accessor here: a private window can make the accessor itself throw, and a sign-out
   * must not fail on a storage read.
   */
  let deviceCeremonySwept = true;
  try {
    sessionStorage.removeItem("ohmail.deviceCeremony");
  } catch {
    deviceCeremonySwept = false;
    survivors.push("ohmail.deviceCeremony");
  }
  if (!handleRemoved) {
    deviceCeremonySwept = false;
    survivors.push(DEVICE_SIGN_IN_KEY);
  }
  // The wall's note that this tab pressed the hand-off: an account id and a time, per tab.
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    deviceCeremonySwept = false;
    survivors.push(HANDOFF_KEY);
  }
  // The tab's late-answer watch note and the splash's presentation note (`session-refresh.ts`): an
  // account id, a renewal's name or the jar's mark, a time.
  const watchLeft = [...forgetLateAnswerWatch(), ...forgetSplashPresentation()];
  if (watchLeft.length > 0) {
    deviceCeremonySwept = false;
    survivors.push(...watchLeft);
  }
  return { survivors, deviceCeremonySwept };
}

/**
 * THE ACCOUNT'S UNSENT WORDS, as its sign-out's sweep takes them: the letter being written (its words, its session,
 * its row) and the replies (their words, their meta), every key that names `owner`, nothing of another account's and
 * nothing of the jar's. A TAB THAT LEARNS ITS ACCOUNT SIGNED OUT ELSEWHERE runs it once its mailbox has left
 * (`useSignedOutElsewhere`): its composer's leaving save writes as it goes, after the signing tab's sweep ran, and a
 * closing page hands what it holds to the account's slot. After this a composer that is gone writes nothing more:
 * its save stands only beside its stored letter (`compose-autosave.ts`, `reply-autosave.ts`). The remembered row in
 * this tab's memory goes with them. Answers what could not be removed.
 */
const UNSENT_WORDS: readonly string[] = [
  COMPOSE_DRAFT_PREFIX, COMPOSE_SESSION_PREFIX, COMPOSE_ROW_PREFIX, OWNED_REPLY_DRAFT_PREFIX, OWNED_REPLY_META_PREFIX,
];

export function forgetUnsentWordsOf(owner: string, mayRemove: () => boolean): LocalSweep {
  forgetComposeRows();
  return sweepFor(owner, UNSENT_WORDS, (scope) => scope === "account" && mayRemove());
}

/**
 * The prefixes whose keys are `<prefix><owner>…` — read off each module's key function. The rest
 * of the sweep's list names its account beside it ({@link OWNER_TAGGED}), names none (a message
 * id, an old reply key), or belongs to the jar's session.
 */
const OWNER_KEYED: readonly string[] = [
  SUBJECT_DISPLAY_PREFIX,
  SEND_LOCKS_PREFIX, SENT_COPY_NOTES_PREFIX, SCREENER_INTENTS_PREFIX, DELETE_INTENTS_PREFIX, ROUTING_INTENTS_PREFIX,
  COMPOSE_DRAFT_PREFIX, COMPOSE_SESSION_PREFIX, COMPOSE_ROW_PREFIX, READING_ALONG_PREFIX,
  ACCESS_VERDICT_PREFIX, OWNED_REPLY_DRAFT_PREFIX, OWNED_REPLY_META_PREFIX, TOLD_DEVICES_PREFIX,
];

/**
 * The jar-wide entries that name their account in a key of their own, under the same prefix: the
 * face mirror and the push id. A one-account wipe takes them when they name that account.
 */
const OWNER_TAGGED: ReadonlyMap<string, string> = new Map([
  [FACE_ACCOUNT_KEY, FACE_ACCOUNT_OWNER_KEY],
  [NOTIFICATION_SUBSCRIPTION_PREFIX, SUBSCRIPTION_OWNER_KEY],
]);

/**
 * How far a one-account wipe may still reach (`forgetThisBrowser`'s `reach`): `jar` takes all of it;
 * `account` only that account's own stores, because another session holds the jar now; `none` takes
 * nothing more, because that account's session is back.
 */
export type WipeReach = "jar" | "account" | "none";

/**
 * The sweep, whole (`owner` null) or for ONE account: an owner-keyed prefix then matches only
 * `<prefix><owner>`, an owner-tagged entry goes with the jar or when its tag names `owner`, and the
 * legacy compose key only itself — as a prefix it would also match every account's
 * `ohmail.ui.compose.<owner>.` buffers. A one-account sweep never takes a revoke's owed record: the
 * door drops its own once the copy is proved gone.
 */
function sweepFor(owner: string | null, list: readonly string[], may: (scope: "jar" | "account") => boolean) {
  if (owner === null) return dropLocalStorageKeys(list);
  const ownsKey = (key: string) => list.some((p) => {
    if (p === REVOKE_OWED_PREFIX) return false;
    if (OWNER_KEYED.includes(p)) {
      const owned = `${p}${owner}`;
      return (key === owned || key.startsWith(`${owned}:`) || key.startsWith(`${owned}.`)) && may("account");
    }
    if (p === LEGACY_COMPOSE_DRAFT_KEY ? key !== p : !key.startsWith(p)) return false;
    const tag = OWNER_TAGGED.get(p);
    return may("jar") || (tag !== undefined && readTag(tag) === owner && may("account"));
  });
  return dropLocalStorageKeysWhere(ownsKey, "localStorage", ownsKey);
}

/** The account an owner-tagged entry names, or `null`: none, or a jar that cannot be read. */
function readTag(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

const tabRetirement = new Set<() => void>();

/** End account-bound work as soon as this tab leaves its account. */
export function subscribeTabRetirement(retire: () => void): () => void {
  tabRetirement.add(retire);
  return () => { tabRetirement.delete(retire); };
}

function retireTabWork(): void {
  for (const retire of tabRetirement) retire();
}

/** Sign-out presses per page, by tab name (a test runs two tabs in one document). */
const presses = new Map<string, { count: number; family: string | null; markerFamily: string | null; finished?: boolean }>();

/**
 * This page's Sign out presses. A mailbox that sees the count move after it mounted has its own press
 * to report (a wipe another tab blocked) while its pending sign-out owns the jar.
 * The pending sign-out's finisher is no press, and a mailbox mounted after either still leaves on return.
 */
export function signOutPresses(tab: string = thisTabName()): number {
  return presses.get(tab)?.count ?? 0;
}

export function ownsPendingSignOut(tab: string, since: number): boolean {
  const press = presses.get(tab);
  if (!press || press.finished || press.count <= since || readOwnerMarker().kind !== "signed-out") return false;
  const current = readSessionFamily();
  return current === press.family || (current === null && press.markerFamily === null);
}

/**
 * `mayProceed` is the pending sign-out's finisher's (`login/finish-sign-out.ts`) and nobody else's: may
 * this call still end the jar it started on? Asked inside the cookie lock before the door is asked,
 * and after a refusal before anything local is touched. False means another tab signed in (or
 * finished this sign-out) meanwhile; the answer is then `null`, and neither half has run.
 */
export function signOut(owner?: string, opts?: { expectedFamily?: string }): Promise<SignOutResult>;
export function signOut(owner: string | undefined, opts: { mayProceed: () => boolean; pending?: PendingSignOut | null }): Promise<SignOutResult | null>;
export async function signOut(
  owner?: string,
  opts: { mayProceed?: () => boolean; expectedFamily?: string; pending?: PendingSignOut | null } = {},
): Promise<SignOutResult | null> {
  /*
   * PENDING FROM THE PRESS, before any await: from here every gate reads a sign-out (the edge sends a
   * new tab to the sign-in page, the manage hand-off, the sync gate, this client's verdict, a tab booting
   * from an earlier answer) and the account's other tabs leave. The serialized clear retires it once revocation and cleanup finish.
   * The finisher's jar is already pending.
   */
  const named = opts.mayProceed === undefined ? readOwner() : null;
  const markerFamily = readSessionFamily();
  const confirmedOwner = opts.mayProceed === undefined ? boundApiOwner?.() ?? null : null;
  const finishing = opts.mayProceed !== undefined;
  const remembered = readPendingSignOut();
  const pending = finishing ? (opts.pending === undefined ? remembered : opts.pending) : null;
  const family = finishing ? (pending === null ? markerFamily : pending.family)
    : opts.expectedFamily ?? (confirmedOwner === null ? null : boundApiFamily?.(confirmedOwner)) ?? markerFamily;
  const ownsFamily = () => {
    const current = readSessionFamily();
    return current === family || (current === null && markerFamily === null);
  };
  const changed = (): SignOutResult | null => opts.mayProceed ? null
    : { cleared: false, remaining: [], inventoryComplete: false, serverRefused: null, replaced: true };
  if (!ownsFamily() || (named !== null && (owner ?? confirmedOwner ?? named) !== named)
    || (confirmedOwner !== null && named !== null && confirmedOwner !== named)) return changed();
  const departed = finishing ? pending?.account ?? undefined : owner ?? named ?? confirmedOwner ?? undefined;
  let provedOwner = departed !== undefined && (
    named === departed || confirmedOwner === departed || pending?.account === departed
    || (readOwnerMarker().kind === "signed-out" && remembered?.account === departed && remembered.family === family)
  );
  const count = signOutPresses() + 1;
  let operation: PendingSignOut | null = finishing ? pending : departed === undefined || !provedOwner ? null : {
    press: `${thisTabName()}.${count}`, account: departed, family, isolatedScope: readIsolatedScope(departed, family),
  };
  let recorded = false;
  const ownsOperation = (requireRecord = false) => {
    const current = readPendingSignOut();
    if (current === null) return !requireRecord && (finishing ? operation === null : !recorded);
    return current?.press === operation?.press && current?.account === operation?.account
      && current?.family === operation?.family;
  };
  const mayProceed = () => ownsFamily() && ownsOperation()
    && readOwnerMarker().kind === "signed-out" && (opts.mayProceed?.() ?? true);
  if (!finishing) {
    presses.set(thisTabName(), { count, family, markerFamily });
    if (operation !== null) {
      recorded = durableSet(PENDING_SIGN_OUT_KEY, JSON.stringify(operation), "session.signOut") === "stored";
    }
    markSignedOutPending();
    postSessionChange();
    if (operation !== null) {
      retainAccountCleanup(operation);
      retainRetiredComposeCleanup(operation);
    }
    retireTabWork();
    retireDeviceSignIn();
    postSignedOut(owner ?? null);
    postSessionChange();
    // A tab closed before the door's request below left still sends it, from `pagehide`.
    auth.armLogoutOnLeave(family ?? undefined, mayProceed, departed);
  }
  let serverRefused: string | null = null;
  try {
    if (!mayProceed()) return changed();
    retainRetiredCleanup(operation ?? { press: thisTabName(), account: null, family });
    if (!finishing || pending?.revoked !== true) {
      await auth.logout({ mayProceed, expectedFamily: family ?? undefined, expectedAccount: departed });
      if (!provedOwner && departed !== undefined && family !== null && mayProceed()) {
        // The successful door checked the expected account against the credential it revoked.
        provedOwner = true;
        operation = {
          press: `${thisTabName()}.${count}`, account: departed, family,
          isolatedScope: readIsolatedScope(departed, family),
        };
        recorded = durableSet(PENDING_SIGN_OUT_KEY, JSON.stringify(operation), "session.signOut") === "stored";
      }
    }
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    const coded = (err as { wire?: { coded?: unknown } } | null)?.wire?.coded === true;
    const alreadyGone = status === 401 && coded;
    serverRefused = alreadyGone ? null : err instanceof Error ? err.message : String(err);
  }

  const result = (local: Awaited<ReturnType<typeof forgetThisBrowser>>): SignOutResult => ({
    cleared: local.remaining.length === 0 && local.inventoryComplete,
    remaining: local.remaining,
    inventoryComplete: local.inventoryComplete,
    serverRefused,
  });

  // A confirmed result retires the shell immediately. Its navigation follows the local wipe.
  if (serverRefused === null && mayProceed()) {
    if (operation?.revoked !== true) {
      const confirmed = { ...(operation ?? { press: thisTabName(), account: null, family }), revoked: true };
      if (durableSet(PENDING_SIGN_OUT_KEY, JSON.stringify(confirmed), "session.signOut") === "stored") {
        operation = confirmed;
        recorded = true;
      }
    }
    if (!finishing) {
      const press = presses.get(thisTabName());
      if (press?.count === count) press.finished = true;
      postLocalSignOut();
    }
    postSessionChange();
  }
  const mayWipeJar = () => readSessionFamily() === family && mayProceed() && ownsOperation(true);
  if (family !== null && departed !== undefined && provedOwner && mayWipeJar() && auth.clearLogoutCookies) {
    const shared = await new Promise<SignOutResult | null>((done) => {
      void withSessionCookieLock(async () => {
        if (!mayWipeJar() || !await clearBrowserWakeNotices() || !mayWipeJar()) return;
        // Keep the pending marker visible until the local stores have been checked.
        const local = await forgetThisBrowser(departed, {
          revokeWake: false, serverHeld: true, reach: () => mayWipeJar() ? "jar" : "none",
        });
        if (!mayWipeJar()) return;
        const base = result(local);
        if (serverRefused !== null || !base.cleared) {
          if (!base.cleared && operation !== null) {
            retainAccountCleanup(operation);
            retainRetiredCleanup(operation);
          }
          done(base);
          return;
        }
        const fences = clearAccountCleanup();
        if (!fences.enumerated || fences.survivors.length > 0) {
          done(result({ ...local, inventoryComplete: false }));
          return;
        }
        await auth.clearLogoutCookies(family);
        const ownsClearedJar = () => readOwnerMarker().kind === "absent"
          && readSessionFamily() === null && ownsOperation(true);
        if (!ownsClearedJar()) return;
        bindApiOwner(null);
        if (operation === null || durableSet(PENDING_SIGN_OUT_KEY,
          JSON.stringify({ ...operation, cachePending: true }), "session.signOut") === "lost") {
          done(result({ ...local, inventoryComplete: false }));
          return;
        }
        let state: NonNullable<SignOutResult["cacheCleanup"]>["state"] = "pending";
        const settled = purgeDepartedCache(ownsClearedJar).then((purged) => {
          state = purged && durableRemove(PENDING_SIGN_OUT_KEY, "session.signOut") !== "lost" ? "complete" : "failed";
        });
        done({
          ...base,
          get cleared() { return state === "complete"; },
          cacheCleanup: { get state() { return state; }, settled },
        });
        // Keep cookie writers out while this origin-wide request is in flight.
        await settled;
      }, { requireLock: true }).then(() => done(null), () => done(null));
    });
    if (shared !== null) return shared;
  }

  // The jar may have changed hands during revocation. Only the departed account's own copy and
  // this document's notes can be removed here. A replacement of the same account keeps its copy.
  const tab = mayProceed() ? forgetThisTab() : { survivors: [] };
  if (mayProceed()) {
    forgetMailDocs();
    forgetComposeRows();
  }
  const reach = (): WipeReach => {
    if (!provedOwner) return "none";
    const current = readOwner();
    if (current !== null) return current === departed ? "none" : "account";
    return readSessionFamily() === family && mayProceed() ? "account" : "none";
  };
  const maySweepAccount = departed !== undefined && reach() !== "none";
  const local = !maySweepAccount
    ? { remaining: [], inventoryComplete: true }
    : await forgetDepartedScope(departed, operation?.isolatedScope, reach);
  const obligation = operation ?? { press: thisTabName(), account: null, family };
  if (serverRefused === null && mayProceed() && operation?.account != null) retainRetiredComposeCleanup(operation);
  if (readOwner() !== null) finishRetiredComposeCleanup();
  if (mayProceed()) retainRetiredCleanup(obligation);
  if (mayProceed() || provedOwner) {
    if (!maySweepAccount || !local.inventoryComplete || local.remaining.length > 0) {
      if (mayProceed() || (readOwner() !== departed && readOwner() !== null)) retainAccountCleanup(obligation);
    } else if (departed !== undefined && accountCleanup(departed)?.press === obligation.press) {
      confirmAccountCleanup(departed);
    }
  }
  if (!mayProceed()) return changed();
  blockApiOwner();
  return result({
    remaining: [...local.remaining, ...tab.survivors],
    inventoryComplete: false,
  });
}

async function forgetDepartedScope(departed: string, isolatedScope: string | undefined, reach: () => WipeReach) {
  const local = await forgetThisBrowser(departed, { only: true, revokeWake: false, reach });
  if (reach() === "none") return { ...local, inventoryComplete: false };
  if (!isolatedScope) return local;
  const isolated = await forgetThisBrowser(isolatedScope, { only: true, revokeWake: false, reach });
  return {
    remaining: [...local.remaining, ...isolated.remaining],
    inventoryComplete: local.inventoryComplete && isolated.inventoryComplete && reach() !== "none",
  };
}

/** Finish outstanding account storage before a newly confirmed shell can open that scope. */
export async function finishAccountCleanup(owner: string, family: string | null, target = owner): Promise<boolean> {
  const operation = accountCleanup(target);
  if (operation?.account !== target) return operation === null;
  const ownsAttempt = () => accountCleanup(target)?.press === operation.press
    && readOwner() === owner && readSessionFamily() === family && family !== operation.family;
  if (!ownsAttempt()) return accountCleanup(target) === null;
  const local = await forgetDepartedScope(target, operation.isolatedScope, () => ownsAttempt() ? "account" : "none");
  if (ownsAttempt() && local.inventoryComplete && local.remaining.length === 0) {
    return confirmAccountCleanup(target) && accountCleanup(target)?.press !== operation.press;
  }
  return accountCleanup(target) === null;
}

export async function finishOtherAccountCleanup(owner: string, family: string | null): Promise<void> {
  for (const target of otherAccountCleanup(owner)) await finishAccountCleanup(owner, family, target);
}

let retryingCache: { press: string; completion: Promise<boolean> } | undefined;

export async function retryPendingCacheCleanup(): Promise<boolean | null> {
  const operation = readPendingSignOut();
  const ownsJar = () => readOwnerMarker().kind === "absent"
    && readSessionFamily() === null && readPendingSignOut()?.press === operation?.press;
  if (operation?.cachePending !== true || !ownsJar()) return null;
  if (retryingCache?.press === operation.press) return retryingCache.completion;
  const completion = withSessionCookieLock(async () => {
    if (!ownsJar()) return readPendingSignOut() === null;
    if (!await purgeDepartedCache(ownsJar)) return false;
    return durableRemove(PENDING_SIGN_OUT_KEY, "session.signOut") !== "lost";
  }, { requireLock: true }).catch(() => false);
  retryingCache = { press: operation.press, completion };
  try {
    return await completion;
  } finally {
    if (retryingCache?.completion === completion) retryingCache = undefined;
  }
}

async function purgeDepartedCache(ownsJar: () => boolean): Promise<boolean> {
  let leaving = false;
  for (let attempt = 0; attempt < 2 && ownsJar() && !leaving; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<false>((resolve) => {
      const stop = () => { controller.abort(); resolve(false); };
      timer = setTimeout(stop, 2_000);
    });
    const leave = () => { leaving = true; controller.abort(); };
    window.addEventListener("pagehide", leave);
    try {
      const purged = await Promise.race([purgeSiteCache(controller.signal), interrupted]);
      if (purged && ownsJar()) return true;
    } finally {
      window.removeEventListener("pagehide", leave);
      clearTimeout(timer);
    }
  }
  return false;
}


/** A live account with unfinished browser cleanup keeps the Account pane open. */
export function signOutStayReason(outcome: SignOutResult): "unverified" | "blocked" | null {
  const trouble = signOutTrouble(outcome);
  if (trouble === null || trouble.key === "signOutServerRefused"
    || outcome.replaced || readOwnerMarker().kind !== "account") return null;
  return trouble.key === "signOutUnverified" ? "unverified" : "blocked";
}

/** A retired tab may offer local cleanup only while the same confirmed sign-out owns the browser. */
export function confirmedLocalCleanup(outcome: SignOutResult, account: string, family: string | undefined) {
  const trouble = signOutTrouble(outcome);
  if (trouble?.key !== "signOutBlocked" && trouble?.key !== "signOutUnverified") return null;
  const pending = readPendingSignOut();
  if (!pending?.revoked || pending.account !== account || pending.family !== (family ?? null)) return null;
  const holds = () => {
    const current = readPendingSignOut();
    return readOwnerMarker().kind === "signed-out" && readSessionFamily() === pending.family
      && current?.revoked === true && current.press === pending.press
      && current.account === pending.account && current.family === pending.family;
  };
  const reason = trouble.key === "signOutBlocked" ? "blocked" : "unverified";
  return holds() ? { reason, holds } as const : null;
}
