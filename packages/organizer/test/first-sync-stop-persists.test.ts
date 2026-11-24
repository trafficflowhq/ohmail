import { describe, it, expect, afterEach } from "vitest";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { WATCHED_FOLDERS } from "@trafficflow/core/adapters/imap";
import type {
  BudgetStop, ChangeBatch, ImapConfig, ImapCursor, MailboxAdapter, PersistedFolderCursor,
} from "@trafficflow/core/adapters/imap";
import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import type { NativeLocator } from "@trafficflow/core";
import { buildCursor, runSyncCycle } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A BUDGETED FIRST SYNC NEVER RESTARTS AT INBOX (mail 0115).
 *
 * The pass reports the folder a spent byte budget refused. The adapter remembered it in memory,
 * so it survived every cycle of one attachment and nothing else: a restart or a re-attach began
 * again at INBOX, and a mailbox whose first folders each hold a large message could spend every
 * pass on them while the tail waited. The stop is now written at pass end and read at attach.
 */

const MiB = 1024 * 1024;

/**
 * A config the fake never dials: `opts.client` is injected, so `connect()` opens no socket.
 *
 * The ports are deliberately NOT the GreenMail box's (3143/3025). This file cannot import core's
 * `_imapenv` helper, so it spells an address out — and spelling the box's would both classify it
 * as a box file (`box-files.mjs`, rightly: it constructs an `ImapAdapter`) and leave a fixture
 * one injection mistake away from dialling a shared server.
 */
function config(): ImapConfig {
  return {
    host: "127.0.0.1", port: 9143, secure: false,
    auth: { user: "fixture@trafficflow.test", pass: "x" },
    smtp: { host: "127.0.0.1", port: 9025, secure: false },
    sentDomain: "trafficflow.test",
  };
}

/**
 * `folders` customer folders holding one `bodyBytes` message each, and an INBOX holding `inbox` of
 * them — the arm that decides whether a stopped folder is ever reached again. LIST-STATUS is
 * advertised because without it the passive inventory is capped and the shape is never posed.
 */
function fakeMailbox(opts: { folders: number; bodyBytes: number; inbox: number }) {
  const names = Array.from({ length: opts.folders }, (_, i) => `cust/${String(i + 1).padStart(3, "0")}`);
  const all = [...WATCHED_FOLDERS, ...names];
  const countFor = (path: string): number =>
    path === "INBOX" ? opts.inbox : (names.includes(path) ? 1 : 0);
  const body = (folder: string, uid: number): Buffer => {
    const head = Buffer.from(`Message-ID: <${folder}-${uid}@x>\r\nSubject: ${folder}\r\n\r\n`);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, opts.bodyBytes - head.length), 0x61)]);
  };
  const mailboxFor = (path: string) => ({
    path, uidValidity: 100n, uidNext: countFor(path) + 1, highestModseq: 0n, exists: countFor(path),
  });
  return {
    names,
    client: {
      capabilities: new Map<string, boolean>([["MOVE", true], ["LIST-STATUS", true]]),
      mailbox: mailboxFor("INBOX"),
      _path: "INBOX",
      async list() {
        return all.map((path) => ({
          path, name: path, delimiter: "/", flags: new Set<string>(),
          status: { messages: countFor(path), uidNext: countFor(path) + 1, highestModseq: 0n, uidValidity: 100n },
        }));
      },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = mailboxFor(path);
        return { path, release() { /* noop */ } };
      },
      async logout() { /* noop */ },
      close() { /* noop */ },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any, _options: any) {
        const folder = this._path;
        const here = countFor(folder);
        if (here === 0) return;
        const every = Array.from({ length: here }, (_, i) => i + 1);
        const asked: number[] = Array.isArray(range) ? range.filter((u) => every.includes(u)) : every;
        for (const uid of asked) {
          if (query?.source) {
            yield {
              uid, flags: new Set<string>(), envelope: { messageId: `<${folder}-${uid}@x>` },
              source: body(folder, uid), internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
            };
          } else if (query?.size) {
            yield { uid, size: opts.bodyBytes };
          } else if (query?.internalDate) {
            yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
          } else {
            yield { uid };
          }
        }
      },
    },
  };
}

/**
 * The folder rows and the known-set, over a Map — the two things `buildCursor` reads and the two
 * writers `runSyncCycle` calls to move them. A stub that answered constants would prove nothing
 * about a restart, because a restart is exactly "what the store still holds".
 */
function store() {
  const rows = new Map<string, { folder: string } & PersistedFolderCursor>();
  const known: KnownLocator[] = [];
  const repo = {
    getMailboxFolders: async () => [...rows.values()],
    listKnownLocators: async () => known,
    upsertMailboxFolder: async (_mb: string, folder: string, cursor: PersistedFolderCursor) => {
      const was = rows.get(folder);
      // The real writer leaves the two stop columns alone — a cursor write may not move a stop.
      rows.set(folder, { ...(was?.budgetStop ? { budgetStop: was.budgetStop } : {}), folder, ...cursor });
    },
    upsertMailboxFolders: async (mb: string, entries: Array<{ folder: string; cursor: PersistedFolderCursor }>) => {
      for (const e of entries) await (repo as unknown as { upsertMailboxFolder: (m: string, f: string, c: PersistedFolderCursor) => Promise<void> }).upsertMailboxFolder(mb, e.folder, e.cursor);
    },
    setMailboxBudgetStop: async (_mb: string, stop: BudgetStop | null) => {
      for (const [folder, row] of rows) {
        if (row.budgetStop !== undefined) rows.set(folder, { ...row, budgetStop: undefined });
      }
      if (stop === null) return;
      const was = rows.get(stop.folder);
      rows.set(stop.folder, {
        ...(was ?? { folder: stop.folder, uidValidity: "0", uidNext: 0, highestModseq: "0" }),
        budgetStop: { uidValidity: stop.uidValidity, uid: stop.uid },
      });
    },
  } as unknown as WorkerRepo;
  /** What the worker persists after a pass: the drained cursors and the ingested locators. */
  const persist = async (batch: ChangeBatch) => {
    for (const c of batch.creates) {
      const [uidValidity, uid] = c.locator.ref.split(":");
      known.push({
        folder: c.locator.folder, uid: Number(uid), uidValidity: String(uidValidity),
        messageId: null, seen: false,
      } as KnownLocator);
    }
    for (const [folder, fc] of Object.entries(batch.newCursor.folders)) {
      await repo.upsertMailboxFolder("mb", folder, fc);
    }
    await repo.setMailboxBudgetStop("mb", batch.budgetStop ?? null);
  };
  return { rows, known, repo, persist };
}

describe("the first sync's budget stop survives a restart", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a fresh process attaching resumes at the folder the budget stopped at", async () => {
    const s = store();
    adapter = new ImapAdapter(config(), {
      client: fakeMailbox({ folders: 6, bodyBytes: 1 * MiB, inbox: 20 }).client,
      capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    await adapter.connect();
    const first = await adapter.changesSince(await buildCursor(s.repo, "mb"));
    // INBOX owes more than the budget, so the pass spends it there and refuses the next folder.
    expect(first.creates.map((c) => c.locator.folder)).toEqual(Array(4).fill("INBOX"));
    expect(first.budgetStop).toEqual({ folder: "cust/001", uidValidity: "100", uid: 1 });
    await s.persist(first);
    await adapter.close();
    adapter = undefined;

    // THE RESTART. A new adapter remembers nothing; the cursor rebuilt from the store is the only
    // thing that crossed it. Without the stored stop this reads INBOX and cust/001 waits again.
    const restarted = new ImapAdapter(config(), {
      client: fakeMailbox({ folders: 6, bodyBytes: 1 * MiB, inbox: 20 }).client,
      capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    try {
      await restarted.connect();
      const cursor = await buildCursor(s.repo, "mb");
      expect(cursor.budgetStop).toEqual({ folder: "cust/001", uidValidity: "100", uid: 1 });
      const after = await restarted.changesSince(cursor);
      expect(after.creates[0]?.locator.folder).toBe("cust/001");
    } finally {
      await restarted.close();
    }
  });

  it("a pass that reaches the end clears the stop, so nothing leads with a settled folder", async () => {
    const s = store();
    await s.repo.setMailboxBudgetStop("mb", { folder: "cust/001", uidValidity: "100", uid: 1 });
    expect((await buildCursor(s.repo, "mb")).budgetStop?.folder).toBe("cust/001");

    adapter = new ImapAdapter(config(), {
      client: fakeMailbox({ folders: 2, bodyBytes: 64 * 1024, inbox: 1 }).client,
      capabilityOverrides: { condstore: false }, maxBatchBytes: 32 * MiB,
    });
    await adapter.connect();
    const batch = await adapter.changesSince(await buildCursor(s.repo, "mb"));
    expect(batch.budgetStop).toBeUndefined();
    await s.persist(batch);
    expect((await buildCursor(s.repo, "mb")).budgetStop).toBeUndefined();
  });

  it("the stored stop keeps its epoch, and a half-written pair is not presented as a fact", async () => {
    const s = store();
    await s.repo.setMailboxBudgetStop("mb", { folder: "Archive", uidValidity: "77", uid: 912 });
    expect((await buildCursor(s.repo, "mb")).budgetStop)
      .toEqual({ folder: "Archive", uidValidity: "77", uid: 912 });
    // A cursor write for the same folder leaves the stop where it is: the two are separate facts.
    await s.repo.upsertMailboxFolder("mb", "Archive", { uidValidity: "77", uidNext: 4, highestModseq: "0" });
    expect((await buildCursor(s.repo, "mb")).budgetStop?.uid).toBe(912);
  });
});

/* ── WHEN THE CYCLE WRITES IT ────────────────────────────────────────────────────────────────
   `runSyncCycle` over doubles, on `delete-evidence-budget.test.ts`'s shape: the question here is
   WHERE in the pass the write happens, which needs the real cycle and no server at all. */

function adapterOf(batch: Partial<ChangeBatch>, cursorSeen: ImapCursor[]): MailboxAdapter {
  return {
    changesSince: async (c: ImapCursor) => {
      cursorSeen.push(c);
      return {
        creates: [], moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: {} }, hasBacklog: false, ...batch,
      } as ChangeBatch;
    },
  } as unknown as MailboxAdapter;
}

function cycleRepo(
  calls: string[], stored: BudgetStop | undefined, onForget?: () => void,
): WorkerRepo {
  const stub = {
    mailboxStatusForWrite: async (): Promise<string> => "connected",
    getMailboxFolders: async () => (stored === undefined ? [] : [{
      folder: stored.folder, uidValidity: stored.uidValidity, uidNext: 0, highestModseq: "0",
      budgetStop: { uidValidity: stored.uidValidity, uid: stored.uid },
    }]),
    listKnownLocators: async () => [],
    listMessageFailures: async () => [],
    claimMessageFailures: async () => [],
    forgetInstanceAt: async (_mb: string, _locator: NativeLocator) => {
      calls.push("forget");
      onForget?.();
    },
    upsertMailboxFolder: async () => { calls.push("cursor"); },
    upsertMailboxFolders: async () => { calls.push("cursor"); },
    setMailboxBudgetStop: async (_mb: string, stop: BudgetStop | null) => {
      calls.push(`stop:${stop === null ? "cleared" : stop.folder}`);
    },
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [],
    recordAudit: async () => {},
  };
  return {
    ...stub,
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  } as unknown as WorkerRepo;
}

async function cycle(
  batch: Partial<ChangeBatch>, stored?: BudgetStop, onForget?: () => void,
): Promise<{ calls: string[]; cursorSeen: ImapCursor[]; threw: unknown }> {
  const calls: string[] = [];
  const cursorSeen: ImapCursor[] = [];
  let threw: unknown = null;
  try {
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE,
      repo: cycleRepo(calls, stored, onForget), adapter: adapterOf(batch, cursorSeen),
      accountId: "acct", mailboxId: "mb",
      role: "organizer", trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
    });
  } catch (err) { threw = err; }
  return { calls, cursorSeen, threw };
}

const STOP: BudgetStop = { folder: "cust/001", uidValidity: "100", uid: 1 };
const LIVE = { folders: { INBOX: { uidValidity: "100", uidNext: 9, highestModseq: "0" } } };

describe("a cycle writes the budget stop once, at pass end", () => {
  it("writes it after the cursors, and hands the stored one back on the next attach", async () => {
    const { calls, cursorSeen } = await cycle({ budgetStop: STOP, hasBacklog: true, newCursor: LIVE });
    expect(calls).toEqual(["cursor", "stop:cust/001"]);
    // The read half, in the same cycle: a store that already holds one hands it to the adapter.
    const again = await cycle({ budgetStop: STOP, hasBacklog: true, newCursor: LIVE }, STOP);
    expect(again.cursorSeen[0]?.budgetStop).toEqual(STOP);
  });

  it("a cycle that dies mid-batch leaves NO stop behind", async () => {
    // The pass reported a stop and then a change refused by class — the cycle is over before the
    // cursors are written. A stop recorded before the work names a place this pass never settled
    // on, so nothing is written at all and the next pass leads exactly where the last stored one
    // said. Written per page, this reads `["forget", "stop:cust/001"]`.
    const { calls, threw } = await cycle(
      {
        budgetStop: STOP, hasBacklog: true, newCursor: LIVE,
        deletes: [{ type: "delete", locator: { folder: "INBOX", ref: "100:1" } }],
      },
      undefined,
      () => { throw new LeaseUnavailableError("the lease could not be read", { op: "list_claims" }); },
    );
    expect(threw).toBeInstanceOf(LeaseUnavailableError);
    expect(calls.filter((c) => c.startsWith("stop:"))).toEqual([]);
  });

  it("an unchanged stop costs no write, and a pass that took the last folder clears it", async () => {
    // A cycle is a COMPARISON: a mailbox stopped at the same place as last time writes nothing.
    const same = await cycle({ budgetStop: STOP, hasBacklog: true, newCursor: LIVE }, STOP);
    expect(same.calls.filter((c) => c.startsWith("stop:"))).toEqual([]);
    // …and a pass that reached the end clears what was stored, exactly once.
    const done = await cycle({ newCursor: LIVE }, STOP);
    expect(done.calls.filter((c) => c.startsWith("stop:"))).toEqual(["stop:cleared"]);
    // A settled mailbox with nothing stored writes nothing either way.
    const idle = await cycle({ newCursor: LIVE });
    expect(idle.calls.filter((c) => c.startsWith("stop:"))).toEqual([]);
  });
});
