import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import * as dbm from "@trafficflow/db";
import { FIXED_NOW, makeDeps, seedSession } from "../../api/test/helpers.js";
import { HttpAdapter, OhmailEngine, type FetchLike } from "@ohmail/client-engine";
import { makeTestDb } from "../../db/src/testing.js";
import { applyRuleRequest, validateRulePayload } from "../../db/src/request-apply.js";
import type { LedgerTx, Tx } from "../../db/src/change-log.js";

// VERIFY-026 HIGH 2, the verifier's probe kept as the control (adapted to the belt's signature only):
// red at that change (both Receipts), green now (both News). A MIXED account (mailbox A organized here, mailbox B held by Laptop, which has
// published its copy once). The web Rules page's Change, then its toast's Undo inside 8 s. The
// organizer applies both legs in order; the reader's cycle records both acks as the worker does
// (applied rows marked and, where this build has it, settled onto the own rows in that unit).
const { accounts, mailboxes, mailboxProfileMirror, organizerRequests, rules: rulesTbl,
  markRequestsSent, markRequestsApplied, markRequestsRefused } = dbm;
const settle = dbm.settleReaderRuleRows;
const app = createApp(apiRoutes);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);

describe("VERIFY-026 probe: a mixed account's Change and its Undo", () => {
  it("Change News->Receipts, Undo back to News: where does Ann's rule end, here and on Laptop", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("authorization", `Bearer ${s.token}`);
      return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
    };
    const made = await fetchImpl("http://localhost/rules", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "sender", match: "ann@shop.example", destination: "ohmail/News" }),
    });
    expect(made.status).toBe(201);
    const ruleId = ((await made.json()) as { id: string }).id;
    await db.insert(mailboxes).values({ accountId: s.accountId, provider: "imap", address: "a@shop.test" });
    const [mbB] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "b@shop.test", organizerRole: "reader",
      organizerState: "held", organizedByCapabilities: "requests,rules,moves,profile", organizedByKind: "local", organizedByName: "Laptop",
    }).returning();
    const org = await makeTestDb();
    const [oa] = await org.insert(accounts).values({ name: "organizer" }).returning();
    await org.insert(rulesTbl).values({ accountId: oa!.id, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" });
    const doc = { rules: await org.select({
      kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination, priority: rulesTbl.priority,
      enabled: rulesTbl.enabled, provenance: rulesTbl.provenance, subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    }).from(rulesTbl) };
    await db.insert(mailboxProfileMirror).values({ mailboxId: mbB!.id, accountId: s.accountId, doc });
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), now: () => new Date(FIXED_NOW.getTime() + 1000) });
    await engine.start();

    const change = await engine.mutate({ kind: "rule_update", ruleId, destination: "ohmail/Receipts", applyRetro: false } as never);
    const undo = await engine.mutate({ kind: "rule_update", ruleId, destination: "ohmail/News", applyRetro: false } as never);
    console.log("PROBE press statuses", change.status, undo.status);

    // THE ORGANIZER: both legs, in order.
    const legs = (await db.select().from(organizerRequests))
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    expect(legs).toHaveLength(2);
    const outcomes: Array<{ id: string; kind: string; payload: unknown; decidedAt: Date; applied: boolean; refusal?: string }> = [];
    for (const r of legs) {
      const payload = validateRulePayload(r.kind, r.payload)!;
      const out = await (org as unknown as Tx).transaction((tx) =>
        applyRuleRequest(tx as unknown as LedgerTx, { accountId: oa!.id, payload, now: FIXED_NOW })) as { applied: boolean; refusal?: string };
      console.log("PROBE leg", JSON.stringify((r.payload as { shown?: unknown }).shown), "->", JSON.stringify(out, big));
      outcomes.push({ id: r.id, kind: r.kind, payload: r.payload, decidedAt: r.decidedAt, applied: out.applied, ...(out.refusal ? { refusal: out.refusal } : {}) });
    }
    // THE READER'S CYCLE: both acks in one pass, as `driveOutstandingRequests` records them.
    const applied = outcomes.filter((o) => o.applied);
    await (db as unknown as Tx).transaction(async (tx) => {
      await markRequestsSent(tx as never, outcomes.map((o) => o.id), FIXED_NOW);
      await markRequestsApplied(tx as never, applied.map((o) => o.id), FIXED_NOW);
      for (const o of applied) await settle(tx as never, s.accountId, { kind: o.kind, payload: o.payload, decidedAt: o.decidedAt });
    });
    for (const o of outcomes.filter((x) => !x.applied)) {
      await (db as unknown as Tx).transaction((tx) => markRequestsRefused(tx as never, [o.id], (o.refusal ?? null) as never, FIXED_NOW));
    }
    const here = (await db.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
    const there = (await org.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
    console.log("PROBE after the cycle: mailbox A's rule (here)", JSON.stringify(here), "mailbox B's rule (Laptop)", JSON.stringify(there));
    expect(here, "the rule that files mailbox A after the person's Undo").toEqual(["ohmail/News"]);
    expect(there, "the rule that files mailbox B after the person's Undo").toEqual(["ohmail/News"]);
  });
});
