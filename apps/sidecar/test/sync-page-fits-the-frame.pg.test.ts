import type { SnapshotResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drafts, mailboxes } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { jsonResponse } from "@trafficflow/api";
import { syncService, type ServiceContext } from "@trafficflow/services";
import { MAX_BODY_BYTES } from "../src/frame.js";
import { SYNC_PAGE_MAX_BYTES } from "@trafficflow/core/transport-frame";
import { encodeResponse } from "../src/protocol.js";

/**
 * A SNAPSHOT PAGE IS BOUNDED BY BYTES, NOT ONLY BY ROWS — measured against the REAL encoder.
 *
 * The builder counted rows and the transport counts bytes, so a page correct by every row rule
 * was still refused: a few hundred stored drafts of rich text and HTML each made a
 * page past the frame cap in bytes. That refusal is not a slow page —
 * `serveOverStdio` answers `sidecar_failed` and the bootstrap never completes, so a person with
 * many rich drafts gets no mail at all, on every retry.
 *
 * The encoder is the real one on purpose: a stub of it is how the two halves disagreed unnoticed.
 * Real Postgres for the fixture because PGlite's wasm heap will not hold 34 MB of rows.
 */
const PG_UP = await realPgAvailable();

let owned: OwnedDb;
let db: OwnedDb["db"];

const NOW = new Date("2026-09-14T09:00:00.000Z");
const RICH_KIB = 170;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "page-fits-the-frame",
});

/** Roughly `kib` kibibytes of ASCII — one byte per character, so the figure is the weight. */
function filler(kib: number, seed: string): string {
  return `${seed}-`.repeat(Math.ceil((kib * 1024) / (seed.length + 1))).slice(0, kib * 1024);
}

/** The page as the transport sees it: the route's own serializer, then the encoder's own cap. */
async function frameBytes(page: SnapshotResponse): Promise<number> {
  const framed = await encodeResponse(1, jsonResponse(page), MAX_BODY_BYTES);
  return framed.body.byteLength;
}

interface Withheldable {
  body: string | null; html: string | null; rationale: string | null; omitted?: string;
}

/** Walk the whole snapshot, framing every page. Returns the drafts delivered and how they came. */
async function drain(accountId: string): Promise<{
  pages: number; bytes: number[]; drafts: Map<string, Withheldable>;
}> {
  const seen = new Map<string, Withheldable>();
  const bytes: number[] = [];
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const page = await syncService.getSnapshot(ctx(accountId), cursor ? { cursor } : {});
    bytes.push(await frameBytes(page));
    for (const c of page.changes) {
      if (c.type !== "draft") continue;
      const d = c.entity as { body: string | null; html: string | null; rationale: string | null; bodyOmitted?: string };
      seen.set(c.id, {
        body: d.body, html: d.html, rationale: d.rationale,
        ...(d.bodyOmitted ? { omitted: d.bodyOmitted } : {}),
      });
    }
    if (page.nextCursor === null) return { pages, bytes, drafts: seen };
    cursor = page.nextCursor;
    if (pages > 60) throw new Error("the snapshot walk did not terminate");
  }
}

describe.skipIf(!PG_UP)("a snapshot page fits the frame that carries it (real Postgres)", () => {
  let richAccount: string;
  let richIds: string[];
  let hugeAccount: string;
  let hugeId: string;
  let smallIds: string[];
  let plainAccount: string;
  let plainIds: string[];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;

    // ── The round's own subject: a few hundred drafts of rich text and HTML.
    richAccount = randomUUID();
    const [rmb] = await db.insert(mailboxes).values({
      accountId: richAccount, provider: "imap", address: `rich-${richAccount}@tf.example`,
    }).returning();
    richIds = [];
    for (let i = 0; i < 100; i += 10) {
      const batch = Array.from({ length: 10 }, (_, k) => ({
        accountId: richAccount, mailboxId: rmb!.id, subject: `rich ${i + k}`,
        body: filler(RICH_KIB, `t${i + k}`),
        html: `<p>${filler(RICH_KIB, `h${i + k}`)}</p>`,
        status: "draft" as const,
        updatedAt: new Date(NOW.getTime() - (i + k) * 60_000),
      }));
      const back = await db.insert(drafts).values(batch).returning({ id: drafts.id });
      richIds.push(...back.map((r) => r.id));
    }

    // ── ONE row that cannot fit an empty page, beside ordinary ones on the same page.
    hugeAccount = randomUUID();
    const [hmb] = await db.insert(mailboxes).values({
      accountId: hugeAccount, provider: "imap", address: `huge-${hugeAccount}@tf.example`,
    }).returning();
    const [huge] = await db.insert(drafts).values({
      accountId: hugeAccount, mailboxId: hmb!.id, subject: "the enormous one",
      // 40 MiB in `rationale` — the AI drafter's reasoning, which has no ceiling at the write
      // door, none in the DTO and none in the schema. `body` has `DRAFT_BODY_MAX_BYTES` and
      // `html` has the `drafts_html_cap` CHECK, so this column is where a row this heavy is
      // actually reachable, and a page carrying it is a page no transport takes.
      rationale: filler(40 * 1024, "huge"),
      html: "<p>the rich half, ordinary</p>", body: "a short plain alternative",
      status: "draft", updatedAt: new Date(NOW.getTime() - 60_000),
    }).returning({ id: drafts.id });
    hugeId = huge!.id;
    const small = await db.insert(drafts).values(
      Array.from({ length: 3 }, (_, i) => ({
        accountId: hugeAccount, mailboxId: hmb!.id, subject: `ordinary ${i}`,
        body: `nothing much ${i}`, status: "draft" as const,
        updatedAt: new Date(NOW.getTime() - (i + 2) * 60_000),
      })),
    ).returning({ id: drafts.id });
    smallIds = small.map((r) => r.id);

    // ── The positive control: an ordinary account, well under every bound.
    plainAccount = randomUUID();
    const [pmb] = await db.insert(mailboxes).values({
      accountId: plainAccount, provider: "imap", address: `plain-${plainAccount}@tf.example`,
    }).returning();
    const plain = await db.insert(drafts).values(
      Array.from({ length: 5 }, (_, i) => ({
        accountId: plainAccount, mailboxId: pmb!.id, subject: `note ${i}`,
        body: `a few words ${i}`, status: "draft" as const,
        updatedAt: new Date(NOW.getTime() - i * 60_000),
      })),
    ).returning({ id: drafts.id });
    plainIds = plain.map((r) => r.id);
  }, 600_000);

  afterAll(async () => {
    if (!owned) return;
    for (const a of [richAccount, hugeAccount, plainAccount]) {
      await db.delete(drafts).where(eq(drafts.accountId, a));
      await db.delete(mailboxes).where(eq(mailboxes.accountId, a));
    }
    await owned.close();
  }, 300_000);

  it("the fixture is the round's: 100 drafts whose rows alone outweigh a page", async () => {
    const rows = await db.select({ body: drafts.body, html: drafts.html }).from(drafts)
      .where(eq(drafts.accountId, richAccount));
    const stored = rows.reduce(
      (n, r) => n + Buffer.byteLength(r.body ?? "", "utf8") + Buffer.byteLength(r.html ?? "", "utf8"), 0,
    );
    expect(rows).toHaveLength(100);
    expect(stored, "the corpus must exceed the cap or the arm proves nothing")
      .toBeGreaterThan(SYNC_PAGE_MAX_BYTES);
  }, 120_000);

  /** CONTROL (1) — the round's own subject. */
  it("every page encodes under the cap and all 100 drafts arrive across them", async () => {
    const walk = await drain(richAccount);
    for (const [i, n] of walk.bytes.entries()) {
      expect(n, `page ${i + 1} is ${n} bytes, past the ${SYNC_PAGE_MAX_BYTES}-byte cap`)
        .toBeLessThanOrEqual(SYNC_PAGE_MAX_BYTES);
    }
    expect(walk.pages, "one page could not have carried this corpus").toBeGreaterThan(1);
    expect([...walk.drafts.keys()].sort()).toEqual([...richIds].sort());
    // Not one of them was withheld: every draft here fits a page of its own many times over.
    expect([...walk.drafts.values()].filter((d) => d.omitted !== undefined)).toEqual([]);
  }, 600_000);

  /** CONTROL (2) — one row that cannot fit an empty page. */
  it("withholds the single oversized row with its marker and delivers the rest of the page", async () => {
    const walk = await drain(hugeAccount);
    for (const n of walk.bytes) expect(n).toBeLessThanOrEqual(SYNC_PAGE_MAX_BYTES);

    const withheld = walk.drafts.get(hugeId);
    expect(withheld, "the oversized draft was dropped, not withheld").toBeDefined();
    expect(withheld!.body).toBeNull();
    expect(withheld!.omitted).toBe("over_page_budget");
    // All three free-text fields go together: leaving `rationale` would leave the very bytes
    // that made the row too heavy, and leaving `html` would carry the same words twice.
    expect(withheld!.html).toBeNull();
    expect(withheld!.rationale).toBeNull();

    for (const id of smallIds) {
      expect(walk.drafts.get(id)?.omitted, `${id} rode with it and must be whole`).toBeUndefined();
      expect(walk.drafts.get(id)?.body).toMatch(/^nothing much /);
    }
  }, 600_000);

  /** CONTROL (3) — the positive control: an ordinary account is untouched by any of this. */
  it("an ordinary account still arrives in ONE page with every body whole", async () => {
    const walk = await drain(plainAccount);
    expect(walk.pages).toBe(1);
    expect(walk.bytes[0]).toBeLessThan(SYNC_PAGE_MAX_BYTES / 100);
    expect([...walk.drafts.keys()].sort()).toEqual([...plainIds].sort());
    for (const d of walk.drafts.values()) {
      expect(d.omitted).toBeUndefined();
      expect(d.body).toMatch(/^a few words /);
    }
  }, 300_000);
});
