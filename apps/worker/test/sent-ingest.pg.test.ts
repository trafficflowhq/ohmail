import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { changeLog, drafts, folderState, mailboxFolders, messages, outboundSends } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { WATCHED_FOLDERS } from "@trafficflow/core/adapters/imap";
import { SendService, type ServiceContext } from "@trafficflow/services";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { buildCursor, runSyncCycle } from "@ohmail/organizer/sync";
import { makeHarness, rawClient, DB_URL } from "../../../packages/organizer/test/_workerenv.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";

/**
 * THE USER'S OWN MAIL, END TO END — slice against real IMAP and real Postgres.
 *
 * The unit guards (`packages/core/test/pipeline.sent.test.ts`,
 * `packages/core/test/adapters/imap.changes.sent.test.ts`) prove the routing decision and the
 * watermark in isolation. Three claims can only be made HERE, because each of them spans the
 * send state machine, a real server's folder naming, and the persist transaction:
 *
 *  1. **ONE row.** ohmail sends a reply — `SendService` mints the Message-ID, SMTP delivers it,
 *     `ImapAdapter.send` APPENDs it to Sent — and the very next sync cycle reads that copy back
 *     out of Sent. The claim is that this produces one `messages` row, not two, and that the
 *     row's identity is literally the id on the `outbound_sends` reservation. No column links
 *     them: the minted Message-ID IS the link, and that is what makes it worth asserting.
 *  2. **It is on the conversation, and it is not unread.** The whole point of the slice.
 *  3. **It is in no view.** Its `folder_state.desired_folder` is the server's own Sent path,
 *     which is outside the six canonical folders every list query filters on — so a Sent
 *     message reaches the product through its thread and through search, and through nothing
 *     else. That is the folder decision, asserted rather than described.
 *
 * PGlite could host none of this: there is no IMAP server behind it, and the persist path being
 * exercised is the one whose seq allocation takes a row lock.
 */

const AVAILABLE = await realPgAvailable(DB_URL);
const svc = new SendService();
const CANONICAL = new Set<string>(WATCHED_FOLDERS);

type Harness = Awaited<ReturnType<typeof makeHarness>>;

function ctxFor(h: Harness): ServiceContext {
  return { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
}

/**
 * The harness's live adapter, wrapped as the send seam SendService drives — and wrapped the way
 * PRODUCTION wraps it.
 *
 * `appended` is forwarded, exactly as `packages/api/src/send-adapter.ts` and the sidecar's
 * `openLocalSend` do, because that is what turns on record-at-send. A fixture that dropped it would
 * quietly test a wire no host serves — the same fake-seam mistake `packages/core/test/log-fields.test.ts`
 * documents, which has shipped a defect through this repository twice.
 */
function liveSend(h: Harness): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) {
      const r = await h.adapter.send(msg);
      return r.sentLocator === null
        ? { providerMessageId: r.providerMessageId }
        : { providerMessageId: r.providerMessageId, appended: { locator: r.sentLocator, raw: r.raw } };
    },
    messageInSent: (id: string) => h.adapter.messageInSent(id),
    async close() { /* the harness owns the connection */ },
  });
}

function eml(o: { from: string; to: string; subject: string; messageId: string; inReplyTo?: string; body?: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "body text",
  ].join("\r\n");
}

/**
 * Every stored row for one Message-ID (RFC 5322) inside this mailbox.
 *
 * Looked up by `message_id_header` and not by `dedup_key`: since that change slice 2 the key is
 * `fp1:<sha256>` over every field a sender chooses, so no test can spell it out — and this file's
 * question is "how many rows exist for the message I appended", which the header answers directly.
 * Case is significant now (`normalizeMessageId` stopped folding it), so the value must match the
 * header as written.
 */
async function rowFor(h: Harness, messageId: string) {
  const rows = await h.db.select().from(messages)
    .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, messageId)));
  return rows;
}

async function stateFor(h: Harness, messageId: string) {
  const [fs] = await h.db.select().from(folderState).where(eq(folderState.messageId, messageId));
  return fs!;
}

describe.skipIf(!AVAILABLE)("Sent ingest (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("a reply ohmail sent comes back from Sent as ONE message, on its thread, read, and in no view", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    const theirId = `them-${randomUUID()}@x.example`;

    // 1. Their message arrives. The sender is a seeded contact, so it stays in the Imbox.
    const c = await rawClient(h.cfg);
    await c.append("INBOX", eml({
      from: "anna@x.example", to: h.cfg.auth.user, subject: "Quote for the north elevation", messageId: theirId,
    }));
    await runSyncCycle(deps);
    const [theirs] = await rowFor(h, `${theirId}`);
    expect(theirs).toBeDefined();
    expect(theirs!.threadId).not.toBeNull();

    // 2. The user replies THROUGH ohmail: minted Message-ID → SMTP → APPEND to Sent.
    const [draft] = await h.db.insert(drafts).values({
      accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      subject: "Re: Quote for the north elevation", body: "Thursday works.",
      to: [{ name: null, address: "anna@x.example" }],
      inReplyToMessageId: theirs!.id, status: "draft",
    }).returning();
    const sendRes = await svc.send(ctxFor(h), draft!.id, `u4c-${randomUUID()}`, { openSendAdapter: liveSend(h), resolveStorageCap: async () => UNMETERED_STORAGE_CAP });
    expect(sendRes.status).toBe("sent");
    const minted = sendRes.providerMessageId!;
    const mintedInner = minted.replace(/[<>]/g, "").toLowerCase();

    // ── RECORD-AT-SEND: THE ROW IS ALREADY THERE, BEFORE ANY CYCLE ────────────────────────
    //
    // `ImapAdapter.send` APPENDed the message to Sent before it returned, so the master held it and
    // the send path projected it. Until that existed this query answered NOTHING and the row arrived
    // with the next poll — the reported "it took a minute". Its locator is the UID GreenMail answered
    // the APPEND with, which is the fact no rebuild could supply.
    const projected = await rowFor(h, `${mintedInner}`);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.unread).toBe(false);
    expect(projected[0]!.threadId).toBe(theirs!.threadId);
    expect((projected[0]!.nativeLocator as { folder: string; ref: string }).folder.toLowerCase())
      .toContain("sent");
    expect((projected[0]!.nativeLocator as { ref: string }).ref).not.toBe("0:0");
    // The client is told about it now, not in a minute.
    const announced = await h.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, h.accountId), eq(changeLog.entityId, projected[0]!.id), eq(changeLog.op, "create"),
    ));
    expect(announced).toHaveLength(1);

    // 3. The next cycle reads that same UID back out of Sent — and must add nothing.
    const seqBefore = (await h.db.select().from(changeLog).where(eq(changeLog.accountId, h.accountId))).length;
    await runSyncCycle(deps);

    // ── ONE ROW, and its identity is the reservation's ────────────────────────────────────
    const mine = await rowFor(h, `${mintedInner}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(projected[0]!.id);
    const [os] = await h.db.select().from(outboundSends).where(eq(outboundSends.draftId, draft!.id));
    // No foreign key ties these two; the minted Message-ID does, and that IS the dedup. Break
    // `dedupKey` (or make the send path invent a second id) and the Sent copy ingests as an
    // unrelated message — two rows for one reply, one of them un-linkable to the send.
    expect(os!.mintedMessageId.replace(/[<>]/g, "").toLowerCase()).toBe(mine[0]!.messageIdHeader);

    // ── NOT UNREAD ────────────────────────────────────────────────────────────────────────
    expect(mine[0]!.unread).toBe(false);

    // ── ON THE CONVERSATION ───────────────────────────────────────────────────────────────
    expect(mine[0]!.threadId).toBe(theirs!.threadId);

    // ── IN NO VIEW, AND NEVER MOVED ───────────────────────────────────────────────────────
    const fs = await stateFor(h, mine[0]!.id);
    expect(fs.desiredFolder).toBe(fs.observedFolder);
    expect(fs.reconcileStatus).toBe("reconciled");
    // The folder decision, asserted: outside the six, so `MessageService.list`'s allow-list
    // (and the triage and Screener queries, which are the same shape) match it in no view.
    expect(CANONICAL.has(fs.desiredFolder)).toBe(false);
    expect(fs.desiredFolder.toLowerCase()).toContain("sent");
    // Their message did not move because ours arrived.
    expect((await stateFor(h, theirs!.id)).desiredFolder).toBe("INBOX");

    // The Sent cursor is persisted, which is what `buildCursor` must union in.
    const folders = await h.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, h.mailboxId));
    const sentCursor = folders.find((f) => !CANONICAL.has(f.folder));
    expect(sentCursor).toBeDefined();
    expect(Number(sentCursor!.uidnext)).toBeGreaterThan(0);

    // ── AND NO CYCLE ADDS ANYTHING, STARTING WITH THE FIRST ───────────────────────────────
    //
    // `seqAfter === seqBefore` is the record-at-send claim, and this line used to read
    // `toBeGreaterThan`: the cycle used to be what CREATED the row, so it emitted the `message`
    // create. Now the send path did, the observation resolves as a `duplicate` (same fingerprint,
    // same folder), and a duplicate writes no `change_log` row at all. A second `create` here would
    // be the permanent duplicate a drifted identity produces.
    const seqAfter = (await h.db.select().from(changeLog).where(eq(changeLog.accountId, h.accountId))).length;
    expect(seqAfter).toBe(seqBefore);
    await runSyncCycle(deps);
    await runSyncCycle(deps);
    expect((await h.db.select().from(changeLog).where(eq(changeLog.accountId, h.accountId))).length).toBe(seqAfter);
    expect(await rowFor(h, `${mintedInner}`)).toHaveLength(1);

    await c.logout();
  }, 40000);

  it("buildCursor hands the adapter back the Sent cursor it persisted", async () => {
    // The Sent path is not a compile-time constant, so a `buildCursor` that only walks
    // `WATCHED_FOLDERS` writes this row every cycle and reads it never. The adapter then falls
    // into its FIRST-SCAN branch on every poll and re-enumerates the whole history window for
    // the life of the process — invisible in every other assertion in this file, because the
    // outcome is identical and only the cost differs. Hence a direct guard.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await h.repo.upsertMailboxFolder(h.mailboxId, "Sent Items", {
      uidValidity: "100", uidNext: 4321, highestModseq: "77",
    });

    const cursor = await buildCursor(h.repo, h.mailboxId);

    // Restore `for (const f of WATCHED_FOLDERS)` and this reads `undefined`.
    expect(cursor.folders["Sent Items"]).toEqual({
      uidValidity: "100", uidNext: 4321, highestModseq: "77", known: [],
    });
    // …and the six are still all present, unioned rather than replaced.
    for (const f of WATCHED_FOLDERS) expect(cursor.folders[f]).toBeDefined();
  }, 20000);

  it("a reply sent from ANOTHER client is threaded and read, even though it was appended unflagged", async () => {
    // The ordinary case for a user: they answer from Apple Mail, which APPENDs to Sent. Some
    // clients do not set `\Seen` on that copy, so the pipeline's forced `seen: true` — not the
    // server's answer — is what keeps the user's own outbox out of their unread count.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    const theirId = `them-${randomUUID()}@x.example`;
    const mineId = `mine-${randomUUID()}@trafficflow.test`;

    const c = await rawClient(h.cfg);
    await c.mailboxCreate("Sent");
    await c.append("INBOX", eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: "Thursday?", messageId: theirId }));
    // No flags argument ⇒ appended UNSEEN.
    await c.append("Sent", eml({
      from: h.cfg.auth.user, to: "anna@x.example", subject: "Re: Thursday?", messageId: mineId, inReplyTo: theirId,
    }));

    await runSyncCycle(deps);

    const [theirs] = await rowFor(h, `${theirId}`);
    const [mine] = await rowFor(h, `${mineId}`);
    expect(mine).toBeDefined();
    expect(mine!.unread).toBe(false);
    expect(mine!.threadId).toBe(theirs!.threadId);
    expect(CANONICAL.has((await stateFor(h, mine!.id)).desiredFolder)).toBe(false);
    await c.logout();
  }, 40000);

  it("a self-CC'd message stays in the Imbox — the Sent twin writes nothing", async () => {
    // One Message-ID, two folders. Before `own_copy` the Sent observation was an
    // `external_move`: the row adopted the Sent path, a `move` delta went to every client, and
    // the message left the Imbox. On a real server, in one cycle, with the real scan order.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    const id = `cc-${randomUUID()}@x.example`;
    const raw = eml({ from: "anna@x.example", to: `${h.cfg.auth.user}, anna@x.example`, subject: "minutes", messageId: id });

    const c = await rawClient(h.cfg);
    await c.mailboxCreate("Sent");
    await c.append("INBOX", raw);
    await c.append("Sent", raw);

    await runSyncCycle(deps);
    await runSyncCycle(deps);

    const rows = await rowFor(h, `${id}`);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.nativeLocator as { folder: string }).folder).toBe("INBOX");
    const fs = await stateFor(h, rows[0]!.id);
    expect(fs.desiredFolder).toBe("INBOX");
    // No move delta was ever emitted for it.
    const moves = await h.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, h.accountId), eq(changeLog.entityId, rows[0]!.id), eq(changeLog.op, "move")));
    expect(moves).toEqual([]);
    await c.logout();
  }, 40000);
});
