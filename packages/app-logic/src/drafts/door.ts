/**
 * WHAT DRAFTS IS HANDED BY ITS SEAT: the composer's and the send's own functions over the rows, never a second copy of
 * them. Drafts lists, asks and reports; whether a row may go, what a waiting send answers and the delete itself are the
 * door's.
 */
import type { EngineDraft } from "@ohmail/wire";
import { HELD_SEND_RECHECK_MS, type PressVerdict } from "@ohmail/client-engine";

/** Why a Discard did nothing, said in its row. */
export type DiscardRefusalWhy = "still-sending" | "unknown-jar" | "cancel-unknown";

/** The row a Discard was refused for, stamped by the press: a second refusal on the same row is heard again. */
export interface DiscardRefusal {
  readonly draftId: string;
  readonly why: DiscardRefusalWhy;
  readonly at: number;
}

export type DiscardResult = PressVerdict | { kind: "blocked"; why: DiscardRefusalWhy };
export type WithdrawResult = "none" | "withdrawn" | "placeholder-withdrawn" | "already_sent" | "unknown";

export interface DraftsDoor {
  /** Opens a row: a reply as that reply where its letter is on this device, else in the composer. */
  open(d: EngineDraft): void;
  /** The hold's answer for a Discard: a running send or a store this browser cannot read refuses. */
  decide(draftId: string): { kind: "go" } | { kind: "refuse"; why: DiscardRefusalWhy };
  /** Takes back a send waiting on the row. `none`: nothing waited. */
  withdrawWaiting(draftId: string): Promise<WithdrawResult>;
  /** The delete, with every editor holding the row emptied and its send record released on a confirmed answer. */
  discard(draftId: string): Promise<DiscardResult>;
  cancelSchedule(id: string): void;
  editScheduled(d: EngineDraft): void;
  resolve(id: string, outcome: "arrived" | "not_arrived"): void;
  sendAgain(d: EngineDraft): void;
  /** The letter this draft answers is on this device. */
  repliesHere(d: EngineDraft): boolean;
  /** Rows this browser holds by a send record. */
  readonly heldHere: ReadonlySet<string>;
  /** Rows a send waiting to go names. */
  readonly waiting: ReadonlySet<string>;
  /** Rows a send left Not sent, with the line it said. */
  readonly notSent: ReadonlyMap<string, string>;
}

/** A row that holds the only copy of a send nobody could confirm. */
export function isHeld(door: Pick<DraftsDoor, "heldHere" | "waiting">, d: EngineDraft): boolean {
  if (door.waiting.has(d.id)) return false;
  return d.status !== "draft" || door.heldHere.has(d.id);
}

/**
 * What a held row says, as a key of Drafts' words: inside the window the engine still checks the Sent folder; after
 * it, that the letter is not there; a send cut off on its way, that it was interrupted. An unreadable stamp reads as
 * past the window: the sentence that claims less.
 */
export function heldSentence(
  d: EngineDraft,
  now: Date,
): "heldChecking" | "heldNotInSent" | "heldInterrupted" {
  if (d.status === "sending") return "heldInterrupted";
  const at = Date.parse(d.updatedAt);
  const checking = Number.isFinite(at) && now.getTime() - at < HELD_SEND_RECHECK_MS;
  return checking ? "heldChecking" : "heldNotInSent";
}
