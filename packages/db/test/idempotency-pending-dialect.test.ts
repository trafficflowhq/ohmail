import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  accounts, idempotencyKeys, claimIdempotencyKey, settleIdempotencyKey, releasePendingIdempotencyKey,
  eraseIdempotentResponses, readIdempotencyKey, IDEMPOTENCY_PENDING_STATUS, IDEMPOTENCY_PENDING_BODY,
  IDEMPOTENCY_TTL_MS, type Tx,
} from "../src/index.js";

/*
 * A KEY CLAIMED BEFORE ITS ANSWER — the three statements, on whichever store this run is (the
 * sqlite project runs this file too). A pending claim binds the key for its own short TTL, the
 * settle takes over only its own body's pending row, and the release deletes only a pending row
 * under that body's hash. Each refusal sits beside the admit that proves the statement ran.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const TTL = 63_000;

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "idempotency-pending" });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => db.transaction((t) => fn(t as unknown as Tx));
  const pending = (key: string, hash: string, now = NOW) => tx((t) => claimIdempotencyKey(t, {
    accountId, key, requestHash: hash, responseStatus: IDEMPOTENCY_PENDING_STATUS,
    responseJson: IDEMPOTENCY_PENDING_BODY, seq: null, now, ttlMs: TTL,
  }));
  const settle = (key: string, hash: string, body: unknown, now = NOW) => tx((t) => settleIdempotencyKey(t, {
    accountId, key, requestHash: hash, responseStatus: 200, responseJson: body, seq: 0, now,
  }));
  const release = (key: string, hash: string) => tx((t) => releasePendingIdempotencyKey(t, { accountId, key, requestHash: hash }));
  const row = async (key: string) => (await db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key))))[0];
  return { db, accountId, pending, settle, release, row };
}

describe("a pending idempotency key, on this store", () => {
  it("binds the key for its own TTL, then frees it", async () => {
    const w = await world();
    expect(await w.pending("k1", "hA")).toBe(true);
    expect(await w.pending("k1", "hB", new Date(NOW.getTime() + TTL - 1_000)), "a live pending key was taken").toBe(false);
    expect(await w.pending("k1", "hB", new Date(NOW.getTime() + TTL + 1_000))).toBe(true);
  });

  it("settles only its own body's pending row", async () => {
    const w = await world();
    await w.pending("k2", "hA");
    expect(await w.settle("k2", "hB", { other: true }), "another body settled over the claim").toBe(false);
    expect(await w.settle("k2", "hA", { answer: 1 })).toBe(true);
    const r = await w.row("k2");
    expect({ status: r?.responseStatus, json: r?.responseJson }).toEqual({ status: 200, json: { answer: 1 } });
    expect(await w.settle("k2", "hA", { answer: 2 }), "a settled answer was overwritten").toBe(false);
  });

  it("never settles into a row an erasure stamped", async () => {
    const w = await world();
    await w.pending("k3", "hA");
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW);
    expect(await w.settle("k3", "hA", { answer: 1 })).toBe(false);
    expect((await w.row("k3"))?.responseJson).toBe("erased");
  });

  it("releases only a pending row under its own hash, never a settled answer", async () => {
    const w = await world();
    await w.pending("k4", "hA");
    expect(await w.release("k4", "hB"), "another body's release took the claim").toBe(false);
    expect(await w.release("k4", "hA")).toBe(true);
    expect(await w.row("k4")).toBeUndefined();
    await w.pending("k5", "hA");
    await w.settle("k5", "hA", { answer: 1 });
    expect(await w.release("k5", "hA")).toBe(false);
    expect((await w.row("k5"))?.responseJson).toEqual({ answer: 1 });
  });

  it("hands back its own claim after an erasure blanked it, never an erased answer", async () => {
    const w = await world();
    await w.pending("k9", "hA");
    await w.pending("k10", "hA");
    await w.settle("k10", "hA", { answer: 1 });
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW);
    expect(await w.release("k9", "hA"), "the run's own claim stayed bound after the erasure").toBe(true);
    expect(await w.row("k9")).toBeUndefined();
    expect(await w.release("k10", "hA"), "an erased answer was handed back for a re-run").toBe(false);
    expect((await w.row("k10"))?.responseJson).toBe("erased");
  });
});

/*
 * AN EXPIRED KEY IS TAKEN OVER WHOLE. An erasure stamps every row the account holds; a row that
 * then expires and is claimed again carries a NEW answer, so the takeover clears the stamp in the
 * statement that claims it. Left standing, the middleware answers that new answer's every replay
 * 410 until the worker prunes the row. The live stamped row stays refused and stamped.
 */
describe("an expired key an erasure stamped, taken over on this store", () => {
  const LATER = new Date(NOW.getTime() + IDEMPOTENCY_TTL_MS + 60 * 60 * 1000);
  const claim = (w: Awaited<ReturnType<typeof world>>, key: string, hash: string, body: unknown, now: Date) =>
    w.db.transaction((t) => claimIdempotencyKey(t as unknown as Tx, {
      accountId: w.accountId, key, requestHash: hash, responseStatus: 201, responseJson: body, seq: null, now,
    }));
  const read = (w: Awaited<ReturnType<typeof world>>, key: string, now: Date) =>
    readIdempotencyKey(w.db as unknown as Tx, w.accountId, key, now);

  it("replays the new answer, not the old erasure", async () => {
    const w = await world();
    expect(await claim(w, "k6", "hA", { first: 1 }, NOW)).toBe(true);
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, new Date(NOW.getTime() + 1_000));
    expect(await claim(w, "k6", "hB", { second: 2 }, LATER), "the expired row was not taken over").toBe(true);
    const r = await read(w, "k6", new Date(LATER.getTime() + 1_000));
    expect({ hash: r?.requestHash, json: r?.responseJson, erasedAt: r?.erasedAt })
      .toEqual({ hash: "hB", json: { second: 2 }, erasedAt: null });
  });

  it("a pending claim over it settles", async () => {
    const w = await world();
    await w.pending("k7", "hA");
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW);
    const after = new Date(NOW.getTime() + TTL + 1_000);
    expect(await w.pending("k7", "hB", after)).toBe(true);
    expect(await w.settle("k7", "hB", { answer: 3 }, after), "the stamp refused its own claim's settle").toBe(true);
    expect((await read(w, "k7", after))?.erasedAt).toBeNull();
  });

  it("POSITIVE CONTROL: a live stamped row is neither taken over nor unstamped", async () => {
    const w = await world();
    await claim(w, "k8", "hA", { first: 1 }, NOW);
    await eraseIdempotentResponses(w.db as unknown as Tx, w.accountId, NOW);
    expect(await claim(w, "k8", "hB", { second: 2 }, new Date(NOW.getTime() + 60_000))).toBe(false);
    const r = await read(w, "k8", new Date(NOW.getTime() + 60_000));
    // The request's hash goes with its answer: a guess at a short body must confirm nothing.
    expect({ hash: r?.requestHash, json: r?.responseJson, stamped: r?.erasedAt instanceof Date })
      .toEqual({ hash: "", json: "erased", stamped: true });
  });
});
