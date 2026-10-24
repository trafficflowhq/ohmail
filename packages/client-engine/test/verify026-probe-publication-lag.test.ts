import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  accounts, idempotencyKeys, mailboxes, mailboxProfileMirror, organizerRequests, rules as rulesTbl,
  markRequestsSent, markRequestsApplied, settleReaderRuleRows,
} from "@trafficflow/db";
import { FIXED_NOW, makeDeps, seedSession } from "../../api/test/helpers.js";
import { HttpAdapter, OhmailEngine, rulesShown, type FetchLike } from "@ohmail/client-engine";
import { makeTestDb } from "../../db/src/testing.js";
import { applyRuleRequest, validateRulePayload } from "../../db/src/request-apply.js";
import { serializeOrganizerProfileCounted } from "../../core/src/adapters/organizer-profile-store.js";
import type { LedgerTx, Tx } from "../../db/src/change-log.js";

// VERIFY-026 HIGH 1, the verifier's probe kept as the control. ADAPTED (ARCH-RULES-PAGE-INVARIANT §5)
// only where it named removed symbols: the page is read through `rulesShown` as a reader-only
// install reads it, the shipped reader behind the Rules page, and the drain stand-in settles with the request's
// `decidedAt`; the server clock advances per request, as production's does. A reader-only account
// whose organizer published once and whose cached copy is NOT re-read before the second press.
const app = createApp(apiRoutes);

async function world() {
  const { db, deps, clock } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    clock.advance(1000);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
  };
  const made = await fetchImpl("http://localhost/rules", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "sender", match: "ann@shop.example", destination: "ohmail/News" }),
  });
  expect(made.status).toBe(201);
  const ruleId = ((await made.json()) as { id: string }).id;
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@shop.test", organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules,moves,profile", organizedByKind: "local", organizedByName: "Laptop",
  }).returning();
  const org = await makeTestDb();
  const [oa] = await org.insert(accounts).values({ name: "organizer" }).returning();
  await org.insert(rulesTbl).values({ accountId: oa!.id, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" });
  /** The organizer's copy; `applied` as a current organizer states it, absent as an older one. */
  const publish = async (applied?: string[]) => {
    const doc = { rules: await org.select({
      kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination, priority: rulesTbl.priority,
      enabled: rulesTbl.enabled, provenance: rulesTbl.provenance, subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    }).from(rulesTbl), ...(applied === undefined ? {} : { applied }) };
    await db.insert(mailboxProfileMirror).values({ mailboxId: mb!.id, accountId: s.accountId, doc })
      .onConflictDoUpdate({ target: mailboxProfileMirror.mailboxId, set: { doc, readAt: new Date() } });
  };
  await publish(); // the organizer's one publication the reader has cached
  let carried = 0;
  /** The organizer applies the next travelled request; the reader's cycle records the ack (worker's unit). */
  const organizerApplies = async () => {
    const rows = (await db.select().from(organizerRequests))
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    const r = rows[carried++]!;
    const payload = validateRulePayload(r.kind, r.payload)!;
    const outcome = await (org as unknown as Tx).transaction((tx) =>
      applyRuleRequest(tx as unknown as LedgerTx, { accountId: oa!.id, payload, now: FIXED_NOW }));
    if ((outcome as { applied?: boolean }).applied) {
      await (db as unknown as Tx).transaction(async (tx) => {
        await markRequestsSent(tx as never, [r.id], FIXED_NOW);
        await markRequestsApplied(tx as never, [r.id], FIXED_NOW);
        await settleReaderRuleRows(tx as never, s.accountId, { kind: r.kind, payload: r.payload, decidedAt: r.decidedAt });
      });
    }
    return { outcome, wire: r.payload as { shown?: unknown }, requestId: r.id };
  };
  const fresh = async () => {
    const e = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), now: () => new Date(FIXED_NOW.getTime() + 1000) });
    await e.start();
    return e;
  };
  const engine = await fresh();
  const orgRule = async () => (await org.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
  /** The organizer's own edits, made on its install. */
  const organizerSets = async (match: string, destination: string) => {
    const [held] = await org.select().from(rulesTbl).where(eq(rulesTbl.match, match));
    if (held) await org.update(rulesTbl).set({ destination, updatedAt: new Date() }).where(eq(rulesTbl.id, held.id));
    else await org.insert(rulesTbl).values({ accountId: oa!.id, kind: "sender", match, destination, priority: 0, enabled: true, provenance: "manual" });
  };
  /** The drain's claim of a request, as its store keeps it for a day. */
  const claimed = (requestId: string, createdAt: Date) => ({
    accountId: oa!.id, key: `meta-request:${requestId}`, requestHash: "h", responseStatus: 200,
    responseJson: { applied: true, requestId }, seq: null, createdAt, expiresAt: new Date(createdAt.getTime() + 86_400_000),
  });
  /** The `applied` list the organizer's own serializer publishes. */
  const appliedList = async () => (await serializeOrganizerProfileCounted(
    org as unknown as Tx, oa!.id, randomUUID(), { applied: true, now: FIXED_NOW })).applied;
  return { db, org, ruleId, engine, fresh, organizerApplies, publish, orgRule, organizerSets, claimed, appliedList };
}

/** The Rules page of a reader-only install, as the shell reads it. */
const page = (e: OhmailEngine, now = new Date(FIXED_NOW.getTime() + 1000)) =>
  rulesShown(e.read(), { readerOnly: true, queued: e.queuedRuleWrites(), applied: e.appliedRuleRequests(), now });

const tick = () => new Promise((r) => setTimeout(r, 20));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);

describe("VERIFY-026 probe: the second press before the published copy is re-read", () => {
  for (const second of ["edit-again", "undo", "remove"] as const) {
    it(`edit, organizer applies, ack recorded, copy NOT re-read, then ${second}`, async () => {
      const w = await world();
      expect((await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never })).status).toBe("awaiting_organizer");
      const first = await w.organizerApplies();
      expect(first.outcome).toMatchObject({ applied: true });
      await w.engine.syncOnce();
      w.engine.refreshWaitingOnOrganizer();
      await tick();
      const ann = page(w.engine).rules.map((r) => r.destination);
      const note = w.engine.waitingOnOrganizer().map((x) => x.state);
      console.log(`PROBE ${second}: organizer now`, JSON.stringify(await w.orgRule()), "page shows", JSON.stringify(ann), "waiting states", JSON.stringify(note));
      const m = second === "edit-again"
        ? { kind: "rule_update", ruleId: w.ruleId, destination: "INBOX" }
        : second === "undo"
          ? { kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/News", applyRetro: false, keepProvenance: true }
          : { kind: "rule_delete", ruleId: w.ruleId };
      expect((await w.engine.mutate(m as never)).status).toBe("awaiting_organizer");
      const two = await w.organizerApplies();
      console.log(`PROBE ${second}: second press shown`, JSON.stringify(two.wire.shown), "outcome", JSON.stringify(two.outcome, big));
      expect(ann, "the page after the applied ack").toEqual(["ohmail/Receipts"]);
      expect(two.outcome, `the ${second} after the person's own applied edit`).toMatchObject({ applied: true });
    });
  }

  it("a Remove the organizer applied, ack recorded, copy NOT re-read: does the row leave the page", async () => {
    const w = await world();
    expect((await w.engine.mutate({ kind: "rule_delete", ruleId: w.ruleId })).status).toBe("awaiting_organizer");
    const first = await w.organizerApplies();
    expect(first.outcome).toMatchObject({ applied: true, op: "delete" });
    await w.engine.syncOnce();
    w.engine.refreshWaitingOnOrganizer();
    await tick();
    const own = (await w.db.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
    const shown = page(w.engine).rules.map((r) => r.destination);
    console.log("PROBE remove-first: organizer now", JSON.stringify(await w.orgRule()), "reader own rows", JSON.stringify(own), "page shows", JSON.stringify(shown), "waiting", JSON.stringify(w.engine.waitingOnOrganizer().map((x) => x.state)));
    expect(shown, "the removed rule on the reader-only page after the applied ack").toEqual([]);
  });

  it("CONTROL: the same undo after the organizer republished and the reader re-read applies", async () => {
    const w = await world();
    await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never });
    await w.organizerApplies();
    await w.publish();
    const relaunched = await w.fresh();
    await relaunched.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/News", applyRetro: false, keepProvenance: true } as never);
    const two = await w.organizerApplies();
    console.log("PROBE control: shown", JSON.stringify(two.wire.shown), "outcome", JSON.stringify(two.outcome, big));
    expect(two.outcome).toMatchObject({ applied: true });
  });
});

describe("a reader-only Rules page follows the organizer's own edits", () => {
  it("a rule the organizer made and then edited is listed at the edited place, without controls", async () => {
    const w = await world();
    await w.organizerSets("bob@shop.example", "ohmail/News");
    await w.publish();
    await w.organizerSets("bob@shop.example", "ohmail/Receipts");
    await w.publish();
    const shown = page(await w.fresh());
    const bob = shown.rules.find((r) => r.match === "bob@shop.example");
    expect(bob?.destination, "the organizer's rule is missing or stale").toBe("ohmail/Receipts");
    expect(shown.doorless.has(bob!.id), "no press here names the organizer's own rule").toBe(true);
    expect(shown.rules.find((r) => r.match === "ann@shop.example")?.id, "the twin row carries the local id").toBe(w.ruleId);
  });

  it("after the person's own applied edit, the organizer's next edit shows once its copy includes the request", async () => {
    const w = await world();
    await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never });
    const { requestId } = await w.organizerApplies();
    await w.organizerSets("ann@shop.example", "INBOX");
    await w.publish([requestId]);
    const e = await w.fresh();
    e.refreshWaitingOnOrganizer();
    await tick();
    expect(page(e).rules.map((r) => r.destination), "the person's older edit hid the organizer's newer one").toEqual(["INBOX"]);
  });

  it("an older organizer's copy (no applied list): the press holds until the copy agrees, and not past the horizon", async () => {
    const w = await world();
    await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never });
    await w.organizerApplies();
    await w.engine.syncOnce();
    w.engine.refreshWaitingOnOrganizer();
    await tick();
    expect(page(w.engine).rules.map((r) => r.destination), "the stale copy undid the person's change").toEqual(["ohmail/Receipts"]);
    const later = new Date(FIXED_NOW.getTime() + 24 * 3_600_000);
    expect(page(w.engine, later).rules.map((r) => r.destination), "past the horizon the copy is the list").toEqual(["ohmail/News"]);
    await w.publish();
    const e = await w.fresh();
    e.refreshWaitingOnOrganizer();
    await tick();
    const agreed = page(e);
    expect(agreed.rules.map((r) => [r.id, r.destination])).toEqual([[w.ruleId, "ohmail/Receipts"]]);
    expect(page(e, later).rules.map((r) => r.destination), "the agreeing copy needs no hold").toEqual(["ohmail/Receipts"]);
  });

  it("a device organizer that answered a thousand requests before still names this one", async () => {
    const w = await world();
    await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never });
    const { requestId } = await w.organizerApplies();
    // A device store keeps every claim it ever made until its own retention prunes them.
    const longAgo = FIXED_NOW.getTime() - 3 * 86_400_000;
    await w.org.insert(idempotencyKeys).values(Array.from({ length: 1000 }, (_, i) => w.claimed(randomUUID(), new Date(longAgo + i))));
    await w.org.insert(idempotencyKeys).values(w.claimed(requestId, FIXED_NOW));
    await w.organizerSets("ann@shop.example", "INBOX");
    await w.publish(await w.appliedList());
    const e = await w.fresh();
    e.refreshWaitingOnOrganizer();
    await tick();
    expect(page(e).rules.map((r) => r.destination), "expired claims crowded the request out of the copy").toEqual(["INBOX"]);
  });
});
