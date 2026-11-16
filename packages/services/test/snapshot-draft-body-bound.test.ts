import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes } from "@trafficflow/db";
import { DRAFT_BODY_MAX_BYTES, utf8ByteLength } from "@trafficflow/core/outbound-text";
import { DraftsService, SyncService, dbFor, type ServiceContext } from "../src/index.js";
import { draftRowToDTO, draftRowToSnapshotDTO } from "../src/dto/materialize.js";
import type { DraftDTO } from "../src/dto/types.js";

/**
 * THE PLAIN DRAFT BODY HAS A CEILING, AND THE TWO DOORS IT IS ENFORCED AT ANSWER DIFFERENTLY.
 *
 * The WRITE door refuses: a body past `DRAFT_BODY_MAX_BYTES` is a 413 naming the number, so
 * nothing new is ever stored over it. The bounded READ — `/sync/snapshot` page 1, which emits
 * every draft the account holds — omits: a body already stored over the ceiling arrives as `null`
 * with a reason, never as a shortened string, because a client cannot tell a truncation from the
 * text and its next autosave would write the shortening back over what the person wrote.
 *
 * The single-row reads are deliberately NOT bounded, and that is the repair path rather than an
 * oversight: `GET /drafts/:id` still answers an oversized body in full, so the message can be
 * opened, cut down and saved.
 */
const draftsSvc = new DraftsService();
const syncSvc = new SyncService();
const NOW = new Date("2026-09-12T08:00:00.000Z");

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `a-${accountId}@x.example`,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** The drafts a snapshot's page 1 carries, as the client would read them. */
async function snapshotDrafts(ctx: ServiceContext): Promise<DraftDTO[]> {
  const page = await syncSvc.getSnapshot(ctx, {});
  return page.changes.filter((c) => c.type === "draft").map((c) => c.entity as DraftDTO);
}

describe("the write door bounds the plain body", () => {
  it("admits a body exactly AT the ceiling", async () => {
    const { ctx, mailboxId } = await setup();
    const body = "a".repeat(DRAFT_BODY_MAX_BYTES);
    const { draft } = await draftsSvc.create(ctx, { mailboxId, body });
    expect(utf8ByteLength(body)).toBe(DRAFT_BODY_MAX_BYTES);
    expect(draft.body).toBe(body);
  });

  it("refuses ONE BYTE over, with the class the rich half already uses", async () => {
    const { ctx, mailboxId } = await setup();
    await expect(
      draftsSvc.create(ctx, { mailboxId, body: "a".repeat(DRAFT_BODY_MAX_BYTES + 1) }),
    ).rejects.toMatchObject({ httpStatus: 413, code: "draft_too_large" });
  });

  it("refuses on the UPDATE arm too, and the stored row is unchanged", async () => {
    const { db, ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, body: "the short one" });
    await expect(
      draftsSvc.update(ctx, draft.id, { body: "a".repeat(DRAFT_BODY_MAX_BYTES + 1) }),
    ).rejects.toMatchObject({ httpStatus: 413, code: "draft_too_large" });
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row!.body).toBe("the short one");
  });

  it("counts BYTES, not characters — a body legal by length and illegal by weight", async () => {
    const { ctx, mailboxId } = await setup();
    // Every character is three UTF-8 bytes, so a third of the ceiling plus one character is
    // three bytes over it while being far under it in `String.length`. A character-counting
    // ceiling would admit this and Postgres `octet_length` would disagree.
    const body = "ä".repeat(DRAFT_BODY_MAX_BYTES / 2 + 1);
    expect(body.length).toBeLessThan(DRAFT_BODY_MAX_BYTES);
    expect(utf8ByteLength(body)).toBeGreaterThan(DRAFT_BODY_MAX_BYTES);
    await expect(draftsSvc.create(ctx, { mailboxId, body }))
      .rejects.toMatchObject({ httpStatus: 413, code: "draft_too_large" });
  });
});

describe("the snapshot page omits an oversized stored body, and never shortens one", () => {
  /** A row written the way a client that predates the ceiling wrote one — straight into the table. */
  async function storeOversized(
    db: Awaited<ReturnType<typeof setup>>["db"], accountId: string, mailboxId: string,
  ): Promise<{ id: string; body: string }> {
    const body = "x".repeat(DRAFT_BODY_MAX_BYTES + 1);
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "the long one", body, status: "draft",
    }).returning();
    return { id: row!.id, body };
  }

  it("emits body null plus the reason, and carries none of the bytes", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const big = await storeOversized(db, accountId, mailboxId);
    await draftsSvc.create(ctx, { mailboxId, body: "the ordinary one" });

    const emitted = await snapshotDrafts(ctx);
    expect(emitted).toHaveLength(2);

    const over = emitted.find((d) => d.id === big.id)!;
    expect(over.body).toBeNull();
    expect(over.bodyOmitted).toBe("over_ceiling");
    // NOT a truncation: nothing of the text is on the page at all, and the rest of the row is
    // intact so the draft still lists with its subject.
    expect(JSON.stringify(over)).not.toContain("xxx");
    expect(over.subject).toBe("the long one");

    const ordinary = emitted.find((d) => d.id !== big.id)!;
    expect(ordinary.body).toBe("the ordinary one");
    expect(ordinary.bodyOmitted).toBeUndefined();
  });

  it("leaves the SINGLE-ROW read whole — the repair path", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const big = await storeOversized(db, accountId, mailboxId);
    const dto = await draftsSvc.get(ctx, big.id);
    expect(dto.body).toBe(big.body);
    expect(dto.bodyOmitted).toBeUndefined();
  });

  it("pairs the two keys in BOTH directions, so they cannot disagree", async () => {
    const { db, accountId, mailboxId } = await setup();
    const big = await storeOversized(db, accountId, mailboxId);
    const [ok] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "fine", body: "short", status: "draft",
    }).returning();

    for (const id of [big.id, ok!.id]) {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
      const dto = draftRowToSnapshotDTO(row!);
      expect(dto.body === null, `${id}: body null and bodyOmitted must arrive together`)
        .toBe(dto.bodyOmitted !== undefined);
    }
  });

  it("is the ONLY thing the bounded projection changes", async () => {
    const { db, accountId, mailboxId } = await setup();
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "fine", body: "short", status: "draft",
    }).returning();
    // A row under the ceiling comes back from the page projection byte-identical to the
    // authoritative one — the wrapper may take a body away and may do nothing else.
    expect(draftRowToSnapshotDTO(row!)).toEqual(draftRowToDTO(row!));
  });
});
