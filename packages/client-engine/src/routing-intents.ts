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

/** Either row a routing window holds. */
export type AnyRoutingIntent = RoutingIntent | ScreenIntent;

export const SCREEN_SHOWN_MAX = 20;

/** The screen jar sits under the v1 jar's name, so the sign-out sweep of the prefix covers it. */
export function screenIntentsKey(key: string): string {
  return `${key}.screen`;
}

/**
 * WHOSE ROUTING — and the key supersession is decided on. A second press about one sender inside
 * one window is not two decisions: it is a change of mind, and only the last may be written.
 * Keyed on the subject and NOT on subject+place, because Reads-then-Receipts IS that change of
 * mind and keeping both would write two rules for one sender.
 */
export function routingSubject(i: Pick<AnyRoutingIntent, "scope" | "address">): string {
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

/**
 * The journal as stored, unfiltered by age. Never throws: a blocked or corrupt jar reads empty,
 * and a row this build cannot read is DROPPED rather than guessed at — the opposite of the
 * outbox's rule, deliberately. An outbox entry is a verb the server may already have seen; a
 * journal entry has not been expressed at all, and replaying a shape we cannot read would file
 * mail under a rule nobody chose. Each jar reads only its own row shape.
 */
function loadJar<T extends AnyRoutingIntent>(door: StorageDoor, key: string, valid: (x: unknown) => x is T): T[] {
  try {
    const raw = door.get(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

/** Both jars under one key: the v1 rows, then the screen rows. */
function load(door: StorageDoor, key: string): { v1: RoutingIntent[]; screen: ScreenIntent[] } {
  return {
    v1: loadJar(door, key, isRoutingIntent),
    screen: loadJar(door, screenIntentsKey(key), isScreenIntent),
  };
}

/** Write one jar, and SAY WHETHER IT LANDED — `screener-intents.ts#save`'s reason. */
function save(door: StorageDoor, key: string, rows: readonly AnyRoutingIntent[]): DurableWrite {
  return rows.length === 0
    ? door.remove(key)
    : door.set(key, JSON.stringify(rows.slice(-ROUTING_INTENTS_MAX)));
}

/**
 * Record the press, replacing whatever this SUBJECT already had IN EITHER JAR. Replacement and not
 * append: two live intents for one sender cannot both be the reader's word, and a re-press after
 * an expiry is the only way the two would otherwise meet.
 */
export function armRoutingIntent(door: StorageDoor, key: string, intent: AnyRoutingIntent): DurableWrite {
  const subject = routingSubject(intent);
  const jars = load(door, key);
  const bounded = intent.messageIds.length <= ROUTING_INTENT_IDS_MAX
    ? intent
    : { ...intent, messageIds: intent.messageIds.slice(0, ROUTING_INTENT_IDS_MAX) };
  const v1 = jars.v1.filter((r) => routingSubject(r) !== subject);
  const screen = jars.screen.filter((r) => routingSubject(r) !== subject);
  if (bounded.v === 2) {
    if (v1.length !== jars.v1.length) save(door, key, v1);
    return save(door, screenIntentsKey(key), [...screen, bounded]);
  }
  if (screen.length !== jars.screen.length) save(door, screenIntentsKey(key), screen);
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
): { live: AnyRoutingIntent[]; expired: AnyRoutingIntent[] } {
  const jars = load(door, key);
  const live: AnyRoutingIntent[] = [];
  const expired: AnyRoutingIntent[] = [];
  const split = <T extends AnyRoutingIntent>(rows: T[], jarKey: string): void => {
    const kept = rows.filter((r) => nowMs - r.at <= ROUTING_INTENT_TTL_MS);
    for (const r of rows) (kept.includes(r) ? live : expired).push(r);
    if (kept.length !== rows.length) save(door, jarKey, kept);
  };
  split(jars.v1, key);
  split(jars.screen, screenIntentsKey(key));
  live.sort((a, b) => a.at - b.at);
  return { live, expired };
}
