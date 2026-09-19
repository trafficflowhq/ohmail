/**
 * AFTER A VERB — what the reading pane does once an action has moved the open message.
 *
 * Every verb used to drop the split column to "Nothing open." — a re-pick per verb. The choice is
 * per device, like picture quality (no server in it), read AT THE MOMENT the pane reacts so a
 * change applies to the next verb: `advance` opens the next message (the row below the acted one,
 * else above), `stay` keeps today's resting pane, `close` clears the selection. The narrow sheet
 * keeps its own grammar — the one consumer applies only where the reading column stands.
 */

/**
 * `advance` by default — the decision the review ranked first, not an omission: the person who
 * just pressed a verb is mid-triage, and the next message is what they came for. The other two
 * values exist for the people who mean them.
 */

import { durableSet } from "./durable";

export const AFTER_VERB_CHOICES = ["advance", "stay", "close"] as const;

export type AfterVerbChoice = (typeof AFTER_VERB_CHOICES)[number];

export const DEFAULT_AFTER_VERB: AfterVerbChoice = "advance";

/** One key, scoped per account exactly as picture quality is (`image-quality.ts`). */
export const AFTER_VERB_STORAGE_KEY = "ohmail.ui.reader.afterVerb";

function afterVerbKeyFor(accountId: string | null): string {
  return accountId ? `${AFTER_VERB_STORAGE_KEY}:${accountId}` : AFTER_VERB_STORAGE_KEY;
}

function isAfterVerbChoice(v: unknown): v is AfterVerbChoice {
  return typeof v === "string" && (AFTER_VERB_CHOICES as readonly string[]).includes(v);
}

export function readAfterVerb(accountId: string | null = null): AfterVerbChoice {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return DEFAULT_AFTER_VERB;
    if (accountId) {
      const scoped = ls.getItem(afterVerbKeyFor(accountId));
      if (isAfterVerbChoice(scoped)) return scoped;
    }
    const bare = ls.getItem(AFTER_VERB_STORAGE_KEY);
    if (isAfterVerbChoice(bare)) return bare;
    return DEFAULT_AFTER_VERB;
  } catch {
    return DEFAULT_AFTER_VERB;
  }
}

export function writeAfterVerb(choice: AfterVerbChoice, accountId: string | null = null): void {
  // A refused jar is announced once by the door itself; the choice still holds for the session.
  durableSet(afterVerbKeyFor(accountId), choice, "reader.afterVerb");
}

/**
 * A verb was dispatched on the message whose id this carries; the pane reacts only if that row
 * then LEAVES the list while the marker is fresh — which is what separates "my verb moved it"
 * from a drain applying another device's work, the case that must never move the cursor.
 */
export interface ActedMarker {
  id: string;
  /** `Date.now()` at dispatch. An optimistic removal lands within a frame; 5 s is generous. */
  at: number;
}

export const ACTED_FRESH_MS = 5_000;

/**
 * The row to advance to, computed from the order the list HELD when the acted row was still in
 * it: the first row after the acted one that is still present, else the nearest one before it.
 * `before` is the previous render's order, `present` the ids on screen now — the acted row's
 * index exists only in `before`, because by the time the pane reacts the row is gone.
 */
export function nextSurvivor(
  before: readonly string[],
  present: ReadonlySet<string>,
  actedId: string,
): string | null {
  const at = before.indexOf(actedId);
  if (at < 0) return null;
  for (let i = at + 1; i < before.length; i++) {
    if (present.has(before[i]!)) return before[i]!;
  }
  for (let i = at - 1; i >= 0; i--) {
    if (present.has(before[i]!)) return before[i]!;
  }
  return null;
}
