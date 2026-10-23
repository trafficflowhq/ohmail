/**
 * THE SCREENER ROWS WHOSE DECISION THE OUTBOX GAVE UP ON.
 *
 * After `OUTBOX_MAX_SERVER_FAILURES` answers nobody modelled the outbox gives a decision up: its
 * overlay goes and the sender is back in Waiting. The Screener had been told `queued`, so its own
 * refused mark was never set and the row looked like a decision never made. This reads the
 * engine's abandoned records instead, so the row says "Not saved" for exactly as long as one
 * stands: Discard and Try again end the record, and a new decision about the sender supersedes it.
 *
 * Which record is about which row: a `screener_decide` names the representative it was pressed on,
 * which is the row's own id or, once newer mail re-minted the row, one of its held letters; a
 * `rule_create` with no second term names the sender's address, or a domain and every row in it.
 * A sliced rule (a subject or body term) decides about some mail of a sender, never the sender.
 */
import { domainOfAddress, ruleMatchKey, type AbandonedMutation, type ScreenerSenderDTO } from "@ohmail/client-engine";

type Row = Pick<ScreenerSenderDTO, "id" | "from" | "held" | "derived">;

const NONE: ReadonlySet<string> = new Set();

export function givenUpRowIds(abandoned: readonly AbandonedMutation[], rows: readonly Row[]): ReadonlySet<string> {
  const decided = new Set<string>();
  const senders = new Set<string>();
  const domains = new Set<string>();
  for (const a of abandoned) {
    if (a.superseded) continue;
    const m = a.mutation;
    if (m.kind === "screener_decide") decided.add(m.senderId);
    else if (m.kind === "rule_create" && !m.subjectContains && !m.bodyContains) {
      (m.ruleKind === "domain" ? domains : senders).add(ruleMatchKey(m.match));
    }
  }
  if (decided.size === 0 && senders.size === 0 && domains.size === 0) return NONE;
  const out = new Set<string>();
  for (const r of rows) {
    // Keyed as the router keys a rule's match (spaces only), so a padded rule names its sender here too.
    const address = ruleMatchKey(r.from.address);
    const domain = domainOfAddress(address);
    // A derived row's held ids are message ids — a representative the record may name.
    const held = r.derived ? r.held.some((h) => decided.has(h.id)) : false;
    if (decided.has(r.id) || held || senders.has(address) || (domain !== null && domains.has(domain))) out.add(r.id);
  }
  return out;
}
