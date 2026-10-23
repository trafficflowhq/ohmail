import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts } from "@trafficflow/db";
import { DraftsService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * compose half — `POST /drafts` refuses a DISABLED mailbox with a 400.
 *
 * The refusal that prevents the damage lives in `SendService.reserve` (see
 * `send-disabled-mailbox.pg.test.ts`). This one exists for a different reason: it is the
 * difference between "you cannot pick this sender" and "we took your message and then could not
 * send it". The user is told while the text is still in front of them.
 *
 * The negative cases carry as much weight as the positive one. `'error'` is the sync worker's
 * verdict about IMAP and `sync_blocked_reason` is a note about our own infrastructure — neither
 * says anything about SMTP, and either one blocking compose would strand a user's outbox on a
 * fault they did not cause and cannot clear.
 */
const svc = new DraftsService();
const NOW = new Date("2026-08-04T12:00:00Z");

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const mk = async (status: string, syncBlockedReason: string | null = null) => {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${status}-${randomUUID().slice(0, 8)}@x.test`,
      status, syncBlockedReason,
    }).returning();
    return mb!.id;
  };
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, accountId, ctx, mk };
}

describe("POST /drafts refuses a disabled mailbox", () => {
  it("a DISABLED mailbox → 400, and no draft row is written", async () => {
    const { db, ctx, mk } = await setup();
    const mbId = await mk("disabled");

    const err = await svc.create(ctx, {
      mailboxId: mbId, subject: "Re: hi", to: [{ name: null, address: "you@example.com" }],
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 400, code: "validation_failed" });
    // The message has to tell the user what to DO, not merely that something is wrong.
    expect((err as Error).message).toMatch(/disconnected/i);

    expect(await db.select().from(drafts).where(eq(drafts.mailboxId, mbId))).toHaveLength(0);
  });

  it("a CONNECTED mailbox still composes", async () => {
    const { ctx, mk } = await setup();
    const { draft } = await svc.create(ctx, { mailboxId: await mk("connected"), subject: "ok" });
    expect(draft.status).toBe("draft");
  });

  it("'error' STILL COMPOSES — a failed IMAP sync says nothing about SMTP", async () => {
    const { ctx, mk } = await setup();
    const { draft } = await svc.create(ctx, { mailboxId: await mk("error"), subject: "ok" });
    expect(draft.status).toBe("draft");
  });

  it("a SYNC-BLOCKED mailbox STILL COMPOSES — the block is about our infrastructure", async () => {
    const { ctx, mk } = await setup();
    for (const reason of ["lease_unreadable", "awaiting_credentials", "at_capacity"]) {
      const { draft } = await svc.create(ctx, {
        mailboxId: await mk("connected", reason), subject: `ok-${reason}`,
      });
      expect(draft.status).toBe("draft");
    }
  });

  it("the ownership check is UNCHANGED: a foreign mailbox is still 400, whatever its status", async () => {
    const { db, ctx } = await setup();
    const other = randomUUID();
    const [foreign] = await db.insert(mailboxes).values({
      accountId: other, provider: "imap", address: "foreign@x.test", status: "connected",
    }).returning();
    await expect(svc.create(ctx, { mailboxId: foreign!.id })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.create(ctx, { mailboxId: randomUUID() })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("PUT /drafts/:id: naming the row's own disabled mailbox is no move", () => {
  /* A draft kept from a removed mailbox is saved by the paired phone naming its own mailbox; every
     mailboxId used to count as a move, and the refusal rolled the new words back. */
  it("a save naming the row's own disabled mailbox takes the words and keeps the mailbox", async () => {
    const { db, ctx, mk } = await setup();
    const mbId = await mk("connected");
    const { draft } = await svc.create(ctx, { mailboxId: mbId, subject: "plan", body: "the words" });
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mbId));

    const out = await svc.update(ctx, draft.id, { mailboxId: mbId, body: "the words, and more" });
    expect(out.draft).toMatchObject({ body: "the words, and more", mailboxId: mbId });
  });

  it("a MOVE onto a disabled mailbox is still 400, and the row keeps its words and mailbox", async () => {
    const { db, ctx, mk } = await setup();
    const from = await mk("connected");
    const gone = await mk("disabled");
    const { draft } = await svc.create(ctx, { mailboxId: from, subject: "plan", body: "the words" });

    const err = await svc.update(ctx, draft.id, { mailboxId: gone, body: "moved" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 400, code: "validation_failed" });
    const [row] = await db.select({ body: drafts.body, mailboxId: drafts.mailboxId }).from(drafts).where(eq(drafts.id, draft.id));
    expect(row).toEqual({ body: "the words", mailboxId: from });
  });

  it("a foreign mailbox id on an update is still 400", async () => {
    const { ctx, mk } = await setup();
    const { draft } = await svc.create(ctx, { mailboxId: await mk("connected"), subject: "plan" });
    await expect(svc.update(ctx, draft.id, { mailboxId: randomUUID(), body: "x" })).rejects.toMatchObject({ httpStatus: 400 });
  });
});
