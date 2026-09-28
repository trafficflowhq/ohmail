import { OUTBOX_UNKEYED_CREATE_TTL_MS } from "./engine.js";
import { senderKey } from "./own-address.js";
import { FOLDER_OF_VIEW, type ScreenDest } from "./types.js";
import type { DurableWrite, StorageDoor } from "./durable.js";

/**
 * A ROUTING PRESS, ON DISK BEFORE ITS WINDOW OPENS — recording the press's INPUTS and never the
 * mutations it planned. `rule_create` mints its optimistic row id at effect time, so a journalled
 * plan replayed at the next launch is a different row under a different idempotency key: a commit
 * that reached the wire and died before clearing its record would write the rule twice. So this
 * holds what the press was ABOUT and the commit re-plans through the same ladder, whose `already`
 * arm writes nothing — which is what makes the replay idempotent.
 */

/** One press, and every message it named. */
export interface RoutingIntent {
  v: 1;
  /** A press id, so a replay can tell two presses apart and clear exactly one. */
  id: string;
  /** The message the plan is seeded from — re-read at commit, and gone is a real answer. */
  seedId: string;
  /** The subject's address, case as written. `senderKey` folds it for the subject. */
  address: string;
  /**
   * SENDER SCOPE ONLY, and the type says so. A domain press widens both halves of a decision
   * and carries a server-side backlog pass that no window here could hold back, so it keeps its
   * own immediate path and its own sentence.
   */
  scope: "sender";
  /**
   * WHERE IT FILES, in the PLANNER's vocabulary and not the folder's. The commit re-plans, and
   * the ladder is asked in views; the overlay maps the same value through `FOLDER_OF_VIEW`, so
   * the place shown and the place planned cannot be given different answers.
   */
  dest: ScreenDest;
  /** The ids the press NAMED — the overlay's set, and what the mail half moved. */
  messageIds: string[];
  /**
   * WHERE THE PRESS WAS MADE FROM, for a surface whose ladder needs it. The phone's Move
   * retargets the rules holding this sender's mail AT THE PLACE IT WAS SHOWN, so its re-plan
   * cannot be derived from the destination alone. Optional because the webapp's ladder reads the
   * sender's whole standing set and has no use for it — and because a row written by a build
   * that did not carry it must still replay.
   */
  from?: string;
  /** Epoch ms at the press, from the caller's clock. */
  at: number;
}

/**
 * A SENDER-SHEET PRESS, v2 — its own jar ({@link screenIntentsKey}), because an older build's loader
 * drops a row with `v !== 1` and its next save rewrites the jar without it, and a v1 row an older
 * build CAN read would be replayed through that build's ladder without its answers. It carries the
 * sheet's answers the commit needs: the rule toggle, the past-mail answer, and what to do with the
 * rules the step showed — by id and fingerprint only, never their terms.
 */
export interface ScreenIntent {
  v: 2;
  verb: "screen";
  id: string;
  seedId: string;
  address: string;
  scope: "sender";
  dest: ScreenDest;
  messageIds: string[];
  makeRule: boolean;
  applyRetro: boolean;
  resolution: "remove" | "keep";
  /** The rules the step showed, at most {@link SCREEN_SHOWN_MAX}; `fp` is `ruleFingerprint`. */
  shown: { id: string; fp: string }[];
  at: number;
}

/**
 * A SCREENER DECISION, v3 — its own jar ({@link decideIntentsKey}) for v2's reason. It records the
 * decision's inputs and never its mutations: the commit re-reads the mirror, deciding a
 * representative still held at the gate and ruling one past it. Sender OR domain, because nothing
 * of a decision leaves at the press: the whole answer, backlog pass included, waits for the close.
 */
export interface DecideIntent {
  v: 3;
  verb: "decide";
  id: string;
  /** The row's representative — the message a `screener_decide` names. */
  seedId: string;
  address: string;
  scope: "sender" | "domain";
  dest: ScreenDest;
  /** The "&read" answer: a let-in files the held mail seen. */
  read: boolean;
  /** The held ids — the overlay's set and the read batch's. */
  messageIds: string[];
  at: number;
}

/**
 * A SCREENER RELEASE, v4 — Allow, Not spam, back to Waiting — its own jar ({@link releaseIntentsKey})
 * for v2's reason. The mail moved at the press; the commit re-reads the rules holding the sender
 * at `from` and writes the release's rule change then. `screener` is back to Waiting, which only
 * deletes the sender's own holding rules.
 */
export interface ReleaseIntent {
  v: 4;
  verb: "release";
  id: string;
  seedId: string;
  address: string;
  scope: "sender";
  /** The pile the sender was released from, as a folder: Screened out or Quarantine. */
  from: string;
  dest: ScreenDest | "screener";
  messageIds: string[];
  at: number;
}

/** Any row the phone's and the web's shared windows hold. */
export type AnyRoutingIntent = RoutingIntent | ScreenIntent | DecideIntent;

/** Any row a journal jar holds: the shared rows and the web Screener's releases. */
export type JarIntent = AnyRoutingIntent | ReleaseIntent;

export const SCREEN_SHOWN_MAX = 20;

/** The screen jar sits under the v1 jar's name, so the sign-out sweep of the prefix covers it. */
export function screenIntentsKey(key: string): string {
  return `${key}.screen`;
}

/** The decide jar, under the same name for the same sweep. */
export function decideIntentsKey(key: string): string {
  return `${key}.decide`;
}

/** The release jar, under the same name for the same sweep. */
export function releaseIntentsKey(key: string): string {
  return `${key}.release`;
}

/**
 * WHOSE ROUTING — and the key supersession is decided on. A second press about one sender inside
 * one window is not two decisions: it is a change of mind, and only the last may be written.
 * Keyed on the subject and NOT on subject+place, because Reads-then-Receipts IS that change of
 * mind and keeping both would write two rules for one sender.
 */
export function routingSubject(i: Pick<JarIntent, "scope" | "address"> & { v?: JarIntent["v"] }): string {
  /* A DECISION IS ITS OWN SUBJECT: a Move of one of the sender's letters inside the window is not
     a change of mind about whether they may write, so it must not drop the decision unsent. */
  if (i.v === 3) {
    const key = senderKey(i.address);
    return `decide:${i.scope}:${i.scope === "domain" ? key.slice(key.lastIndexOf("@") + 1) : key}`;
  }
  return `${i.scope}:${senderKey(i.address)}`;
}

/**
 * How long a stranded routing press is still the reader's word — the engine outbox's own horizon,
 * IMPORTED rather than restated. Inside it the press is obviously still meant; past it the account
 * has moved on (rules revoked, mail refiled, the sender decided on another device) and writing a
 * day-old rule into it is a surprise, not a restoration. A fourth 24-hour literal in this tree
 * would be a fourth thing to keep in step.
 */
export const ROUTING_INTENT_TTL_MS = OUTBOX_UNKEYED_CREATE_TTL_MS;

/** Every owner's journal key starts here. Exported so a sign-out can sweep them. */
export const ROUTING_INTENTS_PREFIX = "ohmail.routing.intents.";

export function routingIntentsKey(owner: string | null): string {
  return `${ROUTING_INTENTS_PREFIX}${owner ?? "local"}`;
}

/**
 * How many open presses one jar holds, and how many ids one press carries. Bounds rather than
 * caps anybody reaches: past them the oldest row and the newest ids are dropped rather than the
 * write refused, because a quota rejection would take the whole journal with it — the failure
 * the journal exists to prevent. The id list is the overlay's, so losing its tail costs a row's
 * placement for the rest of a window and never the press.
 */
export const ROUTING_INTENTS_MAX = 100;
export const ROUTING_INTENT_IDS_MAX = 200;

export function isRoutingIntent(x: unknown): x is RoutingIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 1
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.seedId === "string" && r.seedId.length > 0
    && typeof r.address === "string" && r.address.length > 0
    && r.scope === "sender"
    /* A DESTINATION THIS BUILD CAN ACT ON, or the row is not one: `screener` is where mail is
       held and never a place consent can choose, and an unknown view names a folder we would
       have to invent. */
    && typeof r.dest === "string" && r.dest !== "screener"
    && Object.prototype.hasOwnProperty.call(FOLDER_OF_VIEW, r.dest)
    && Array.isArray(r.messageIds) && r.messageIds.every((m) => typeof m === "string")
    && (r.from === undefined || (typeof r.from === "string" && r.from.length > 0))
    && typeof r.at === "number" && Number.isFinite(r.at);
}

/**
 * A v2 row, or not one. ABSENT ANSWERS ARE REFUSED, never defaulted: a row without its resolution
 * would commit as "keep" and say the mail goes there, and one without `applyRetro` would pick the
 * backlog answer for the person.
 */
export function isScreenIntent(x: unknown): x is ScreenIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const shown = r.shown;
  return r.v === 2 && r.verb === "screen"
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.seedId === "string" && r.seedId.length > 0
    && typeof r.address === "string" && r.address.length > 0
    && r.scope === "sender"
    && typeof r.dest === "string" && r.dest !== "screener"
    && Object.prototype.hasOwnProperty.call(FOLDER_OF_VIEW, r.dest)
    && Array.isArray(r.messageIds) && r.messageIds.every((m) => typeof m === "string")
    && typeof r.makeRule === "boolean" && typeof r.applyRetro === "boolean"
    && (r.resolution === "remove" || r.resolution === "keep")
    && Array.isArray(shown) && shown.length <= SCREEN_SHOWN_MAX
    && shown.every((e) => typeof e === "object" && e !== null
      && typeof (e as { id?: unknown }).id === "string" && typeof (e as { fp?: unknown }).fp === "string")
    && typeof r.at === "number" && Number.isFinite(r.at);
}

/** A v3 row, or not one — the same refusal of absent answers as {@link isScreenIntent}. */
export function isDecideIntent(x: unknown): x is DecideIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 3 && r.verb === "decide"
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.seedId === "string" && r.seedId.length > 0
    && typeof r.address === "string" && r.address.length > 0
    && (r.scope === "sender" || r.scope === "domain")
    && typeof r.dest === "string" && r.dest !== "screener"
    && Object.prototype.hasOwnProperty.call(FOLDER_OF_VIEW, r.dest)
    && typeof r.read === "boolean"
    && Array.isArray(r.messageIds) && r.messageIds.every((m) => typeof m === "string")
    && typeof r.at === "number" && Number.isFinite(r.at);
}

/** A v4 row, or not one — the same refusal of absent answers as {@link isScreenIntent}. */
export function isReleaseIntent(x: unknown): x is ReleaseIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 4 && r.verb === "release"
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.seedId === "string" && r.seedId.length > 0
    && typeof r.address === "string" && r.address.length > 0
    && r.scope === "sender"
    && (r.from === FOLDER_OF_VIEW.screened || r.from === FOLDER_OF_VIEW.spam)
    && typeof r.dest === "string" && Object.prototype.hasOwnProperty.call(FOLDER_OF_VIEW, r.dest)
    && Array.isArray(r.messageIds) && r.messageIds.every((m) => typeof m === "string")
    && typeof r.at === "number" && Number.isFinite(r.at);
}

/**
 * The journal as stored, unfiltered by age. Never throws: a blocked or corrupt jar reads empty,
 * and a row this build cannot read is DROPPED rather than guessed at — the opposite of the
 * outbox's rule, deliberately. An outbox entry is a verb the server may already have seen; a
 * journal entry has not been expressed at all, and replaying a shape we cannot read would file
 * mail under a rule nobody chose. Each jar reads only its own row shape.
 */
function loadJar<T extends JarIntent>(door: StorageDoor, key: string, valid: (x: unknown) => x is T): T[] {
  try {
    const raw = door.get(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

/** The four jars under one key: the v1 rows, the screen rows, the decide rows, the release rows. */
function load(door: StorageDoor, key: string): {
  v1: RoutingIntent[]; screen: ScreenIntent[]; decide: DecideIntent[]; release: ReleaseIntent[];
} {
  return {
    v1: loadJar(door, key, isRoutingIntent),
    screen: loadJar(door, screenIntentsKey(key), isScreenIntent),
    decide: loadJar(door, decideIntentsKey(key), isDecideIntent),
    release: loadJar(door, releaseIntentsKey(key), isReleaseIntent),
  };
}

/** Write one jar, and SAY WHETHER IT LANDED — `screener-intents.ts#save`'s reason. */
function save(door: StorageDoor, key: string, rows: readonly JarIntent[]): DurableWrite {
  return rows.length === 0
    ? door.remove(key)
    : door.set(key, JSON.stringify(rows.slice(-ROUTING_INTENTS_MAX)));
}

/**
 * Record the press, replacing whatever this SUBJECT already had IN ANY JAR. Replacement and not
 * append: two live intents for one sender cannot both be the reader's word, and a re-press after
 * an expiry is the only way the two would otherwise meet.
 */
export function armRoutingIntent(door: StorageDoor, key: string, intent: JarIntent): DurableWrite {
  const subject = routingSubject(intent);
  const jars = load(door, key);
  const bounded = intent.messageIds.length <= ROUTING_INTENT_IDS_MAX
    ? intent
    : { ...intent, messageIds: intent.messageIds.slice(0, ROUTING_INTENT_IDS_MAX) };
  const v1 = jars.v1.filter((r) => routingSubject(r) !== subject);
  const screen = jars.screen.filter((r) => routingSubject(r) !== subject);
  const decide = jars.decide.filter((r) => routingSubject(r) !== subject);
  const release = jars.release.filter((r) => routingSubject(r) !== subject);
  if (bounded.v !== 1 && v1.length !== jars.v1.length) save(door, key, v1);
  if (bounded.v !== 2 && screen.length !== jars.screen.length) save(door, screenIntentsKey(key), screen);
  if (bounded.v !== 3 && decide.length !== jars.decide.length) save(door, decideIntentsKey(key), decide);
  if (bounded.v !== 4 && release.length !== jars.release.length) save(door, releaseIntentsKey(key), release);
  if (bounded.v === 4) return save(door, releaseIntentsKey(key), [...release, bounded]);
  if (bounded.v === 3) return save(door, decideIntentsKey(key), [...decide, bounded]);
  if (bounded.v === 2) return save(door, screenIntentsKey(key), [...screen, bounded]);
  return save(door, key, [...v1, bounded]);
}

/**
 * Forget one press — Undo, and the commit's own settle — from whichever jar holds it.
 *
 * The commit calls this only AFTER its dispatch has settled, never before: the engine persists a
 * verb to its outbox ahead of the wire, so between the dispatch and that write this journal is
 * the only durable copy and dropping it early reopens the hole one step along.
 */
export function disarmRoutingIntent(door: StorageDoor, key: string, pressId: string): void {
  const jars = load(door, key);
  const v1 = jars.v1.filter((r) => r.id !== pressId);
  if (v1.length !== jars.v1.length) save(door, key, v1);
  const screen = jars.screen.filter((r) => r.id !== pressId);
  if (screen.length !== jars.screen.length) save(door, screenIntentsKey(key), screen);
  const decide = jars.decide.filter((r) => r.id !== pressId);
  if (decide.length !== jars.decide.length) save(door, decideIntentsKey(key), decide);
  const release = jars.release.filter((r) => r.id !== pressId);
  if (release.length !== jars.release.length) save(door, releaseIntentsKey(key), release);
}

/**
 * Every intent this boot should look at, oldest first, with the dead told apart from the live.
 *
 * TWO LISTS AND NOT A FILTER: an expiry is a fact the reader is owed, not a deletion — the same
 * answer the Screener's journal reached, where the silent sweep was the defect. The sweep still
 * WRITES: a row left in place is re-read and re-rejected at every launch for ever.
 */
export function takeRoutingIntents(
  door: StorageDoor, key: string, nowMs: number,
): { live: JarIntent[]; expired: JarIntent[] } {
  const jars = load(door, key);
  const live: JarIntent[] = [];
  const expired: JarIntent[] = [];
  const split = <T extends JarIntent>(rows: T[], jarKey: string): void => {
    const kept = rows.filter((r) => nowMs - r.at <= ROUTING_INTENT_TTL_MS);
    for (const r of rows) (kept.includes(r) ? live : expired).push(r);
    if (kept.length !== rows.length) save(door, jarKey, kept);
  };
  split(jars.v1, key);
  split(jars.screen, screenIntentsKey(key));
  split(jars.decide, decideIntentsKey(key));
  split(jars.release, releaseIntentsKey(key));
  live.sort((a, b) => a.at - b.at);
  return { live, expired };
}
