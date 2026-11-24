import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, ServiceError, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * A SEND FROM A DISABLED MAILBOX MUST FAIL VISIBLY, NEVER LOOK SENT.
 *
 * ## The ending this file exists to make unreachable
 *
 * `SendService.reserve` used to read only `mailboxes.address`, so a disabled mailbox was refused
 * only by ACCIDENT and only on one of the four paths that disable one: `MailboxService.delete`
 * deletes the credential rows, so `makeSendAdapter` refuses. That refusal happens in `send()`,
 * AFTER the reserve transaction has committed a `pending` reservation and flipped the draft to
 * `sending` — so the draft can never be sent again under a new key, a same-key retry answers
 * `in_flight`, and once the row goes stale the recovery path writes `unverified`, whose user-
 * facing text is *"Check your Sent folder before retrying."* For a message that never left.
 *
 * The other three paths (`disableExcessMailboxes` on a billing downgrade, `markMailboxStoodDown`
 * for the organizer lease, and a plain `PATCH {status:'disabled'}`) leave the credentials in
 * place, so there was no accident at all: the mail was genuinely sent.
 *
 * ## Why REAL Postgres and not PGlite (AGENTS.md)
 *
 * The property is not "reserve returns an error" — it is that the reservation's INSERT is
 * **rolled back**. The check sits with the other new-reservation preconditions, i.e. AFTER the
 * `outbound_sends` INSERT has already executed inside the transaction, so what is under test is
 * whether the throw actually unwinds a real write. `notFreedKey` below is the sharp end of it:
 * after the refusal the idempotency key must still be FREE, which is only true if the row is
 * genuinely gone rather than merely unreferenced. The concurrency test additionally needs two
 * independent connections and a held `FOR UPDATE` lock, which PGlite is structurally unable to
 * express (single connection, no cross-transaction blocking).
 */
const PG_UP = await realPgAvailable();

const ownedA = makeOwnedDb(PG_TEST_URL);
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = ownedA.db;

const NOW = new Date("2026-08-04T12:00:00.000Z");
const svc = new SendService();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** A fake SendAdapter — NO network, ever. Counts sends so a phantom is distinguishable. */
function fakeAdapter(opts: { inSent?: boolean } = {}) {
  const state = { sendCalls: 0, opens: 0, closes: 0 };
  const factory: OpenSendAdapter = async () => {
    state.opens += 1;
    return {
      async send(msg: OutboundMessage) {
        state.sendCalls += 1;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return opts.inSent ?? false; },
      async close() { state.closes += 1; },
    };
  };
  return { factory, state };
}

/**
 * What `makeSendAdapter` does for a mailbox whose credentials were deleted
 * (`requireImapCredential`, `packages/api/src/attachments-adapter.ts`). Reproduced rather than imported: `packages/services`
 * does not depend on `packages/api`, and the exact ServiceError is the contract being modelled.
 */
const credentiallessAdapter: OpenSendAdapter = async () => {
  throw new ServiceError("mailbox_not_signed_in", 424, "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings", undefined, false);
};

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await ownedA.close(); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a disabled mailbox refuses inside the reserve transaction", () => {
  async function seeded(status = "connected", syncBlockedReason: string | null = null) {
    const accountId = randomUUID();
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: `o20-${randomUUID().slice(0, 8)}@x.test`,
      status, syncBlockedReason,
    }).returning();
    const [d] = await dbA.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    const ctx: ServiceContext = {
      db: dbFor(dbA, accountId),
      accountId, userId: null, now: () => NOW, requestId: "r",
    };
    return { accountId, mailboxId: mb!.id, draftId: d!.id, ctx };
  }

  const draftStatus = async (id: string): Promise<string> => {
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, id));
    return d!.status;
  };
  const sendRows = async (draftId: string) =>
    dbA.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));

  // ── THE ACCEPTANCE ────────────────────────────────────────────────────────────────────────
  it("ACCEPTANCE: reserve 409s `mailbox_disabled`, the draft stays 'draft', and NO outbound_sends row exists", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
    const { factory, state } = fakeAdapter();

    const err = await svc.send(ctx, draftId, "k-acceptance", { openSendAdapter: factory })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_disabled");
    expect((err as ServiceError).httpStatus).toBe(409);

    // The refusal happened BEFORE any adapter was opened: no SMTP was even attempted.
    expect(state.opens).toBe(0);
    expect(state.sendCalls).toBe(0);

    // The two halves of the acceptance.
    expect(await draftStatus(draftId)).toBe("draft");
    expect(await sendRows(draftId)).toHaveLength(0);
  });

  // ── THE ROLLBACK ITSELF, not merely its visible residue ───────────────────────────────────
  it("the reservation is ROLLED BACK, not skipped: the same Idempotency-Key is still FREE afterwards", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    await expect(svc.send(ctx, draftId, "k-reuse", { openSendAdapter: fakeAdapter().factory }))
      .rejects.toMatchObject({ code: "mailbox_disabled" });

    // Reconnect and retry under the SAME key. If the refused attempt's INSERT had survived, this
    // would hit the UNIQUE(account_id, idempotency_key) reservation gate and come back as a
    // replay/in_flight instead of a real send. It sends, so the row is genuinely gone.
    await dbA.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, mailboxId));
    const { factory, state } = fakeAdapter();
    const res = await svc.send(ctx, draftId, "k-reuse", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(await draftStatus(draftId)).toBe("sent");
    expect(await sendRows(draftId)).toHaveLength(1);
  });

  // ── THE RULING ON SYNC-SIDE FACTS ─────────────────────────────────────────────────────────
  it("'error' STILL SENDS — SMTP is a separate transport from the IMAP sync that failed", async () => {
    const { draftId, ctx } = await seeded("error");
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, draftId, "k-error", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(await draftStatus(draftId)).toBe("sent");
  });

  it("a sync-blocked mailbox STILL SENDS — the block is our infrastructure's note, not the mailbox's state", async () => {
    const { draftId, ctx } = await seeded("connected", "at_capacity");
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, draftId, "k-blocked", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
  });

  // ── IDEMPOTENT REPLAY SURVIVES THE NEW CHECK ──────────────────────────────────────────────
  it("REPLAY IS PRESERVED: a same-key retry after a SUCCESSFUL send replays 'sent' even once the mailbox is disabled", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    const { factory, state } = fakeAdapter();

    const first = await svc.send(ctx, draftId, "k-replay", { openSendAdapter: factory });
    expect(first.status).toBe("sent");

    // The mailbox is disconnected AFTER the message genuinely went out.
    await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    // The retry must hand back the recorded result. Refusing here would be this ticket's own
    // defect mirrored: telling a user their sent message failed.
    const second = await svc.send(ctx, draftId, "k-replay", { openSendAdapter: factory });
    expect(second.status).toBe("sent");
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(state.sendCalls).toBe(1);                       // NEVER a second send
  });

  // ── THE RACE: DISABLED WHILE A SEND IS IN FLIGHT ──────────────────────────────────────────
  it("RACE, disable-first: the reserve's read sees 'disabled' → 409, draft 'draft', zero rows", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    // The full `delete`: status flip AND credential removal, committed before the send starts.
    await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    const err = await svc.send(ctx, draftId, "k-race-a", { openSendAdapter: credentiallessAdapter })
      .catch((e: unknown) => e);

    expect((err as ServiceError).code).toBe("mailbox_disabled");
    expect((err as ServiceError).httpStatus).toBe(409);
    expect(await draftStatus(draftId)).toBe("draft");
    expect(await sendRows(draftId)).toHaveLength(0);
  });

  it("RACE, reserve-first: the disable lands after the reservation commits → a VISIBLE 424, never 'sent'/'unverified'", async () => {
    const { mailboxId, draftId, ctx } = await seeded();

    // `openSendAdapter` is called by `send()` AFTER the reserve transaction has committed — the
    // exact window the race occupies. Disabling + stripping credentials here reproduces the
    // interleaving deterministically instead of hoping for it.
    const raceAdapter: OpenSendAdapter = async (mailboxId2: string) => {
      await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId2));
      throw new ServiceError("mailbox_not_signed_in", 424, "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings", undefined, false);
    };

    const err = await svc.send(ctx, draftId, "k-race-b", { openSendAdapter: raceAdapter })
      .catch((e: unknown) => e);

    // The ending is a refusal the client sees, NOT a phantom: the shared credential reader's 424.
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(424);

    // THE STRANDED RESERVATION THIS TEST USED TO RECORD IS GONE, AND THAT IS THE POINT.
    //
    // This block used to assert `sending` + a `pending` row, and said so as a complaint rather
    // than a contract: *"This ending is NOT clean… the draft is parked in `sending` with a
    // `pending` row behind it. That is the pre-existing stranded-reservation gap (the worker's
    // reconcile, noted on `resumeExisting`) and is deliberately NOT papered over here."* It then
    // named the half that was load-bearing: *"What matters for that change is the negative: it never
    // reads as delivered."*
    //
    // The pre-SMTP window closed that gap. `openSendAdapter` throwing is a DEFINITE non-delivery
    // — the factory reads credentials, decrypts and dials IMAP, and offers no envelope to any
    // server — so the reservation is finalized `failed` and the draft returns to `draft`. There
    // is nothing left stranded for a reconcile to find, and a same-key replay re-serves this
    // refusal instead of probing a Sent folder for mail that never left.
    //
    // The negatives are untouched and still carry the claim.
    const status = await draftStatus(draftId);
    expect(status).toBe("draft");
    expect(status).not.toBe("sent");
    expect(status).not.toBe("unverified");
    const rows = await sendRows(draftId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status, "the reservation is terminal — nothing is stranded").toBe("failed");
    expect(rows[0]!.providerMessageId).toBeNull();

    // AND THE ROW WEARS NO SENTENCE, BECAUSE THIS IS AN INTERACTIVE SEND.
    //
    // `drafts.send_error` means "an appointment could not be kept" — the web row quotes it as
    // "wasn't sent at its SCHEDULED TIME" and the phone, having no Drafts screen, lists any draft
    // carrying it among the appointments. This send had no appointment: it is a person pressing
    // Send, and they already have the 424 asserted above. Writing the field here would file an
    // interactive refusal as a failed schedule on both clients, which is why the terminal finalize
    // gates the write on `send_at` rather than writing it unconditionally.
    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.sendAt, "no appointment — which is what gates the sentence").toBeNull();
    expect(row!.sendError).toBeNull();
    expect(await dbA.select().from(mailboxes).where(eq(mailboxes.id, mailboxId))
      .then((r) => r[0]!.status)).toBe("disabled");
  });

  it("WHICH ENDING HAPPENS IS DECIDED BY COMMIT ORDER: reserve's read does NOT block on the disabler's row lock", async () => {
    const { mailboxId, draftId, ctx } = await seeded();

    // Hold a genuine `FOR UPDATE` lock on the mailbox row — what `MailboxService.delete` takes —
    // on an INDEPENDENT connection, and keep the transaction open across the whole send.
    let releaseLock: (() => void) | undefined;
    const locked = new Promise<void>((r) => { releaseLock = r; });
    const holder = sqlB.begin(async (tx) => {
      await tx`select id from mailboxes where id = ${mailboxId} for update`;
      await tx`update mailboxes set status = 'disabled' where id = ${mailboxId}`;
      await locked;                                   // hold it, UNCOMMITTED
    });

    await sleep(150);                                  // the lock is certainly held by now
    const started = Date.now();
    const { factory, state } = fakeAdapter();
    const res = await svc.send(ctx, draftId, "k-order", { openSendAdapter: factory });
    const elapsed = Date.now() - started;

    // Under READ COMMITTED a plain SELECT reads the last COMMITTED row version and does not wait
    // on a writer's lock. So reserve saw 'connected' and proceeded — promptly, not after the
    // holder released. This is the mechanism, and it is why the outcome is decided by which
    // transaction commits first rather than by any ordering `reserve` could impose on itself.
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(elapsed).toBeLessThan(1_000);               // it did NOT block on the held lock

    releaseLock!();
    await holder;

    // And once the disable COMMITS, the very next reservation is refused.
    const [d2] = await dbA.insert(drafts).values({
      accountId: ctx.accountId, mailboxId, subject: "second", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    await expect(svc.send(ctx, d2!.id, "k-order-2", { openSendAdapter: factory }))
      .rejects.toMatchObject({ code: "mailbox_disabled", httpStatus: 409 });
    expect(await draftStatus(d2!.id)).toBe("draft");
    expect(await sendRows(d2!.id)).toHaveLength(0);
  });

  /**
   * THE ENFORCED-SYNC DOORBELL IS SKIPPED UNDER CONTENTION, NEVER WAITED ON.
   *
   * `finalizeSent` stamps `mailboxes.sync_requested_at` so the worker's kick scan reconciles the new
   * Sent copy in seconds. It runs AFTER SMTP has accepted the message, which is what makes a plain
   * `update mailboxes ... where id = $1` unsafe: it waits for whoever holds that row — the disabler
   * above, or `MailboxService.delete` — and a lock wait throws nothing, so the finalize transaction
   * simply stops with the reservation `in_flight` and the draft not `sent`. A message that DID go out
   * ends up in no terminal state at all.
   *
   * The test above catches the symptom by its clock. This one names the CONTRACT, so a future change
   * cannot restore the blocking form and pass by being fast: the stamp uses `FOR UPDATE SKIP LOCKED`,
   * so a held row is left unstamped — zero rows updated, `sync_requested_at` still NULL — and the
   * send still reaches `sent`. That is the documented degradation for a doorbell: the worker's
   * ordinary poll picks the copy up on its next cycle.
   */
  it("the enforced-sync stamp SKIPS a locked mailbox row rather than waiting for it", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    const before = await dbA.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(before[0]!.syncRequestedAt).toBeNull();

    // A holder that takes the row and NEVER touches status — so nothing about this test depends on
    // the disable path. The only question is whether the stamp waits for a row lock.
    let releaseLock: (() => void) | undefined;
    const locked = new Promise<void>((r) => { releaseLock = r; });
    const holder = sqlB.begin(async (tx) => {
      await tx`select id from mailboxes where id = ${mailboxId} for update`;
      await locked;
    });
    await sleep(150);

    const { factory, state } = fakeAdapter();
    const started = Date.now();
    const res = await svc.send(ctx, draftId, "k-doorbell", { openSendAdapter: factory });
    const elapsed = Date.now() - started;

    // The send completed on its own schedule, and it completed as `sent` — the terminal state.
    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(elapsed).toBeLessThan(1_000);
    expect(await draftStatus(draftId)).toBe("sent");

    // And the doorbell was SKIPPED, not merely delayed: the row is still unstamped while held.
    const during = await dbA.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(during[0]!.syncRequestedAt).toBeNull();

    releaseLock!();
    await holder;
  });

  /**
   * …AND THE DOORBELL STILL RINGS when nothing is holding the row, or the skip above would be
   * indistinguishable from having removed the stamp altogether. This is the arm that fails if a
   * future edit "fixes" the lock wait by deleting the write.
   */
  it("stamps the mailbox on an uncontended sent finalize", async () => {
    const { mailboxId, draftId, ctx } = await seeded();
    const { factory } = fakeAdapter();
    const res = await svc.send(ctx, draftId, "k-doorbell-free", { openSendAdapter: factory });
    expect(res.status).toBe("sent");
    const after = await dbA.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(after[0]!.syncRequestedAt).not.toBeNull();
  });
});
