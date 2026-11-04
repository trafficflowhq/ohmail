import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import type {
  ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, recordChange } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * AN IDLE DRAIN ON THIS DOOR IS A COMPARISON.
 *
 * The local engine's poll used to re-read every locator the mailbox holds, rebuild the cursor from
 * all of them, and fold the write-ahead log — once per interval, for ever, over a mailbox nobody
 * was writing to. This is that claim on the real door: a real store, the real cycle, the engine's
 * own drain line as the instrument, and the counters read off it.
 *
 * The positive control is in the same file and matters more than the claim: a drain that finds
 * mail still reads, still derives and still folds. The alternative to an expensive idle tick is
 * mail that never arrives.
 */

/** `ohmail/_meta` in memory, EMPTY — nobody has ever organized this mailbox. */
class FreeLease implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number { return 7_700; }
}

const EMPTY_CURSOR = { folders: {} };

function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <idle-${uid}@stranger.test>`,
    "From: stranger@elsewhere.test",
    "To: owner@trafficflow.test",
    `Subject: idle mail ${uid}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/**
 * A server that hands over `first` once, then nothing until a test PUTS something in `pending`.
 *
 * `onAsk` runs INSIDE the cycle, which is the only way to reach the instant this file needs: a
 * write that lands while a drain is running, between the two readings of the change log.
 */
function mailbox(
  first: number[], pending: number[], onAsk?: () => Promise<void>,
): (cfg: ImapConfig) => MailboxAdapter {
  const meta = new FreeLease();
  let handed = false;
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false, idle: false,
        specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      if (onAsk) await onAsk();
      const give = handed ? pending.splice(0) : (handed = true, first);
      return {
        creates: give.map((uid) => ({
          type: "create" as const,
          locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
          raw: arrival(uid),
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
      };
    },
  } as unknown as MailboxAdapter);
}

interface Drain {
  cycles: number; observed: number; cursorBuilds: number;
  locatorReads: number; locatorRows: number; cursorFolders: number; checkpoints: number;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function boot(first: number[], pending: number[], onAsk?: () => Promise<void>): Promise<{
  sidecar: Sidecar; drains: Drain[];
}> {
  const drains: Drain[] = [];
  const dataDir = await freshDataDir("ohmail-idle-");
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
    },
    address: "owner@trafficflow.test",
    machineName: "idle host",
    // An hour: nothing polls behind these cases, so every drain in them is one this file asked for.
    pollIntervalMs: 60 * 60 * 1000,
    adapterFactory: mailbox(first, pending, onAsk),
    log: (event, detail) => {
      if (event === "sync_drain") drains.push(detail as unknown as Drain);
    },
  });
  cleanups.push(async () => {
    await sidecar.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  // A fresh row is a consent-less reader, and a reader is not this file's subject.
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  await sidecar.start();
  return { sidecar, drains };
}

describe("an idle drain over a mailbox nobody wrote to", () => {
  /**
   * SETTLE FIRST, AND THAT IS NOT BOOKKEEPING. The cursor is built BEFORE the cycle ingests, so
   * the drain that takes mail builds from what the memo held and then drops it — the re-read is
   * owed to the NEXT drain, which is exactly right and is what the second case asserts. "Idle"
   * therefore means the drain after a drain that changed nothing, and this is where that starts.
   */
  async function settled(first: number[], pending: number[], onAsk?: () => Promise<void>): Promise<{
    sidecar: Sidecar; drains: Drain[];
  }> {
    const b = await boot(first, pending, onAsk);
    await b.sidecar.syncUntilQuiet();   // pays for the launch drain's writes
    await b.sidecar.syncUntilQuiet();   // changed nothing
    b.drains.length = 0;
    return b;
  }

  it("reads no locators, derives nothing and folds no log", async () => {
    const { sidecar, drains } = await settled([1, 2, 3], []);
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();
    expect(drains.length).toBe(2);
    for (const d of drains) {
      expect(d.observed).toBe(0);
      // The cycle still ASKS for a cursor — it has to, to ask the server anything.
      expect(d.cursorBuilds).toBeGreaterThan(0);
      // And it answers without going to the store, without walking a row, without rebuilding an
      // array and without folding the log. That is the whole claim.
      expect(d.locatorReads).toBe(0);
      expect(d.locatorRows).toBe(0);
      expect(d.cursorFolders).toBe(0);
      expect(d.checkpoints).toBe(0);
    }
  });

  it("does the whole thing again for one message", async () => {
    const pending: number[] = [];
    const { sidecar, drains } = await settled([1, 2, 3], pending);

    pending.push(4);
    await sidecar.syncUntilQuiet();
    const took = drains.find((d) => d.observed > 0);
    expect(took, "the drain that took the message").toBeDefined();
    // It FOLDS, because it wrote mail — the half of the checkpoint gate that must never be lost.
    expect(took!.checkpoints).toBeGreaterThan(0);

    // And the write dropped the memo, so the next drain pays the full price again: it reads the
    // projection, walks every row and rebuilds the folders it derives from them.
    drains.length = 0;
    await sidecar.syncUntilQuiet();
    expect(drains.length).toBe(1);
    expect(drains[0]!.observed).toBe(0);
    expect(drains[0]!.locatorReads).toBeGreaterThan(0);
    expect(drains[0]!.locatorRows).toBeGreaterThan(0);
    expect(drains[0]!.cursorFolders).toBeGreaterThan(0);
  });

  /**
   * A WRITE FROM OUTSIDE THE DRAIN DROPS THE MEMO, INCLUDING ONE MADE WHILE A DRAIN WAS RUNNING.
   *
   * The app's own routes share this store and never touch the cycle's repo, so the classification
   * proxy cannot see them; what sees them is the change-log mark, and the mark the memo is held
   * against is the one read at the drain's START. Recording the END reading instead would fold a
   * route's write into the drain's own account and drop nothing — the case this drives, with the
   * write landing between two drains and the next drain owing a full re-read.
   */
  it("drops the memo when something outside the drain wrote", async () => {
    /* The write lands INSIDE the drain — the fake server writes it when the cycle asks it for
       changes, which is after the drain read the log and before it reads it again. That instant is
       the whole case: held against the END reading the write is invisible for ever, because the
       drain's own account has already absorbed it. */
    let write: (() => Promise<void>) | null = null;
    const { sidecar, drains } = await settled([1, 2, 3], [], async () => {
      const w = write; write = null;
      if (w) await w();
    });
    await sidecar.syncUntilQuiet();
    expect(drains[drains.length - 1]!.locatorReads).toBe(0);

    const accountId = (await sidecar.db.select({ id: mailboxes.accountId }).from(mailboxes))[0]!.id;
    // What every route does on its way out: one change row, so the window learns. In a transaction
    // because the seq allocator refuses outside one — the same door a route uses.
    write = async () => {
      await sidecar.db.transaction(async (tx) => {
        await recordChange(tx as never, {
          accountId, entityType: "message",
          entityId: "11111111-1111-4111-8111-111111111111", op: "update",
        });
      });
    };
    await sidecar.syncUntilQuiet();      // the write lands inside this one

    drains.length = 0;
    await sidecar.syncUntilQuiet();
    expect(drains.length).toBe(1);
    expect(drains[0]!.observed).toBe(0);
    expect(drains[0]!.locatorReads).toBeGreaterThan(0);
    expect(drains[0]!.locatorRows).toBeGreaterThan(0);
  });

  /**
   * AND THE RE-READ SETTLES. A memo that re-read on every cycle would pass the case above and
   * still be the defect this work is about, so the drain AFTER the re-read is asserted quiet.
   */
  it("goes quiet again once the re-read has happened", async () => {
    const pending: number[] = [];
    const { sidecar, drains } = await settled([1, 2, 3], pending);
    pending.push(5);
    await sidecar.syncUntilQuiet();     // takes it
    await sidecar.syncUntilQuiet();     // re-reads
    drains.length = 0;
    await sidecar.syncUntilQuiet();
    expect(drains.length).toBe(1);
    expect(drains[0]!.locatorReads).toBe(0);
    expect(drains[0]!.locatorRows).toBe(0);
    expect(drains[0]!.checkpoints).toBe(0);
  });

  /**
   * THE LADDER'S CLOSING READ IS ITS OWN, AND THE DRAIN'S MARK IS NOT A SUBSTITUTE FOR IT.
   *
   * An idle drain reads the same one-row aggregate over `change_log` four times: the ladder's
   * before and after, and the drain body's own start and end. The body's closing mark and the
   * ladder's look identical and the saving is obvious — and taking it is wrong, which is why
   * this test exists rather than the saving.
   *
   * `drainPass` runs the REQUEST CHANNEL after the drain body returns: the meta requests another
   * install queued, applied here. `applyScreenerDecision`, `applyMessageMove`,
   * `applyProfileUpdate` and `applyRuleRequest` all append change rows. A ladder comparing
   * against a mark taken before that channel would read "nothing happened" over a screener
   * decision it had just applied, and rest for two minutes on a mailbox that had changed — the
   * failure-looks-like-healthy shape, with the ladder reporting the quiet it caused.
   *
   * So this is a census over the span between the drain body's closing mark and the ladder's
   * read, and what it asserts is that the span is NOT INERT: the request channel is in it. If it
   * ever becomes inert the saving is available and this test should be the thing that says so.
   *
   * WATCHED FAILING: point `noteIdleOutcome` at a mark carried out of the drain body — the
   * assertion below names the channel that would be skipped over.
   */
  it("THE REQUEST CHANNEL SITS BETWEEN THE DRAIN'S MARK AND THE LADDER'S READ — a source census", () => {
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const at = (re: RegExp): number => {
      const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
      expect(hits.length, `this census cannot find ${String(re)} exactly once — it is measuring nothing`)
        .toBe(1);
      return hits[0]!;
    };
    const bodyMark = at(/^\s*const markAtEnd = await changeLogMark\(\);$/);
    // The body's own last act, in its `finally` — `return cycles;` is written three times here.
    const bodyEnds = at(/^\s*writeDrainLine\(\);$/);
    const drainReturns = at(/^\s*const cycles = await drainPass\(maxCycles\);$/);
    const laddersRead = at(/^\s*if \(opts\.force !== true\) await noteIdleOutcome\(markBefore\);$/);
    expect(bodyEnds).toBeGreaterThan(bodyMark);
    expect(laddersRead).toBeGreaterThan(drainReturns);

    /* THE CHANNEL, BY THE CALLS IT MAKES, in the region between the body's end and `drainPass`
       handing back. Read as CALLS and not as names appearing: a census satisfied by a symbol
       being present passes for a file that never invokes it. */
    const between = lines.slice(bodyEnds, drainReturns).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const channel = ["applyMetaRequests", "settleOwnOutstandingRequests", "driveOutstandingRequests"];
    const present = channel.filter((fn) => new RegExp(`\\bawait ${fn}\\(`).test(between));
    expect(
      present,
      "the request channel is no longer between the drain's closing mark and the ladder's read. "
        + "If nothing in that span can append to change_log any more, the ladder may take the "
        + "drain's mark instead of reading it again — and this test is where that is decided",
    ).toEqual(channel);

    /* …AND THE LADDER STILL READS FOR ITSELF. The census above says the span is dangerous; this
       says the code respects it. A memo carried out of the drain body reddens here. */
    const ladder = lines.slice(
      at(/^\s*const noteIdleOutcome = async \(before: string \| null\): Promise<void> => \{$/),
      at(/^\s*const quiet = before !== null && after !== null && before === after;$/),
    ).join("\n");
    expect(
      /const after = await changeLogMark\(\);/.test(ladder),
      "the idle ladder no longer takes its own closing reading — see the request channel above",
    ).toBe(true);
  });
});
