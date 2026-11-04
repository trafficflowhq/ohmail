import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import type {
  ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core/mail";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { IngestPlans } from "../src/pglite-plans.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ WHAT A DRAIN OVER A MAILBOX NOBODY WROTE TO COSTS THE STORE ════════════════════════════
 *
 * `IDLE-DRAIN-COST-IS-STILL-THE-WHOLE-PASS`: an empty drain does the whole pass — the lease
 * read, the resurface, the appointment and away passes, the send reconcile, a cursor over every
 * folder, the suggest pass and a checkpoint. Resting behind the idle ladder divides that by
 * eight; it does not make it cheap. This is the number, so a pass added to the tail is visible
 * before a release rather than after one.
 *
 * It is a RATCHET and it may only FALL. Every statement here is paid on every poll of every
 * settled mailbox for as long as the app is open — at the landed two-minute ceiling that is
 * thirty a hour, for ever, on a machine whose owner is doing something else.
 *
 * ── THE NUMBER, AND WHERE IT GOES ───────────────────────────────────────────────────────────
 *
 * Measured on `apps/sidecar/test/rigs/heartbeat-passes-rig.mjs`, which records every statement
 * WITH THE FRAME OF OUR OWN SOURCE THAT ASKED FOR IT — the pass a statement belongs to is not
 * readable from its SQL, and two passes read the same table. The twelve are: the ladder's
 * opening mark, the lease and role read, the resurface's due query, a transaction, the screening
 * settings, the drain's own opening mark, the dead letters, the folder cursor, a transaction,
 * the flag reconcile, the sync stamp and the drain's closing mark.
 *
 * ── WHY A COUNT AND NOT A DURATION ──────────────────────────────────────────────────────────
 *
 * A duration here is this machine's, and a CI box would have to be given a slack that hides the
 * regression. A statement is a statement on every host, and on the hosted door each one is a
 * network round trip — which is the arithmetic `ingest-round-trips.test.ts` is built on and the
 * reason that file counts rather than times.
 *
 * ── THE FIXTURE IS PRODUCTION'S SHAPE ───────────────────────────────────────────────────────
 *
 * The adapter advertises `move`, `uidplus`, `condstore` and `specialUse`, so the passes take the
 * branches the shipped engine takes rather than a degraded fixture's. A ratchet measured against
 * a fixture that cannot do what production does pins the fixture (CLAUDE.md, and the round-trip
 * ratchet's own scar: a fixture with no `moveMany` pinned one question per message where
 * production batches fifty).
 */

/**
 * `ohmail/_meta` in memory, empty at the start — nobody has organized this mailbox yet.
 *
 * IT REMEMBERS WHAT IT WAS GIVEN, and that is load-bearing rather than tidiness: a lease folder
 * that accepts a claim and cannot hand it back reads as `own_claim_missing` on the very next
 * poll, the install never becomes the organizer, and every drain returns zero cycles — a
 * ratchet standing over a drain that never happened. It was written that way first and the
 * positive controls below are what caught it.
 */
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

function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <ratchet-${uid}@stranger.test>`,
    "From: A Stranger <stranger@nowhere.test>",
    "To: Owner <owner@trafficflow.test>",
    `Subject: ratchet ${uid}`,
    "Date: Tue, 16 Sep 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

function mailbox(first: number[]): (cfg: ImapConfig) => MailboxAdapter {
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
      const give = handed ? [] : (handed = true, first);
      return {
        creates: give.map((uid) => ({
          type: "create" as const,
          locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
          raw: arrival(uid),
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
      };
    },
  } as unknown as MailboxAdapter);
}

/**
 * THE INSTRUMENT, on the PROTOTYPE, so every handle this process opens is covered including the
 * one `openLocalDb` keeps to itself. A transaction counts as ONE — drizzle drives the
 * transaction's own handle for the statements inside it, and what this file is about is what the
 * drain asks the store for, of which a transaction is one ask with its own round trip.
 */
function statementCounter(): { on: () => void; off: () => string[] } {
  let counting = false;
  let seen: string[] = [];
  let inTx = 0;
  const shape = (sql: unknown): string =>
    String(typeof sql === "string" ? sql : JSON.stringify(sql)).replace(/\s+/g, " ").slice(0, 100);
  /* THE STORE'S OWN DOOR (IDLE-DRAIN-RATCHET-BLIND-TO-THE-STORE-DOOR): the ingest lane's parameterised
     statements leave through `IngestPlans.run` over `execProtocol`, never PGlite's `query`, so the
     pending-folder, special-folder and failure reads were never counted. Each is one statement here,
     outside a transaction; inside one the transaction is the ask, as before. */
  const doors: Array<[Record<string, (...a: unknown[]) => Promise<unknown>>, string]> = [
    [PGlite.prototype as never, "query"], [PGlite.prototype as never, "exec"], [PGlite.prototype as never, "transaction"],
    [IngestPlans.prototype as never, "run"],
  ];
  for (const [proto, name] of doors) {
    const original = proto[name]!;
    if ((original as unknown as { __ratchet?: boolean }).__ratchet) continue;
    const wrapped = async function counted(this: unknown, ...args: unknown[]): Promise<unknown> {
      if (counting && name === "transaction") seen.push("BEGIN..COMMIT");
      else if (counting && !(name === "run" && inTx > 0)) seen.push(shape(args[0]));
      if (name !== "transaction") return original.apply(this, args);
      inTx += 1;
      try { return await original.apply(this, args); } finally { inTx -= 1; }
    };
    (wrapped as unknown as { __ratchet: boolean }).__ratchet = true;
    proto[name] = wrapped as never;
  }
  return { on: () => { counting = true; seen = []; }, off: () => { counting = false; return seen; } };
}

const probe = statementCounter();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function settled(seed: number[]): Promise<{ sidecar: Sidecar; drains: unknown[] }> {
  const drains: unknown[] = [];
  const dataDir = await freshDataDir("ohmail-ratchet-");
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
    },
    address: "owner@trafficflow.test",
    machineName: "ratchet host",
    // An hour, so every drain below is one this file asked for and never the poll timer's.
    pollIntervalMs: 60 * 60 * 1000,
    adapterFactory: mailbox(seed),
    log: (event, detail) => { if (event === "sync_drain") drains.push(detail); },
  });
  cleanups.push(async () => {
    await sidecar.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  await sidecar.start();
  /* TWO DRAINS TO SETTLE, and the second is not bookkeeping: the cursor is built before the
     cycle ingests, so the drain that TAKES mail still owes the next one a re-read. "Idle" is the
     drain after a drain that changed nothing. */
  await sidecar.syncUntilQuiet();
  await sidecar.syncUntilQuiet();
  drains.length = 0;
  return { sidecar, drains };
}

/**
 * The ratchet. It may FALL with a measurement beside it; it may not rise.
 *
 * TWENTY-THREE, and what they are, in the order the drain asks them: the ladder's opening mark ·
 * the lease and role read · the resurface's due query · a transaction · the away responder's two
 * expiry writes and its body read · a transaction · the screening settings · the drain's own
 * opening mark · the dead letters · the folder-ops queue · the junk-rescue queue · the folder
 * cursor · a transaction · the filing reconcile's folder state · the junk and trash folder names ·
 * the flag reconcile · the sync stamp · the drain's closing mark · the ladder's closing mark ·
 * two transactions.
 *
 * 22 → 23 with the junk-rescue queue (mail 0115), MEASURED here and paid deliberately. The read is
 * one indexed statement per cycle over the mailbox's DUE pending rescues, and it is the price of
 * the pass being repo-driven rather than gated behind a stamp: a gate is what makes a queued
 * command undrained on exactly the doors this file measures, which is the defect the lane closed.
 * `folder_ops` pays the same statement on the line above for the same reason.
 *
 * THE LAST TWO MARKS LOOK LIKE ONE READING AND ARE NOT: the request channel runs between them,
 * and it applies other installs' screener decisions, moves, profile edits and rules — all of
 * which append change rows. `idle-drain-is-a-comparison.test.ts` holds that span.
 *
 * THE RIG READS THIRTEEN FOR THE SAME CODE, and the difference is the fixture rather than the
 * build: `heartbeat-passes-rig.mjs` stands up a world with no away responder row and nothing in
 * the folder-ops queue, so three of the passes above return before their first statement. Two
 * fixtures, two numbers, and neither is "the" production shape — what a ratchet needs is ONE
 * fixture held still, so a pass added to the tail shows up as a number that moved.
 */
/*
 * 23 → 27 WITH THE STORE'S OWN DOOR COUNTED (IDLE-DRAIN-RATCHET-BLIND-TO-THE-STORE-DOOR), and the
 * product did not move: this file read 18 at that base because the ingest lane's statements
 * (IngestPlans over `execProtocol`) never reached PGlite's `query`. Counted at that door the same
 * drain reads 27, among them the dead letters' two reads, the pending folder states and the special
 * folder names. The count above is what the old instrument could see, kept for its history.
 */
const CEILING = 27;

describe("what an idle drain asks the store", () => {
  it(`costs at most ${CEILING} statements on a settled mailbox`, async () => {
    const { sidecar, drains } = await settled([1, 2, 3]);

    probe.on();
    const cycles = await sidecar.syncUntilQuiet();
    const asked = probe.off();
    const statements = asked.length;

    /* THE POSITIVE CONTROLS FIRST. A drain that did not run costs nothing and would pass any
       ceiling; a drain that found work is not the subject. Both are read off the engine's own
       line rather than inferred. */
    expect(cycles, "no cycle ran — this ceiling would pass for a drain that never happened").toBe(1);
    expect(drains, "the drain wrote no summary line, so nothing here describes a drain").toHaveLength(1);
    const d = drains[0] as { observed: number; locatorReads: number; checkpoints: number };
    expect(d.observed, "the drain found mail — that is not an idle drain").toBe(0);
    expect(d.locatorReads, "the drain re-read the known set — it is not settled yet").toBe(0);
    expect(d.checkpoints, "a settled drain folded the log; the tail wrote something").toBe(0);
    expect(asked.filter((s) => s.includes('from "message_failures"')).length,
      "the dead-letter reads leave through the store's plan door; a counter that does not see them sees PGlite alone")
      .toBeGreaterThan(0);

    /* THE LIST, NOT JUST THE NUMBER. A ceiling that reddens with a count alone sends the next
       person back to a rig to find out WHICH statement appeared; this prints what it counted. */
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ idleDrainStatements: statements, ceiling: CEILING, asked }, null, 1));
    expect(
      statements,
      `an idle drain now asks the store ${statements} times, over the ${CEILING} this ratchet `
        + "holds. Every one is paid on every poll of every settled mailbox for as long as the app "
        + "is open; if the pass is worth it, move the ceiling here with the measurement beside it",
    ).toBeLessThanOrEqual(CEILING);
  }, 120_000);
});
