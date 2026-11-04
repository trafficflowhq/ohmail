import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createApp, jsonResponse, recordIdempotent, type Route } from "@trafficflow/api";
import { IdempotencyRaceLost } from "@trafficflow/services";
import { rules, idempotencyKeys, recordChange, eraseIdempotentResponses, type Tx } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * DEMO handler (test-only) proving the middleware seam. It runs ONE tx that:
 * inserts a `rules` row, records the change (→ seq), and — when the middleware
 * exposed `deps.idempotency` — records the idempotency row IN THE SAME tx.
 * `calls` counts real executions so a replay can be shown to skip the handler.
 */
function makeDemo() {
  let calls = 0;
  const handler: Route["handler"] = async (request, deps) => {
    calls++;
    const body = (await request.json()) as { match: string };
    const accountId = deps.session!.accountId;
    const idem = deps.idempotency;
    const out = await (deps.db as unknown as Tx).transaction(async (tx) => {
      const [rule] = await tx.insert(rules)
        .values({ accountId, kind: "sender", match: body.match, destination: "INBOX" }).returning();
      const seq = await recordChange(tx, { accountId, entityType: "rule", entityId: rule!.id, op: "create", meta: null });
      const dto = { id: rule!.id, match: body.match };
      if (idem) {
        // The CLAIM is load-bearing: `false` means a concurrent request committed this key
        // first, and the caller must throw so its own effect rolls back (the atomic contract + the
        // concurrency fix). A real service does exactly this; see
        // `idempotency-concurrency.pg.test.ts` for the two-connection proof.
        const claimed = await recordIdempotent(tx, {
          accountId, key: idem.key, requestHash: idem.requestHash,
          responseStatus: 201, seq: Number(seq), responseJson: dto, now: deps.now(),
        });
        if (!claimed) throw new IdempotencyRaceLost(accountId, idem.key);
      }
      return { dto, seq };
    });
    return jsonResponse(out.dto, { status: 201, seq: out.seq });
  };
  return { handler, calls: () => calls };
}

describe("withIdempotency", () => {
  it("first call: 201 + X-Sync-Seq + exactly one rules row (and the idempotency row commits with it)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const demo = makeDemo();
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler: demo.handler }]);

    const res = await app.handle(
      req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body: JSON.stringify({ match: "a@b.example" }) }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    expect(demo.calls()).toBe(1);

    // Atomicity: both the rules row and the idempotency row are present after commit.
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, s.accountId));
    expect(ruleRows).toHaveLength(1);
    const idemRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idemRows).toHaveLength(1);
    expect(idemRows[0].seq).toBe(Number(res.headers.get("x-sync-seq")));
  });

  it("same key + same body: verbatim replay, handler NOT re-run, no second rules row, same X-Sync-Seq", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const demo = makeDemo();
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler: demo.handler }]);
    const body = JSON.stringify({ match: "a@b.example" });

    const first = await app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body }), deps);
    const firstJson = await first.json();
    const firstSeq = first.headers.get("x-sync-seq");

    const second = await app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body }), deps);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstJson);       // verbatim
    expect(second.headers.get("x-sync-seq")).toBe(firstSeq); // same seq
    expect(demo.calls()).toBe(1);                          // handler ran once

    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, s.accountId));
    expect(ruleRows).toHaveLength(1);                      // no second insert
  });

  it("same key + different body: 409 idempotency_replay", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const demo = makeDemo();
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler: demo.handler }]);

    await app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body: JSON.stringify({ match: "a@b.example" }) }), deps);
    const res = await app.handle(
      req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body: JSON.stringify({ match: "different@x.example" }) }),
      deps,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_replay");
    expect(demo.calls()).toBe(1);
  });

  it("after an erasure, a retry under the key is 410 whatever its body, and the row confirms no guess", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const demo = makeDemo();
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler: demo.handler }]);
    const body = JSON.stringify({ match: "a@b.example" });
    const send = (b: string) => app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body: b }), deps);
    const storedHash = async () =>
      (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId)))[0]!.requestHash;
    const guess = createHash("sha256").update(`POST\n/rules\n\n${body}`).digest("hex");

    await send(body);
    expect(await storedHash(), "the guess is not the stored hash's form").toBe(guess);
    await (db as unknown as Tx).transaction((tx) => eraseIdempotentResponses(tx, s.accountId, FIXED_NOW));
    expect(await storedHash()).not.toBe(guess);
    const same = await send(body);
    const other = await send(JSON.stringify({ match: "different@x.example" }));

    expect([same.status, other.status]).toEqual([410, 410]);
    expect((await other.json()).error.code).toBe("erased");
    expect(demo.calls()).toBe(1);
  });

  it("no Idempotency-Key: handler runs normally each time", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const demo = makeDemo();
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler: demo.handler }]);
    const body = JSON.stringify({ match: "a@b.example" });

    await app.handle(req("POST", "/rules", { bearer: s.token, body }), deps);
    await app.handle(req("POST", "/rules", { bearer: s.token, body }), deps);
    expect(demo.calls()).toBe(2);
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, s.accountId));
    expect(ruleRows).toHaveLength(2);
  });

  // The atomicity is LOAD-BEARING: the middleware provides NO silent store. A handler that
  // mutates but forgets the in-tx `recordIdempotent` is therefore NOT idempotent — the second
  // call re-runs (no row to replay). This test bites if a post-hoc net is ever reintroduced:
  // with a net, calls would be 1 and idemRows 1. The invariant is "record in-tx or you get no
  // idempotency", never "the middleware quietly covers for you (reopening the crash window)".
  it("atomicity is load-bearing: a handler that omits the in-tx record gets NO silent net", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    let calls = 0;
    const handler: Route["handler"] = async (request, d) => {
      calls++;
      const body = (await request.json()) as { match: string };
      const accountId = d.session!.accountId;
      const [rule] = await (d.db as unknown as Tx).transaction(async (tx) => {
        const inserted = await tx.insert(rules)
          .values({ accountId, kind: "sender", match: body.match, destination: "INBOX" }).returning();
        await recordChange(tx, { accountId, entityType: "rule", entityId: inserted[0]!.id, op: "create", meta: null });
        return inserted; // deliberately does NOT recordIdempotent
      });
      return jsonResponse({ id: rule!.id }, { status: 201 });
    };
    const app = createApp([{ method: "POST", pattern: "/rules", options: { idempotent: true }, handler }]);
    const body = JSON.stringify({ match: "a@b.example" });

    await app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body }), deps);
    await app.handle(req("POST", "/rules", { bearer: s.token, headers: { "idempotency-key": "k1" }, body }), deps);

    expect(calls).toBe(2); // re-ran — no silent replay
    const idemRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idemRows).toHaveLength(0); // the middleware stored nothing
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, s.accountId));
    expect(ruleRows).toHaveLength(2);
  });
});
