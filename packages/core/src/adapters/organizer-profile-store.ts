import { and, eq } from "drizzle-orm";
import {
  awayResponders, contacts, mailboxes as mailboxesTbl, notifyRules as notifyRulesTbl,
  rules as rulesTbl, tags as tagsTbl,
  type Tx,
} from "@trafficflow/db";
import type { OrganizerProfilePayload } from "./organizer-profile.js";

/**
 * The serializer — the organizer's store, read into the profile document's payload. It reads ONLY
 * configuration: screened-in senders (`contacts` — a row there IS the screener's yes; the no
 * travels in `rules` as a `ohmail/Screened` destination), rules by natural keys, notification
 * opt-ins, the single autoresponder row, tag names. Deliberately not read: anything adaptive and
 * anything secret — no credential column appears in any query, and the worker's suite pins the
 * document's exact key census so a new field is a reviewed decision. It sits below both callers —
 * the organizer's write-behind and the API's import surface — because "is the found document
 * already what the local store says" must be answered from the same serialization both use.
 */
export async function serializeOrganizerProfile(
  db: Tx, accountId: string,
  /**
   * The mailbox, and it is why this function stopped being account-scoped (mail 0094). Everything
   * else here belongs to the ACCOUNT; `signature` does not — it is `mailboxes.signature`, the
   * text appended to mail sent from this address, and a person with two mailboxes has two of
   * them: serializing one account-wide would publish one mailbox's sign-off into the other's
   * document. Required rather than optional: an optional mailbox would default to no signature,
   * and a caller that forgot it would publish a document that silently drops the field — the
   * republish then reads as the person having cleared their signature.
   */
  mailboxId: string,
): Promise<OrganizerProfilePayload> {
  // ONE SNAPSHOT, not five. Under READ COMMITTED each statement sees its own snapshot, so a
  // screener decide committing between the contacts read and the rules read would serialize a
  // TORN configuration — the contact without its promoted rule — and the document would say
  // something no store ever held (self-healing one flush later, but "a burst is one write" is
  // the contract, and a torn read is how it becomes two). REPEATABLE READ pins all five reads
  // to one snapshot; PGlite is real Postgres, so the same statement works on both stores.
  const [contactRows, ruleRows, notifyRows, awayRows, tagRows, mailboxRows] = await db.transaction(async (tx) => {
    return [
      await tx.select({ address: contacts.address, name: contacts.name })
        .from(contacts).where(eq(contacts.accountId, accountId)),
      await tx.select({
        kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination,
        priority: rulesTbl.priority, enabled: rulesTbl.enabled, provenance: rulesTbl.provenance,
        subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
      }).from(rulesTbl).where(eq(rulesTbl.accountId, accountId)),
      await tx.select({ kind: notifyRulesTbl.kind, target: notifyRulesTbl.target })
        .from(notifyRulesTbl).where(eq(notifyRulesTbl.accountId, accountId)),
      // `subject` is not selected: the responder is reply-only since 0087 and the column is inert
      // until the 0.15 contract migration drops it. Reading it here would put a dead field back
      // into every published document.
      await tx.select({
        enabled: awayResponders.enabled, body: awayResponders.body,
        startsAt: awayResponders.startsAt, endsAt: awayResponders.endsAt,
        audience: awayResponders.audience, throttle: awayResponders.throttle,
        piles: awayResponders.piles,
      }).from(awayResponders).where(eq(awayResponders.accountId, accountId)),
      await tx.select({ name: tagsTbl.name }).from(tagsTbl).where(eq(tagsTbl.accountId, accountId)),
      // THE SIXTH READ, inside the same snapshot as the other five for the reason the comment
      // above gives: a signature edit committing between two statements would serialize a
      // configuration no store ever held. Scoped by ACCOUNT as well as by mailbox — a predicate
      // on the id alone would serialize whatever row carried that uuid, and the account column is
      // the only thing that makes "this mailbox is ours" a property of the query.
      await tx.select({ signature: mailboxesTbl.signature }).from(mailboxesTbl)
        .where(and(eq(mailboxesTbl.id, mailboxId), eq(mailboxesTbl.accountId, accountId))),
    ] as const;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const away = awayRows[0];
  return {
    screener: contactRows.map((c) => (c.name === null ? { address: c.address } : { address: c.address, name: c.name })),
    rules: ruleRows.map((r) => ({
      kind: r.kind, match: r.match, destination: r.destination,
      priority: r.priority, enabled: r.enabled, provenance: r.provenance,
      ...(r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
      ...(r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
    })),
    notifyRules: notifyRows.map((n) => ({ kind: n.kind, target: n.target })),
    awayResponder: away === undefined ? null : {
      enabled: away.enabled,
      body: away.body,
      throttle: away.throttle,
      startsAt: away.startsAt === null ? null : away.startsAt.toISOString(),
      endsAt: away.endsAt === null ? null : away.endsAt.toISOString(),
      audience: away.audience,
      // The row's own scope, so it reaches the person's other computers. `canonicalizeProfilePayload`
      // sorts and dedupes it; this is the stored value.
      piles: [...away.piles],
    },
    tagNames: tagRows.map((t) => t.name),
    // NO ROW READS AS NO SIGNATURE, which is also what a NULL column reads as. They are the same
    // answer here on purpose: a mailbox that is not this account's is not a state this serializer
    // can report on, and its caller has already established the mailbox before asking.
    signature: mailboxRows[0]?.signature ?? null,
  };
}
