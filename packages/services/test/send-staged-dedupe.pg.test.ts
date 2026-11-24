import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, drafts, outboundSends } from "@trafficflow/db";
import { type AttachmentStagingStorage, makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, makeAttachmentStagingPort } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * SEC3-NEW-3 — ONE STAGED TICKET IS ONE DOWNLOAD, AGAINST THE REAL TABLE.
 *
 * ## The ending this file makes unreachable
 *
 * An email-verified account stages one attachment declared as ONE BYTE, then sends a draft naming
 * that single valid ticket as many times as the request body has room for. The declared total is
 * summed from the ticket, and the ticket declares one byte, so the repeats stayed far below the
 * attachment-byte cap however long the list got; resolution then walked the request array with
 * `await storage.download()` inside the loop and pulled the same object once per occurrence. One
 * authenticated request, an amplification factor equal to the array length — and a delivered
 * message carrying the same file that many times.
 *
 * The route now also refuses a list longer than `SEND_MAX_ATTACHMENT_PARTS`, so the shape that
 * survives to reach this service is a repeat list INSIDE that ceiling — which is what these tests
 * use. The dedupe is what has to hold for it, and it is the same defect at 50 repeats as at
 * many more.
 *
 * ## Why REAL Postgres and not PGlite (AGENTS.md)
 *
 * The claim is not "the resolver returns one attachment" — that is settled in
 * `attachment-staging-store.test.ts` against an injected port, with no database anywhere. What is
 * under test HERE is the same property with the real seam underneath it, and the two things PGlite
 * cannot speak to:
 *
 *  · `readStagingTickets` issues a genuine `WHERE id IN (…)` against `attachment_staging`, so the
 *    ticket that reaches the resolver is a row Postgres returned rather than one a fake supplied.
 *    The declared size the cap is enforced against is read from that row, not asserted by a stub.
 *  · the send has to COMMIT. The dedupe happens on both sides of the reserve transaction — the
 *    declared total before it, the download after it — and the assertion that the reservation ends
 *    `sent` with one attachment on the wire is a claim about a transaction that really ran.
 *
 * ## The mutations watched, and the one result worth writing down
 *
 * The DOWNLOAD side is deduplicated at two layers — `SendService.send` before it calls the port,
 * and `resolveStagedAttachments` inside it — and **neither mutation alone turns this file red**.
 * Restoring `input.stagedAttachmentIds ?? []` in `send` leaves the resolver collapsing the list;
 * restoring `for (const id of requestedIds)` in the resolver leaves `send` handing it a list with
 * nothing to collapse. That is what defence in depth is supposed to look like, and it is recorded
 * here because a single-layer mutation coming back GREEN reads exactly like a guard that does not
 * guard. Removing BOTH is red and unmistakable: **50 downloads for one object**, and a message
 * carrying 50 copies of a one-byte file.
 *
 * Each layer is therefore watched on its own where it is reachable alone — the resolver in
 * `attachment-staging-store.test.ts` (five downloads for one object, no database in the file), and
 * the route's own dedupe in `packages/api/test/send-attachment-bounds.test.ts`.
 *
 * The DECLARE side has only one layer and is watched here directly: restoring
 * `input.stagedAttachmentIds ?? []` in `reserve` fails the second test with
 * the refusal naming the total and the limit — a 413 for a 1 MB message.
 */
const PG_UP = await realPgAvailable();

const sql = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
const owned = makeOwnedDb(PG_TEST_URL);
const db = owned.db;

const NOW = new Date("2026-08-14T12:00:00.000Z");
const svc = new SendService();
const MIB = 1024 * 1024;

/** A send adapter that records the outgoing message. No network, ever. */
function fakeAdapter() {
  const state = { sendCalls: 0, sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to release */ },
  });
  return { factory, state };
}

/**
 * An in-memory bucket that TALLIES DOWNLOADS PER PATH.
 *
 * The tally is the measurement this file exists for. "One attachment arrived" and "one request was
 * made to object storage" are different claims, and only the second one is about the cost an
 * authenticated caller can make this process incur.
 */
function countingStorage() {
  const objects: Record<string, Uint8Array> = {};
  const downloads: Record<string, number> = {};
  const storage: AttachmentStagingStorage = {
    async signUpload(objectPath) {
      return {
        uploadUrl: `https://storage.example/${objectPath}?token=t`,
        uploadMethod: "PUT",
        uploadHeaders: { "x-upsert": "false" },
      };
    },
    async download(objectPath) {
      downloads[objectPath] = (downloads[objectPath] ?? 0) + 1;
      const bytes = objects[objectPath];
      if (!bytes) throw new Error("no such object");
      return bytes;
    },
    async remove(paths) { for (const p of paths) delete objects[p]; },
  };
  return {
    storage, objects, downloads,
    total: () => Object.values(downloads).reduce((a, b) => a + b, 0),
  };
}

/**
 * EVERY ACCOUNT THIS FILE CREATES, so it can take them away again.
 *
 * ── WHY A PG FIXTURE HAS TO CLEAN UP, AND WHAT IT COST NOT TO ────────────────────────────────
 *
 * The :5433 Postgres is SHARED and long-lived — it is the same database every `*.pg.test.ts` in
 * the repository migrates and writes to, run after run. A fixture that leaves rows behind is not
 * merely untidy: it is a permanent change to what every other suite's database-global assertions
 * see. This one left many mailboxes carrying a real `smtp_max_size_bytes`, and
 * `packages/db/test/mailbox-smtp-max-size.pg.test.ts` asserts that NO row carries a value that
 * migration could have written. That assertion went permanently red, and its red said "mail 0055
 * backfilled the column" when what had actually happened was "another suite ran".
 *
 * The mailboxes are load-bearing to this file — `smtpMaxSizeBytes` is the only ceiling a
 * staged-only send has, so they cannot simply be left null — which makes cleanup the only fix on
 * this side. The assertion over there was narrowed to production-shaped addresses in the same
 * change, because a run killed between its last test and its `afterAll` will always leak, and a
 * guard that depends on every fixture behaving is a guard that reports other people's crashes.
 */
const created: string[] = [];

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);

afterAll(async () => {
  if (PG_UP && created.length > 0) {
    // Child rows first: `accounts` is referenced by every one of these. The order is the FK
    // graph's, and `drafts` before `mailboxes` because a draft names the mailbox it will send from.
    for (const table of [
      "attachment_staging", "outbound_sends", "drafts", "change_log", "idempotency_keys", "mailboxes",
    ]) {
      await sql.unsafe(
        `delete from ${table} where account_id = any($1::uuid[])`, [created],
      );
    }
    await sql`delete from accounts where id = any(${created}::uuid[])`;
  }
  await sql.end({ timeout: 5 });
  await owned.close();
});

describe.skipIf(!PG_UP)("SEC3-NEW-3 — a repeated staged ticket, against real Postgres", () => {
  /**
   * `smtpMaxSizeBytes` is THE BINDING CEILING for every send in this file, and passing it is not
   * optional decoration — it is the only ceiling a staged-only send has. `sendSurfaceFor` resolves
   * the host surface to `null` when the request carries staged references and no inline
   * attachment, because those bytes never rode this host's request body. A cap test that leaves
   * this at 25 MB and tightens `surfaceMaxTotalBytes` instead is asserting nothing: the surface it
   * tightened is discarded before `effectiveAttachmentCap` sees it.
   */
  async function seeded(smtpMaxSizeBytes = 25 * MIB) {
    // A REAL account row: `attachment_staging.account_id` carries a foreign key, so a synthetic
    // uuid — which the mailboxes/drafts tables happily accept — cannot own a ticket here.
    const [acct] = await db.insert(accounts)
      .values({ name: `n3-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    created.push(accountId);      // see `afterAll` — this database outlives the run
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `n3-${randomUUID().slice(0, 8)}@x.test`,
      smtpMaxSizeBytes,
    }).returning();
    const ctx: ServiceContext = {
      db: dbFor(db, accountId),
      accountId, userId: null, now: () => NOW, requestId: "r",
    };
    const bucket = countingStorage();
    const port = makeAttachmentStagingPort({
      db: db as unknown as Parameters<typeof makeAttachmentStagingPort>[0]["db"],
      storage: bucket.storage,
    });

    /** Mint a real `attachment_staging` row and put its bytes in the bucket. */
    async function stage(filename: string, size: number): Promise<string> {
      // A DISTINCT KEY PER FILE. The mint's identity is its `Idempotency-Key` now, so two files
      // staged under one key would be one ticket — which is the point of the key and is exactly
      // what this file's own subject (distinct tickets stay distinct) is about.
      const grant = await port.mint({
        accountId, filename, contentType: "application/octet-stream",
        sizeBytes: size, now: NOW, idempotencyKey: `dedupe-${randomUUID()}`,
      });
      const objectPath = new URL(grant.uploadUrl).pathname.replace(/^\//, "");
      bucket.objects[objectPath] = new Uint8Array(size).fill(7);
      return grant.id;
    }

    async function newDraft(): Promise<string> {
      const [d] = await db.insert(drafts).values({
        accountId, mailboxId: mb!.id, subject: "with a file", body: "here",
        to: [{ name: null, address: "you@example.com" }], status: "draft",
      }).returning();
      return d!.id;
    }

    return { accountId, ctx, bucket, port, stage, newDraft };
  }

  it("ACCEPTANCE: a one-byte ticket named 50 times is downloaded ONCE and delivered ONCE", async () => {
    // 50 rather than far more because the route now refuses a list longer than
    // `SEND_MAX_ATTACHMENT_PARTS` outright; this is the shape that gets PAST the ceiling and has
    // to be collapsed rather than refused. The amplification is the same defect at 50 as at 1000.
    const { ctx, bucket, port, stage, newDraft } = await seeded();
    const id = await stage("invoice.pdf", 1);
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(
      ctx, draftId, `k-${randomUUID()}`,
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: port.source },
      { stagedAttachmentIds: Array<string>(50).fill(id) },
    );

    expect(res.status).toBe("sent");
    // THE AMPLIFICATION ASSERTION — the port's own tally, over a REAL ticket row.
    expect(bucket.total()).toBe(1);
    // The correctness half: one copy on the wire, not 50.
    expect(state.sent[0]!.attachments).toHaveLength(1);
    expect(state.sent[0]!.attachments![0]!.filename).toBe("invoice.pdf");
    // And the transaction really committed.
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
  });

  it("the DECLARED total is deduplicated too: 1 MB named ten times clears a 3 MB ceiling", async () => {
    // The reserve-side half, and the one a download-only fix leaves broken. Summing the row's
    // `size_bytes` once per occurrence makes this 10 MB and answers 413 for a 1 MB message —
    // refusing a send over bytes that were never going to be transferred twice.
    //
    // The ceiling is the MAILBOX's, per `seeded`: a staged-only send discards the host surface.
    const { ctx, bucket, port, stage, newDraft } = await seeded(3 * MIB);
    const id = await stage("photo.jpg", MIB);
    const { factory, state } = fakeAdapter();

    const res = await svc.send(
      ctx, await newDraft(), `k-${randomUUID()}`,
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: port.source },
      { stagedAttachmentIds: Array<string>(10).fill(id) },
    );

    expect(res.status).toBe("sent");
    expect(bucket.total()).toBe(1);
    expect(state.sent[0]!.attachments).toHaveLength(1);
    expect(state.sent[0]!.attachments![0]!.content.byteLength).toBe(MIB);
  });

  it("DISTINCT tickets are still summed and still refused — the dedupe collapses repeats only", async () => {
    // Never weaken the check being fixed. Two different 2 MB rows are 4 MB against the mailbox's
    // 3 MB announcement and must still be a 413, with nothing fetched and nothing sent.
    const { ctx, bucket, port, stage, newDraft } = await seeded(3 * MIB);
    const a = await stage("a.bin", 2 * MIB);
    const b = await stage("b.bin", 2 * MIB);
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const err = await svc.send(
      ctx, draftId, `k-${randomUUID()}`,
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: port.source },
      { stagedAttachmentIds: [a, b, a, b, a] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413 });
    expect(bucket.total()).toBe(0);
    expect(state.sendCalls).toBe(0);
    // Refused INSIDE the reserve transaction, so nothing was reserved — the rollback is the point.
    expect(await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))
      .toHaveLength(0);
  });

  it("distinct tickets each download exactly once, in the order the composer listed them", async () => {
    const { ctx, bucket, port, stage, newDraft } = await seeded();
    const first = await stage("first.bin", 16);
    const second = await stage("second.bin", 32);
    const { factory, state } = fakeAdapter();

    const res = await svc.send(
      ctx, await newDraft(), `k-${randomUUID()}`,
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: port.source },
      { stagedAttachmentIds: [second, first, second, first] },
    );

    expect(res.status).toBe("sent");
    expect(bucket.total()).toBe(2);
    expect(Object.values(bucket.downloads)).toEqual([1, 1]);
    expect(state.sent[0]!.attachments!.map((x) => x.filename))
      .toEqual(["second.bin", "first.bin"]);
  });
});
