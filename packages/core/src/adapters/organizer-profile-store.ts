import { eq } from "drizzle-orm";
import {
  awayResponders, contacts, notifyRules as notifyRulesTbl, rules as rulesTbl, tags as tagsTbl,
  type Tx,
} from "@trafficflow/db";
import type { OrganizerProfilePayload } from "./organizer-profile.js";

/**
 * THE SERIALIZER — the organizer's store, read into the profile document's payload.
 *
 * It reads ONLY configuration: the screened-in senders (`contacts` — a row there IS the
 * screener's "yes"; the "no" is durably a rule whose destination is `ohmail/Screened`, so it
 * travels in `rules`), the rules by their natural keys, the notification opt-ins, the single
 * autoresponder row, and the tag names. Deliberately NOT read: anything adaptive (rule hit
 * counts, retro-apply state, learning signals) and anything secret — there is no credential
 * column in any query below, and the worker's suite pins the serialized document's exact key
 * census so a new field is a reviewed decision.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE WRITE-BEHIND COMPOSITION ──────────────────────────────
 *
 * It was the write-behind's private serializer while the organizer was its only caller. The
 * import surface is the second one: deciding whether a found document is ALREADY what the local
 * store says — and so needs no import prompt at all — is the same question the write-behind's
 * dirty check asks, and it has to be answered from the same serialization or the two callers
 * disagree about one store. The write-behind runs in the organizer processes; the import surface
 * runs in the API's service layer, which may not import an application — so the one serializer
 * sits below both, beside the document format it feeds. `drizzle-repo.ts` is the precedent for a
 * core adapter that reads the database directly.
 */
export async function serializeOrganizerProfile(db: Tx, accountId: string): Promise<OrganizerProfilePayload> {
  // ONE SNAPSHOT, not five. Under READ COMMITTED each statement sees its own snapshot, so a
  // screener decide committing between the contacts read and the rules read would serialize a
  // TORN configuration — the contact without its promoted rule — and the document would say
  // something no store ever held (self-healing one flush later, but "a burst is one write" is
  // the contract, and a torn read is how it becomes two). REPEATABLE READ pins all five reads
  // to one snapshot; PGlite is real Postgres, so the same statement works on both stores.
  const [contactRows, ruleRows, notifyRows, awayRows, tagRows] = await db.transaction(async (tx) => {
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
      }).from(awayResponders).where(eq(awayResponders.accountId, accountId)),
      await tx.select({ name: tagsTbl.name }).from(tagsTbl).where(eq(tagsTbl.accountId, accountId)),
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
    },
    tagNames: tagRows.map((t) => t.name),
  };
}
