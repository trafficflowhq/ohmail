import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, changeLog, mailboxes, messages, routingDecisions,
  storeScreenerSuggestion, SCREENER_SUGGESTION_PROVENANCE,
} from "@trafficflow/db";
import { SyncService, type ServiceContext, type SyncChange } from "../src/index.js";
import { resetScreeningState } from "../src/consent-reset.js";

/**
 * THE NARROW SUGGESTION ENTITY ON `/sync`, watched at the wire: one change per purchase, the
 * entity carrying the VERDICT and never the stored `rationale`, tombstones for a re-buy's
 * replaced row and for a reset. MUTATION-WATCH (each run red, restored): `dto/materialize.ts`
 * add `rationale: r.rationale ?? ""` to the DTO → the key census case goes red, the exact
 * defect it exists to refuse (a smuggled column); `db/screener-suggestion.ts` drop the
 * `recordChanges` call → "one change row per purchase" goes red with zero rows, nothing reaches
 * any client; `dto/materialize.ts` drop the `inputProvenance` predicate → the mistyped-change
 * case goes red, a PIPELINE decision's id served (with its rationale) under this type.
 */

const svc = new SyncService();

/** Every key the wire admits for this entity, sorted — reasonCode/brand/count only when earned. */
/* `actRefusal`/`actRefusedAt`: a refused act on suggestions, a closed code and an instant — no
   model text. The client parse (`ScreenerSuggestionEntity`) admits the same two. */
const ADMITTED_KEYS = [
  "actRefusal", "actRefusedAt",
  "boughtAt", "confidence", "decision", "destination", "id",
  "messageId", "senderKey", "spam", "updatedAt",
] as const;

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x.example" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-09-18T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

async function screenerMessage(db: Db, accountId: string, mailboxId: string, from: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
    subject: "hello", fromAddress: from, snippet: "s",
  }).returning();
  return m!.id;
}

const suggestionChanges = (resp: { changes: { creates: SyncChange[]; updates: SyncChange[]; deletes: SyncChange[] } }) => ({
  creates: resp.changes.creates.filter((c) => c.type === "screener_suggestion"),
  deletes: resp.changes.deletes.filter((c) => c.type === "screener_suggestion"),
});

describe("a bought suggestion rides /sync as the narrow verdict entity", () => {
  it("one purchase, one change row; the entity carries exactly the admitted keys", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const messageId = await screenerMessage(db, accountId, mailboxId, "Stranger@Corp.test");

    const bought = Date.now();
    // Stored with the fact that capped it, which the act reads and the wire never carries.
    await storeScreenerSuggestion(db, {
      accountId, messageId, destination: "INBOX", confidence: 0.8,
      rationale: "a person writing for the first time", spam: false, senderReason: "correspondent",
    });

    const rows = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), eq(changeLog.entityType, "screener_suggestion"),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("create");

    const resp = await svc.getChanges(ctx, {});
    const { creates } = suggestionChanges(resp);
    expect(creates).toHaveLength(1);
    const entity = creates[0]!.entity as Record<string, unknown>;
    // The key census: the wire's exact vocabulary, sorted. `rationale` — the model's own text —
    // is what the census exists to refuse; an extra field here is a smuggled column.
    expect(Object.keys(entity).sort()).toEqual([...ADMITTED_KEYS]);
    expect(entity.senderKey).toBe("stranger@corp.test");
    expect(entity.messageId).toBe(messageId);
    expect(entity).toMatchObject({ decision: "yes", destination: "INBOX", spam: false, confidence: 0.8 });
    // The local timing half of the rig figure: purchase to delta-visible, one process, no poll.
    expect(Date.parse(String(entity.boughtAt))).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`landing→delta-visible measured ${(Date.now() - bought)} ms in-process`);
  });

  it("the verdict is derived, not the row: a gate-holding rationale rides as decision=hold", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const messageId = await screenerMessage(db, accountId, mailboxId, "x@y.test");
    await storeScreenerSuggestion(db, {
      accountId, messageId, destination: "INBOX", confidence: 0.9,
      rationale: "best held at the Screener until a person decides", spam: false, senderReason: "none",
    });
    const { creates } = suggestionChanges(await svc.getChanges(ctx, {}));
    expect(creates[0]!.entity).toMatchObject({ decision: "hold", destination: "INBOX" });
  });

  it("posture tightens yes: under people_only a Reads verdict rides as decision=no", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await db.insert(accountSettings).values({ accountId, ohboxPolicy: "people_only" });
    const messageId = await screenerMessage(db, accountId, mailboxId, "news@list.test");
    await storeScreenerSuggestion(db, {
      accountId, messageId, destination: "ohmail/News", confidence: 0.9, rationale: "", spam: false, senderReason: "none",
    });
    const { creates } = suggestionChanges(await svc.getChanges(ctx, {}));
    expect(creates[0]!.entity).toMatchObject({ decision: "no", destination: "ohmail/News" });
  });

  it("a re-buy tombstones the replaced row and creates the new one in one allocation", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const messageId = await screenerMessage(db, accountId, mailboxId, "x@y.test");
    await storeScreenerSuggestion(db, {
      accountId, messageId, destination: "INBOX", confidence: 0.5, rationale: "", spam: false, senderReason: "none",
    });
    const first = await svc.getChanges(ctx, {});
    const firstId = suggestionChanges(first).creates[0]!.id;

    await storeScreenerSuggestion(db, {
      accountId, messageId, destination: "ohmail/News", confidence: 0.7, rationale: "", spam: false, senderReason: "none",
    });
    const tail = await svc.getChanges(ctx, { since: first.cursor });
    const { creates, deletes } = suggestionChanges(tail);
    expect(deletes.map((d) => d.id)).toEqual([firstId]);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.id).not.toBe(firstId);
    expect(creates[0]!.entity).toMatchObject({ destination: "ohmail/News" });
    // The delete's seq precedes the create's: one page applying in order never holds two rows.
    expect(deletes[0]!.seq).toBeLessThan(creates[0]!.seq);
  });

  it("a change row naming a PIPELINE decision under this type tombstones — provenance scope", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const messageId = await screenerMessage(db, accountId, mailboxId, "x@y.test");
    const [pipeline] = await db.insert(routingDecisions).values({
      accountId, messageId, inputProvenance: "ai", destination: "ohmail/News",
      confidence: 0.9, rationale: "the model's own sentence", spam: false, status: "pending_approval",
    }).returning({ id: routingDecisions.id });
    await db.transaction(async (tx) => {
      const { recordChange } = await import("@trafficflow/db");
      await recordChange(tx as never, {
        accountId, entityType: "screener_suggestion", entityId: pipeline!.id, op: "create",
      });
    });
    const resp = await svc.getChanges(ctx, {});
    const { creates, deletes } = suggestionChanges(resp);
    expect(creates).toHaveLength(0);
    expect(deletes.map((d) => d.id)).toEqual([pipeline!.id]);
  });

  it("a screening reset tombstones every suggestion on the wire", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const m1 = await screenerMessage(db, accountId, mailboxId, "x@y.test");
    const m2 = await screenerMessage(db, accountId, mailboxId, "z@y.test");
    for (const messageId of [m1, m2]) {
      await storeScreenerSuggestion(db, {
        accountId, messageId, destination: "INBOX", confidence: 0.5, rationale: "", spam: false, senderReason: "none",
      });
    }
    const before = await svc.getChanges(ctx, {});
    expect(suggestionChanges(before).creates).toHaveLength(2);

    await resetScreeningState(ctx);
    const stored = await db.select().from(routingDecisions).where(and(
      eq(routingDecisions.accountId, accountId),
      eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
    ));
    expect(stored).toHaveLength(0);
    const tail = await svc.getChanges(ctx, { since: before.cursor });
    expect(suggestionChanges(tail).deletes).toHaveLength(2);
  });
});
