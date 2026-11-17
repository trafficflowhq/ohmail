import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { changeLog, mailboxes, messageInvitations, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { normalizeMime, planChange, newMessageInsertOf, UNMETERED_STORAGE_CAP, type Logger } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "@ohmail/organizer/sync";
import { ingestRunRepository, persistNewRun, RunConflictError } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import { dialect } from "@trafficflow/db/dialect";
import { FakeAdapterFleet, rawOf } from "../../../packages/organizer/test/_fakeadapter.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";
import { shapeLetters, invitationLetter, ME, reply, request, type InvitationLetter } from "../../../packages/organizer/test/_invitations.js";

/**
 * A FIRST IMPORT KEEPS THE SAME INVITATIONS AS ONE LETTER AT A TIME. The worker's import stores runs
 * of new letters in one transaction (`ingest-run.ts`); a letter carrying an invitation is never a run
 * member, so the per-letter commit writes its row and the answer it records. The page below is fed
 * to two fresh stores, runs off and runs on, and their rows and changes compared.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c42e";

function recorder(): Logger & { events: string[] } {
  const events: string[] = [];
  const log = {
    level: "debug" as const, events, child: () => log,
    debug: (e: string) => { events.push(e); }, info: (e: string) => { events.push(e); },
    warn: (e: string) => { events.push(e); }, error: (e: string) => { events.push(e); },
  };
  return log as unknown as Logger & { events: string[] };
}

const plain = (n: number): InvitationLetter => ({
  from: `p${n}@x.example`, subject: `plain ${n}`, messageId: `plain-${n}@x.example`,
  headers: [`Date: ${new Date(Date.UTC(2026, 10, 1, 8, n)).toUTCString()}`], contentType: "text/plain", body: `words ${n}`,
});

/** Plain letters around invitations of every method, the person's own answers among them. */
function page(): InvitationLetter[] {
  return [
    plain(1), plain(2),
    invitationLetter("ask-1@studio.example", request("kickoff-1@studio.example", 2)),
    plain(3),
    invitationLetter("answer-1@lichtgrat.example", reply("kickoff-1@studio.example", "ACCEPTED", "20261111T090000Z", 2), {
      from: ME, folder: "Sent", ownAuthored: true,
    }),
    invitationLetter("answer-2@lichtgrat.example", reply("kickoff-1@studio.example", "DECLINED", "20261112T090000Z", 2), {
      from: ME, folder: "Sent", ownAuthored: true,
    }),
    plain(4), plain(5),
    ...shapeLetters().map((c) => c.letter),
    plain(6),
  ];
}

async function ingest(runs: boolean): Promise<{ db: Tx; log: Logger & { events: string[] } }> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, { deliver: page() });
  const base = makeDrizzleRepo(db as never);
  const log = recorder();
  await runSyncCycle({
    log, writeAuthority: FIXTURE_LEASE, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
    repo: runs ? ingestRunRepository(base) : base, adapter, accountId: ACCOUNT, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, ...(runs ? { ingestRuns: INGEST_RUN_BOUNDS } : {}),
  });
  return { db, log };
}

/** The rows and every message change, by the letter's Message-ID. */
async function dump(db: Tx): Promise<unknown> {
  const ids = new Map((await db.select({ id: messages.id, mid: messages.messageIdHeader }).from(messages)).map((m) => [m.id, m.mid]));
  const rows = (await db.select().from(messageInvitations))
    .map(({ messageId, mailboxId: _m, accountId: _a, createdAt: _c, ...rest }) => ({ letter: ids.get(messageId), ...rest }))
    .sort((a, b) => String(a.letter).localeCompare(String(b.letter)));
  const changes = (await db.select({ type: changeLog.entityType, id: changeLog.entityId, op: changeLog.op }).from(changeLog).orderBy(asc(changeLog.seq)))
    .filter((c) => c.type === "message").map((c) => `${c.op} ${ids.get(String(c.id))}`);
  return { rows, changes };
}

describe("a first import with runs keeps the invitations one letter at a time keeps", () => {
  it("the same rows, the same answers recorded and the same message changes, and no run falls back", async () => {
    const off = await ingest(false);
    const on = await ingest(true);
    const want = await dump(off.db) as { rows: Array<{ letter: string; answer: string | null }>; changes: string[] };
    // The control: the page's invitations reached the store, the answers were recorded.
    expect(want.rows.length).toBeGreaterThanOrEqual(7);
    expect(want.rows.find((r) => r.letter === "ask-1@studio.example")?.answer).toBe("declined");
    expect(want.changes.filter((c) => c === "update ask-1@studio.example").length).toBeGreaterThanOrEqual(1);
    expect(await dump(on.db)).toEqual(want);
    // The runs stored the plain letters, and none of them met an invitation.
    expect(on.log.events).not.toContain("sync_ingest_run_fell_back");
  }, 120_000);

  it("a run handed a letter that carries an invitation refuses it whole, and writes nothing", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
    const repo = makeDrizzleRepo(db as never);
    const letter = invitationLetter("ask-9@studio.example", request("kickoff-9@studio.example"));
    const raw = rawOf(letter);
    const parsed = await normalizeMime(raw);
    const plan = await planChange({ type: "create", locator: { folder: "INBOX", ref: "1:1" }, raw, seen: false }, {
      repo, accountId: ACCOUNT, mailboxId: mb!.id, readerMode: false, trustedAuthservIds: new Set<string>(),
    }, parsed);
    expect(plan.new?.invitation?.uid).toBe("kickoff-9@studio.example");
    await expect(db.transaction((tx) => persistNewRun(tx as unknown as Tx, dialect(db), makeDrizzleRepo(tx as never), [
      { plan: plan.new!, insert: newMessageInsertOf(plan.new!, ACCOUNT, mb!.id) },
    ], { accountId: ACCOUNT, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP }))).rejects.toBeInstanceOf(RunConflictError);
    expect(await db.select().from(messages).where(eq(messages.accountId, ACCOUNT))).toEqual([]);
  });
});
