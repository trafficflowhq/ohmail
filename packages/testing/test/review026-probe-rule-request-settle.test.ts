import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { mailboxes, organizerRequests, markRequestsApplied, markRequestsRefused, markRequestsSent } from "@trafficflow/db";
import { FIXED_NOW, makeDeps, seedSession } from "../../api/test/helpers.js";
import { HttpAdapter, OhmailEngine, rulesList, type FetchLike } from "@ohmail/client-engine";
import { waitingByRow, actingRules } from "../../../apps/webapp/app/views/rules-standing.js";

// REVIEW-026 H2, the reviewer's probe kept as the control: the REAL rules route's 202 through the
// REAL engine, on a reader-only account. Red at that change; the press now carries its legs' ids.
const app = createApp(apiRoutes);

async function world(clientSkewMs: number) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const bodies: Array<{ method: string; path: string; status: number; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    const res = await app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
    const u = new URL(String(url));
    if ((init?.method ?? "GET") !== "GET") {
      const copy = res.clone();
      bodies.push({ method: init?.method ?? "GET", path: u.pathname, status: res.status, body: await copy.json().catch(() => null) });
    }
    return res;
  };
  // A rule made while no mailbox exists is written here (201); then the only mailbox is held elsewhere.
  const made = await fetchImpl("http://localhost/rules", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "sender", match: "ann@shop.example", destination: "ohmail/News" }),
  });
  expect(made.status).toBe(201);
  const ruleId = ((await made.json()) as { id: string }).id;
  await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@shop.test", organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules,moves,profile", organizedByKind: "local", organizedByName: "Laptop",
  });
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }),
    // The client's clock as it reads the 202's answer: after the server stamped `decided_at` (+), or behind it (-).
    now: () => new Date(FIXED_NOW.getTime() + clientSkewMs),
  });
  return { db, deps, s, engine, ruleId, bodies };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("REVIEW-026 probe: a queued rule removal and the server's list", () => {
  it("the real 202 carries no top-level requestId; the queue entry carries its leg's id", async () => {
    const w = await world(1000);
    await w.engine.start();
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId: w.ruleId });
    expect(res.status).toBe("awaiting_organizer");
    const del = w.bodies.find((b) => b.method === "DELETE")!;
    console.log("PROBE 202 BODY", JSON.stringify(del));
    expect(del.status).toBe(202);
    expect((del.body as Record<string, unknown>).requestId).toBeUndefined();
    const [row] = await w.db.select().from(organizerRequests);
    expect(w.engine.organizerRequests().map((r) => r.requestId)).toEqual([row!.id]);
  });

  it("while the request is still pending, one press is how many entries", async () => {
    const w = await world(1000);
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_delete", ruleId: w.ruleId });
    w.engine.refreshWaitingOnOrganizer();
    await tick();
    const list = w.engine.waitingOnOrganizer();
    console.log("PROBE pending list", JSON.stringify(list.map((x) => ({ requestId: x.requestId, state: x.state, kind: x.kind }))));
    console.log("PROBE pending phone strip open count", list.filter((x) => x.state !== "refused").length);
    expect(list, "one press reads as one entry").toHaveLength(1);
  });

  for (const outcome of ["refused", "applied"] as const) {
    it(`after the organizer's ${outcome} ack, what the engine and the Rules page say`, async () => {
      const w = await world(1000);
      await w.engine.start();
      await w.engine.mutate({ kind: "rule_delete", ruleId: w.ruleId });
      const all = await w.db.select().from(organizerRequests); expect(all).toHaveLength(1); const row = all[0];
      await w.db.transaction(async (tx) => {
        await markRequestsSent(tx as never, [row!.id], FIXED_NOW);
        if (outcome === "refused") await markRequestsRefused(tx as never, [row!.id], "no_such_rule", FIXED_NOW);
        else await markRequestsApplied(tx as never, [row!.id], FIXED_NOW);
      });
      w.engine.refreshWaitingOnOrganizer();
      await tick();
      await w.engine.syncOnce();
      await tick();
      const list = w.engine.waitingOnOrganizer();
      console.log(`PROBE ${outcome} queue`, JSON.stringify(w.engine.organizerRequests()));
      console.log(`PROBE ${outcome} list`, JSON.stringify(list.map((x) => ({ requestId: x.requestId, kind: x.kind, state: x.state, reason: x.refusedReason, ruleId: x.ruleId, decidedAt: x.decidedAt }))));
      const rules = rulesList(w.engine.read());
      const { shown } = actingRules(rules);
      const split = waitingByRow(list.filter((x) => x.kind.startsWith("rule.")), shown, rules);
      const onRow = split.onRow.get(w.ruleId);
      console.log(`PROBE ${outcome} row note`, JSON.stringify(onRow ? { state: onRow.state, reason: onRow.refusedReason, requestId: onRow.requestId } : null));
      // The phone strip's count: `waiting-lines.ts:13` counts every entry that is not refused.
      console.log(`PROBE ${outcome} phone strip open count`, list.filter((x) => x.state !== "refused").length);
      // What a correct merge would give: the queue settled by the server's ending.
      expect(w.engine.organizerRequests(), "the queue entry outlived the server's ending").toHaveLength(0);
      expect(onRow?.state ?? "none", "the rule's row note").toBe(outcome === "refused" ? "refused" : "none");
    });
  }
});
