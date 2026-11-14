import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import {
  changeLog, closeStoodDownAppointments, drafts, mailboxes, mailboxCredentials,
  REMOVED_MAILBOX_SEND_SENTENCE, STAND_DOWN_SEND_SENTENCES,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, ScheduleService, type ServiceContext } from "@trafficflow/services";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  REMOVING A MAILBOX CLOSES THE APPOINTMENTS IT ORPHANS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE STATE THIS FILE EXISTS TO MAKE UNREACHABLE ────────────────────────────────────────
 *
 * `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION` was closed for the HANDOVER — every stand-down site
 * now calls `closeStoodDownAppointments`. It was not closed for the other event that ends an
 * organizer's right to keep an appointment, and that one is the event a user triggers on
 * purpose: removing the mailbox.
 *
 * The close could not cover it BY CONSTRUCTION, which is why nothing caught it. Its precondition
 * reads `disabled` WITH a `disabled_reason` as a stand-down and `disabled` with NONE as a
 * removal, and returns zero for the second — deliberately, and stated in its own header
 * ("a removal's drafts belong to a row the user deleted, not to an organizer handover"). And
 * `MailboxService.delete` clears `disabled_reason` in the same statement that writes the
 * tombstone, for its own good reason: leaving it would tell somebody another install had claimed
 * a mailbox they themselves removed.
 *
 * So the two correct decisions composed into a hole. After a removal the row read
 * `status: 'scheduled'`, `send_at` in the future, `send_error: null` — with the credentials
 * deleted, so nothing could ever send it, and no pass that would ever report it as failed.
 * `SendService.reserve` refuses a `disabled` mailbox, and the scheduled pass's expiry is enforced
 * INSIDE that pass — the same "an expiry enforced inside a pass that may never run is not an
 * expiry" the handover taught, reached through the other door.
 *
 * ── WHY REAL POSTGRES ─────────────────────────────────────────────────────────────────────
 *
 * The close runs inside `MailboxService.delete`'s transaction, which already holds the mailbox
 * row `FOR UPDATE`. That re-entrancy — a nested `db.transaction` taking a lock the outer one owns
 * — is a real-Postgres property; PGlite is single-connection and would report a green that says
 * nothing about it (CLAUDE.md). The scoping and mirror-image guards ride along on the same store
 * rather than being split across two harnesses.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────
 *
 * Delete the `closeRemovedMailboxAppointments` call from `MailboxService.delete` and the first
 * two cases go red with the row still lying. Flip its precondition from `mb.reason !== null` to
 * `mb.reason === null` and the mirror-image guard goes red. Drop the `sendKey: null` from the
 * shared `set` and the unfindable-by-either-claim-arm assertion goes red. Drop the mailbox
 * predicate from the UPDATE and the scoping case goes red. All four were run.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");

const NOW = new Date("2026-09-02T12:00:00.000Z");
/** Twelve minutes out, the sibling file's interval. */
const DUE = new Date("2026-09-02T12:12:00.000Z");

const schedules = new ScheduleService();
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const svc = makeMailboxService({ keyProvider: KP });

const ctxOf = (accountId: string): ServiceContext => ({
  db: dbA as unknown as ServiceContext["db"],
  accountId, userId: null, now: () => NOW, requestId: "r",
});

interface World {
  ctx: ServiceContext;
  accountId: string;
  mailboxId: string;
  draftId: string;
}

/** An account with one mailbox, one stored credential, and one appointment twelve minutes out. */
async function seeded(): Promise<World> {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `gone-${tag}@removal.test`,
  }).returning();
  // The credential the removal deletes. Written directly rather than through `create` so this
  // file needs no IMAP probe: what matters is that a row exists to be gone afterwards.
  const sealed = await KP.encrypt(fixturePassword("mailbox-removal-sends"));
  await dbA.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap",
    secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion,
  });
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the appointment", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx = ctxOf(accountId);
  await schedules.schedule(ctx, d!.id, DUE.toISOString());
  return { ctx, accountId, mailboxId: mb!.id, draftId: d!.id };
}

/** The newest `change_log` seq for one draft, or -1 when nothing has been recorded for it. */
const maxSeqFor = async (accountId: string, draftId: string): Promise<bigint> => {
  const rows = await dbA.select().from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, draftId)));
  return rows.reduce((hi, r) => (r.seq > hi ? r.seq : hi), -1n);
};

const rowOf = async (id: string) => {
  const [row] = await dbA.select().from(drafts).where(eq(drafts.id, id));
  return row!;
};

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("removing a mailbox closes the appointments it orphans", () => {
  it("the removal closes the appointment, deletes the credentials, and keeps the row", async () => {
    const w = await seeded();

    const before = await rowOf(w.draftId);
    expect(before.status, "the appointment stands before the removal").toBe("scheduled");
    expect(before.sendError).toBeNull();
    expect(before.sendKey).not.toBeNull();

    // The high-water mark BEFORE the removal — `seeded()` has already written a `draft`/`update`
    // row for the schedule itself, so "a row exists" proves nothing and "a NEWER row exists" is
    // the only claim about this removal.
    const seqBefore = await maxSeqFor(w.accountId, w.draftId);

    const out = await svc.delete(w.ctx, w.mailboxId);

    // ── THE TOMBSTONE, UNCHANGED ────────────────────────────────────────────────────────
    // The row is kept — `messages.mailbox_id` references it — and every column that would go
    // on making a statement the removal has made untrue is cleared.
    const [mb] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.status).toBe("disabled");
    expect(mb!.disabledReason, "a removal is not a handover and must not claim to be").toBeNull();
    expect(mb!.takeoverAuthorizedAt).toBeNull();
    expect(mb!.syncBlockedReason).toBeNull();

    // ── THE CREDENTIALS ARE GONE ────────────────────────────────────────────────────────
    const creds = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, w.mailboxId));
    expect(creds, "a removed mailbox must not keep a decryptable secret").toHaveLength(0);

    // ── AND THE APPOINTMENT IS OVER, WITH A SENTENCE ────────────────────────────────────
    const after = await rowOf(w.draftId);
    expect(after.status).toBe("draft");
    expect(after.sendAt, "an appointment that will not be kept must not still name a time").toBeNull();
    expect(after.sendKey, "the key is the claim predicate — leaving it leaves the appointment").toBeNull();
    expect(after.sendError).toBe(REMOVED_MAILBOX_SEND_SENTENCE);

    // The sentence a person actually reads, composed as the clients compose it.
    expect(`This message wasn't sent at its scheduled time: ${after.sendError!}`).toBe(
      "This message wasn't sent at its scheduled time: This mailbox was removed from ohmail, so "
      + "the scheduled send was not made. Nothing was deleted from the mail server. Connect the "
      + "mailbox again to schedule it.",
    );

    // ── THE MIRROR LEARNS IT, AND THE ASSERTION HAS TO BE ABLE TO FAIL ────────────────────
    //
    // This first read the whole change log for the draft and asked whether ANY `draft`/`update`
    // row existed — which `seeded()` had already guaranteed, because `ScheduleService.schedule`
    // records one when it makes the appointment. The check was therefore true before `delete`
    // ran and stayed true with `recordChanges` deleted from the close: a guard that cannot fail
    // is not evidence (CLAUDE.md). Caught by review, not by the mutation set, because the
    // mutations that were run all changed the UPDATE rather than the notification beside it.
    //
    // So the bar is a row NEWER than everything the setup wrote: the max seq is captured before
    // the removal and the assertion demands one strictly above it.
    const logRows = await dbA.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.draftId)));
    const fresh = logRows.filter((c) => c.seq > seqBefore);
    expect(fresh.length, "the removal announced nothing — no mirror can learn the appointment is over")
      .toBeGreaterThan(0);
    expect(fresh.some((c) => c.entityType === "draft" && c.op === "update")).toBe(true);

    // AND THE SEQ IS THE ONE THE ROUTE ECHOES. `X-Sync-Seq` is what gives the mirror that asked
    // for the removal a target to wait for; a null here would be a 204 with nothing to converge
    // on (the delta contract's echo, the "Delta-first client contract" invariant).
    expect(out.seq, "the removal emitted a change and reported no seq to echo").not.toBeNull();
    expect(fresh.map((c) => c.seq)).toContain(out.seq);
  });

  it("the sentence is the REMOVAL's, never a handover's — there is no organizer to be sent to", async () => {
    const w = await seeded();
    await svc.delete(w.ctx, w.mailboxId);
    const after = await rowOf(w.draftId);
    for (const handover of Object.values(STAND_DOWN_SEND_SENTENCES)) {
      expect(after.sendError, "a removal must never quote a handover's sentence")
        .not.toBe(handover);
    }
    expect(after.sendError, "nobody organizes this mailbox now")
      .not.toContain("organized now");
  });

  it("the STAND-DOWN close still refuses the tombstone it was always meant to refuse", async () => {
    const w = await seeded();
    await svc.delete(w.ctx, w.mailboxId);
    // The row is now `disabled` with a NULL reason. The handover's close must take nothing —
    // its guard is what keeps a deposed leader from cancelling a successor's appointment, and
    // the removal arm must not have loosened it.
    const r = await closeStoodDownAppointments(dbA, {
      accountId: w.accountId, mailboxId: w.mailboxId,
      reason: "organized_elsewhere:cloud", now: NOW,
    });
    expect(r.closed).toBe(0);
    // And the removal's own sentence is still the one on the row.
    expect((await rowOf(w.draftId)).sendError).toBe(REMOVED_MAILBOX_SEND_SENTENCE);
  });

  it("is scoped to the mailbox removed — another mailbox's appointment stands", async () => {
    const w = await seeded();
    // A second mailbox on the SAME account, with its own appointment.
    const [other] = await dbA.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap",
      address: `kept-${randomUUID().slice(0, 8)}@removal.test`,
    }).returning();
    const [d2] = await dbA.insert(drafts).values({
      accountId: w.accountId, mailboxId: other!.id, subject: "the other one", body: "words",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
      createdAt: NOW, updatedAt: NOW,
    }).returning();
    await schedules.schedule(w.ctx, d2!.id, DUE.toISOString());

    await svc.delete(w.ctx, w.mailboxId);

    const kept = await rowOf(d2!.id);
    expect(kept.status, "an account keeps its other mailboxes' appointments").toBe("scheduled");
    expect(kept.sendError).toBeNull();
    expect(kept.sendKey).not.toBeNull();
  });

  it("leaves the CLAIM WINDOW and a RESERVATION alone — those rows belong to the send machinery", async () => {
    // 'draft' + send_key is a live attempt or the recovery arm's replay; 'sending' has a
    // reservation. Both are the send path's, exactly as they are for the handover's close.
    for (const status of ["draft", "sending"] as const) {
      const w = await seeded();
      await dbA.update(drafts).set({ status }).where(eq(drafts.id, w.draftId));
      await svc.delete(w.ctx, w.mailboxId);
      const after = await rowOf(w.draftId);
      expect(after.status, `a '${status}' row is not the removal's to close`).toBe(status);
      expect(after.sendKey, `a '${status}' row keeps the key its claim arm resolves by`).not.toBeNull();
      expect(after.sendError).toBeNull();
    }
  });

  it("a removal with nothing scheduled closes nothing and still removes the mailbox", async () => {
    const w = await seeded();
    // Cancel the appointment first: the ordinary case is a mailbox with no appointment at all,
    // and the removal must not depend on there being one.
    await dbA.update(drafts).set({ status: "draft", sendAt: null, sendKey: null })
      .where(eq(drafts.id, w.draftId));

    await svc.delete(w.ctx, w.mailboxId);

    const after = await rowOf(w.draftId);
    expect(after.sendError, "a draft nobody scheduled must not be given a failure sentence")
      .toBeNull();
    const creds = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, w.mailboxId));
    expect(creds).toHaveLength(0);
  });
});
