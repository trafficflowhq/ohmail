import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, folderState, mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  MemoryMirrorStore, consentPartition,
  type EngineMessage, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { cutlineCounts } from "../src/consent-cutline.js";
import type { ServiceContext } from "../src/context.js";

/**
 * ══ THE CUTLINE, OVER MAIL THAT IS ALREADY FILED ══════════════════════════════════════════
 *
 * `consent-cutline.pg.test.ts` exists to stop the two implementations drifting, and it says so:
 * *"this file builds ONE set of rows, runs both over it, and requires the same answer. The
 * fixture is deliberately made of the cases where a naive version of either would be wrong."*
 *
 * **Not one of its eleven fixture rows sits in `ohmail/Reads`, `ohmail/Receipts`,
 * `ohmail/Screened` or `ohmail/Quarantine`** — every row is `ohmail/Screener`, `INBOX`, or a Sent
 * folder. Those four folders are exactly where the two implementations parted company, so the
 * parity guard had never been able to see it. This file is the fixture that can: one sender per
 * already-filed folder, with the two cases that separate the fix from a plausible wrong one.
 *
 * ── WHERE THEY PARTED ─────────────────────────────────────────────────────────────────────
 *
 * SERVER (`consent-cutline.ts#cutlineCounts`): the `inbound` CTE admitted any message whose
 * `desired_folder` is one of the SIX presented folders, then classified its sender. A sender with
 * no rule and unread mail was `active_undecided` no matter which of the six it sat in.
 *
 * CLIENT (`client-engine/src/consent-cutline.ts#consentPartition`): after the known-folder check
 * it bails on anything outside the two UNDECIDED RESIDENCES —
 *
 *     if (!UNDECIDED_RESIDENCES.has(m.folder)) { placeOf.set(m.id, m.folder); continue; }
 *
 * — before the sender is ever added to `activeUndecided` or `dormantUndecided`. The file states
 * the rule it is following: *"Mail anywhere else — Reads, Receipts, Screened, Quarantine — is
 * already where somebody put it. An explicit placement is itself an answer."*
 *
 * The CLIENT is the one that matches the written design. Measured at HEAD before the fix, over
 * the first three rows below: **server 3, client 1**. `GET /consent` is what reports that number
 * to the user, and the two senders in the difference can never appear in the queue.
 *
 * ── THE ROW THAT RULES OUT THE OTHER FIX ──────────────────────────────────────────────────
 *
 * The obvious repair is `and fs.desired_folder in ('INBOX','ohmail/Screener')` on `inbound`. It
 * makes the first case pass and introduces a second disagreement, because it also narrows what
 * ACTIVITY is measured over — and the client does not narrow that. `senderActivity` runs over
 * every presented folder before the residence bail is reached.
 *
 * `split@` below is that case: old, READ mail at the gate, and UNREAD mail filed into Reads.
 * The client calls them active-undecided. The narrowed server would call them dormant-undecided.
 * Both counts are asserted, so the wrong fix is red here rather than shipped.
 */
const AVAILABLE = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-08T12:00:00.000Z");
const RECENT = new Date("2026-08-01T09:00:00.000Z");
/** Well outside the 60-day window, so only unread mail can make its sender active. */
const OLD = new Date("2023-02-04T09:00:00.000Z");
const ACCOUNT = randomUUID();
const OWN = `filed-own-${ACCOUNT.slice(0, 8)}@example.com`;
let mailboxId = "";

const ctx: ServiceContext = {
  db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "cutline-filed",
};

/**
 * One sender per already-filed folder, all with no rule behind them and all with unread mail —
 * so the server's `active` test passes on every one and ONLY the residence test separates them.
 */
const ROWS = [
  { from: "spam@nobody.test", folder: "ohmail/Quarantine", date: RECENT, unread: true },
  { from: "list@bulletin.test", folder: "ohmail/News", date: RECENT, unread: true },
  { from: "invoice@vendor.test", folder: "ohmail/Receipts", date: RECENT, unread: true },
  { from: "turned@away.test", folder: "ohmail/Screened", date: RECENT, unread: true },
  // A control that BOTH sides agree on, so a failure cannot be read as "the fixture is empty".
  { from: "waiting@nobody.test", folder: "ohmail/Screener", date: RECENT, unread: true },
  // DORMANT and undecided at the gate: read, and older than the window. Pins the dormant count,
  // which the four filed senders above would otherwise have been silently added to by a fix that
  // moved them from one bucket to the other instead of out of both.
  { from: "quiet@nobody.test", folder: "ohmail/Screener", date: OLD, unread: false },
  // See the header: mail in BOTH kinds of place. Read and old at the gate, unread in Reads.
  // Active on the client (activity is measured over all six folders), and it must stay active
  // on the server — which the narrowing fix would have broken.
  { from: "split@nobody.test", folder: "ohmail/Screener", date: OLD, unread: false },
  { from: "split@nobody.test", folder: "ohmail/News", date: OLD, unread: true },
];

async function mirror(): Promise<MemoryMirrorStore> {
  const stored = await db.select({
    id: messages.id, from: messages.fromAddress, unread: messages.unread,
    date: messages.date, folder: folderState.desiredFolder,
  }).from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(eq(messages.accountId, ACCOUNT));

  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(stored.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
    entity: {
      id: m.id, accountId: ACCOUNT, mailboxId, threadId: null, messageIdHeader: null,
      subject: "", from: { name: null, address: m.from }, to: [], cc: [],
      date: m.date ? m.date.toISOString() : null,
      folder: m.folder as Folder, snippet: "", unread: m.unread,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    } satisfies EngineMessage,
  })) as SyncChange[]);
  return store;
}

describe.skipIf(!AVAILABLE)("the cutline over mail that is already filed", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `filed-${ACCOUNT.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: OWN,
    }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;

    for (const r of ROWS) {
      const [m] = await db.insert(messages).values({
        accountId: ACCOUNT, mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
        fromAddress: r.from, subject: "s", date: r.date, unread: r.unread, snippet: "",
      }).returning({ id: messages.id });
      await db.insert(folderState).values({
        messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: r.folder, observedFolder: r.folder,
        lastSetBy: "us", reconcileStatus: "reconciled",
      });
    }
  }, 120_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("server and client agree on how many senders are still owed a decision", async () => {
    const server = await cutlineCounts(ctx);
    const clientSide = consentPartition(await mirror(), { now: NOW, ownAddresses: [OWN] });

    expect(
      clientSide.counts.activeUndecidedSenders,
      "the number GET /consent reports is not the number the queue will show",
    ).toBe(server.activeUndecidedSenders);
    expect(
      clientSide.counts.dormantUndecidedSenders,
      "the two implementations disagree about who is waiting in History",
    ).toBe(server.dormantUndecidedSenders);
  });

  /**
   * THE ABSOLUTE NUMBERS, so a regression that moved BOTH implementations together is still red.
   *
   * The test above compares two things that can be wrong in the same direction — the whole
   * reason the original parity guard could not see this defect is that both of its
   * implementations happened to agree on the rows it had.
   */
  it("counts the two gate senders and nobody who has already been filed", async () => {
    const server = await cutlineCounts(ctx);

    // `waiting@` (unread at the gate) and `split@` (unread mail in Reads makes them active; their
    // gate mail is what keeps them countable at all). The four filed senders are not owed a
    // decision — somebody already made one by putting their mail where it is.
    expect(server.activeUndecidedSenders).toBe(2);
    // `quiet@` alone. The filed four must not have been moved into this bucket instead.
    expect(server.dormantUndecidedSenders).toBe(1);
    // Nobody here has a rule.
    expect(server.decidedSenders).toBe(0);
  });
});
