/**
 * WHO WROTE THE HEADER — the one rule for reading a sender's own words as identity or as rank.
 *
 * Identity is `(account, mailbox, uidvalidity, uid)` or the content fingerprint. A header the
 * SENDER writes — Message-ID, In-Reply-To, References, To, Cc — may GROUP or RANK only when
 * something the sender does not control corroborates it: our own sent record, the person's own
 * reply, or the server's locator. Without that rule a stranger names a colleague in Cc and reads
 * as that colleague's correspondent, or reuses a Message-ID and reads as a message we hold.
 *
 * A spoofed `From` is NOT covered: no authentication result reaches this seam, so an address that
 * wrote to us is corroborated by the delivery and by nothing stronger.
 */

/** How an address came to be on a conversation. `sender_named` is a claim, never evidence. */
export type CounterpartyEvidence = "we_wrote" | "they_wrote" | "sender_named";

/**
 * One message as this rule reads it.
 *
 * `ownAuthored` is the SERVER's answer — the message's locator is the mailbox's Sent folder — or
 * the engine's own record of a send. Never the `From` header: that is the sender's own writing,
 * and taking it as proof of authorship is the lever the rule removes.
 */
export interface CounterpartyMessage {
  ownAuthored: boolean;
  from: string | null | undefined;
  /** `To` ∪ `Cc`. */
  recipients: readonly (string | null | undefined)[];
}

const STRENGTH: Record<CounterpartyEvidence, number> = {
  we_wrote: 2,
  they_wrote: 1,
  sender_named: 0,
};

/**
 * Classify every address these messages mention — the strongest evidence each one has.
 *
 * A message WE authored contributes its recipients as `we_wrote`: we chose to write to them. A
 * message we did not author contributes its author as `they_wrote` and its recipients as
 * `sender_named` — the To and Cc of somebody else's mail are that sender's claim about who else
 * is involved. Addresses are lowercased; the account's OWN addresses are not filtered here,
 * because who counts as "own" is the caller's question and every caller already answers it.
 */
export function counterpartyEvidence(
  messages: Iterable<CounterpartyMessage>,
): Map<string, CounterpartyEvidence> {
  const out = new Map<string, CounterpartyEvidence>();
  const claim = (address: string | null | undefined, evidence: CounterpartyEvidence): void => {
    const a = address?.trim().toLowerCase();
    if (!a) return;
    const held = out.get(a);
    if (held === undefined || STRENGTH[evidence] > STRENGTH[held]) out.set(a, evidence);
  };
  for (const m of messages) {
    if (m.ownAuthored) {
      for (const r of m.recipients) claim(r, "we_wrote");
      continue;
    }
    claim(m.from, "they_wrote");
    for (const r of m.recipients) claim(r, "sender_named");
  }
  return out;
}

/** Evidence a grouping or a ranking may act on — ours, or theirs, never a third party's claim. */
export function isCorroboratedCounterparty(evidence: CounterpartyEvidence | undefined): boolean {
  return evidence === "we_wrote" || evidence === "they_wrote";
}

/** The addresses of {@link counterpartyEvidence} that {@link isCorroboratedCounterparty} admits. */
export function corroboratedCounterparties(
  messages: Iterable<CounterpartyMessage>,
): Set<string> {
  const out = new Set<string>();
  for (const [address, evidence] of counterpartyEvidence(messages)) {
    if (isCorroboratedCounterparty(evidence)) out.add(address);
  }
  return out;
}

/**
 * Fold `from`'s classifications into `into`, keeping the stronger evidence for each address.
 *
 * One home for the strength order, because the thread-join heal unions two conversations' facts
 * as it decides — after B joins A, C is judged against what B brought — and a union that took
 * the LAST value would let a `sender_named` claim overwrite `we_wrote`.
 */
export function mergeCounterpartyEvidence(
  into: Map<string, CounterpartyEvidence>,
  from: ReadonlyMap<string, CounterpartyEvidence>,
): void {
  for (const [address, evidence] of from) {
    const held = into.get(address);
    if (held === undefined || STRENGTH[evidence] > STRENGTH[held]) into.set(address, evidence);
  }
}

/** A row a Message-ID grouping is about to key on. */
export interface MessageIdGroupCandidate {
  messageIdHeader: string | null | undefined;
  /** TRUE ⇒ our own outbound copy: the engine minted it, or the server filed it in Sent. */
  ownOutbound: boolean;
}

/**
 * MAY THIS ROW BE GROUPED BY ITS MESSAGE-ID? Only our own outbound copies may.
 *
 * The two rows a Message-ID legitimately identifies are both ours — the engine's provisional Sent
 * copy beside the ingested one, and a provider that files its own copy of an SMTP submission — so
 * "our own outbound" is what the grouping is actually about, and the server's Sent locator says it
 * without asking the sender anything. Two INBOUND rows sharing a Message-ID are two messages: one
 * of them would otherwise not be rendered, which for the reader is the message disappearing.
 */
export function mayGroupByMessageId(
  row: MessageIdGroupCandidate,
): row is MessageIdGroupCandidate & { messageIdHeader: string } {
  return Boolean(row.messageIdHeader) && row.ownOutbound;
}
