import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, mailboxes } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  MAILBOX_SIGNATURE_MAX_CHARS, MailboxService, SyncService, mailboxSignatures, setMailboxSignature,
  type ServiceContext, type SettingsDTO,
} from "../src/index.js";

/**
 * ═══ THE PER-MAILBOX SIGNATURE'S WRITE PATH — mail 0075 ══════════════════════════════════════
 *
 * The stored text a compose offers under the message when the mailbox is the sender. The write
 * path is `setMailboxFoldersEnabled`'s statement for statement — ownership 404 before anything
 * writes, the settings stamp moved BEFORE the mailbox row, the `settings` change row in the
 * same transaction — so the properties pinned here are the same ones that seam already earns:
 * the echo is what the database holds, a foreign mailbox persists nothing, and every write
 * rings the wake so open composers re-read `GET /consent` live.
 *
 * The COMPOSE-side rules (the removable block, follows-From-unless-edited, serialize exactly
 * as shown) live in the webapp suites; nothing here reads the column on the send path, because
 * nothing on the send path does.
 */

const svc = new SyncService();

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [a] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "one@example.com" }).returning();
  const [b] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "two@example.com" }).returning();
  let tick = 0;
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date(Date.parse("2026-08-27T00:00:00.000Z") + ++tick * 1_000),
    requestId: "r",
  };
  return { db, accountId, mb1: a!.id, mb2: b!.id, ctx };
}

const column = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string) => {
  const [row] = await db.select({ signature: mailboxes.signature })
    .from(mailboxes).where(eq(mailboxes.id, id));
  return row!.signature;
};

describe("setMailboxSignature — store, clear, refuse", () => {
  it("stores the text AS TYPED and echoes what the column holds", async () => {
    const { db, mb1, ctx } = await setup();
    const text = "Best regards\nAnna Muster\nohmail.app";
    const out = await setMailboxSignature(ctx, mb1, text);
    // `signatureHtml: null` is the new third field (mail 0098): a plain write stores text and
    // no markup, which is what every write on this path does. Named rather than loosened —
    // `toEqual` still pins the WHOLE echo, so a future field cannot appear unnoticed.
    expect(out).toEqual({ mailboxId: mb1, signature: text, signatureHtml: null });
    expect(await column(db, mb1)).toBe(text);
  });

  it("null clears; a blank string is nobody's signature and clears too", async () => {
    const { db, mb1, ctx } = await setup();
    await setMailboxSignature(ctx, mb1, "keep me");
    expect((await setMailboxSignature(ctx, mb1, null)).signature).toBeNull();
    expect(await column(db, mb1)).toBeNull();
    await setMailboxSignature(ctx, mb1, "keep me");
    expect((await setMailboxSignature(ctx, mb1, "  \n\t ")).signature).toBeNull();
    expect(await column(db, mb1)).toBeNull();
  });

  it("interior whitespace is the user's formatting — only a FULLY blank value collapses", async () => {
    const { db, mb1, ctx } = await setup();
    const text = "  indented on purpose\n\n— A";
    await setMailboxSignature(ctx, mb1, text);
    expect(await column(db, mb1)).toBe(text);
  });

  it("refuses a NUL-bearing signature with a 400 — a legal JSON string PostgreSQL text cannot hold", async () => {
    // Unrejected, the NUL reaches the driver as an encoding error — a 500 that rolls back the
    // whole batch about a value the wire-shape checks had waved through (review round 1).
    const { db, mb1, ctx } = await setup();
    await setMailboxSignature(ctx, mb1, "keep");
    await expect(setMailboxSignature(ctx, mb1, "a\u0000b")).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining("NUL"),
    });
    expect(await column(db, mb1), "the refused write must not have landed").toBe("keep");
  });

  it("refuses past the ceiling with a 400 that names the bound, and persists nothing", async () => {
    const { db, mb1, ctx } = await setup();
    await setMailboxSignature(ctx, mb1, "small");
    const big = "x".repeat(MAILBOX_SIGNATURE_MAX_CHARS + 1);
    await expect(setMailboxSignature(ctx, mb1, big)).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining(String(MAILBOX_SIGNATURE_MAX_CHARS)),
    });
    expect(await column(db, mb1), "the refused write must not have landed").toBe("small");
    // Exactly the ceiling is legal — the bound is "at most".
    const exact = "y".repeat(MAILBOX_SIGNATURE_MAX_CHARS);
    expect((await setMailboxSignature(ctx, mb1, exact)).signature).toBe(exact);
  });

  it("a mailbox of ANOTHER account is a 404 before anything writes", async () => {
    const { db, ctx } = await setup();
    const otherAccount = randomUUID();
    const [foreign] = await db.insert(mailboxes)
      .values({ accountId: otherAccount, provider: "imap", address: "theirs@example.com" })
      .returning();
    await expect(setMailboxSignature(ctx, foreign!.id, "not yours")).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect(await column(db, foreign!.id)).toBeNull();
    // …and no settings change row was appended for the refused write.
    const rows = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, ctx.accountId),
      eq(changeLog.entityType, "settings"),
    ));
    expect(rows).toHaveLength(0);
  });
});

describe("a removed mailbox keeps its signature inert; the same address added again starts empty", () => {
  it("the tombstone keeps its text, a Save on it is a 404 that writes nothing, the new row is empty", async () => {
    const { db, ctx } = await setup();
    const service = new MailboxService({
      keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1), allowance: async () => {},
    });
    const body = {
      provider: "imap", address: "again@example.test",
      imap: { host: "imap.example.test", port: 993, secure: true, user: "again@example.test", pass: "pw" },
    };
    const probe = { probe: async () => ({ verdict: "ok" as const }) };
    const first = await service.create(ctx, body as never, probe);
    await db.update(mailboxes).set({ organizerRole: "organizer", organizeConsentedAt: new Date() })
      .where(eq(mailboxes.id, first.id));
    await setMailboxSignature(ctx, first.id, "old sign-off");
    await service.delete(ctx, first.id);

    // A plain removal stays reversible, so the text stays on the tombstone.
    expect(await column(db, first.id)).toBe("old sign-off");
    await expect(setMailboxSignature(ctx, first.id, "new")).rejects.toMatchObject({ httpStatus: 404 });
    expect(await column(db, first.id), "a Save reached the removed copy").toBe("old sign-off");

    const second = await service.create(ctx, body as never, probe);
    expect(second.id).not.toBe(first.id);
    expect(await column(db, second.id), "the new row was seeded from the tombstone").toBeNull();
  });
});

describe("mailboxSignatures — only the mailboxes that HAVE one travel", () => {
  it("absent key IS the resting state; a clear removes the key", async () => {
    const { db, accountId, mb1, mb2, ctx } = await setup();
    expect(await mailboxSignatures(db, accountId)).toEqual({});
    await setMailboxSignature(ctx, mb1, "— one");
    expect(await mailboxSignatures(db, accountId)).toEqual({ [mb1]: "— one" });
    await setMailboxSignature(ctx, mb2, "— two");
    await setMailboxSignature(ctx, mb1, null);
    expect(await mailboxSignatures(db, accountId)).toEqual({ [mb2]: "— two" });
  });
});

describe("the write rings the wake and travels the settings entity", () => {
  it("appends ONE settings change row per write, entity_id = the account id", async () => {
    const { db, accountId, mb1, ctx } = await setup();
    await setMailboxSignature(ctx, mb1, "— sig");
    const rows = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId),
      eq(changeLog.entityType, "settings"),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(accountId);
    expect(rows[0]!.op).toBe("update");
  });

  it("moves the entity's stamp — and the entity carries NO signature text, deliberately", async () => {
    const { db, accountId, mb1, ctx } = await setup();
    await setMailboxSignature(ctx, mb1, "first");
    const first = await svc.getChanges(ctx, { since: "0" });
    const settingsOf = (page: typeof first) =>
      [...page.changes.creates, ...page.changes.updates, ...page.changes.moves]
        .filter((c) => c.type === "settings");
    const before = settingsOf(first).pop()!.entity as SettingsDTO;

    await setMailboxSignature(ctx, mb1, "second");
    const after = settingsOf(await svc.getChanges(ctx, { since: "0" })).pop()!.entity as SettingsDTO;
    expect(after.updatedAt > before.updatedAt,
      `the stamp did not move (${before.updatedAt} → ${after.updatedAt}) — the write is silent to stamp watchers`,
    ).toBe(true);
    // THE BOUND (review round 1): every write appends its own settings row and the delta
    // materializes one entity PER ROW with no compaction, so text on the entity would repeat
    // the account's whole signature map once per batched write — megabytes for a many-mailbox
    // batch at the ceiling. The entity is the doorbell; the MAP travels on the consent read,
    // exactly once per re-ask.
    expect("signatures" in (after as unknown as Record<string, unknown>),
      "the settings entity grew a signatures field — the amplification bound is gone").toBe(false);
    expect(await mailboxSignatures(db, accountId)).toEqual({ [mb1]: "second" });
  });
});
