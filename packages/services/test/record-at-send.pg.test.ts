import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { carryDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { changeLog, drafts, mailboxes, messageBodies, messageInstances, messages, threads } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  commitChange, createLogger, fingerprintDedupKey, messageFingerprint, normalizeMime, planChange,
  type Change, type Logger, type OpenSendAdapter, type OutboundMessage, type RepoPort, type RoutingPort,
  UNMETERED_STORAGE_CAP,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/** `commitChange`'s repo: the ports this path writes through plus the conditional folder
 *  completion it requires — the plan it persists is older than the transaction — and the
 *  read-state door of its INBOX-copy arm. */
type SentTxRepo = RepoPort & RoutingPort & Pick<WorkerRepo, "completeFolderState" | "adoptFolderState" | "applyExternalFlag">;
import { SendService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  RECORD-AT-SEND, THROUGH THE DOOR — the send path writes the row, and the worker writes nothing
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ImapAdapter.send` SMTPs the message and then APPENDs it to the mailbox's own Sent folder, so the
 * master holds it before `SendService.send` returns. Until this slice the `messages` row was written
 * only by the sync worker's next pass over Sent — up to a poll interval later — and the user's
 * report was exactly that: *"I see my sent message now in the ohbox, but it took a minute!"*
 *
 * `SendService.projectSentCopy` now records it in a separate short transaction after the finalize.
 * This file is the guard for the four claims that make that safe, all of which span the send state
 * machine, the ingest pipeline and the persist transaction:
 *
 *  1. **The row is there before any worker cycle**, with the sent content, the append's locator, not
 *     unread, on its conversation, and announced to clients in `change_log`.
 *  2. **The worker's later observation of the same UID adds nothing** — no second row, no delta, no
 *     placement change, no audit.
 *  3. **A provider's own re-rendered Sent copy** (Exchange Online files one beside ours) converges on
 *     the same row rather than becoming a second one.
 *  4. **A failure to record does not fail the send.** The mail has already gone; a 500 for a
 *     delivered message is the worst available ending, so the fault is logged and the send answers
 *     `sent`.
 *
 * ## WHY REAL POSTGRES AND NOT PGLITE (AGENTS.md)
 *
 * The claims are about TRANSACTION BOUNDARIES, which is the category PGlite has been green for and
 * wrong about three times in this repository. Specifically: claim 4 asserts that the projection's
 * transaction failing leaves the FINALIZE committed — a statement about two separate transactions,
 * only one of which unwound — and claims 1–3 exercise `insertMessage`'s `ON CONFLICT DO NOTHING`
 * upsert, `setPrimaryInstance`'s three-statement vacate/update/insert against
 * `message_instances_locator_uq`, and `recordChange`'s seq allocation under the account's row lock.
 * None of those mean anything without a real MVCC engine and real constraints.
 */
const PG_UP = await realPgAvailable();

const owned = makeOwnedDb(PG_TEST_URL);
// BRANDED, like every production factory. A handle with no dialect brand refuses at the first
// statement the seam composes for it, and the send path composes one.
const db = owned.db;
const svc = new SendService();
const NOW = new Date("2026-08-13T09:00:00.000Z");
const OWNER_DOMAIN = "trafficflow.test";
const SENT = "Sent";

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); });

/**
 * The bytes `MailComposer` would have handed to `client.append` — CRLF, a `Date:` the composer
 * stamped, and the Message-ID `SendService` minted.
 *
 * `messageId` comes from the `OutboundMessage` the service built, which is what ties the projected
 * row's identity to the reservation: there is no foreign key between `outbound_sends` and
 * `messages`, the minted id IS the link.
 */
function appendedBytes(o: { messageId: string; to: string; subject: string; body: string; inReplyTo?: string }): Buffer {
  return Buffer.from([
    "From: sender@" + OWNER_DOMAIN,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    `Message-ID: ${o.messageId}`,
    "Date: Thu, 13 Aug 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    o.body,
    "",
  ].join("\r\n"));
}

/**
 * EXCHANGE ONLINE'S OWN COPY — filed into Sent Items beside the one we appended, at its own UID,
 * with the body re-wrapped. Same words, same Message-ID, DIFFERENT fingerprint, which is what makes
 * `resolveExisting`'s own-sent-twin arm (and not the key lookup) the thing that keeps it to one row.
 */
function rerenderedBytes(o: { messageId: string; to: string; subject: string; body: string }): Buffer {
  return Buffer.from([
    "Received: from smtp.example.test by EXCH01.example.test; Thu, 13 Aug 2026 09:00:01 +0000",
    "From: sender@" + OWNER_DOMAIN,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId}`,
    "Date: Thu, 13 Aug 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body.replace(/ and /, "\r\nand "),
    "",
  ].join("\r\n"));
}

/**
 * The send seam a REAL `ImapAdapter` wrapper presents — `appended` carried out, exactly as
 * `packages/api/src/send-adapter.ts` and the sidecar's `openLocalSend` now do it.
 *
 * `render` is the fixture's hook for what the server ends up holding; `uid` is what the APPEND
 * response reported.
 */
function appendingAdapter(opts: {
  to: string; subject: string; body: string; inReplyTo?: string; uid?: number;
}) {
  const state = { sends: 0, raw: Buffer.alloc(0), messageId: "" };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sends += 1;
      state.messageId = msg.messageId!;
      state.raw = appendedBytes({
        messageId: msg.messageId!, to: opts.to, subject: opts.subject, body: opts.body,
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      });
      return {
        providerMessageId: msg.messageId!,
        appended: { locator: { folder: SENT, ref: `77:${opts.uid ?? 11}` }, raw: state.raw },
      };
    },
    async messageInSent() { return true; },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state };
}

/** A logger whose lines this test can read, so "the failure was reported" is an assertion. */
function capturingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ service: "send", sink: (line) => { lines.push(line); } }), lines };
}

async function seeded(opts: { to?: string; subject?: string; body?: string; inReplyToMessageId?: string } = {}) {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `sender@${OWNER_DOMAIN}`, status: "connected",
  }).returning();
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id,
    subject: opts.subject ?? "Re: the north elevation",
    body: opts.body ?? "Thursday works, and I will bring the revised drawings.",
    to: [{ name: null, address: opts.to ?? "anna@example.com" }],
    ...(opts.inReplyToMessageId ? { inReplyToMessageId: opts.inReplyToMessageId } : {}),
    status: "draft",
  }).returning();
  const ctx: ServiceContext = {
    db: dbFor(db, accountId),
    accountId, userId: null, now: () => NOW, requestId: "r",
  };
  return { accountId, mailboxId: mb!.id, draftId: d!.id, ctx };
}

const rowsFor = (mailboxId: string) =>
  db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
const logRows = (accountId: string) =>
  db.select().from(changeLog).where(eq(changeLog.accountId, accountId));

/**
 * Run the SYNC WORKER's two ingest phases over one change — `planChange` outside a transaction,
 * `commitChange` inside one with a tx-scoped repo. Copied in shape from `packages/organizer/src/sync.ts`
 * rather than imported, because `packages/services` does not depend on `apps/worker`; what matters
 * is that it is the same two pipeline functions over the same repo adapter.
 */
async function workerIngest(accountId: string, mailboxId: string, change: Change) {
  const repo = makeDrizzleRepo(db as never) as RepoPort;
  const plan = await planChange(change, { repo, accountId, mailboxId });
  return (db as unknown as { transaction<T>(f: (tx: unknown) => Promise<T>): Promise<T> }).transaction(
    (tx) => {
      // A transaction object carries no dialect brand, so a repository built straight from it
      // refuses on the first statement the seam composes — which for the ingest path is the
      // storage counter's row lock. Carried from the handle the transaction was opened on, the
      // same thing the production tx-scoped repo sites do.
      const txRepo = makeDrizzleRepo(carryDialect(db, tx as object) as never) as SentTxRepo;
      return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
    },
  );
}

/** What the worker's Sent-folder scan hands the pipeline for a UID it read out of Sent. */
function sentObservation(raw: Buffer, uid: number): Change {
  return { type: "create", locator: { folder: SENT, ref: `77:${uid}` }, raw, seen: true, ownAuthored: true };
}

describe.skipIf(!PG_UP)("record-at-send — the sent message is a row before any worker cycle", () => {
  // ── 1. THE ACCEPTANCE ─────────────────────────────────────────────────────────────────────
  it("ACCEPTANCE: the row is queryable the moment send() returns, with the sent content and the locator", async () => {
    const { accountId, mailboxId, draftId, ctx } = await seeded();
    const { factory, state } = appendingAdapter({
      to: "anna@example.com",
      subject: "Re: the north elevation",
      body: "Thursday works, and I will bring the revised drawings.",
    });

    const res = await svc.send(ctx, draftId, `ras-${randomUUID()}`, { openSendAdapter: factory, resolveStorageCap: async () => UNMETERED_STORAGE_CAP });
    expect(res.status).toBe("sent");
    expect(state.sends).toBe(1);

    // NO SYNC CYCLE HAS RUN. This is the whole slice: before record-at-send there was nothing here
    // at all until the worker's next pass over Sent.
    const rows = await rowsFor(mailboxId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // The content, parsed out of the bytes that were appended.
    expect(row.messageIdHeader).toBe(res.providerMessageId!.replace(/[<>]/g, ""));
    expect(row.subject).toBe("Re: the north elevation");
    expect(row.fromAddress).toBe(`sender@${OWNER_DOMAIN}`);
    expect((row.toAddresses as Array<{ address: string }>).map((a) => a.address)).toEqual(["anna@example.com"]);
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, row.id));
    expect(body!.text).toContain("Thursday works");

    // THE IDENTITY IS THE APPENDED BYTES' OWN FINGERPRINT — not a rebuild's. Derived here through
    // the real `normalizeMime` + `messageFingerprint`, so this can only pass if the projection
    // fingerprinted the same source ingest would.
    expect(row.dedupKey).toBe(fingerprintDedupKey(messageFingerprint(await normalizeMime(state.raw))));

    // THE LOCATOR, and the primary instance that mirrors it — which is what puts this UID into the
    // adapter's known-set and stops the next cycle re-fetching it at all.
    expect(row.nativeLocator).toEqual({ folder: SENT, ref: "77:11" });
    const inst = await db.select().from(messageInstances).where(eq(messageInstances.messageId, row.id));
    expect(inst).toHaveLength(1);
    expect(inst[0]!.isPrimary).toBe(true);
    expect(inst[0]!.folder).toBe(SENT);
    expect(Number(inst[0]!.uid)).toBe(11);

    // NOT UNREAD: nothing the user wrote is new to them.
    expect(row.unread).toBe(false);
    // ON A CONVERSATION — a message with no thread reaches the reader through nothing.
    expect(row.threadId).not.toBeNull();

    // ANNOUNCED. Without this row in `change_log` no mirror ever learns about the message and the
    // whole projection is invisible.
    const creates = (await logRows(accountId))
      .filter((c) => c.entityType === "message" && c.op === "create" && c.entityId === row.id);
    expect(creates).toHaveLength(1);
    // And nothing was told to MOVE: `desired === arrival` for own-authored mail, so ohmail does not
    // file the user's Sent folder for them.
    expect((await logRows(accountId)).filter((c) => c.op === "move")).toEqual([]);

    // The draft reached `sent` — the projection did not disturb the send state machine.
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
  }, 60_000);

  // ── 2. THE DEDUP PROOF ────────────────────────────────────────────────────────────────────
  it("a simulated worker pass over Sent adds NO second row and NO churn", async () => {
    const { accountId, mailboxId, draftId, ctx } = await seeded();
    const { factory, state } = appendingAdapter({
      to: "anna@example.com",
      subject: "Re: the north elevation",
      body: "Thursday works, and I will bring the revised drawings.",
      uid: 21,
    });
    await svc.send(ctx, draftId, `ras-${randomUUID()}`, { openSendAdapter: factory, resolveStorageCap: async () => UNMETERED_STORAGE_CAP });

    const before = await logRows(accountId);
    const projected = (await rowsFor(mailboxId))[0]!;

    // The worker reads that very UID back out of Sent and ingests it.
    const out = await workerIngest(accountId, mailboxId, sentObservation(state.raw, 21));

    // `observedFolder === knownFolder` ⇒ `duplicate`, decided before any evidence test.
    expect(out.outcome).toBe("duplicate");
    expect(out.messageId).toBe(projected.id);
    expect(out.action).toEqual({ type: "none" });
    // ONE row.
    expect(await rowsFor(mailboxId)).toHaveLength(1);
    // NO CHURN: not one further `change_log` row, so no client is told anything happened. This is
    // the assertion that would catch a projection whose identity drifted from ingest's — a second
    // `message`/`create` delta is exactly what a drifted fingerprint produces.
    expect((await logRows(accountId)).length).toBe(before.length);
    // And a second pass is idempotent too.
    await workerIngest(accountId, mailboxId, sentObservation(state.raw, 21));
    expect(await rowsFor(mailboxId)).toHaveLength(1);
    expect((await logRows(accountId)).length).toBe(before.length);
    // One thread, not two.
    expect(await db.select().from(threads).where(eq(threads.accountId, accountId))).toHaveLength(1);
  }, 60_000);

  // ── 3. THE EXCHANGE SHAPE ─────────────────────────────────────────────────────────────────
  it("Exchange's own re-rendered Sent copy converges on the projected row and repoints its locator", async () => {
    const { accountId, mailboxId, draftId, ctx } = await seeded();
    const to = "anna@example.com";
    const subject = "Re: the north elevation";
    const body = "Thursday works, and I will bring the revised drawings.";
    const { factory, state } = appendingAdapter({ to, subject, body, uid: 31 });
    await svc.send(ctx, draftId, `ras-${randomUUID()}`, { openSendAdapter: factory, resolveStorageCap: async () => UNMETERED_STORAGE_CAP });

    const projected = (await rowsFor(mailboxId))[0]!;
    const before = await logRows(accountId);
    const twin = rerenderedBytes({ messageId: state.messageId, to, subject, body });

    // The premise, asserted: the twin's identity really differs, so what saves this is the
    // own-sent-twin arm and not a fingerprint hit.
    expect(fingerprintDedupKey(messageFingerprint(await normalizeMime(twin))))
      .not.toBe(projected.dedupKey);

    const out = await workerIngest(accountId, mailboxId, sentObservation(twin, 32));

    expect(out.outcome).toBe("duplicate");
    expect(out.messageId).toBe(projected.id);
    expect(await rowsFor(mailboxId)).toHaveLength(1);
    expect((await logRows(accountId)).length).toBe(before.length);
    // The row points at the copy the server kept. Same folder, so this repairs a locator and decides
    // no placement: nothing adopted, nothing moved.
    const [after] = await rowsFor(mailboxId);
    expect(after!.nativeLocator).toEqual({ folder: SENT, ref: "77:32" });
    // The stored key is UNCHANGED — it names the copy the row was born from, and repointing identity
    // at whichever rendering was seen last is exactly what `resolveExisting` refuses to do.
    expect(after!.dedupKey).toBe(projected.dedupKey);
  }, 60_000);

  // ── 4. THE FAILURE MODE ───────────────────────────────────────────────────────────────────
  it("a record-at-send failure does NOT fail the send: still `sent`, and the reason is logged", async () => {
    const { accountId, mailboxId, draftId } = await seeded();
    const { log, lines } = capturingLog();

    /**
     * A handle whose THIRD transaction throws.
     *
     * `SendService.send` opens exactly three: 1 the reservation, 2 `finalizeSent`, 3 the
     * record-at-send projection. The count is asserted below, so if that structure ever changes this
     * test fails loudly instead of quietly injecting the fault somewhere harmless — which is the
     * failure mode of every "throw on the Nth call" fixture that does not check N.
     *
     * Failing the PERSIST phase rather than the read is deliberate: it is the case that proves the
     * finalize's own transaction stayed committed while this one unwound.
     */
    let txCount = 0;
    // On the pool's own handle, the one the binder knows: the account's handle bound over it opens
    // its transactions through it. Taken off again when the send has answered.
    const transaction = db.transaction;
    Object.defineProperty(db, "transaction", {
      configurable: true,
      value: async function (this: unknown, fn: Parameters<typeof transaction>[0], config?: Parameters<typeof transaction>[1]) {
        txCount += 1;
        if (txCount === 3) throw new Error("record-at-send persist failed");
        return transaction.call(this as typeof db, fn, config);
      },
    });
    const ctx: ServiceContext = {
      db: dbFor(db, accountId),
      accountId, userId: null, now: () => NOW, requestId: "r",
    };
    const { factory, state } = appendingAdapter({
      to: "anna@example.com", subject: "Re: the north elevation", body: "Thursday works.", uid: 41,
    });

    const res = await svc.send(ctx, draftId, `ras-${randomUUID()}`, { openSendAdapter: factory, log, resolveStorageCap: async () => UNMETERED_STORAGE_CAP })
      .finally(() => { Object.defineProperty(db, "transaction", { value: transaction, configurable: true, writable: true }); });

    // THE SEND SUCCEEDED. The mail is gone; a thrown error here would answer "your message failed"
    // for a message sitting in the recipient's inbox.
    expect(res.status).toBe("sent");
    expect(res.providerMessageId).toBe(state.messageId);
    expect(txCount).toBe(3);
    // The send state machine is intact — the projection's rollback took only its own transaction.
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
    // And no row was written, so the Sent-folder watch is what will heal it.
    expect(await rowsFor(mailboxId)).toHaveLength(0);

    // REPORTED. A swallowed exception with nothing in the log is how a late row becomes
    // undiagnosable, so the line is the other half of the policy.
    const warn = lines.find((l) => l.includes("sent_record_failed"));
    expect(warn, `no sent_record_failed line was emitted: ${lines.join("\n")}`).toBeDefined();
    expect(warn).toContain(mailboxId);
    // The logger's own census must not have refused a field this call site passes.
    expect(warn).not.toContain("droppedFields");

    // …and the worker's pass then writes the row, which is the backstop being real rather than
    // asserted: the same bytes, ingested normally, land the message that the projection did not.
    const healed = await workerIngest(accountId, mailboxId, sentObservation(state.raw, 41));
    expect(healed.outcome).toBe("new");
    expect(await rowsFor(mailboxId)).toHaveLength(1);
  }, 60_000);

  // ── 5. NO APPEND TO PROJECT ───────────────────────────────────────────────────────────────
  it("an adapter that reports no append leaves the wire exactly as it was", async () => {
    // A spy, or any transport that files sent mail some other way. Absence is not an error: the
    // Sent-folder watch is the path that always exists, and this is the pre-projection behaviour.
    const { accountId, mailboxId, draftId, ctx } = await seeded();
    const { log, lines } = capturingLog();
    const factory: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) { return { providerMessageId: msg.messageId! }; },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    });

    const res = await svc.send(ctx, draftId, `ras-${randomUUID()}`, { openSendAdapter: factory, log, resolveStorageCap: async () => UNMETERED_STORAGE_CAP });

    expect(res.status).toBe("sent");
    expect(await rowsFor(mailboxId)).toHaveLength(0);
    // Not a failure, so nothing is logged — an operator must not be shown a fault for a spy.
    expect(lines.filter((l) => l.includes("sent_record_failed"))).toEqual([]);
    expect((await logRows(accountId)).filter((c) => c.entityType === "message")).toEqual([]);
  }, 60_000);
});
