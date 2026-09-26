/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" ON THE PHONE — the decisions, no rendering.
 *
 * A mailbox can carry a settings document another ohmail saved in it. The organizer that finds one
 * holds its gate and its settings write until somebody answers, so a phone that could not answer
 * held both for ever. This module picks the question to show and says it; the card
 * (`ProfileImportCard.tsx`) and Settings (`SavedSettingsPanel`) render it, and the four calls are
 * `net/profile-import.ts`'s. The web's card is the reference, word for word where the words exist.
 */
import { Copy } from "../copy";
import { dayStamp } from "./day-stamp";
import type { ProfileImportCounts, ProfileImportQuestion } from "../net/profile-import";

/** One mailbox and what its door answered. */
export interface MailboxQuestion {
  mailboxId: string;
  address: string;
  question: ProfileImportQuestion;
}

/** How soon a mailbox is asked again without a ring: an open answer rarely changes, a `none` can at any drain. */
export const ASK_AGAIN_OPEN_MS = 5 * 60 * 1000;
export const ASK_AGAIN_NONE_MS = 60 * 1000;

/**
 * WHICH MAILBOXES THIS PASS ASKS. A rung doorbell (`World.mailboxes.settingsBell` moved: an
 * organizer found or lapsed a settings document) asks every one at once; otherwise each waits
 * out its own throttle. The web's hook keeps the same rule.
 */
export function mailboxesToAsk(
  ids: readonly string[], asked: ReadonlyMap<string, number>,
  answers: Readonly<Record<string, ProfileImportQuestion>>, now: number, rang: boolean,
): string[] {
  return ids.filter((id) => {
    const last = asked.get(id);
    if (rang || last === undefined) return true;
    const prior = answers[id];
    return now - last >= (prior === undefined || prior.state === "none" ? ASK_AGAIN_NONE_MS : ASK_AGAIN_OPEN_MS);
  });
}

/**
 * ONE TICKET PER ASK, PER MAILBOX: only the newest ask's answer lands, and a press outranks every
 * ask that left before it — so a ring racing a slower ask, or a Not now racing a ring, cannot
 * bring an older answer back over a newer one.
 */
export function askTickets(): {
  begin: (id: string) => number; supersede: (id: string) => void; current: (id: string, ticket: number) => boolean;
} {
  const n = new Map<string, number>();
  const next = (id: string): number => { const t = (n.get(id) ?? 0) + 1; n.set(id, t); return t; };
  return { begin: next, supersede: (id) => { next(id); }, current: (id, ticket) => n.get(id) === ticket };
}

/** The question on the card: the first open one, in the order the mailboxes came. */
export function cardQuestion(rows: readonly MailboxQuestion[]): MailboxQuestion | null {
  return rows.find((r) => r.question.state === "found" || r.question.state === "newer") ?? null;
}

/** The rows Settings lists: every "Not now" whose document still stands in its mailbox. */
export function savedRows(rows: readonly MailboxQuestion[]): MailboxQuestion[] {
  return rows.filter((r) => r.question.state === "declined");
}

/**
 * The counts in words, joined by the deck. Zero-count parts vanish. Not `Intl.ListFormat`: Hermes
 * has none, so the phone would read a bare comma list where node reads the conjunction.
 */
export function countsSaid(counts: ProfileImportCounts): string {
  const parts: string[] = [];
  if (counts.screener > 0) parts.push(Copy.pfiScreenerPart(counts.screener));
  if (counts.rules > 0) parts.push(Copy.pfiRulesPart(counts.rules));
  if (counts.notifyRules > 0) parts.push(Copy.pfiNotifyPart(counts.notifyRules));
  if (counts.tags > 0) parts.push(Copy.pfiTagsPart(counts.tags));
  if (counts.awayResponder) parts.push(Copy.pfiAwayPart);
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return Copy.pfiListPair(parts[0]!, parts[1]!);
  return Copy.pfiListMany(parts.slice(0, -1).join(", "), parts[parts.length - 1]!);
}

/** Who saved it and when. Nothing where the stamp does not parse — a date is never invented. */
export function savedBySaid(producer: { kind: string }, updatedAt: string, locale: string): string | null {
  if (Number.isNaN(new Date(updatedAt).getTime())) return null;
  const when = dayStamp(updatedAt, locale);
  if (producer.kind === "cloud") return Copy.pfiSavedByCloud(when);
  if (producer.kind === "local") return Copy.pfiSavedByLocal(when);
  if (producer.kind === "mobile") return Copy.pfiSavedByPhone(when);
  return Copy.pfiSavedBy(when);
}

/**
 * THE CARD'S LIFECYCLE around one question. `failed` keeps the question and both presses, with
 * the door's sentence where it wrote one — the answer survives a refused request.
 */
export type CardPhase =
  | { kind: "asking" }
  | { kind: "busy" }
  | { kind: "failed"; message: string | null }
  | { kind: "imported"; details: string; skippedRules: number };

/** The refusal line: the door's own sentence, else the generic one, and the retry. */
export function failureSaid(message: string | null): string {
  return `${Copy.pfiErrorTitle} ${message ?? Copy.pfiErrorGeneric} ${Copy.pfiErrorRetry}`;
}
