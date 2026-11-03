import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { KbService } from "../src/index.js";
import { ServiceError } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

const svc = new KbService();

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const ctxA: ServiceContext = { db, accountId: A, userId: null, now: () => new Date("2026-07-28T12:00:00Z"), requestId: "r" };
  const ctxB: ServiceContext = { db, accountId: B, userId: null, now: () => new Date("2026-07-28T12:00:00Z"), requestId: "r" };
  return { db, A, B, ctxA, ctxB };
}

describe("KbService — CRUD", () => {
  it("creates, gets, lists, updates (full PUT), and removes", async () => {
    const { ctxA } = await setup();
    const created = await svc.create(ctxA, { title: "Refund policy", content: "30 days.", tags: ["billing"] });
    expect(created.title).toBe("Refund policy");
    expect(created.tags).toEqual(["billing"]);

    const got = await svc.get(ctxA, created.id);
    expect(got.content).toBe("30 days.");

    const page = await svc.list(ctxA);
    expect(page.items.map((e) => e.id)).toContain(created.id);

    const updated = await svc.update(ctxA, created.id, { title: "Refund policy v2", content: "45 days.", tags: [] });
    expect(updated.title).toBe("Refund policy v2");
    expect(updated.content).toBe("45 days.");
    expect(updated.tags).toEqual([]);

    await svc.remove(ctxA, created.id);
    await expect(svc.get(ctxA, created.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("empty title → 400; empty content → 400; bad tags → 400", async () => {
    const { ctxA } = await setup();
    await expect(svc.create(ctxA, { title: "  ", content: "x" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.create(ctxA, { title: "x", content: "" })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.create(ctxA, { title: "x", content: "y", tags: [1 as unknown as string] }))
      .rejects.toBeInstanceOf(ServiceError);
  });

  it("cross-account get/update/remove → 404", async () => {
    const { ctxA, ctxB } = await setup();
    const e = await svc.create(ctxA, { title: "secret", content: "A only" });
    await expect(svc.get(ctxB, e.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.update(ctxB, e.id, { title: "x", content: "y" })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.remove(ctxB, e.id)).rejects.toMatchObject({ httpStatus: 404 });
    // B's list never sees A's entry.
    const pb = await svc.list(ctxB);
    expect(pb.items.map((i) => i.id)).not.toContain(e.id);
  });
});

describe("KbService.retrieve — dedicated lexical retrieval", () => {
  it("ranks the relevant entry top for a lexical query", async () => {
    const { ctxA } = await setup();
    const refund = await svc.create(ctxA, { title: "Refund policy", content: "We refund within 30 days of purchase." });
    await svc.create(ctxA, { title: "Office hours", content: "We are open Monday to Friday." });
    await svc.create(ctxA, { title: "Shipping", content: "Orders ship in two business days." });

    const hits = await svc.retrieve(ctxA, "refund");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(refund.id);
  });

  /**
   * THE TWO ARMS, TOLD APART — and until this existed neither could be measured.
   *
   * The retrieval predicate is `lexical OR fuzzy`, so a case that only asks "was the entry
   * found" is answered by whichever arm happens to work. Breaking the word-index arm entirely —
   * pointing it at text that is in no entry — left every case here GREEN, on both stores,
   * because the substring degrade caught the same rows. That is a test of the pair, not of
   * either part.
   *
   * Two words that are BOTH in the entry and NOT adjacent separate them. A word index matches
   * on both stores (the server's lexeme query and this store's full-text index each treat two
   * bare terms as "and"); the degrade is a contiguous substring and cannot match at all. So a
   * hit here is the word index answering, on whichever store this run opened.
   */
  it("finds two non-adjacent words, which only the word index can do — on either store", async () => {
    const { ctxA } = await setup();
    const refund = await svc.create(ctxA, {
      title: "Refund policy", content: "We refund within 30 days of purchase.",
    });
    await svc.create(ctxA, { title: "Office hours", content: "We are open Monday to Friday." });

    const hits = await svc.retrieve(ctxA, "refund purchase");
    expect(hits.map((h) => h.id),
      "the word index found nothing, and the substring degrade cannot match two words that are " +
      "not adjacent — so this search had no working arm at all").toContain(refund.id);
  });

  it("degrades to ILIKE offline so a substring still matches (PGlite has no pg_trgm)", async () => {
    const { ctxA } = await setup();
    const e = await svc.create(ctxA, { title: "Warranty terms", content: "Covered for twelve months." });
    // "warrant" is a substring but not a full lexeme stem hit path — the degrade arm catches it.
    const hits = await svc.retrieve(ctxA, "warrant");
    expect(hits.map((h) => h.id)).toContain(e.id);
    // The degrade reads `_` as typed, never as any one character.
    const typed = await svc.create(ctxA, { title: "Ticket", content: "Logged as tk_42 today." });
    await svc.create(ctxA, { title: "Ticket two", content: "Logged as tkx42 today." });
    expect((await svc.retrieve(ctxA, "tk_42")).map((h) => h.id)).toEqual([typed.id]);
  });

  it("blank query returns nothing; retrieval is account-scoped", async () => {
    const { ctxA, ctxB } = await setup();
    await svc.create(ctxA, { title: "Refund policy", content: "30 days." });
    expect(await svc.retrieve(ctxA, "   ")).toEqual([]);
    // B has no entries → a matching query still returns nothing (isolation).
    expect(await svc.retrieve(ctxB, "refund")).toEqual([]);
  });
});
