import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { flagState, folderState, messageInstances, messages, upsertDesiredSeen } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger } from "../src/log.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SYNC LOOP'S DIAGNOSTICS REACH A SINK ON THE STANDALONE DOOR
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `engine.ts` built its `syncDeps` with no `log` at all. `@trafficflow/worker/sync` writes every
 * one of its diagnostics through `log?.warn` / `log?.error`, so on this door the optional chain
 * went to `undefined` and the lines were discarded — silently, and specifically the lines that
 * report a write the MAIL SERVER did not accept: a refused `STORE`, a `STORE` whose bookkeeping
 * did not commit, a read-state intent with no locator to name.
 *
 * That matters more here than anywhere else in the product. On the hosted door a dropped line is
 * still visible in the database an operator can query; a standalone install's database is on the
 * user's own laptop and nobody reads it, so the log is the only witness there is. A person
 * reporting "I marked it read and my mailbox never saw it" left no trace at all.
 *
 * ── WHY THIS IS NOT A MOCK-LOGGER TEST ──────────────────────────────────────────────────────
 *
 * `log.ts`'s own census already records what a fake logger cannot see: a test that injects one
 * asserts what the CALL SITE hands over, never what the allowlist lets through, and this
 * repository has shipped two instrumentation regressions through exactly that gap. So the sink
 * here is the REAL `createSidecarLogger`, and the assertions read the emitted BYTES — which makes
 * this simultaneously the wiring guard and the `ALLOWED_FIELDS` guard for the sync loop's lines.
 */

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

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(stored: NativeLocator[]): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(locator: NativeLocator): Promise<void> {
      stored.push(locator);
    },
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

interface Line { level: string; event: string; [k: string]: unknown }

describe("the standalone door's sync loop can be heard", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const lines: Line[] = [];
  const stored: NativeLocator[] = [];
  afterEach(async () => {
    lines.length = 0;
    stored.length = 0;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-synclog-");
    const logger = createSidecarLogger({ sink: (l) => { lines.push(JSON.parse(l) as Line); } });
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "sync log host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(stored),
      log: () => {},
      // THE SUBJECT. Absent, and every assertion below reads an empty array.
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    return sidecar;
  }

  /**
   * A message the user has read, whose only watched copy then went away with a deleted folder.
   *
   * This is the folder-delete sweep's own end state, written directly rather than driven through
   * `applyFolderDeletion` so the test states its precondition instead of depending on another
   * pass to produce it: `native_locator` NULL, the row tombstoned, no `message_instances` row
   * left — and a `flag_state` row still `pending`, which is the part that makes it a bug. The
   * sweep deletes `folder_state` for these messages and there is no `delete(flagState)` anywhere
   * in the tree, so the read-state intent outlives the mail it was about.
   */
  async function seedReadThenSwept(sidecar: Sidecar): Promise<string> {
    const dedup = "mid:swept@synclog.test";
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: "hash-swept",
      dedupKey: dedup,
      subject: "in a folder that is gone",
      fromAddress: "someone@elsewhere.test",
      unread: true,
      nativeLocator: { folder: "INBOX/Old", ref: "1:77" },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageId: m!.id,
      folder: "INBOX/Old",
      uidvalidity: 1n,
      uid: 77,
      isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id,
      desiredFolder: "INBOX/Old",
      observedFolder: "INBOX/Old",
      lastSetBy: "external",
      reconcileStatus: "reconciled",
    });

    // The user read it while no push could run (the route's push would STORE before the sweep).
    await sidecar.db.update(messages).set({ unread: false }).where(eq(messages.id, m!.id));
    await upsertDesiredSeen(sidecar.db, m!.id, false, true, new Date());

    // …and then the folder it lived in is deleted on the server. The sweep's end state:
    await sidecar.db.update(messages)
      .set({ nativeLocator: null, deletedAt: new Date() })
      .where(eq(messages.id, m!.id));
    await sidecar.db.delete(messageInstances).where(eq(messageInstances.messageId, m!.id));
    await sidecar.db.delete(folderState).where(eq(folderState.messageId, m!.id));
    return m!.id;
  }

  it("a read-state intent the server can never be asked about is REPORTED, not dropped", async () => {
    const sidecar = await boot();
    const id = await seedReadThenSwept(sidecar);

    await sidecar.syncUntilQuiet();

    expect(stored, "there is no locator — nothing may be sent to the mail server").toEqual([]);

    const line = lines.find((l) => l.event === "reconcile_flag_no_locator");
    expect(
      line,
      "the sync loop's diagnostics are discarded on this door — `syncDeps` was built with no `log`",
    ).toBeDefined();
    expect(line!.level).toBe("warn");
    expect(line!.service).toBe("sidecar");
    expect(line!.messageId).toBe(id);
    expect(line!.mailboxId).toBe(sidecar.world.mailboxId);
    expect(line!.attempts).toBe(1);
    expect(line!.state).toBe("deferred");

    // THE BYTES, NOT THE CALL SITE. A field the census refuses is reported by NAME in
    // `droppedFields` and its value never reaches the line — which is how instrumentation has
    // gone missing here twice before, invisibly to a test that asserts what a call site handed
    // over. Nothing this line carries may be on that list.
    expect(line!.droppedFields, "the sync loop's fields did not survive `ALLOWED_FIELDS`")
      .toBeUndefined();
  });

  it("and the intent is bounded in the database, not just narrated", async () => {
    const sidecar = await boot();
    const id = await seedReadThenSwept(sidecar);

    await sidecar.syncUntilQuiet();

    const [row] = await sidecar.db.select().from(flagState).where(eq(flagState.messageId, id));
    // Still owed — a deferral is about how often we ask, never about whether we still owe it.
    expect(row!.reconcileStatus).toBe("pending");
    expect(row!.desiredSeen, "the user's intent must survive the deferral").toBe(true);
    // …and no longer due, which is the bound: before this the row was read on every cycle for the
    // rest of the mailbox's life.
    expect(row!.attempts).toBe(1);
    expect(row!.nextAttemptAt, "an unbounded skip re-reads this row for ever").not.toBeNull();
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("the same drain says nothing when there is nothing to say", async () => {
    // The counterweight. A door that logged a warn on every cycle would satisfy the two tests
    // above and be useless in production, so the quiet case is pinned beside them.
    const sidecar = await boot();
    await sidecar.syncUntilQuiet();

    expect(lines.filter((l) => l.event === "reconcile_flag_no_locator")).toEqual([]);
    expect(lines.filter((l) => l.level === "error"), JSON.stringify(lines)).toEqual([]);
  });
});
