/**
 * THE FIRST RUN'S ANSWERS, NARROWED. The host contract carries the first run's and the seed review's answers as
 * opaque payloads; each is read here, field by field, into the shape the stage draws. Whatever no reader can read is
 * `null`: nothing is taken as done that the answer did not say.
 */
import type { FirstRunDecisionCount, FirstRunOrganizeOutcome } from "../../doors/first-run-host.js";

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

const OUTCOMES: readonly FirstRunOrganizeOutcome[] = ["stored", "gone", "held", "unchecked"];

/** What Agree did, or `null` where the answer is none of the four: nothing is taken as stored then. */
export function organizedOf(answer: unknown): FirstRunOrganizeOutcome | null {
  return OUTCOMES.find((o) => o === answer) ?? null;
}

/** What agreeing would screen, or `null`: the step then names no count and the press asks for no backlog. */
export function decisionCountOf(answer: unknown): FirstRunDecisionCount | null {
  const a = record(answer);
  if (a === null) return null;
  const letters = count(a.letters);
  const senders = count(a.senders);
  const total = count(a.total);
  if (letters === null || senders === null || total === null) return null;
  if (typeof a.complete !== "boolean" || typeof a.mirrored !== "boolean") return null;
  return { letters, senders, total, complete: a.complete, mirrored: a.mirrored };
}

/** How many senders wait with mail in one mailbox, or `null`: the lead then names no number. */
export function waitingOf(answer: unknown): number | null {
  return count(record(answer)?.senders);
}

/** The door's reader of its own second-factor refusal, where it hands one. */
export function stepUpOf(stepUp: unknown): ((thrown: unknown) => boolean) | null {
  const door = record(stepUp);
  if (door === null || typeof door.required !== "function") return null;
  return (thrown) => (door.required as (this: unknown, e: unknown) => unknown).call(door, thrown) === true;
}

/** Why the review left an address out. Closed: another reason is not drawn. */
export const SEED_EXCLUSIONS = ["robot-recipient", "machine-sent", "own-address"] as const;
export type SeedExclusion = (typeof SEED_EXCLUSIONS)[number];

export interface SeedCandidate {
  readonly address: string;
  readonly name: string | null;
  /** How many times the account wrote to them. */
  readonly messages: number;
  /** A rule stands for them already: shown, never written again. */
  readonly alreadyDecided: boolean;
}

export interface SeedReviewRead {
  readonly candidates: readonly SeedCandidate[];
  readonly excluded: readonly { readonly address: string; readonly reason: SeedExclusion }[];
  readonly scannedMessages: number;
  /** The scan stopped at its bound. */
  readonly truncated: boolean;
}

function candidateOf(v: unknown): SeedCandidate | null {
  const c = record(v);
  const messages = count(c?.messages);
  if (c === null || typeof c.address !== "string" || c.address === "" || messages === null) return null;
  return {
    address: c.address,
    name: typeof c.name === "string" && c.name.trim() !== "" ? c.name : null,
    messages,
    alreadyDecided: c.alreadyDecided === true,
  };
}

/** The sent-mail review as the server answered it, or `null` when the answer is not one. A row it cannot read is left out. */
export function seedReviewOf(answer: unknown): SeedReviewRead | null {
  const a = record(answer);
  if (a === null || !Array.isArray(a.candidates) || !Array.isArray(a.excluded)) return null;
  const candidates = a.candidates.map(candidateOf).filter((c): c is SeedCandidate => c !== null);
  const excluded = a.excluded.flatMap((v: unknown) => {
    const e = record(v);
    const reason = SEED_EXCLUSIONS.find((r) => r === e?.reason);
    return e !== null && typeof e.address === "string" && reason !== undefined
      ? [{ address: e.address, reason }]
      : [];
  });
  return {
    candidates,
    excluded,
    scannedMessages: count(a.scannedMessages) ?? 0,
    truncated: a.truncated === true,
  };
}
