import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  changeLog as pgChangeLog, flagState as pgFlagState, folderState as pgFolderState,
  mailboxes as pgMailboxes, messages as pgMessages,
} from "@trafficflow/db";
import {
  changeLog as deviceChangeLog, flagState as deviceFlagState, folderState as deviceFolderState,
  mailboxes as deviceMailboxes, messages as deviceMessages,
} from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { applyScreenerDecision, DECISION_BATCH_MAX, SCREENER_FOLDER } from "../src/screener-apply.js";
import { upsertDesiredSeenMany } from "../src/flag-intent.js";

/**
 * A DECISION OVER MORE THAN ONE SET, ON THIS STORE: every held letter moves, each move is followed
 * by its read update in the order the decision walked the bag, the seqs are contiguous, each
 * letter's read intent is written against its own observed state, and `lastSeq` names the last
 * row. The skip of a row that left the gate mid-set is `screener-domain-batches.pg.test.ts`'s.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const mailboxes = (ON_SQLITE ? deviceMailboxes : pgMailboxes) as unknown as typeof pgMailboxes;
const messages = (ON_SQLITE ? deviceMessages : pgMessages) as unknown as typeof pgMessages;
const folderState = (ON_SQLITE ? deviceFolderState : pgFolderState) as unknown as typeof pgFolderState;
const flagState = (ON_SQLITE ? deviceFlagState : pgFlagState) as unknown as typeof pgFlagState;
const changeLog = (ON_SQLITE ? deviceChangeLog : pgChangeLog) as unknown as typeof pgChangeLog;

const ACCOUNT = "11111111-2222-3333-4444-5555555555b1";
const MAILBOX = "22222222-3333-4444-5555-6666666666b1";
const NOW = new Date("2026-09-26T09:00:00.000Z");
const HELD = 2 * DECISION_BATCH_MAX + 7;

/** Held ids newest first — the order the decision walks one mailbox's bag. */
const idOf = (i: number) => `33333333-4444-5555-6666-${String(i).padStart(12, "0")}`;

describe("a decision written in sets keeps every per-letter fact, on this store", () => {
  it(`a screen-out over ${HELD} held letters`, async () => {
    const db = await makeTestDb();
    await db.insert(mailboxes).values({ id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "sets@example.test" } as never);
    const ids = Array.from({ length: HELD }, (_x, i) => idOf(i));
    const unread = (i: number) => i % 3 !== 0;
    await db.insert(messages).values(ids.map((id, i) => ({
      id, accountId: ACCOUNT, mailboxId: MAILBOX, bodyHash: `h${i}`, dedupKey: `sets:${i}`,
      subject: `Note ${i}`, snippet: "", fromAddress: `sender-${i}@corp.test`, unread: unread(i),
      date: new Date(NOW.getTime() - (i + 1) * 60_000), createdAt: NOW,
      // Checked at ingest, as every row since mail 0148: another address's unchecked row waits for its check.
      senderCheck: "none",
    })) as never);
    await db.insert(folderState).values(ids.map((id) => ({
      messageId: id, desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    })) as never);

    const result = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCOUNT, scope: "domain", address: "sender-0@corp.test", appliedFolder: "ohmail/Screened",
      decision: "no", triggeringActionId: "screener:sets", now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    expect(result.rerouted.map((r) => r.messageId)).toEqual(ids);
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, ACCOUNT)).orderBy(asc(changeLog.seq));
    expect(log.filter((r) => r.entityType === "message").map((r) => `${r.op}:${r.entityId}`))
      .toEqual(ids.map((id) => `move:${id}`));
    const seqs = log.map((r) => BigInt(r.seq as never));
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1n)).toBe(true);
    expect(BigInt(result.lastSeq as never)).toBe(seqs[seqs.length - 1]);

    const moved = await db.select({ id: folderState.messageId, d: folderState.desiredFolder }).from(folderState);
    expect(moved.every((r) => r.d === "ohmail/Screened")).toBe(true);
    expect(await db.select().from(flagState), "a screen-out wrote a read intent").toEqual([]);
    const still = await db.select({ id: messages.id }).from(messages).where(eq(messages.unread, true));
    expect(still.map((r) => r.id).sort()).toEqual(ids.filter((_id, i) => unread(i)).sort());
  }, 60_000);

  it("an empty set of read intents sends nothing", async () => {
    const db = await makeTestDb();
    await expect(upsertDesiredSeenMany(db as never, [], true, NOW)).resolves.toBeUndefined();
    expect(await db.select().from(flagState)).toEqual([]);
  });
});
