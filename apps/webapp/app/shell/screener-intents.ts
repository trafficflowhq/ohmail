"use client";

/**
 * The Screener's decisions, on disk the moment they are made. A decision used to exist ONLY as a
 * `setTimeout` closure for its whole undo window (8.4 s): close the tab or crash inside it and the
 * decision was gone — with the product having already told the reader it happened, at the primary
 * consent gate. The undo window is kept; the delay is now a scheduled DURABLE INTENT: it lands here
 * synchronously before the timer is armed, Undo deletes it, and the commit deletes it only once the
 * engine has taken the verb. A crash inside the window resolves one way, deterministically: the
 * next boot reads the journal and commits — a decision that lands 30 s late is a decision; one that
 * evaporates is the product being wrong about the reader's mail.
 */

/**
 * `localStorage` and not the mirror store, because it is SYNCHRONOUS: an IndexedDB write is a
 * promise a killed tab need never settle, while `setItem` has returned before `decide()` does — the
 * compose scratch buffer's own reasoning. Owner-keyed in the shape `composeDraftKey` uses: a
 * decision one account made must never replay for the next account on the same browser. The owner
 * is `storageOwner()`: the standalone desktop has no cookie and mounts one engine per mailbox, and
 * a `"local"` fallback there meant every mailbox replaying every other mailbox's decisions.
 * Storage can refuse (Safari private mode); every access is wrapped, and a refusal means a decision
 * is only as durable as the tab — exactly the behaviour before this file existed.
 */

import type { DecisionDestination, DecisionScope } from "@ohmail/ui";
import { durableRemove, durableSet, type DurableWrite } from "./durable";
import { storageOwner } from "./storage-owner";

/**
 * One scheduled decision — the trim, not the row. `ScreenerSenderDTO` carries every held message in full, and a
 * bulk "apply all" over a busy queue is hundreds of rows; persisting the DTO would put megabytes of mail text
 * in `localStorage` to record a five-field decision. What the commit path consumes is here and nothing else:
 * the id, where it files, whether it marks read, its scope, whether the sender's held ids ride along, and
 * enough of the sender to name them in a refusal. `v` names the shape so a future build can migrate rather than
 * guess; an unrecognised entry is DROPPED rather than replayed — the opposite of the outbox's rule,
 * deliberately: an outbox entry is a verb the server may have seen, a journal entry has not been expressed at
 * all, and replaying one this build cannot read would file mail somewhere nobody chose.
 */
export interface ScreenerIntent {
  v: 1;
  /** The queue row's id — a representative MESSAGE id on a derived row, a fixture id otherwise. */
  id: string;
  dest: DecisionDestination;
  read: boolean;
  scope: DecisionScope;
  /** This decision is one step of a bulk and raises no sentence of its own. */
  quiet: boolean;
  /** Epoch ms at the press, from the same clock `decide` reads. */
  at: number;
  /** `ScreenerSenderDTO.derived` — the switch between the decide path and the past-the-gate one. */
  derived: boolean;
  /** A derived row's held message ids, for the "&read" batch. `[]` on a fixture row. */
  heldIds: string[];
  /** Enough of the sender to name them in a refusal toast, and no more. */
  from: { name: string | null; address: string };
}

/**
 * How long a scheduled decision is still the reader's decision. Twenty-four hours, the engine
 * outbox's own horizon (`OUTBOX_UNKEYED_CREATE_TTL_MS`): inside it, replaying is obviously right —
 * the reader pressed a key about a stranger and the queue has not moved; past it the queue HAS
 * moved (decided on another device, held mail swept, the rep evicted), and quietly filing a day-old
 * decision into a re-read queue is a surprise, not a restoration — an expired intent is dropped,
 * not committed. A ceiling on staleness, not a retry budget: the moment a decision reaches
 * `engine.mutate` the durable outbox owns it and retries under its own key.
 */
export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Every owner's journal key starts here. Exported so sign-out can sweep them. */
export const SCREENER_INTENTS_PREFIX = "ohmail.screener.intents.";

/** One key per ACCOUNT, holding the whole journal — see the header for why it is owner-keyed. */
export function screenerIntentsKey(owner: string | null = storageOwner()): string {
  return `${SCREENER_INTENTS_PREFIX}${owner ?? "local"}`;
}

function isIntent(x: unknown): x is ScreenerIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 1
    && typeof r.id === "string" && r.id.length > 0
    && typeof r.dest === "string"
    && typeof r.read === "boolean"
    && typeof r.scope === "string"
    && typeof r.quiet === "boolean"
    && typeof r.at === "number"
    && typeof r.derived === "boolean"
    && Array.isArray(r.heldIds) && r.heldIds.every((h) => typeof h === "string")
    && typeof r.from === "object" && r.from !== null
    && typeof (r.from as Record<string, unknown>).address === "string";
}

/** The journal as stored, unfiltered by age. Never throws: a blocked or corrupt jar reads empty. */
function load(): ScreenerIntent[] {
  try {
    const raw = window.localStorage.getItem(screenerIntentsKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isIntent) : [];
  } catch {
    return [];
  }
}

/**
 * WRITE THE JOURNAL, AND SAY WHETHER IT LANDED.
 *
 * This used to swallow, on the argument that a refused jar left the decision "as durable as the
 * tab, exactly as before" — which is true and is not the whole of it: the undo window was still
 * offered over a record nobody held, so the product went on promising a decision it had no way
 * to keep. The answer travels to `decide`, which commits at once rather than offering an undo it
 * cannot honour.
 */
function save(rows: ScreenerIntent[]): DurableWrite {
  const key = screenerIntentsKey();
  return rows.length === 0
    ? durableRemove(key, "screener.intents")
    : durableSet(key, JSON.stringify(rows), "screener.intents");
}

/**
 * ARM ONE DECISION — synchronous, and the FIRST thing `decide()` does.
 *
 * Same-id replacement rather than append: `decide` refuses a second press on a row already in
 * `s.pending`, so two live intents for one id cannot both be the reader's word. Replacing also
 * makes the write idempotent under a re-press after an expiry, which is the only way the two can
 * meet.
 */
export function armScreenerIntent(intent: ScreenerIntent): DurableWrite {
  const rows = load().filter((r) => r.id !== intent.id);
  rows.push(
    intent.heldIds.length <= INTENT_HELD_IDS_MAX
      ? intent
      : { ...intent, heldIds: intent.heldIds.slice(0, INTENT_HELD_IDS_MAX) },
  );
  return save(rows);
}

/**
 * HOW MANY HELD IDS ONE SCHEDULED DECISION CARRIES, and what is given up past it. The ids exist only for the "&read"
 * batch that rides a KEEP decision (`screener-state.ts` gates the list on `derived && read`, so a demoting decision
 * carries none at all). A sender with more than this many held messages is a mailing list somebody is admitting, and
 * the truncation costs exactly one thing on a RESTORED decision: the mail past the cap stays bold. That is the same
 * residual the commit path already accepts in writing for this batch — visible where it happened, undone by reading
 * it — and it is a far better trade than a quota refusal, which is swallowed and would take the whole journal,
 * decision included, with it. The LIVE path is untouched: `commit` rebuilds the intent from the entry, so a decision
 * whose timer fires normally marks the whole bag read exactly as before.
 */
export const INTENT_HELD_IDS_MAX = 500;

/**
 * DISARM ONE — Undo, and the commit's own settle.
 *
 * Called by the commit only AFTER `engine.mutate` has settled, never before it is dispatched: the
 * engine persists the verb to its outbox ahead of the wire, so between the press and that write
 * this journal is the only durable copy and dropping it early would reopen the whole defect one
 * step further along.
 */
export function disarmScreenerIntent(id: string): void {
  const rows = load();
  const kept = rows.filter((r) => r.id !== id);
  if (kept.length !== rows.length) save(kept);
}

/**
 * EVERY INTENT THIS BOOT SHOULD ACT ON, and the expired ones swept in the same pass.
 *
 * `nowMs` is injected rather than read, so the TTL is testable without a fake clock over the whole
 * suite and so the caller's clock is the engine's clock.
 *
 * The sweep WRITES: an expired intent is removed here rather than left to be re-read and
 * re-rejected on every boot for ever. A journal that only ever grows is a second defect wearing
 * the first one's clothes.
 */
export function takeScreenerIntents(nowMs: number): ScreenerIntent[] {
  const rows = load();
  if (rows.length === 0) return [];
  const live = rows.filter((r) => nowMs - r.at <= INTENT_TTL_MS);
  if (live.length !== rows.length) save(live);
  return live.slice().sort((a, b) => a.at - b.at);
}
