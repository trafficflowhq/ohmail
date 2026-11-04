import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { and, asc, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { changeLog, messageInstances, messages, messageStates } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A SCHEDULED RESURFACE FIRES ON A STANDALONE INSTALL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * "Resurfaces Friday at 9" is a dated promise, printed in the UI with a real wall-clock date on
 * it, and the only thing that can keep it is a pass that notices the date has arrived and flips
 * `bubbled_up` → `resurfaced`. That pass had exactly one production caller — the hosted worker's
 * cycle — so on a STANDALONE install, which is the free tier and has no worker anywhere, the row
 * sat at `bubbled_up` for ever. Nothing failed: the schedule was written correctly, the UI
 * rendered the date correctly, and the moment simply never came.
 *
 * The repository-level guard for it is structural (`test/every-pass-has-a-producer.test.ts` now
 * names BOTH doors' callers). This file is the behavioural half: it drives the real engine and
 * asks whether the row moved.
 *
 * ── WHY PGLITE AND NOT :5433, DESPITE WHAT THE HOUSE RULE SAYS ────────────────────────────
 *
 * "PGlite green means nothing for transactional code" is a rule about the HOSTED store, where
 * PGlite is a stand-in for a Postgres nobody tested against. Here the inversion applies and it is
 * the whole point of the slice: **PGlite IS production on the desktop.** `apps/sidecar/src/db.ts`
 * opens it on disk under the user's home, this test opens the same store through the same
 * `createSidecar`, and running the claim against :5433 instead would measure a database no
 * desktop install has. The same reasoning is already written out in `sync-liveness.test.ts`.
 *
 * The one claim PGlite genuinely cannot host is the CONCURRENT one — two writers racing for the
 * same due row, where `allocateSeq`'s row lock decides whether a flip can double-emit — because
 * PGlite is single-connection and cannot express two allocators at all. That claim is not skipped
 * and is not re-stated here: `apps/worker/test/bubble-up.concurrency.pg.test.ts` proves it
 * against real Postgres on two physical connections, over THIS EXACT FUNCTION, which is the
 * reason the desktop calls the worker's pass rather than a copy of it. What is proved here is the
 * property a single-writer store CAN falsify: that a second drain over an already-flipped row
 * neither flips it again nor emits a second change.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────
 *
 * Delete the `await resurfaceDue();` line from `drain()` in `apps/sidecar/src/engine.ts`. The
 * first test goes red with the row still at `bubbled_up` and zero change-log rows; restore it and
 * it goes green. That mutation was run.
 */

/** An empty `ohmail/_meta` that accepts this install's claim — `readMailboxLease` requires one. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

/**
 * A mailbox with NOTHING IN IT, deliberately.
 *
 * The claim under test is about a row that is already in the local database and a clock that has
 * passed, and neither has anything to do with mail arriving. An empty mailbox also makes the
 * drain settle in one cycle, so "within one drain" is a statement about the pass and not about
 * how long a backlog took.
 */
const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

const HOUR = 60 * 60 * 1000;

describe("the standalone door flips a due resurface", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(): Promise<Sidecar> {
    // `realpathSync` because macOS hands out `/var/…` for a `/private/var/…` directory and PGlite
    // records the resolved path in its lock file.
    const dataDir = await freshDataDir("ohmail-resurface-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all — see the engine's
        // "NO PASSWORD, NO CONNECTION" branch, which returns before the first drain without one.
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "resurface host",
      // Long enough that the poll timer never fires: every drain in this file is one the test
      // asked for, so a flip is never a coincidence of scheduling.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    /* THIS FILE'S SUBJECT IS A DOOR THAT ORGANIZES, AND THAT IS NOW A PRECONDITION. A fresh
       mailbox comes up as a consent-less READER, and this fixture never said otherwise —
       measured, not assumed: role `reader`, consent NULL, `organizing` false on every drain
       here. While the resurface pass ran outside the organizer gate that changed no outcome,
       which is why it went unnoticed; gated, an un-consented fixture would measure a reader
       being refused rather than this door keeping its promise. The consent-less side has its
       own case in `reader-drain.test.ts`. */
    await grantOrganizeConsent(sidecar);

    // Claims the organizer lease and runs one drain over the (empty) mailbox. Everything this
    // file seeds is written AFTER it, so the flip under test is the one the explicit
    // `syncUntilQuiet()` below performs.
    await sidecar.start();
    return sidecar;
  }

  /** One message plus its triage state. Returns the `message_states.id` — the change-log entity. */
  async function seedSnooze(sidecar: Sidecar, subject: string, bubbleUpAt: Date): Promise<string> {
    const dedup = `mid:${subject}@resurface.test`;
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${subject}`,
      dedupKey: dedup,
      subject,
      fromAddress: "someone@elsewhere.test",
      nativeLocator: { folder: "INBOX", ref: `1:${subject.length}` },
    }).returning();
    /* A WATCHED INSTANCE, because the drain's sync cycle runs the mail-0065 reaper
       (`tombstoneInstanceless`): a locator-bearing message with no `message_instances` row is
       mail the server no longer holds, and the reaper tombstones it mid-test — an extra
       `message` delete change that has nothing to do with the resurface under test. */
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageId: m!.id,
      folder: "INBOX",
      uidvalidity: 1n,
      uid: subject.length,
      isPrimary: true,
    });
    const [st] = await sidecar.db.insert(messageStates).values({
      accountId: sidecar.world.accountId,
      messageId: m!.id,
      state: "bubbled_up",
      bubbleUpAt,
    }).returning();
    return st!.id;
  }

  const stateOf = async (sidecar: Sidecar, id: string) => {
    const [row] = await sidecar.db.select().from(messageStates).where(eq(messageStates.id, id));
    return row!;
  };

  const changesFor = async (sidecar: Sidecar, id: string) =>
    sidecar.db.select().from(changeLog)
      .where(and(
        eq(changeLog.accountId, sidecar.world.accountId),
        eq(changeLog.entityId, id),
      ))
      .orderBy(asc(changeLog.seq));

  it("a due row is resurfaced within one drain, and a not-due row is left alone", async () => {
    const sidecar = await boot();
    const due = await seedSnooze(sidecar, "due", new Date(Date.now() - HOUR));
    const notDue = await seedSnooze(sidecar, "later", new Date(Date.now() + 24 * HOUR));

    await sidecar.syncUntilQuiet();

    const flipped = await stateOf(sidecar, due);
    expect(flipped.state, "a due bubbled_up row did not resurface — the promise the UI printed " +
      "with a real date on it is still unkept on this door").toBe("resurfaced");
    /* The schedule is SPENT. A `resurfaced` row still carrying its timestamp reads as "still
       scheduled" to anything that looks at the column, including the pass itself on the next
       drain, which is where a re-flip would come from. */
    expect(flipped.bubbleUpAt).toBeNull();

    // …and exactly one change, so the client's own `/sync` over this local change_log advances
    // once. The desktop window projects from this table; a flip nobody recorded is invisible.
    const changes = await changesFor(sidecar, due);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.entityType).toBe("message_state");
    expect(changes[0]!.op).toBe("update");

    /* ── THE MESSAGE PROJECTION, ON THIS DOOR TOO ──────────────────────────────────────────
     *
     * The pass emits `message_state` AND `message`, because the window pins on
     * `message.triage.state` and the client joins nothing. The delta contract for that is proved
     * end-to-end in `packages/client-engine/test/contract.test.ts`; what is asserted HERE is the
     * half that is specific to this door — that the local change_log the desktop window reads
     * carries both rows, for the message the drain actually flipped. A desktop-only regression
     * would otherwise be invisible to a contract test that runs against the hosted API. */
    const [msgRow] = await sidecar.db.select().from(messageStates).where(eq(messageStates.id, due));
    const projection = await changesFor(sidecar, msgRow!.messageId);
    expect(projection).toHaveLength(1);
    expect(projection[0]!.entityType).toBe("message");
    expect(projection[0]!.op).toBe("update");
    // The state lands first, so a window applying in seq order never reads the projection before
    // the row it projects.
    expect(projection[0]!.seq > changes[0]!.seq).toBe(true);

    // THE OTHER HALF, and the one that fails if the pass ever drops its `bubbleUpAt <= now`
    // clause: a resurface scheduled for tomorrow is not due today.
    const untouched = await stateOf(sidecar, notDue);
    expect(untouched.state).toBe("bubbled_up");
    expect(untouched.bubbleUpAt).not.toBeNull();
    expect(await changesFor(sidecar, notDue)).toHaveLength(0);
  }, 60_000);

  it("a second drain neither flips it again nor emits a second change", async () => {
    const sidecar = await boot();
    const due = await seedSnooze(sidecar, "twice", new Date(Date.now() - HOUR));

    await sidecar.syncUntilQuiet();
    const first = await stateOf(sidecar, due);
    expect(first.state).toBe("resurfaced");
    const afterOne = await changesFor(sidecar, due);
    expect(afterOne).toHaveLength(1);

    /* Two more drains over the same rows. The pass re-asserts `state='bubbled_up'` inside the
       UPDATE, so a row that has already moved matches zero rows and no change is recorded — which
       is the property that makes it safe for this pass to run on every poll for the life of the
       process. Without it a resurfaced row would be re-announced to the client on every cycle,
       and the item would keep jumping back to the top of the Ohbox after the user dismissed it. */
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();

    const after = await stateOf(sidecar, due);
    expect(after.state).toBe("resurfaced");
    expect(after.bubbleUpAt).toBeNull();
    // The SEQ too, not just the count: an identical row appended twice would still be one entity
    // with two announcements.
    const afterThree = await changesFor(sidecar, due);
    expect(afterThree).toHaveLength(1);
    expect(afterThree[0]!.seq).toBe(afterOne[0]!.seq);
  }, 60_000);
});
