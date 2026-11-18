import type { DraftDTO, SnapshotResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes } from "@trafficflow/db";
import { PAGE_MAX_ROW_BYTES } from "@trafficflow/core/transport-frame";
import { DRAFT_ROW_MAX_BYTES, PageByteBudget, weighChange } from "../src/sync-page-byte-budget.js";
import { draftRowToDTO, draftRowWithheldDTO } from "../src/dto/materialize.js";
import { SyncService, dbFor, type ServiceContext } from "../src/index.js";

/**
 * THE BUDGET ITSELF, AND THE ORDINARY PAGE IT MUST LEAVE ALONE.
 *
 * The transport arm (`apps/sidecar/test/sync-page-fits-the-frame.pg.test.ts`) drives the real
 * encoder over a real 34 MB corpus. This is the half that fits in PGlite: the arithmetic, the
 * withheld projection's pairing rule, and the positive control that a page inside every bound is
 * byte-for-byte what it was before there was a byte bound at all.
 */
const sync = new SyncService();
const NOW = new Date("2026-09-14T09:00:00.000Z");

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `b-${accountId}@x.example`,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** The bytes the route's serializer would put on the wire for this page. */
const wireBytes = (page: SnapshotResponse): number => Buffer.byteLength(JSON.stringify(page), "utf8");

describe("weighChange measures with the serializer the transport uses", () => {
  it("counts UTF-8 bytes, not characters — the trap the row limits fell into", () => {
    const ascii = weighChange({ s: "a".repeat(100) });
    const accented = weighChange({ s: "ä".repeat(100) });
    // Same `String.length`, twice the bytes. A character count would call these equal.
    expect(accented).toBeGreaterThan(ascii);
    expect(accented - ascii).toBe(100);
  });

  it("includes the separator, so a sum of changes is not short of the array it becomes", () => {
    const one = { type: "draft", id: "a" };
    const two = { type: "draft", id: "b" };
    const asArray = Buffer.byteLength(JSON.stringify([one, two]), "utf8");
    // `[` + `]` are the envelope's, which the frame reserve covers; everything inside is charged.
    expect(weighChange(one) + weighChange(two)).toBe(asArray - 1);
  });
});

describe("PageByteBudget", () => {
  it("admits up to the limit and not past it", () => {
    const b = new PageByteBudget(1000);
    expect(b.admits(1000)).toBe(true);
    expect(b.admits(1001)).toBe(false);
    b.charge(400);
    expect(b.used).toBe(400);
    expect(b.admits(600)).toBe(true);
    expect(b.admits(601)).toBe(false);
  });

  it("holds a reserve back for the phase that comes after", () => {
    const b = new PageByteBudget(1000);
    b.charge(500);
    expect(b.admits(500)).toBe(true);
    // The same 500 bytes, asked with 200 kept back for the draft phase.
    expect(b.admits(500, 200)).toBe(false);
    expect(b.remaining(200)).toBe(300);
  });

  it("a limit of 0 or none is refused by name — it would bound the page by rows alone", () => {
    expect(new PageByteBudget(PAGE_MAX_ROW_BYTES).remaining()).toBe(PAGE_MAX_ROW_BYTES);
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(() => new PageByteBudget(limit as number), String(limit)).toThrow(/^PageByteBudget: /);
    }
  });
});

describe("the withheld projection", () => {
  it("takes all three free-text fields and pairs the marker with a null body", async () => {
    const { db, accountId, mailboxId } = await setup();
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "the heavy one", body: "some words",
      html: "<p>some words</p>", rationale: "why the model wrote it", status: "draft",
    }).returning();
    const whole = draftRowToDTO(row!);
    const withheld = draftRowWithheldDTO(whole);

    expect(withheld.body).toBeNull();
    expect(withheld.html).toBeNull();
    expect(withheld.rationale).toBeNull();
    expect(withheld.bodyOmitted).toBe("over_page_budget");
    // The pairing rule the snapshot writer's own test states, in both directions.
    expect(withheld.body === null).toBe(withheld.bodyOmitted !== undefined);
    // The row still LISTS: nothing else is taken, so the draft has a subject and its dates.
    expect(withheld.subject).toBe("the heavy one");
    expect(withheld.id).toBe(whole.id);
    expect(withheld.updatedAt).toBe(whole.updatedAt);
    expect(withheld.to).toEqual(whole.to);
  });

  it("is small enough to ride a page — that is the whole point of withholding it", async () => {
    const { db, accountId, mailboxId } = await setup();
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "s".repeat(1000), body: "b".repeat(50_000),
      html: "<p>h</p>", rationale: "r".repeat(500_000), status: "draft",
    }).returning();
    const withheld = draftRowWithheldDTO(draftRowToDTO(row!));
    expect(weighChange(withheld)).toBeLessThan(DRAFT_ROW_MAX_BYTES);
  });
});

describe("an ordinary page is untouched by any of this (the positive control)", () => {
  it("five small drafts arrive on one page, whole, with no marker and no second page", async () => {
    const { ctx, mailboxId, db, accountId } = await setup();
    const made = await db.insert(drafts).values(
      Array.from({ length: 5 }, (_, i) => ({
        accountId, mailboxId, subject: `note ${i}`, body: `a few words ${i}`,
        html: `<p>a few words ${i}</p>`, status: "draft" as const,
        updatedAt: new Date(NOW.getTime() - i * 60_000),
      })),
    ).returning({ id: drafts.id });

    const page = await sync.getSnapshot(ctx, {});
    const seen = page.changes.filter((c) => c.type === "draft").map((c) => c.entity as DraftDTO);

    expect(page.nextCursor).toBeNull();
    expect(seen.map((d) => d.id).sort()).toEqual(made.map((r) => r.id).sort());
    for (const d of seen) {
      expect(d.bodyOmitted).toBeUndefined();
      expect(d.body).toMatch(/^a few words /);
      expect(d.html).toMatch(/^<p>a few words /);
    }
    // And it is nowhere near the bound: the budget can only be visible on a page that needs it.
    expect(wireBytes(page)).toBeLessThan(PAGE_MAX_ROW_BYTES / 1000);
  });

  it("an oversized stored BODY still says over_ceiling, not the new reason", async () => {
    const { ctx, db, accountId, mailboxId } = await setup();
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "the long one", body: "x".repeat(262_145), status: "draft",
    }).returning({ id: drafts.id });
    const page = await sync.getSnapshot(ctx, {});
    const dto = page.changes.find((c) => c.type === "draft" && c.id === row!.id)!.entity as DraftDTO;
    // The two reasons name two different facts and the older one must not be swallowed: this row
    // is under the page budget, so only its body was ever the problem.
    expect(dto.bodyOmitted).toBe("over_ceiling");
    expect(dto.html).toBeNull();   // it was stored plain
  });
});
