/**
 * WHAT THE DOOR PAGE IS TOLD, as it crosses: a refusal as its key and arguments, the connection as rows and words, a
 * probe as what it measured. Pure readings of the connection layer's own values; nothing here dials or stores, and
 * nothing here hands on a credential: a row's token is read only as "has one", a code and a password never.
 */
import { organizesHere } from "../engine/standalone-door";
import type { Connection } from "../net/connection";
import { isNotTls, isPinFailure } from "../net/host-pinning";
import {
  MANAGED_ORIGIN, parsePairLink, shortPin, unreachableSaid, type Negotiation, type PairAdmission, type PickerStep,
} from "../net/pairing";
import { refuse, type Refusal, type RefusalArg, type RefusalKey } from "../refusal";
import { gateFor } from "../state/gate";
import type { ServerProfile } from "../state/servers";
import { EMPTY_STANDALONE, type StandaloneFields } from "../ui/standalone-form";
import {
  SAID_ARG_MAX, SAID_DEPTH, type DoorAt, type DoorMigrating, type DoorState, type OpenInput, type PairFacts, type PairedRow,
  type SaidRefusal,
} from "./door-kinds";

/** The part of the connection the door stands on. */
export type DoorConnection = Pick<
  Connection,
  | "state" | "syncing" | "syncError" | "profiles" | "activeId" | "ask" | "probeBase" | "probePair" | "pairConfirmed" | "signIn"
  | "openStandalone" | "switchTo" | "forget" | "erasedCalendarScopes" | "unsentDraftsHere" | "disconnect" | "syncNow"
>;

/**
 * A refusal as it crosses: its key and its arguments. An argument that repeats a secret this side holds (a code, a
 * password), or that is a whole pairing link, crosses empty; one over the bound is cut; one deeper than the bound is dropped.
 */
export function said(r: Refusal, secrets: readonly string[] = [], depth = 1): SaidRefusal {
  const arg = (a: RefusalArg): string | SaidRefusal => {
    if (typeof a === "object" && a !== null) return depth < SAID_DEPTH ? said(a, secrets, depth + 1) : "";
    const text = String(a);
    if (secrets.some((secret) => secret !== "" && text.includes(secret)) || parsePairLink(text) !== null) return "";
    return text.slice(0, SAID_ARG_MAX);
  };
  return { code: r.say, args: (r.args ?? []).map(arg) };
}

/** Every refresh token this phone holds or is trying: a refusal of the connection's that quotes one crosses without it. */
export function heldTokens(profiles: readonly ServerProfile[]): string[] {
  return profiles.flatMap((p) => [p.refreshToken, p.refreshAttempt]).filter((t): t is string => t !== null && t !== "");
}

/** The sentence a negotiation that offers no pairing ends on: one table of clauses with the pairing probe's. */
export function negotiationSaid(n: Negotiation, step?: PickerStep): Refusal {
  if (n.kind === "unreachable") {
    if (isNotTls(n.detail)) return refuse("notEncrypted");
    const clause = unreachableSaid(n.detail);
    return clause === null ? refuse("unreachable") : refuse("unreachableWhy", clause);
  }
  if (n.kind === "not-ohmail") return refuse("notOhmail");
  return step?.kind === "managed-signin-later" ? refuse("managedDeferred") : refuse("noPairing");
}

/** Hosted is said of the hosted address alone: any server's first word can say "managed". */
const hosted = (flavor: string, origin: string): boolean => flavor === "managed" && origin === MANAGED_ORIGIN;

/** What a probe measured, as the confirmation draws it: never a field of the link. */
export function factsOf(admission: PairAdmission): PairFacts {
  const what = admission.flavor === "desktop-host" ? "computer" : hosted(admission.flavor, admission.origin) ? "hosted"
    : admission.flavor === "local" ? "local" : "server";
  return { what, address: admission.origin, key: admission.pin === null ? null : shortPin(admission.pin) };
}

function rowOf(p: ServerProfile, activeId: string | null): PairedRow {
  const own = organizesHere(p);
  const needsPair = !own && p.refreshToken === null;
  return {
    id: p.id,
    kind: own ? "own" : hosted(p.flavor, p.origin) ? "hosted"
      : p.flavor === "desktop-host" || p.flavor === "local" ? "computer" : "server",
    address: own ? "" : p.origin,
    account: own || needsPair ? null : p.accountId,
    open: p.id === activeId,
    needsPair,
  };
}

/**
 * A store's upgrade as the door says it: only under the connect that waits on it, and only where the boot screen
 * counts one (a store that is not fresh, more than one entry owed). A first launch's empty store and a single entry
 * are over before anybody reads a number.
 */
function migratingOf(s: DoorConnection["state"]): DoorMigrating | null {
  const m = s.k === "connecting" ? s.migrating : undefined;
  if (m === undefined || m.fresh || m.pending <= 1) return null;
  return { applied: m.applied, pending: m.pending, since: m.since };
}

/** The connection as the door draws it. Under the shell this side holds no mail, so it counts none. */
export function doorStateOf(conn: DoorConnection, after: SaidRefusal | null): DoorState {
  const s = conn.state;
  const open = s.k === "live" || s.k === "shell" ? s.session.profile : null;
  const sync = conn.syncError;
  const pinned = open !== null && open.pin !== null;
  /* A handshake that failed is said by which of the two it is (`copy.en.ts`, `connectSyncFailed`), never in the
     platform's own words. */
  const stopped = sync !== null && isPinFailure(sync);
  const held = heldTokens(conn.profiles);
  return {
    session: open !== null ? "live" : s.k === "connecting" ? "opening" : s.k === "refused" ? "refused" : s.k === "ended" ? "ended" : "none",
    migrating: migratingOf(s),
    said: s.k === "refused" || s.k === "ended" ? said(s.reason, held) : null,
    openId: open?.id ?? null,
    syncing: conn.syncing,
    syncSaid: sync === null || stopped ? null : said(typeof sync === "object" ? sync : refuse("verbatimDetail", sync), held),
    syncStopped: stopped ? (pinned ? "keyChanged" : "certificate") : null,
    pinned,
    total: null,
    paired: conn.profiles.map((p) => rowOf(p, conn.activeId)),
    after,
  };
}

/** The page a door opens at: where it was asked to, else welcome with nothing paired and nothing to say, else the list. */
export function doorAtOf(asked: DoorAt | null, conn: Pick<DoorConnection, "state" | "profiles">): DoorAt {
  return asked ?? (gateFor(conn.state, conn.profiles.length).to === "welcome" ? "welcome" : "servers");
}

/** A forget's refusals after which nothing of the pairing is left on this phone: what stands is elsewhere. */
const GONE_ALL_THE_SAME: Partial<Record<RefusalKey, true>> = {
  forgetServerUnreachable: true, forgetServerEnded: true, forgetServerOwed: true, forgetClaimStands: true,
};
export const leavesNothingHere = (reason: Refusal): boolean => GONE_ALL_THE_SAME[reason.say] === true;

/** The typed mailbox as the engine's open reads it. The password is read here, once. */
export function fieldsOf(input: Omit<OpenInput, "pass">, password: string): StandaloneFields {
  const port = (p: number | null) => (p === null ? "" : String(p));
  return {
    ...EMPTY_STANDALONE,
    address: input.address,
    password,
    name: input.name ?? "",
    imapHost: input.imap.host,
    imapPort: port(input.imap.port),
    smtpHost: input.smtp?.host ?? "",
    smtpPort: port(input.smtp?.port ?? null),
  };
}

