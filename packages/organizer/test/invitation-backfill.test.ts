import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { changeLog, mailboxes, mailboxPass, messageInvitations, messages, passProgress, readPassProgress, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { invitationBackfillPass, newInvitationBackfillState } from "../src/invitation-backfill.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import {
  shapeLetters, invitationLetter, ME, recorder, refuseInvitationRows, reply, request, SQLITE_STORE, type InvitationLetter,
} from "./_invitations.js";

/**
 * THE PASS OVER STORED MAIL gives every letter stored before ingest kept invitations the row ingest
 * gives one now (mail 0204): the same rows, each with a message change at a new position, in bounded
 * runs a restart resumes, reading the mail server and nothing else, on both stores (the `sqlite`
 * project runs this file too). The stores below are made as ingest makes them, then their rows are
 * taken away, which is what a store from before the entry holds.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c43e";

/** Letters of every method, the person's own answers among them, and plain ones between. */
function letters(): InvitationLetter[] {
  const plain = (n: number): InvitationLetter => ({
    from: `p${n}@x.example`, subject: `plain ${n}`, messageId: `plain-${n}@x.example`,
    headers: [`Date: ${new Date(Date.UTC(2026, 10, 1, 8, n)).toUTCString()}`], contentType: "text/plain", body: `words ${n}`,
  });
  return [
    plain(1),
    invitationLetter("ask-1@studio.example", request("kickoff-1@studio.example", 2)),
    plain(2),
    invitationLetter("answer-1@lichtgrat.example", reply("kickoff-1@studio.example", "TENTATIVE", "20261111T090000Z", 2), {
      from: ME, folder: "Sent", ownAuthored: true,
    }),
    ...shapeLetters().map((c) => c.letter),
  ];
}

/** Every row by its letter's Message-ID, without the instants a write stamps. */
async function rowsOf(db: Tx): Promise<unknown[]> {
  const rows = await db.select({ mid: messages.messageIdHeader, row: messageInvitations }).from(messageInvitations)
    .innerJoin(messages, eq(messages.id, messageInvitations.messageId));
  return rows.map(({ mid, row: { createdAt: _c, ...rest } }) => ({ mid, ...rest })).sort((a, b) => String(a.mid).localeCompare(String(b.mid)));
}

async function storedBefore0204() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
  const fleet = new FakeAdapterFleet();
  const dial = (): MailboxAdapter => fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, { deliver: letters() });
  const repo = makeDrizzleRepo(db as never);
  const cycleWith = (adapter: MailboxAdapter): Promise<unknown> => runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo, adapter, accountId: ACCOUNT, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
  });
  // Stored by an adapter with no targeted re-read, so the pass cannot run while the store fills.
  await cycleWith(dial());
  fleet.targetedRetry = true;
  const adapter = dial();
  const cycle = (): Promise<unknown> => cycleWith(adapter);
  // What ingest keeps now, and then a store from before the entry: the same letters, no rows.
  const ingested = await rowsOf(db);
  await db.delete(messageInvitations);
  await db.delete(passProgress).where(eq(passProgress.job, "invitation_backfill"));
  const lastSeq = (await db.select({ seq: changeLog.seq }).from(changeLog)).reduce((n, r) => (BigInt(String(r.seq)) > n ? BigInt(String(r.seq)) : n), 0n);
  return { db, mailboxId: mb!.id, fleet, adapter, repo, cycle, ingested, lastSeq };
}

type World = Awaited<ReturnType<typeof storedBefore0204>>;
const pass = (w: World, opts: Partial<Parameters<typeof invitationBackfillPass>[0]> = {}) => invitationBackfillPass({
  repo: w.repo as WorkerRepo, adapter: w.adapter, accountId: ACCOUNT, mailboxId: w.mailboxId,
  write: (fn) => (w.repo as WorkerRepo).transaction((r) => fn(r as WorkerRepo)), state: newInvitationBackfillState(), ...opts,
});
const marks = (w: World) => readPassProgress(w.db, mailboxPass("invitation_backfill", ACCOUNT, w.mailboxId));
/** Letters that carry a calendar part: each one is read again once. */
const CANDIDATES = letters().filter((l) => l.contentType.startsWith("multipart/")).length;
/** Visits until the done mark, at most `max`. */
async function untilDone(w: World, visit: () => Promise<unknown>, max = 20): Promise<number> {
  let n = 0;
  for (; n < max && (await marks(w)).doneAt === null; n++) await visit();
  return n;
}

describe("the invitation pass over stored mail", () => {
  it("writes the rows ingest writes, each with a message change at a new position, and marks the mailbox done", async () => {
    const w = await storedBefore0204();
    expect(w.ingested.length).toBeGreaterThanOrEqual(6);
    // Each visit reads a bounded run: as many visits as the run's reads divide the candidates in.
    expect(await untilDone(w, w.cycle)).toBeGreaterThanOrEqual(Math.ceil(CANDIDATES / 25));
    expect(await rowsOf(w.db)).toEqual(w.ingested);
    const after = (await w.db.select({ seq: changeLog.seq, type: changeLog.entityType, id: changeLog.entityId, op: changeLog.op })
      .from(changeLog).orderBy(asc(changeLog.seq))).filter((c) => BigInt(String(c.seq)) > w.lastSeq);
    const withRows = await w.db.select({ id: messageInvitations.messageId }).from(messageInvitations);
    for (const { id } of withRows) {
      expect(after.filter((c) => c.type === "message" && c.id === id && c.op === "update").length, id).toBeGreaterThanOrEqual(1);
    }
    expect((await marks(w)).doneAt).not.toBeNull();
    // Done is done: a second visit reads the mail server for nothing more.
    const before = w.fleet.targetedFetches.length;
    await w.cycle();
    expect(w.fleet.targetedFetches.length).toBe(before);
  });

  it("a run of one read at a time takes as many visits, and a restart goes on from the cursor", async () => {
    const w = await storedBefore0204();
    const reads: number[] = [];
    // Each visit a restart: a fresh process state, the place read from the store.
    const visits = await untilDone(w, async () => { reads.push((await pass(w, { reads: 1 })).read); }, CANDIDATES + 5);
    expect(Math.max(...reads)).toBe(1);
    expect(visits).toBeGreaterThanOrEqual(CANDIDATES);
    expect(await rowsOf(w.db)).toEqual(w.ingested);
  });

  it("a read that fails settles nothing: the cursor stays and the next visit reads the same letters", async () => {
    const w = await storedBefore0204();
    const failing = { ...w.adapter, fetchByUid: async () => { throw new Error("connection reset"); } } as MailboxAdapter;
    const r = await pass(w, { adapter: failing });
    expect(r.stopped).toBe("fetch_failed");
    expect(await marks(w)).toMatchObject({ doneAt: null });
    expect(await rowsOf(w.db)).toEqual([]);
    await untilDone(w, () => pass(w));
    expect(await rowsOf(w.db)).toEqual(w.ingested);
  });

  it("asks the mail server for the letters it reads again and for nothing else", async () => {
    const w = await storedBefore0204();
    const asked: string[] = [];
    const watched = new Proxy(w.adapter, {
      get(obj, prop): unknown {
        const value = Reflect.get(obj, prop, obj) as unknown;
        if (typeof value !== "function") return value;
        return (...a: unknown[]) => { asked.push(String(prop)); return (value as (...b: unknown[]) => unknown).apply(obj, a); };
      },
    });
    await pass(w, { adapter: watched });
    expect(new Set(asked)).toEqual(new Set(["fetchByUid"]));
  });

  it("a letter the server now holds as another is settled without a row, and so is one it no longer holds", async () => {
    const w = await storedBefore0204();
    // The server's copy of every letter changed under the same UIDs: none is the stored letter.
    w.fleet.behave(w.mailboxId, { deliver: letters().map((l) => ({ ...l, messageId: `other-${l.messageId}`, subject: "another" })) });
    let written = 0;
    await untilDone(w, async () => { written += (await pass(w)).written; });
    expect(written).toBe(0);
    expect(await rowsOf(w.db)).toEqual([]);
    expect((await marks(w)).doneAt).not.toBeNull();
  });

  it("a refusal of a row's own value settles its letter without the row, says so, and the walk goes on", async () => {
    const w = await storedBefore0204();
    const log = recorder();
    const lift = await refuseInvitationRows(w.db, "kickoff-1@studio.example", "22023", "REQUEST");
    try {
      await untilDone(w, () => pass(w, { log }));
    } finally {
      await lift();
    }
    const [asked] = await w.db.select({ id: messages.id }).from(messages).where(eq(messages.messageIdHeader, "ask-1@studio.example"));
    expect((await marks(w)).doneAt, "the walk stopped at the refused letter").not.toBeNull();
    expect(await rowsOf(w.db)).toEqual((w.ingested as Array<{ mid: string }>).filter((r) => r.mid !== "ask-1@studio.example"));
    expect(log.lines.filter((l) => l.event === "invitation_row_refused")).toEqual([{
      event: "invitation_row_refused",
      fields: { accountId: ACCOUNT, mailboxId: w.mailboxId, messageId: asked!.id, reason: SQLITE_STORE ? "constraint_violation" : "data_exception" },
    }]);
  });

  it.skipIf(SQLITE_STORE)("any other fault ends the visit with the cursor where it was, and a later visit writes the row", async () => {
    const w = await storedBefore0204();
    const lift = await refuseInvitationRows(w.db, "kickoff-1@studio.example", "40P01", "REQUEST");
    let visit: unknown = null;
    try {
      visit = await pass(w).then(() => null, (e: unknown) => e);
    } finally {
      await lift();
    }
    expect(visit, "the visit went on past a fault of the store").toMatchObject({ code: "40P01" });
    expect(await marks(w)).toMatchObject({ doneAt: null });
    await untilDone(w, () => pass(w));
    expect(await rowsOf(w.db)).toEqual(w.ingested);
  });

  it("a repo or an adapter that cannot run the pass marks nothing done", async () => {
    const w = await storedBefore0204();
    const blind = { ...w.adapter, fetchByUid: undefined } as MailboxAdapter;
    expect((await pass(w, { adapter: blind })).waited).toBe("unsupported");
    expect((await marks(w)).doneAt).toBeNull();
  });
});

describe("the pass's logs", () => {
  it("carry ids, counts and closed words through the real logger: no letter's text, no field dropped", async () => {
    const w = await storedBefore0204();
    const raw: string[] = [];
    const log = createLogger({ service: "worker", level: "debug", sink: (l) => { raw.push(l); } });
    const failing = { ...w.adapter, fetchByUid: async () => { throw new Error("kickoff-1@studio.example secret text"); } } as MailboxAdapter;
    await pass(w, { adapter: failing, log });
    await untilDone(w, () => pass(w, { log }));
    const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => String(l.event).startsWith("invitation_backfill"));
    expect(lines.map((l) => l.event)).toEqual(expect.arrayContaining(["invitation_backfill_fetch_failed", "invitation_backfill_pass"]));
    for (const l of lines) expect(l.droppedFields, String(l.event)).toBeUndefined();
    const said = JSON.stringify(lines);
    for (const marker of ["kickoff-1@studio.example", "tobias@studio.example", ME, "secret text"]) expect(said).not.toContain(marker);
  });
});
