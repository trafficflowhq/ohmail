/**
 * A DECISION THIS PHONE SENT TO THE INSTALL THAT ORGANIZES THE MAILBOX, and what became of it.
 *
 * On a mailbox another install organizes, a Screener press is a request the organizer applies on
 * its next pass. Until it answers, the sender keeps a mark; a refusal is said with
 * its reason. The facts are the engine's own `pendingDecisions` (`GET /screener`): `pending` and
 * `sent` are in flight, `refused` rides for a day; `applied` and `expired` are absent.
 */

import { Copy } from "../copy";

/** One entry of the route's `pendingDecisions`, as this phone keeps it. */
export interface RelayedDecision {
  /** The address (sender scope) or the domain (domain scope), lower-cased. */
  subject: string;
  scope: "sender" | "domain";
  state: "pending" | "sent" | "refused";
  refusedReason: string | null;
}

/** What the sender's row and sheet say, or nothing. */
export type RelayMark = { kind: "waiting"; text: string } | { kind: "refused"; text: string };

/** Read one entry off the wire, or `null` for one this build cannot act on. */
export function relayedOf(raw: unknown): RelayedDecision | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const subject = typeof r.subject === "string" ? r.subject.trim().toLowerCase() : "";
  const scope = r.scope === "sender" || r.scope === "domain" ? r.scope : null;
  const state = r.state === "pending" || r.state === "sent" || r.state === "refused" ? r.state : null;
  if (subject === "" || scope === null || state === null) return null;
  const refusedReason = state === "refused" && typeof r.refusedReason === "string" ? r.refusedReason : null;
  return { subject, scope, state, refusedReason };
}

const domainOf = (address: string): string => {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
};

function reasonSentence(reason: string | null): string | null {
  switch (reason) {
    case "unauthenticated": return Copy.relayReasonUnauthenticated;
    case "conflict": return Copy.relayReasonConflict;
    case "account_erased": return Copy.relayReasonAccountErased;
    case "stale": return Copy.relayReasonStale;
    case "unhandled_kind": return Copy.relayReasonUnhandledKind;
    case "invalid_payload": return Copy.relayReasonInvalidPayload;
    case "wrong_mailbox": return Copy.relayReasonOtherMailbox;
    default: return null;
  }
}

/**
 * THE MARK FOR ONE SENDER. A decision still in flight outranks a refusal of an earlier one — the
 * route's own rule — so a second press over a refused one reads as waiting, not as refused.
 */
export function relayMarkFor(
  address: string,
  relayed: readonly RelayedDecision[] | null,
  holder: string | null,
): RelayMark | null {
  if (relayed === null || relayed.length === 0) return null;
  const sender = address.trim().toLowerCase();
  const domain = domainOf(sender);
  const mine = relayed.filter((d) => (d.scope === "sender" ? d.subject === sender : d.subject === domain));
  if (mine.length === 0) return null;
  if (mine.some((d) => d.state !== "refused")) {
    return { kind: "waiting", text: holder ? Copy.relayWaiting(holder) : Copy.relayWaitingUnknown };
  }
  const why = reasonSentence(mine[0]!.refusedReason);
  return { kind: "refused", text: why === null ? Copy.relayRefusedUnknown : Copy.relayRefused(why) };
}

/**
 * THE MARK THE PRESS LEAVES AT ONCE, before the next read confirms it: the press answered that the
 * decision was recorded for the organizer, and the next read carries the same entry as `pending`.
 */
export function withSentHere(
  relayed: readonly RelayedDecision[] | null,
  decided: { address: string; scope: "sender" | "domain" },
): RelayedDecision[] {
  const subject = decided.scope === "domain" ? domainOf(decided.address) : decided.address.trim().toLowerCase();
  const rest = (relayed ?? []).filter((d) => !(d.scope === decided.scope && d.subject === subject));
  return [...rest, { subject, scope: decided.scope, state: "pending", refusedReason: null }];
}

/**
 * WHAT THE SENDER'S SHEET SAYS ABOVE THE DECISION, on a mailbox another install organizes: the
 * mark once a decision is out, and before any press that the decision travels there.
 */
export function senderSheetLine(
  mark: RelayMark | null,
  organizer: { name: string; stopped: boolean } | null,
): string | null {
  if (mark !== null) return mark.text;
  if (organizer === null || organizer.stopped) return null;
  return Copy.senderSentThere(organizer.name);
}
