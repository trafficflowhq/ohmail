"use client";

/**
 * THE SCREENER'S DECISIONS, ON DISK THE MOMENT THEY ARE MADE.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────
 *
 * A Screener decision used to exist ONLY as a `setTimeout` closure for its whole undo window:
 * `screener-state.ts#decide` armed `commitTimer: setTimeout(() => commit(id), COMMIT_MS)` and the
 * toast said the mail was filed. `COMMIT_MS` is `UNDO_MS + COMMIT_GRACE_MS` = 8.4 s, so for eight
 * and a half seconds the only record of an explicit consent decision was a timer in one tab's
 * event loop. Close the tab, navigate away, crash, or let the OS reclaim the process inside that
 * window and the decision was gone — with the product having already told the reader it happened.
 *
 * That is the class the closing review named as the top blocker ("this product decides in memory
 * and persists afterwards"), met at the product's primary consent gate.
 *
 * ── THE SHAPE, AND WHY IT IS THIS ONE ───────────────────────────────────────────────────────
 *
 * The undo window is deliberate UX and is kept. What changes is what the delay is made of: a
 * SCHEDULED DURABLE INTENT rather than an unpersisted timer. The intent lands here — synchronously
 * — before the timer is armed; Undo deletes it; the commit deletes it only once the engine has
 * taken the verb (the durable outbox's own `putOutbox` runs ahead of the wire, so from that moment
 * the outbox is the durable record and this journal has nothing left to hold).
 *
 * A crash inside the window therefore resolves ONE way, deterministically: the next boot reads the
 * journal and commits. **The user's decision survives.** That direction is chosen rather than
 * assumed — the alternative is discarding an act the toast has already reported as done, on the
 * one screen a person visits in order to be sure about their mail. A decision that lands 30 s late
 * is a decision; a decision that evaporates is the product being wrong about the reader's mail.
 *
 * ── WHY `localStorage` AND NOT THE MIRROR STORE ─────────────────────────────────────────────
 *
 * Because it is SYNCHRONOUS. The engine's durable outbox is the right home for a verb that has
 * been expressed, and that is exactly where a committed decision goes; but this journal has to
 * survive the window BETWEEN the press and the express, and an IndexedDB write is a promise that
 * a killed tab need never settle. `window.localStorage.setItem` has returned before `decide()`
 * does. The same reasoning the compose scratch buffer already runs on, one surface over.
 *
 * Owner-keyed, in the shape `composeDraftKey` and `searchSortKey` already use and for the same
 * reason: `localStorage` is per-ORIGIN, and a decision one account made must never be replayed by
 * the next account to sign in on the same browser. The `"local"` fallback is the standalone
 * desktop and every moment before sign-in — a real situation, not a missing value.
 *
 * Storage can refuse (Safari private mode throws on write). Every access is wrapped, and a refusal
 * means a decision is only as durable as the tab — which is precisely today's behaviour, so a
 * blocked jar is no worse off than before this file existed.
 */

import type { DecisionDestination, DecisionScope } from "@ohmail/ui";
import { readOwner } from "./owner-cookie";

/**
 * ONE SCHEDULED DECISION — the trim, not the row.
 *
 * `ScreenerSenderDTO` carries every held message in full (`held: ScreenerHeldMail[]`, subject and
 * snippet each), and a bulk "apply all" over a busy queue is hundreds of rows. Persisting the DTO
 * would put megabytes of mail text in `localStorage` to record a five-field decision. What the
 * commit path actually consumes is here and nothing else: the id it names, where it files, whether
 * it marks read, its scope, whether the sender's own held ids ride along (derived rows only), and
 * enough of the sender to name them in a refusal.
 *
 * `v` names the shape so a future build can migrate rather than guess. An entry this build does
 * not recognise is DROPPED rather than replayed — the opposite of the outbox's rule, and
 * deliberately: an outbox entry is a verb the server may already have seen, so guessing at it is
 * dangerous; a journal entry is a decision that has not been expressed at all, and replaying one
 * whose fields this build cannot read would file mail somewhere nobody chose.
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
 * HOW LONG A SCHEDULED DECISION IS STILL THE READER'S DECISION.
 *
 * Twenty-four hours, the same horizon the engine's outbox uses for its own age rule
 * (`OUTBOX_UNKEYED_CREATE_TTL_MS`), and for a related reason. Inside it, replaying is obviously
 * right: the reader pressed a key about a stranger and the queue has not moved. Past it the queue
 * HAS moved — the sender may have been decided on another device, the held mail swept, the rep
 * evicted — and quietly filing a day-old decision into a queue the reader has since re-read is a
 * surprise rather than a restoration. An expired intent is dropped, not committed.
 *
 * This is a ceiling on staleness, not a retry budget: nothing here retries, because the moment a
 * decision reaches `engine.mutate` the durable outbox owns it and retries it under its own key.
 */
export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** One key per ACCOUNT, holding the whole journal — see the header for why it is owner-keyed. */
export function screenerIntentsKey(owner: string | null = readOwner()): string {
  return `ohmail.screener.intents.${owner ?? "local"}`;
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

function save(rows: ScreenerIntent[]): void {
  try {
    if (rows.length === 0) window.localStorage.removeItem(screenerIntentsKey());
    else window.localStorage.setItem(screenerIntentsKey(), JSON.stringify(rows));
  } catch {
    /* private mode, or a full quota — the decision is as durable as the tab, exactly as before */
  }
}

/**
 * ARM ONE DECISION — synchronous, and the FIRST thing `decide()` does.
 *
 * Same-id replacement rather than append: `decide` refuses a second press on a row already in
 * `s.pending`, so two live intents for one id cannot both be the reader's word. Replacing also
 * makes the write idempotent under a re-press after an expiry, which is the only way the two can
 * meet.
 */
export function armScreenerIntent(intent: ScreenerIntent): void {
  const rows = load().filter((r) => r.id !== intent.id);
  rows.push(
    intent.heldIds.length <= INTENT_HELD_IDS_MAX
      ? intent
      : { ...intent, heldIds: intent.heldIds.slice(0, INTENT_HELD_IDS_MAX) },
  );
  save(rows);
}

/**
 * HOW MANY HELD IDS ONE SCHEDULED DECISION CARRIES, and what is given up past it.
 *
 * The ids exist only for the "&read" batch that rides a KEEP decision (`screener-state.ts` gates
 * the list on `derived && read`, so a demoting decision carries none at all). A sender with more
 * than this many held messages is a mailing list somebody is admitting, and the truncation costs
 * exactly one thing on a RESTORED decision: the mail past the cap stays bold. That is the same
 * residual the commit path already accepts in writing for this batch — visible where it happened,
 * undone by reading it — and it is a far better trade than a quota refusal, which is swallowed and
 * would take the whole journal, decision included, with it.
 *
 * The LIVE path is untouched: `commit` rebuilds the intent from the entry, so a decision whose
 * timer fires normally marks the whole bag read exactly as before.
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
