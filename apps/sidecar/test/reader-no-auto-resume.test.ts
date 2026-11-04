import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq, isNull, sql } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim, LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import {
  drafts, folderState, mailboxes, messages, organizerRequests, outboundSends, threads,
  RELEASED_ORGANIZER_SEND_SENTENCE, STAND_DOWN_SEND_SENTENCES,
} from "@trafficflow/db";
import { ScheduleService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A READER DOES NOT TAKE THE MAILBOX BACK BY ITSELF — the memory, across a POLL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"Ceasing to organize is automatic; becoming an organizer never is."* The lease alone cannot
 * hold that line: once the other organizer releases, `ohmail/_meta` is EMPTY, and an empty folder
 * correctly reads as "nobody has ever organized this mailbox" — `decideLease`'s first arm, which
 * organizes. The row is the memory the mailbox cannot hold.
 *
 * ── WHY THIS FILE EXISTS BESIDE THE RELAUNCH TEST THAT ALREADY ASSERTS IT ────────────────
 *
 * The relaunch case has been guarded since the beginning, and it was ENOUGH while a demoted
 * install stopped: the poll timer was cleared and the login closed, so the only reader of that
 * memory was the next process, and the next process read the ROW. A demoted install is now a
 * READER — connected, poll timer running, mirror growing — and that puts a second reader of the
 * same memory inside one process, on a path nothing was asserting:
 *
 *   the gate stands down mid-life          → the row says `reader`
 *   the other organizer releases its claim → `ohmail/_meta` is empty
 *   the poll timer fires a minute later    → the gate reads the lease again
 *
 * The value it consults there was computed ONCE at assembly, before the stand-down existed, so it
 * was null and the gate organized. No relaunch, no human, nothing on the row to explain it: a
 * machine somebody left running takes back a mailbox they deliberately moved.
 *
 * ── AND THE APPOINTMENT RIDES ALONG, WHICH IS WHY THE DRAFT IS HERE ─────────────────────
 *
 * A silent re-promotion is also the double-send shape. The stand-down closes the pending
 * appointment with a sentence and clears `send_at`/`send_key` precisely so neither side can find
 * it again; an install that quietly became the organizer again would be the side that goes
 * looking. The draft in this test is checked after every transition, and the mailbox's `send`
 * throws, so an attempt would be recorded rather than pass silently.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────
 *
 * Delete `priorStandDown = outcome.reason;` from the stand-down arm of `mayOrganize`
 * (`apps/sidecar/src/engine.ts`) and the first test goes red on the poll after the release, on
 * `organizerState().organizing` — *"a poll took the mailbox back with nobody having asked for
 * it"*. It stops there, so the row and the claim assertions below it are unobserved in that run;
 * the ROW would in fact still say `reader`, because this engine writes the role only in the arm
 * that spends a takeover stamp, and an auto-resume spends none. That combination — organizing a
 * mailbox the row says is somebody else's — is the same disagreement the hosted gate had, and
 * the reason it cannot happen here is this memory rather than a second write. Delete
 * `priorStandDown = null;` from the organize arm and the SECOND test goes red instead, on the
 * RENEWAL COUNT — and that symptom is worth naming because it is not the one that looks obvious.
 * The gate returns at the memory before it touches `organizer`, so nothing visibly demotes:
 * `organizerState()` still says organizing, the row still says `organizer`, and the drain still
 * runs as an organizer. What silently stops is the LEASE READ, and renewing the claim is what
 * that read does — so the install goes on organizing while its claim in `ohmail/_meta` ages out,
 * and one stale window later another install is entitled to take the mailbox from under it.
 * Both mutations were run.
 */

/** An in-memory `ohmail/_meta`, writable by the test so a claim can arrive and leave mid-life. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /**
   * MAKE EVERY READ OF THIS FOLDER FAIL, the way the server fails.
   *
   * `LeaseUnavailableError` with `op: "list_claims"` is exactly what `makeLeasePeekIo` throws when
   * the FETCH is refused. A bare `Error` here would be a different fault from production's and the
   * catch under test branches on nothing else, so the arm would be measured against a fixture.
   */
  unreadable = false;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    if (this.unreadable) {
      throw new LeaseUnavailableError(
        "ohmail/_meta could not be read", { op: "list_claims" },
      );
    }
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
  /**
   * EVERY RECORD IN THE FOLDER BEARING THIS INSTALL ID, asked of the SERVER — what a RELEASE reads.
   *
   * Present because `makeLeaseIo` defines it, which makes it the only shape production has. A
   * double without it is not a smaller server, it is a different one: `releaseMailboxClaim`
   * answers "the records this install owns could not be enumerated" and throws, so the release
   * this file measures never happens and the claim it asserts gone is still standing. The
   * argument in full is beside the same method in `standalone-consent-and-removal.test.ts`.
   *
   * Matched on the HEADER, as the server matches it, and returned UNPARSED: these are CANDIDATES
   * and not claims, since a settings document in the same folder carries the same header.
   */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  /** Cloud arrives and takes the mailbox. */
  async seedCloudClaim(): Promise<void> {
    await this.appendClaim(formatClaim({
      /* ── THE HANDOVER CARRIES A PRESS (0.14.1) ────────────────────────────────────────
       *
       * `claimedAt: new Date()` makes this claim NEWER than the one this install already holds,
       * and kind stopped ranking in 0.14.1 — so on incumbency alone the incumbent keeps the
       * mailbox and this fixture would model "a cloud install arrived and lost", which is the
       * correct answer to the folder it describes and is not the scenario the cases below are
       * about.
       *
       * A cloud install that TAKES a mailbox from a live local organizer does it exactly one
       * way: somebody pressed "Organize here" on the web, `organizeHere` stamped the row, and the
       * gate wrote that instant onto the claim. So the fixture writes what the product writes.
       */
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "handover",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));
  }
  /** Everything is released — the state an empty folder describes, and the one that organizes. */
  clear(): void {
    this.claims.length = 0;
  }
  get count(): number {
    return this.claims.length;
  }
  /**
   * How many claims have EVER been appended. Renewing is append-then-expunge (IMAP has no
   * in-place update), so this counts renewals where {@link count} counts occupancy — and it is
   * the only way from outside to see whether the gate consulted the lease at all on a given pass.
   */
  get appends(): number {
    return this.nextUid - 1;
  }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** A quiet mailbox whose SEND throws, so a send attempt is an assertion rather than a hope. */
function quietMailbox(meta: MemoryMetaFolder) {
  const sends: OutboundMessage[] = [];
  /**
   * HOW MANY TIMES THE `ohmail/*` TREE WAS CREATED (mail 0088).
   *
   * The claim count says whether this install took the LEASE; this says whether it acted like an
   * organizer against the mailbox itself. They are two different writes and a fix for one does not
   * imply the other — a gate that returned `false` while something downstream still called
   * `ensureFolders` would leave six folders in a stranger's mailbox with no claim to explain them.
   */
  const folderBuilds = { count: 0 };
  /**
   * EVERY IMAP MOVE THIS INSTALL ASKED FOR — the verb a reader's drain may not use at all, and
   * the only one a pass's ROLE decides on its own. `ensureFolders` is spent after the first
   * organizing pass and a send needs an appointment; this is what a later pass can still be
   * watched doing.
   */
  const moves: NativeLocator[] = [];
  const factory = (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    /**
     * THE APPEND-LESS READ (mail 0088). Without it the engine's peek arm is skipped entirely —
     * `notePeekedHolder` returns at `typeof peekIo !== "function"` — and the holder columns this
     * file now asserts on would keep whatever the stand-down last wrote, for the wrong reason.
     *
     * It is the SAME folder object with one method exposed, which is exactly the production shape:
     * `ImapAdapter.leasePeekIo()` is a narrowing of the same connection, and the narrowness is the
     * enforcement rather than a convention.
     */
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> { folderBuilds.count += 1; },
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    /* Answers WHERE THE MESSAGE LANDED, as the real adapter does. Handing the source locator back
       made every completion's write fail, so a filed row stayed pending and due, and a drain whose
       first cycle files before its walk filed it a second time in the same cycle. */
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      moves.push(locator);
      return { folder: toFolder, ref: `1:${900 + moves.length}` };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(m: OutboundMessage): Promise<SendResult> {
      sends.push(m);
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
  return { factory, sends, folderBuilds, moves };
}

const HOUR = 60 * 60 * 1000;
const schedules = new ScheduleService();

describe("a reader does not resume organizing on its own", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-noresume-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function boot(
    dir: string, sends: ReturnType<typeof quietMailbox>,
    /** Every line this launch writes, for the case whose subject IS the boot's own record. */
    onLog?: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine somebody left running",
      // Long enough that the timer never fires on its own: every poll here is one the test asked
      // for, so a failure is a decision and never a race.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: sends.factory,
      log: (event, detail) => { onLog?.(event, (detail ?? {}) as Record<string, unknown>); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    /* -- THIS FILE IS ABOUT AN INSTALL THAT WAS ASKED TO ORGANIZE ---------------------------
     *
     * A fresh mailbox is created as a consent-less READER now: the standalone door builds the
     * mirror and re-arranges nothing until somebody presses "Agree and start organizing"
     * (`identity.ts#ensureLocalWorld`, and the gate's consent arm in `engine.ts`). Every case
     * below is about a transition FROM organizing — standing down, being taken over, keeping or
     * losing an appointment — so "somebody agreed" is this file's precondition and not part of
     * what it tests. Written here rather than through the consent route because the route is
     * another file's subject; the column is the fact the gate reads.
     *
     * Without it the engine never reaches the lease at all, and these cases go red in the shape
     * that hides the cause: `organizing` is false, which is what several of them assert, but for
     * the wrong reason and with `ohmail/_meta` never read.     *
     * BOTH COLUMNS, because they are two different readers. The engine's gate reads the CONSENT
     * (may this install organize at all); `assertOrganizerRole` — which every service write door
     * consults, `ScheduleService` included — reads the ROLE. In the real flow the consent route
     * writes the stamp and the pass that spends it writes the role, so an install that has been
     * organizing for a while carries both; setting only one produces a state the product never
     * reaches, and the refusal it earns ("another install is organizing this mailbox…") names a
     * holder that does not exist. */
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      /* ONLY ON A FRESH STORE. Several cases here boot a SECOND install over a data directory the
         first one already stood down in, and that row's `reader` IS the fact under test — the
         memory that stops a relaunch auto-resuming a mailbox somebody moved. An unconditional
         write would erase it and the case would pass for the wrong reason. A NULL consent stamp is
         exactly "this store has no history", because every path that gives it one also gives it
         a role. */
      .where(isNull(mailboxes.organizeConsentedAt));
    return sidecar;
  }

  async function scheduleOne(sidecar: Sidecar): Promise<string> {
    const [d] = await sidecar.db.insert(drafts).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      subject: "the appointment",
      body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "draft",
    }).returning();
    const ctx: ServiceContext = {
      db: sidecar.db as never, accountId: sidecar.world.accountId, userId: null,
      now: () => new Date(), requestId: "test",
    };
    await schedules.schedule(ctx, d!.id, new Date(Date.now() + 2 * HOUR).toISOString());
    return d!.id;
  }

  const draftRow = async (sidecar: Sidecar, id: string) => {
    const [row] = await sidecar.db.select().from(drafts).where(eq(drafts.id, id));
    return row!;
  };
  const mailboxRow = async (sidecar: Sidecar) => {
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    return row!;
  };

  /**
   * One message this install has decided to file and has not filed yet — `desired != observed`,
   * `last_set_by: 'us'`, a locator to move from. Written the way a door writes it: the desire
   * only, the observation kept.
   */
  async function seedPendingMove(sidecar: Sidecar): Promise<void> {
    const [th] = await sidecar.db.insert(threads)
      .values({ accountId: sidecar.world.accountId, subject: "s" }).returning();
    const dedupKey = "ff00ee11dd22cc33";
    const [msg] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, threadId: th!.id,
      dedupKey, messageIdHeader: `<${dedupKey}@example.invalid>`, bodyHash: "b",
      nativeLocator: { folder: "INBOX", uidvalidity: "1", uid: 7 },
    }).returning();
    await sidecar.db.insert(folderState).values({
      messageId: msg!.id, desiredFolder: "ohmail/News", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });
  }

  it("THE POLL AFTER THE RELEASE — an empty lease folder does not hand the mailbox back", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    expect(sidecar.organizerState().organizing).toBe(true);

    const draftId = await scheduleOne(sidecar);
    expect((await draftRow(sidecar, draftId)).status).toBe("scheduled");

    // ── THE HANDOVER, MID-LIFE ────────────────────────────────────────────────────────────
    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");
    // The appointment is over, honestly, and its handles are gone — so neither side can find it.
    const closed = await draftRow(sidecar, draftId);
    expect(closed.status).toBe("draft");
    expect(closed.sendAt).toBeNull();
    expect(closed.sendKey).toBeNull();
    expect(closed.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);

    // ── THE OTHER ORGANIZER RELEASES, AND THE PROCESS IS STILL RUNNING ────────────────────
    //
    // This is the whole scenario. The folder is now empty, which is the ONE state `decideLease`
    // organizes on without any explicit action, and the poll timer is what reaches it.
    meta.clear();
    expect(meta.count).toBe(0);
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();

    expect(sidecar.organizerState().organizing,
      "a poll took the mailbox back with nobody having asked for it").toBe(false);
    const row = await mailboxRow(sidecar);
    expect(row.organizerRole, "the row was promoted by a poll, not by a person").toBe("reader");
    // NOTHING WAS APPENDED EITHER. Organizing is not only a row: it writes a claim into the
    // user's own mailbox, and a claim this install had no right to make outlives the process.
    expect(meta.count, "this install appended a claim to a mailbox it had stood down from").toBe(0);

    // The appointment is still closed, and no send was attempted on any of these passes.
    const after = await draftRow(sidecar, draftId);
    expect(after.status).toBe("draft");
    expect(after.sendAt, "a silent re-promotion re-armed a closed appointment").toBeNull();
    expect(after.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);
    expect(mailbox.sends).toHaveLength(0);
    expect(await sidecar.db.select().from(outboundSends)).toHaveLength(0);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  N CYCLES OVER AN EMPTY FOLDER — the standalone twin of the hosted gate fix (mail 0088)
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The first case above proves the mailbox is not handed back on the poll AFTER a release. This
   * proves the same thing about the poll after that, and the one after that — and it proves the
   * other half a claim count cannot reach: the `ohmail/*` TREE is never built either.
   *
   * Both hosts carry this case in the same shape, deliberately. The rule is one rule and it was
   * implemented on one door: the hosted worker ran the WRITE gate for a consented reader on every
   * cycle and arm 4 promoted it against an empty folder. A rule two doors are supposed to share is
   * worth nothing if only one of them is tested for it, which is how that hole survived.
   *
   * HOW TO WATCH IT FAIL: replace the `rowRole === "reader" && !takeoverAuthorized` arm in
   * `mayOrganize` (`apps/sidecar/src/engine.ts`) with the RAM-based `priorStandDown` test it
   * replaced, then boot a SECOND install over the same data directory — the RAM value starts null,
   * the gate reads the lease, and the empty folder promotes. Run, not assumed.
   */
  it("N CYCLES over an empty folder: no claim, and the ohmail/* tree is never built", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    expect(sidecar.organizerState().organizing).toBe(true);

    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing).toBe(false);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");

    // The other organizer releases cleanly. This is the state arm 4 answers `organize` on.
    meta.clear();
    const buildsAtHandover = mailbox.folderBuilds.count;

    for (let i = 0; i < 6; i++) await sidecar.syncUntilQuiet();

    expect(meta.count, "a reader claimed a mailbox nobody asked it to organize").toBe(0);
    expect(mailbox.folderBuilds.count,
      "a reader created the ohmail/* tree in a mailbox it does not organize")
      .toBe(buildsAtHandover);
    expect(sidecar.organizerState().organizing, "six polls promoted a reader").toBe(false);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE DEMOTION AND ITS HANDOVER ARE ONE TRANSACTION HERE TOO — the sidecar's half
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Three statements used to run in a row in the stand-down arm: the handover of pending local
   * moves (in its own transaction, its failure swallowed), the in-memory latch, and the row write.
   * So a handover that could not be written left a demotion recorded anyway — and the latch with
   * it, which is the part that makes it permanent: `priorStandDown` gates the export ON THE
   * TRANSITION, so the next cycle skipped the handover for ever. Every move recorded in the
   * takeover window stayed on a reader that may not perform it, in front of the one install that
   * could, with nothing failing anywhere.
   *
   * THE FAULT IS THE DATABASE REFUSING THE WRITE, which is how production fails here — a lock
   * timeout, a disk error, a relation that is not there. The table is renamed away and back, so
   * the error arrives out of `db.transaction` exactly as a real one would rather than as a stub
   * throwing a class the catch was written for.
   *
   * The SECOND cycle is the assertion that matters: it can only export if the latch was never
   * set, which is the difference between "this failure costs a cycle" and "this failure costs
   * every pending move".
   */
  it("a handover the store REFUSES leaves no demotion and no latch — the next cycle does both", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    expect(sidecar.organizerState().organizing).toBe(true);

    /* THE INTENT THE WINDOW PRODUCES: a paired device's forwarded move, recorded here while the
       row still said `organizer`. Written as the door writes it — desired only, observed kept. */
    const [th] = await sidecar.db.insert(threads)
      .values({ accountId: sidecar.world.accountId, subject: "s" }).returning();
    const dedupKey = "aa11bb22cc33dd44";
    const [msg] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, threadId: th!.id,
      dedupKey, messageIdHeader: `<${dedupKey}@example.invalid>`, bodyHash: "b",
      nativeLocator: { folder: "INBOX", uidvalidity: "1", uid: 7 },
    }).returning();
    await sidecar.db.insert(folderState).values({
      messageId: msg!.id, desiredFolder: "ohmail/News", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });

    // The store refuses the handover's write, and the demotion rides the same transaction.
    await sidecar.db.execute(sql`alter table organizer_requests rename to organizer_requests_parked`);
    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();

    expect((await mailboxRow(sidecar)).organizerRole,
      "the demotion was recorded with its handover missing").toBe("organizer");

    // …and the table comes back, as a lock that cleared or a disk that recovered.
    await sidecar.db.execute(sql`alter table organizer_requests_parked rename to organizer_requests`);
    await sidecar.syncUntilQuiet();

    expect((await mailboxRow(sidecar)).organizerRole, "the retry did not demote").toBe("reader");
    const handed = await sidecar.db.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, sidecar.world.mailboxId));
    expect(handed, "the latch stood, so the intent was never handed over").toHaveLength(1);
    expect(handed[0]!.payload).toEqual({ dedupKey, destination: "reads" });
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A DEMOTED READER KEEPS LOOKING — the peek the RAM arm used to skip (mail 0088)
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The arm this replaces read a value in RAM and returned. It never looked at the folder, so a
   * demoted install's holder columns FROZE at the instant of the handover: the pane named whoever
   * had taken the mailbox for ever, and a SECOND handover — the mailbox moving on to a third
   * machine — was invisible on this install indefinitely.
   *
   * Nothing failed and nothing was wrong on screen at the instant it froze, which is why it needed
   * a test rather than a reading: the row said something true once and then went on saying it.
   */
  it("a demoted reader's holder columns follow a SECOND handover", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();

    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect((await mailboxRow(sidecar)).organizedByName).toBe("ohmail Cloud");
    expect((await mailboxRow(sidecar)).organizerState).toBe("held");

    // The mailbox moves on to a third machine while this install reads it.
    const appendsBefore = meta.appends;
    meta.clear();
    await meta.appendClaim(formatClaim({
      authorizedAt: new Date(), capabilities: ["requests"],
      installId: "the-other-laptop", kind: "local", displayName: "The Kitchen iMac",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "second-handover",
    }));
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.organizedByName, "the pane still names the install that no longer holds the mailbox")
      .toBe("The Kitchen iMac");
    expect(row.organizedByKind).toBe("local");
    expect(row.organizerState).toBe("held");
    /* …AND IT STILL DID NOT CLAIM ANYTHING WHILE LOOKING. The peek's IO has one method and no way
       to write, so the only append after the handover is the FIXTURE'S own — measured as a delta
       rather than a total, because the total also counts this install's own claim from before it
       was demoted and the first handover's. */
    expect(meta.appends - appendsBefore,
      "the peek appended to ohmail/_meta — a reader claimed a mailbox it only reads").toBe(1);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  "STOP ORGANIZING THIS MAILBOX, KEEP MY MAIL" — the standalone door (mail 0088)
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The same four properties the hosted twin asserts, and the fourth is the one that belongs in
   * THIS file: the release ends with an empty folder and a consented reader, which is precisely
   * the shape that used to organize — so a release without the gate arm above is a control that
   * undoes itself on its own next poll.
   *
   * The appointment is here for the reason every case in this file carries one: a silent
   * re-promotion is also the double-send shape, and the mailbox's `send` throws, so an attempt is
   * an assertion rather than a hope. Its sentence is the RELEASE's — nobody took this mailbox, so
   * "schedule it again where the mailbox is organized now" would name a place that does not exist.
   */
  it("a RELEASE gives the mailbox up, closes the appointment honestly, and nothing takes it back", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    expect(sidecar.organizerState().organizing).toBe(true);
    expect(meta.count, "the install never claimed, so there is nothing to release").toBe(1);

    const draftId = await scheduleOne(sidecar);
    expect((await draftRow(sidecar, draftId)).status).toBe("scheduled");

    // ── THE PRESS ─────────────────────────────────────────────────────────────────────────
    // One column, written the way the local route writes it: no role change, no IMAP.
    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));

    await sidecar.syncUntilQuiet();

    expect(sidecar.organizerState().organizing, "the release was not honoured").toBe(false);
    const row = await mailboxRow(sidecar);
    expect(row.organizerRole).toBe("reader");
    // NOBODY WON IT. A stand-down names the winner; a release has none to name.
    expect(row.organizedByKind).toBeNull();
    expect(row.organizedByName).toBeNull();
    expect(row.organizerState).toBeNull();
    // Spent, so a later "Organize here" is not answered by this request instead.
    expect(row.releaseRequestedAt).toBeNull();
    expect(row.takeoverAuthorizedAt).toBeNull();
    // The mailbox is in perfect health and still connected — the whole product difference between
    // releasing and removing.
    expect(row.status).toBe("connected");
    expect(row.organizeConsentedAt).not.toBeNull();
    expect(row.organizerEventAt, "the release did not stamp the organizing event").not.toBeNull();
    // THE CLAIM IS OUT OF THE FOLDER, so another install can take the mailbox at once rather than
    // waiting out a staleness window it cannot see the end of.
    expect(meta.count, "the released install left its claim standing").toBe(0);

    // THE APPOINTMENT IS OVER, HONESTLY, and its handles are gone so neither side finds it again.
    const closed = await draftRow(sidecar, draftId);
    expect(closed.status).toBe("draft");
    expect(closed.sendAt).toBeNull();
    expect(closed.sendKey).toBeNull();
    expect(closed.sendError).toBe(RELEASED_ORGANIZER_SEND_SENTENCE);
    // …and NOT the stand-down's, which would tell somebody who just stopped organizing their own
    // mailbox that another install had claimed it.
    expect(closed.sendError).not.toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:unknown"]);

    // ── AND IT STAYS RELEASED ─────────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i++) await sidecar.syncUntilQuiet();
    expect(meta.count, "the released install re-claimed the mailbox on a later poll").toBe(0);
    expect(sidecar.organizerState().organizing).toBe(false);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");
    expect(mailbox.sends).toHaveLength(0);
    expect(await sidecar.db.select().from(outboundSends)).toHaveLength(0);
  }, 60_000);

  /**
   * THE REVERSAL, which is what makes the release a control rather than a one-way door: a press
   * after a release takes the mailbox back, on the next poll, with no relaunch.
   *
   * It also pins the interaction the two stamps have with each other. They are contradictory
   * instructions about one mailbox, and the release spends BOTH — so a press must be a NEW write
   * after the release has been honoured, and it must be honoured in its turn rather than eaten by
   * a release request the gate takes first.
   */
  it("…and a press after a release takes the mailbox back on the next poll", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();

    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing).toBe(false);
    expect(meta.count).toBe(0);

    const pressed = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    expect(pressed.outcome).toBe("authorized");
    /* NO PREVIOUS HOLDER TO NAME. `standDownMemory`'s released arm: reader + consented + no holder
       + no occupancy answers `null`, so the person is not told they took the mailbox back from an
       organizer that never existed. Without that arm this reads `organized_elsewhere:unknown`. */
    expect(pressed.previousReason,
      "a release was reported as a stand-down, so the claim-back names a holder nobody saw")
      .toBeNull();

    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing, "the press did not take effect").toBe(true);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("organizer");
    expect(meta.count, "the promoted install did not claim the mailbox").toBe(1);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A STAND-DOWN IS NOT A RELEASE, EVEN AFTER THE WINNER GOES AWAY (review finding, mail 0088)
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The released arm of `standDownMemory` was first written against an ABSENCE — reader, consented,
   * no holder kind, no occupancy — on the argument that a stand-down writes both holder columns in
   * the same statement as the role, so the shape was unreachable from one.
   *
   * It is not. The reader's own per-cycle peek is an enumerated writer of the same columns, and it
   * writes all four NULL whenever it looks and finds an EMPTY folder — which is exactly what a
   * stood-down reader sees the moment the install that beat it releases or is removed. A genuine
   * stand-down therefore DECAYS into the released shape on its own, one poll later, with nothing
   * having released anything.
   *
   * Two things went wrong there and neither showed a symptom: the claim-back screen named no
   * previous holder on the one occasion there is one, and — the more expensive half —
   * `world.standDownReason` feeds the LAUNCH CATCH-UP for orphaned scheduled sends, so a stood-down
   * install whose winner had gone away stopped closing them. The draft goes on saying "Sends Tue
   * 14:50" for a time that has passed, for ever.
   *
   * So the release writes a marker only the release writes, and this is the row that keeps the
   * distinction honest from the other side.
   */
  it("a stand-down whose winner's claim later VANISHES is still reported as a stand-down", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();

    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");
    expect((await mailboxRow(sidecar)).organizedByKind).toBe("cloud");

    // The winner releases. The reader's peek now finds an empty folder and writes the four holder
    // columns NULL — which is the shape the released arm used to key on.
    meta.clear();
    await sidecar.syncUntilQuiet();
    const decayed = await mailboxRow(sidecar);
    expect(decayed.organizedByKind, "the peek did not clear the holder — the case is not set up")
      .toBeNull();
    expect(decayed.organizerState).toBeNull();
    expect(decayed.organizerReleasedAt,
      "a stand-down wrote the release marker — the two events are no longer distinguishable")
      .toBeNull();

    // …and the press that follows names what it took the mailbox back FROM.
    const pressed = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    /* THE MEMORY SURVIVES, which is the property. Its KIND does not, and that is worth stating
       rather than asserting around: the holder columns are what `standDownMemory` composes the
       suffix from, and the peek has just cleared them because the folder really is empty — so the
       honest answer degrades from `:cloud` to `:unknown`. "Another organizer took this mailbox and
       has since gone" is still true and still the sentence the claim-back needs; what is no longer
       recoverable is which kind of machine it was, and inventing that would be worse than
       admitting it. `null` is the answer that must not appear, because `null` means "you released
       this yourself" and drives both the sentence and the launch catch-up. */
    expect(pressed.previousReason,
      "a stand-down whose winner went away was reported as a release, so the claim-back screen "
      + "says nothing about what was taken back — and the launch catch-up stops closing orphaned "
      + "scheduled sends on it").toBe("organized_elsewhere:unknown");
  }, 60_000);

  it("POSITIVE CONTROL: the press opens the gate, and the promotion STAYS across the next poll", async () => {
    // The memory is a gate a human opens, not a wall. Both halves matter and the second is the
    // one a fix for the first can break: if the memory is not spent by the promotion, the very
    // next poll refuses again and the install drains as a reader against a row that says
    // `organizer` — the two halves disagreeing in the other direction.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();

    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing).toBe(false);

    meta.clear();
    const pressed = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    expect(pressed.outcome).toBe("authorized");
    // The sentence the person is shown names what they took it back from — which is exactly what
    // reading the retired column returned NULL for.
    expect(pressed.previousReason).toBe("organized_elsewhere:cloud");

    // No restart: the stamp is re-read at the top of the gate, so the next poll promotes.
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing,
      "the press did not take effect on the next poll").toBe(true);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("organizer");
    expect((await mailboxRow(sidecar)).takeoverAuthorizedAt,
      "a spent request must not authorize a later seizure").toBeNull();

    /* -- …AND IT HOLDS, WHICH IS MEASURED AT THE LEASE AND NOT AT THE ROLE ------------------
     *
     * The stamp is spent, so this poll has nothing but the memory to go on. A memory the
     * promotion failed to spend does not demote anything visible — the gate returns before it
     * touches `organizer`, so the state, the row and the drain's role all still say organizer.
     * What it stops is the install READING THE LEASE, and reading the lease is how an organizer
     * renews its claim (append-then-expunge, §3.3). An organizer that stops renewing goes on
     * behaving like one and loses the mailbox to the next install a stale window later.
     *
     * So the assertion is that the folder was written to again. The role is asserted beside it
     * because a future change could break the visible half instead.
     */
    const renewsSoFar = meta.appends;
    await sidecar.syncUntilQuiet();
    expect(meta.appends,
      "the organizer stopped renewing its claim — it ages out of its own mailbox in one window")
      .toBeGreaterThan(renewsSoFar);
    expect(sidecar.organizerState().organizing,
      "the poll after the promotion demoted an install that IS the organizer").toBe(true);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("organizer");
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  /**
   * A PASS THAT COULD NOT ESTABLISH ITS ROLE DOES NOT KEEP THE LAST GOOD ANSWER.
   *
   * `GATE-CACHED-ROLE-ON-DOUBLE-FAILURE`. The gate's unreadable-role arm returned false while
   * leaving the cached record standing, and that record held the last GOOD answer — `organizing:
   * true`. `drain` decides organizer-only work from it, so the pass most likely to be running over
   * a broken connection ran as the organizer.
   *
   * The sequence uses the reachable half of the arm: another writer demotes the row (the local
   * door, the Settings pane, a `DELETE`) while this process's RAM still says it organizes, and the
   * peek that would settle it fails. Both halves of the arm's condition are then true and neither
   * read can answer.
   */
  it("both reads failing leaves the cached role at NOT organizing, never at the last good answer", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();

    // An empty folder and a consented row: this install organizes, and RAM says so.
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing,
      "the fixture never reached the state the defect needs").toBe(true);

    // ANOTHER WRITER moves the row to `reader`. RAM does not hear about it — which is the whole
    // reason the gate re-reads the row rather than trusting its own memory.
    await sidecar.db.update(mailboxes)
      .set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));

    // …and the peek that would settle who holds it cannot be taken.
    meta.unreadable = true;
    await sidecar.syncUntilQuiet();

    const state = sidecar.organizerState();
    expect(state.organizing,
      "the pass that could not read its own role went on organizing from a stale cache").toBe(false);
    expect(state.unreadableSince,
      "the unreadable lease left no mark, so the pane shows an ordinary connected mailbox")
      .not.toBeNull();
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  /**
   * …AND THE DRAIN OF THAT PASS RUNS UNDER THE ROLE THE GATE READ.
   *
   * `GATE-CACHED-ROLE-ON-DOUBLE-FAILURE`, the second half. The gate answering false was never
   * the whole question: `drain` decided its organizer-only work from `organizer.organizing`, a
   * field that outlives the gate, so the pass depended on the unreadable arm having written the
   * cache before the drain read it — a second mechanism standing in for the answer. The role is
   * a VALUE now, read once per pass and handed down.
   *
   * The verb watched is the MOVE: `ensureFolders` is spent by the first organizing pass and a
   * send needs an appointment, so filing is what a later pass can still be caught doing.
   *
   * MUTATION WATCHED: drop `organizing: false` from the gate's unreadable-row arm. Before this
   * change that reddens this case — the drain reads the last good answer and files somebody's
   * mail from an install that could not establish its own role. After it, nothing moves.
   */
  it("a pass that could not establish its role files nothing, whatever the cache says", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing,
      "the fixture never reached the state the defect needs").toBe(true);

    await seedPendingMove(sidecar);

    // The double failure: another writer demotes the row, and the peek that would settle it
    // cannot be taken. Neither read can answer, and RAM still says this install organizes.
    await sidecar.db.update(mailboxes)
      .set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    meta.unreadable = true;
    await sidecar.syncUntilQuiet();

    expect(mailbox.moves,
      "the pass that could not read its own role moved somebody else's mail").toEqual([]);
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  it("POSITIVE CONTROL — the same pending move IS filed while the gate reads organizer", async () => {
    // Without this the rule above is satisfied by a drain that files nothing ever.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    await sidecar.syncUntilQuiet();

    await seedPendingMove(sidecar);
    await sidecar.syncUntilQuiet();

    expect(mailbox.moves.map((m) => m.folder),
      "an organizer's own drain left its pending move unfiled").toEqual(["INBOX"]);
  }, 60_000);

  it("a readable peek on a demoted row still reports the holder — the positive control", async () => {
    // Without this the rule above is indistinguishable from one that answers "not organizing" for
    // every reader cycle whatever the peek said, which would erase the holder the pane renders.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, mailbox);
    await sidecar.start();
    await sidecar.syncUntilQuiet();

    await meta.seedCloudClaim();
    await sidecar.db.update(mailboxes)
      .set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();

    const state = sidecar.organizerState();
    expect(state.organizing).toBe(false);
    expect(state.heldBy, "a readable peek lost the holder it read").not.toBeNull();
    expect(state.unreadableSince, "a peek that worked left an unreadable mark").toBeNull();
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A MAILBOX A BUILD OLDER THAN MAIL 0083 PAUSED — the one-way door, and the press behind it
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * ≤0.13.x recorded "somebody else has this mailbox" by switching the mailbox OFF —
   * `{ status: 'disabled', disabledReason: 'organized_elsewhere:*', takeoverAuthorizedAt: null }`,
   * naming no role at all. `loadLocalRoster` excludes that row, so it has no runtime, so no lease
   * is ever read for it, so the takeover the pane offers can NEVER be spent: the stamp is written
   * and the poll that would spend it belongs to a runtime that does not exist. Measured on a
   * preserved profile — one account, two mailboxes, one of them in exactly this shape.
   *
   * The boot ends the STATE rather than the exclusion. Three properties, and the second is the way
   * of getting it wrong:
   *
   *  1. the row RUNS — on the roster, with a connection and a poll timer of its own;
   *  2. as a READER — the rewrite claims nothing, so an EMPTY `ohmail/_meta` (the winner long
   *     gone) must not be read as permission by the very launch that un-paused the row. That is
   *     the forbidden auto-resume this whole file is about, reached through the repair;
   *  3. and the press is SPENT by the ordinary poll, which is the whole point of (1).
   *
   * Mutation-watched, each restored:
   *  · the `endLegacyOrganizerPauses` call removed from the boot — the pre-fix tree — → red on (1):
   *    the row is still `disabled`, `organizerStates()` is empty, and the stamp is never spent;
   *  · `organizerRole: "reader"` written as `"organizer"` in the rewrite → red on (2): this launch
   *    claims the mailbox and builds the `ohmail/*` tree with nobody having pressed anything.
   */
  it("a pause an older build left ends at boot: the row RUNS, as a reader that claims nothing", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const first = await boot(dir, quietMailbox(meta));
    const mailboxId = first.world.mailboxId;
    /* THE 0.13.x STAND-DOWN, written as that build wrote it. Modelled on the shape and not on the
       preserved row's contents; the role is left at `organizer`, which is what a mailbox this
       install was organizing keeps, because that write named no role. */
    await first.db.update(mailboxes)
      .set({
        status: "disabled",
        disabledReason: "organized_elsewhere:cloud",
        takeoverAuthorizedAt: null,
      })
      .where(eq(mailboxes.id, mailboxId));
    await first.stop();

    const mailbox = quietMailbox(meta);
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const sidecar = await boot(dir, mailbox, (event, detail) => { lines.push({ event, detail }); });

    /* (1) — and the ROW is what says so, before a single poll: `connected`, a reader, and still
       remembering why. The reason moves onto the column that has a writer, because a `connected`
       row carrying a `disabled_reason` would be a row saying two different things about itself. */
    const row = await mailboxRow(sidecar);
    expect(row.status).toBe("connected");
    /* THE ROLE IS ASSERTED UNDER (2) AND NOT HERE, and the ordering is the whole of whether the
       mutation that matters can be watched: with the rewrite writing `organizer`, a role assertion
       on this line reddens first and the run never reaches the claim — so the consequence, an
       install that seizes a mailbox nobody pressed for, would go unobserved in exactly the run
       that produces it. */
    expect(row.organizedByKind, "the row forgot why it is a reader").toBe("cloud");
    expect(row.disabledReason).toBeNull();
    expect(Object.keys(sidecar.organizerStates()),
      "the mailbox this install holds still has no runtime, so no lease is read for it")
      .toEqual([mailboxId]);
    expect(lines.filter((l) => l.event === "local_mailbox_pause_ended")
      .map((l) => ({ id: l.detail.mailboxId, why: l.detail.disabledReason })),
    "the boot said nothing about the row it rewrote")
      .toEqual([{ id: mailboxId, why: "organized_elsewhere:cloud" }]);

    // (2) The folder is EMPTY — the state `decideLease`'s first arm organizes on — and six polls
    // of a reader nobody pressed for must still leave it alone.
    await sidecar.start();
    for (let i = 0; i < 6; i++) await sidecar.syncUntilQuiet();
    expect(meta.count, "the launch that un-paused the row claimed the mailbox itself").toBe(0);
    expect(mailbox.folderBuilds.count,
      "the launch that un-paused the row built ohmail/* in a mailbox it does not organize")
      .toBe(0);
    expect(sidecar.organizerState().organizing, "the rewrite promoted the install").toBe(false);
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");

    // (3) The person presses "Organize here instead" — and now there is a poll to spend it.
    const pressed = await requestOrganizerTakeover(sidecar.db, { intent: "takeover", mailboxId, now: new Date() });
    expect(pressed.outcome).toBe("authorized");
    expect(pressed.mailboxId, "a second row was minted for the same mailbox").toBe(mailboxId);
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing, "the press was never spent").toBe(true);
    const after = await mailboxRow(sidecar);
    expect(after.organizerRole).toBe("organizer");
    expect(after.takeoverAuthorizedAt, "the authorization must be spent, not left set").toBeNull();
    expect(meta.count, "the promoted install did not claim the mailbox").toBe(1);
  }, 60_000);

  /* AN ORGANIZER EVENT IS A FLIP, NEVER A RE-RUN. A press can stand on a row that already
     organizes (one landing while a promotion spent an older one); the next poll promotes again.
     That promotion changes nothing a person was told, so it must leave `organizer_event_at` —
     or a notice dismissed in between comes back. The hosted twin is `clearOrganizerStandDown`. */
  it("a promotion of a row already organizing leaves the event, so a dismissed notice stays gone", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(dir, quietMailbox(meta));
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing, "the case needs an organizing install").toBe(true);

    const event = new Date(Date.now() - 60_000);
    const seen = new Date(Date.now() - 30_000);
    await sidecar.db.update(mailboxes)
      .set({ organizerEventAt: event, organizerEventSeenAt: seen, takeoverAuthorizedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.takeoverAuthorizedAt, "the promotion never ran over the standing press").toBeNull();
    expect(row.organizerEventAt?.getTime(), "a promotion that flipped nothing moved the event")
      .toBe(event.getTime());
  }, 60_000);

  it("POSITIVE CONTROL: a press that promotes a READER stamps the event", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(dir, quietMailbox(meta));
    await sidecar.start();
    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect((await mailboxRow(sidecar)).organizerRole).toBe("reader");
    meta.clear();

    const before = new Date(Date.now() - 1);
    await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    await sidecar.syncUntilQuiet();
    const row = await mailboxRow(sidecar);
    expect(row.organizerRole).toBe("organizer");
    expect(row.organizerEventAt?.getTime() ?? 0, "a real flip must stamp: another door reads `elsewhere` off it")
      .toBeGreaterThan(before.getTime());
  }, 60_000);

  /* THE STAND-DOWN ON THE SAME RULE (REVIEW-026 L1): a press that loses to the SAME live holder
     re-runs the demotion over a row that already reads that holder; nothing changed, so the event
     keeps its instant and a dismissed 'elsewhere' stays dismissed. */
  it("a stand-down that re-reads the SAME holder leaves the event, so a dismissed notice stays gone", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(dir, quietMailbox(meta));
    await sidecar.start();
    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    const before = await mailboxRow(sidecar);
    expect(before.organizerRole, "the case needs a stood-down reader").toBe("reader");

    const event = new Date(Date.now() - 60_000);
    await sidecar.db.update(mailboxes)
      .set({ organizerEventAt: event, organizerEventSeenAt: new Date(Date.now() - 30_000),
        takeoverAuthorizedAt: new Date(), takeoverIntent: "join" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();

    const row = await mailboxRow(sidecar);
    expect(row.organizerRole).toBe("reader");
    expect(row.takeoverAuthorizedAt, "the losing press never reached the stand-down").toBeNull();
    expect(row.organizerEventAt?.getTime(), "a stand-down that changed nothing moved the event")
      .toBe(event.getTime());
  }, 60_000);
});
