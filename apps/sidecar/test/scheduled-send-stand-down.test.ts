import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { drafts, mailboxes, outboundSends, scheduledSendFiles, STAND_DOWN_SEND_SENTENCES } from "@trafficflow/db";
import { ScheduleService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A HANDOVER MUST NOT ORPHAN A PENDING SCHEDULED SEND — `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, MEASURED ON A REAL MAILBOX ───────────────────────────────────────────────
 *
 * An appointment was made on a standalone install; the mailbox was then connected to a managed
 * Cloud account and handed over; the standalone was relaunched past the due time, which is what a
 * person opening their old app does. It stood down (`organized_elsewhere:cloud`),
 * `syncUntilQuiet()` returned **0 cycles** on start and on four further polls, and
 * `scheduled_send_pass` was **never emitted once** — `sendScheduled()` is inside `drain`, and
 * `syncUntilQuiet` gates on `mayOrganize()` before `drain`. Seventeen minutes past due the row was
 * still `status:'scheduled'`, `send_error: null`, and the Drafts screen still read
 * **"Sends Tue 14:50"** for a time that had gone. Nothing would ever change it.
 *
 * The honest-failure machinery could not help: `SCHEDULED_SEND_EXPIRY_MS` — the constant that
 * exists so a day-late appointment is closed with a sentence rather than delivered quietly — is
 * enforced INSIDE that same unreachable pass.
 *
 * ── WHAT THIS FILE PROVES, AND WHY IT IS THE ENGINE AND NOT A UNIT ───────────────────────
 *
 * That the GATE closes them on the way down, and that a stood-down install closes its own on
 * every launch. Both are properties of `createSidecar`'s composition — where the call sits
 * relative to `stopped`, the adapter close and `priorStandDown` — and a unit test of the closer
 * cannot see any of it. The third test is the interaction with the reclaim
 * (`QAR-DESKTOP-CANNOT-RECLAIM-MAILBOX`): taking the mailbox back must not resurrect an
 * appointment the stand-down already finalized.
 *
 * ── WHY PGLITE AND NOT :5433 ─────────────────────────────────────────────────────────────
 *
 * `resurface-drain.test.ts`'s reason verbatim: **PGlite IS production on the desktop.**
 * `apps/sidecar/src/db.ts` opens it on disk under the user's home and this test opens the same
 * store through the same `createSidecar`; running these against :5433 would measure a database no
 * desktop install has. The claims PGlite genuinely cannot host — a claim and a close racing for
 * one row across two connections, and the reservation exclusions — are not skipped and are not
 * re-stated here: `packages/services/test/scheduled-send-stand-down.pg.test.ts` proves them
 * against real Postgres over the SAME function.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────
 *
 * Delete `await standDownAppointments(outcome.reason);` from `mayOrganize` in
 * `apps/sidecar/src/engine.ts` and the first test goes red with the row still `scheduled` and
 * `send_error` null — the measured state, exactly. Delete the
 * `if (priorStandDown) await standDownAppointments(...)` line and the second goes red the same
 * way. Make `requestOrganizerTakeover` write `status: "connected"` (what the CLI's
 * `authorizeOrganizerTakeover` does, which is right for a stopped app and wrong for a button) and
 * the third goes red on the row the press left behind; move the stand-down clear out of
 * `mayOrganize`'s organize arm and back to assembly and the same test goes red on the row at
 * boot, which is the window where a lease has not been read and a send would be accepted; make
 * the grant's write unconditional again and the removal case goes red with the tombstone revived;
 * drop the abort that follows the read-back and the same case goes red with the install still
 * organizing a mailbox that is gone. All six mutations were run.
 */

/** An in-memory `ohmail/_meta`, writable by the test so a claim can arrive mid-life. */
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
  /** Cloud arrives and takes the mailbox — the handover, as the worker's gate writes it. */
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
  /** Everything is released — the state an empty folder describes. */
  clear(): void {
    this.claims.length = 0;
  }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * A mailbox with nothing in it whose SEND throws. Nothing in this file should reach SMTP, and a
 * throwing transport is what makes that an assertion rather than a hope: if a stood-down install
 * ever did run the pass, the attempt would be recorded here rather than passing silently.
 */
function quietMailbox(meta: MemoryMetaFolder) {
  const sends: OutboundMessage[] = [];
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
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
    async send(m: OutboundMessage): Promise<SendResult> {
      sends.push(m);
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
  return { factory, sends };
}

const HOUR = 60 * 60 * 1000;
const schedules = new ScheduleService();

describe("a stand-down closes the send-later appointments it can no longer keep", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    // `realpathSync` because macOS hands out `/var/…` for a `/private/var/…` directory and PGlite
    // records the resolved path in its lock file.
    const dir = await freshDataDir("ohmail-standdown-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function boot(
    dir: string, meta: MemoryMetaFolder, sends: ReturnType<typeof quietMailbox>,
  ): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all.
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the old machine",
      // Long enough that the poll timer never fires: every drain here is one the test asked for.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: sends.factory,
      log: () => {},
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    void meta;
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

  /** An appointment two hours out, made the way the compose surface makes one. */
  async function scheduleOne(
    sidecar: Sidecar, subject = "the appointment",
    files?: { filename: string; contentType: string; content: Buffer }[],
  ): Promise<string> {
    const [d] = await sidecar.db.insert(drafts).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      subject,
      body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "draft",
    }).returning();
    const ctx: ServiceContext = {
      db: sidecar.db as never, accountId: sidecar.world.accountId, userId: null,
      now: () => new Date(), requestId: "test",
    };
    await schedules.schedule(ctx, d!.id, new Date(Date.now() + 2 * HOUR).toISOString(), files ? { files, surfaceMaxTotalBytes: null } : undefined);
    return d!.id;
  }

  const draftRow = async (sidecar: Sidecar, id: string) => {
    const [row] = await sidecar.db.select().from(drafts).where(eq(drafts.id, id));
    return row!;
  };

  it("THE HANDOVER WITH FILES (mail 0179) — the closed appointment's kept files go with it, the count stays as the mark", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, meta, mailbox);
    await sidecar.start();
    const draftId = await scheduleOne(sidecar, "with files", [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }]);
    expect(await sidecar.db.select().from(scheduledSendFiles)).toHaveLength(1);
    await meta.seedCloudClaim();
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing).toBe(false);
    const closed = await draftRow(sidecar, draftId);
    expect(closed).toMatchObject({ status: "draft", sendKey: null, sendFiles: 1 });
    expect(await sidecar.db.select().from(scheduledSendFiles), "a stood-down appointment kept its files").toHaveLength(0);
    expect(mailbox.sends).toHaveLength(0);
  });

  it("THE HANDOVER — the gate stands down and the appointment is closed with a sentence, not left saying 'Sends'", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const sidecar = await boot(dir, meta, mailbox);
    await sidecar.start();
    // The install organizes at first — which is what makes the stand-down below a transition and
    // not a starting condition.
    expect(sidecar.organizerState().organizing).toBe(true);

    const draftId = await scheduleOne(sidecar);
    const armed = await draftRow(sidecar, draftId);
    expect(armed.status).toBe("scheduled");
    expect(armed.sendAt).not.toBeNull();

    // ── THE MAILBOX IS HANDED OVER ────────────────────────────────────────────────────────
    await meta.seedCloudClaim();
    /* -- THIS ASSERTED "no cycles" AND MAIL 0083 RETIRED THE DOCTRINE IT CAME FROM ----------
     *
     * It read `expect(cycles).toBe(0)` under the sentence *"this is the state in which the
     * scheduled-send pass can never run again"*, which was the measured truth of an install that
     * STOPPED when it stood down. A demoted install is now a READER — connected, poll timer
     * running, mirror growing, `\Seen` its one IMAP write verb — so it runs cycles by design, and
     * an assertion that it does not is an assertion against the product.
     *
     * What this test is FOR is untouched and is asserted below: the appointment is closed with a
     * sentence, `send_at`/`send_key` are gone, and nothing was offered to any server. Those are
     * the claims `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION` was closed on; "no cycles" was the
     * mechanism they happened to ride, and the mechanism moved.
     *
     * The bar that replaces it is the one that still matters at this seam: whatever the cycles
     * did, they did not SEND. `mailbox.sends` is checked below and is the direct statement of it.
     */
    const cycles = await sidecar.syncUntilQuiet();
    // POSITIVE, not non-negative. `>= 0` is true of every possible return including ZERO, which is
    // precisely the old behaviour this line is supposed to reject — an assertion that cannot fail
    // is not a weakened guard, it is no guard.
    expect(cycles, "a reader ran no cycles at all — the pre-0083 behaviour").toBeGreaterThan(0);
    expect(sidecar.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });

    // ── AND THE APPOINTMENT IS OVER, HONESTLY ─────────────────────────────────────────────
    const closed = await draftRow(sidecar, draftId);
    expect(closed.status, "the appointment survived a stand-down that can never keep it").toBe("draft");
    expect(closed.sendAt, "the row still names a time nothing will act on").toBeNull();
    expect(closed.sendKey).toBeNull();
    expect(closed.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);
    // Nothing was offered to any server — the never-offered arm of the send-window contract, and
    // the reason `failed` (rather than a deferred recovery) is the honest ending here.
    expect(mailbox.sends).toHaveLength(0);
    expect(await sidecar.db.select().from(outboundSends)).toHaveLength(0);

    /* -- THE ROW RECORDS THE STAND-DOWN, ON THE COLUMNS MAIL 0083 MOVED IT TO ---------------
     *
     * This asserted `status: 'disabled'` + `disabled_reason`, which was the stand-down's whole
     * spelling until 0083 split the CONNECTION from the ROLE. A demoted install is CONNECTED —
     * it is a reader, it stays on its own roster and its mirror goes on growing — so `disabled`
     * here would now be an assertion against the product, and `disabled_reason` gains no writer
     * anywhere in the tree.
     *
     * `disabled_reason` is asserted NULL rather than left unmentioned: "the column that used to
     * carry this is empty" is the fact three consumers were still reading when this file went
     * red, so it is worth stating rather than implying.
     */
    const [mb] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(mb!.status, "a reader is CONNECTED — `disabled` means tombstone or plan-disable")
      .toBe("connected");
    expect(mb!.organizerRole).toBe("reader");
    expect(mb!.organizedByKind).toBe("cloud");
    expect(mb!.disabledReason, "mail 0083 left this column with no writer").toBeNull();
  }, 60_000);

  it("THE LAUNCH CATCH-UP — an install already stood down closes its own on the next start", async () => {
    // This is every orphan in the field: the stand-down happened before the close existed, so
    // nothing on any later launch would ever reach the lease arm — `mayOrganize` returns at
    // `priorStandDown` without reading the lease at all.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const first = await boot(dir, meta, mailbox);
    await first.start();
    const draftId = await scheduleOne(first);

    /* -- THE STAND-DOWN AS MAIL 0083 WRITES IT, AND THE OLD SHAPE HID THIS TEST'S OWN DEFECT --
     *
     * This set `status: 'disabled'` + `disabled_reason`, which is what the gate wrote before
     * 0083 and what nothing writes now. Two things were wrong with leaving it: the state under
     * test was one no install can reach any more, and `closeStoodDownAppointments` keys on
     * `organizer_role = 'reader'`, so the closer would have refused this row for a reason that
     * has nothing to do with the catch-up this test is about.
     *
     * `organized_by_kind` is written beside the role because it is where the WHO now lives — it
     * is what `standDownMemory` recomposes `organized_elsewhere:cloud` out of on the next launch,
     * and a reader row without it remembers only that somebody took the mailbox.
     */
    await first.db.update(mailboxes)
      .set({
        status: "connected", organizerRole: "reader", organizedByKind: "cloud",
        disabledReason: null, takeoverAuthorizedAt: null,
      })
      .where(eq(mailboxes.id, first.world.mailboxId));
    expect((await draftRow(first, draftId)).status).toBe("scheduled");
    expect((await draftRow(first, draftId)).sendError).toBeNull();
    await first.stop();

    // The person opens their old app. Cloud has since released, so the folder is empty — which
    // the lease alone would read as "nobody has ever organized this mailbox". The ROW is what
    // keeps this install stood down, and the catch-up rides that same memory.
    meta.clear();
    const second = await boot(dir, meta, mailbox);
    expect(second.world.standDownReason).toBe("organized_elsewhere:cloud");
    expect(second.world.mailboxId).toBe(first.world.mailboxId);

    // BEFORE `start()`: the close is in the assembly, not in the drain, because `start()` returns
    // before the gate when no password is stored and a stood-down install with a forgotten
    // password is exactly one whose Drafts screen somebody opens.
    const healed = await draftRow(second, draftId);
    expect(healed.status, "a relaunched stood-down install left the orphan standing").toBe("draft");
    expect(healed.sendAt).toBeNull();
    expect(healed.sendKey).toBeNull();
    expect(healed.sendError).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);

    /* -- THE CATCH-UP MUST NOT RESUME ORGANIZING, AND "0 CYCLES" IS NO LONGER HOW THAT READS --
     *
     * This asserted `syncUntilQuiet()` returned 0, which was the same conflation mail 0083 undid
     * in the first test: a reader RUNS cycles — that is the product — so a cycle count says
     * nothing about who organizes the mailbox. What the catch-up must not do is make this install
     * the organizer, and that is a question about the role, asked directly.
     *
     * The lease folder is EMPTY here (Cloud released), which is exactly the state that would
     * auto-resume if the row's memory were not consulted: `decideLease` reads an empty folder as
     * "nobody has ever organized this mailbox" and organizes. The row is the memory the mailbox
     * cannot hold, and this is the assertion that watches it hold.
     */
    await second.start();
    await second.syncUntilQuiet();
    expect(second.organizerState().organizing,
      "a relaunch auto-resumed organizing a mailbox this install had stood down from").toBe(false);
    const [stillReader] = await second.db.select().from(mailboxes)
      .where(eq(mailboxes.id, second.world.mailboxId));
    expect(stillReader!.organizerRole).toBe("reader");
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  it("A REMOVAL THAT LANDS DURING THE LEASE READ IS NOT REVIVED BY THE GRANT", async () => {
    // The grant runs after a network round trip — `readMailboxLease` — and the bridge is serving
    // throughout it. A `DELETE /mailboxes/:id` committing in that window makes the row a
    // TOMBSTONE: `disabled`, reason NULL, credentials gone. An unconditional grant would revive it
    // as `connected`, undoing a removal the person asked for and leaving a connected mailbox with
    // no stored login. The clear is therefore conditional on the stand-down still being on the row.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const first = await boot(dir, meta, mailbox);
    await first.start();
    await meta.seedCloudClaim();
    await first.syncUntilQuiet();
    await requestOrganizerTakeover(first.db, { intent: "takeover", mailboxId: first.world.mailboxId, now: new Date() });
    await first.stop();

    // The removal, exactly as `MailboxService.delete` leaves the row: disabled with NO reason.
    meta.clear();
    const second = await boot(dir, meta, mailbox);
    await second.db.update(mailboxes)
      .set({ status: "disabled", disabledReason: null })
      .where(eq(mailboxes.id, second.world.mailboxId));
    await second.start();

    const [row] = await second.db.select().from(mailboxes)
      .where(eq(mailboxes.id, second.world.mailboxId));
    expect(row!.status, "a grant revived a mailbox the person had removed").toBe("disabled");
    expect(row!.disabledReason, "a tombstone must stay a tombstone — a reason would make it a pause")
      .toBeNull();
    expect(row!.takeoverAuthorizedAt,
      "the request is spent whatever the row became; leaving it would authorize a later seizure")
      .toBeNull();

    // AND THE LAUNCH ORGANIZES NOTHING. Preserving the row is not enough on its own: the lease
    // had already said organize and had already appended this install's claim, so without the
    // abort this launch would have gone on to create the `ohmail/*` tree, drain, and hold a poll
    // timer against a mailbox the person removed — under a row every later launch excludes.
    expect(second.organizerState().organizing,
      "the install went on organizing a mailbox that had been removed").toBe(false);
    expect(await second.syncUntilQuiet(), "a removed mailbox must run no cycles").toBe(0);
  }, 60_000);

  it("THE RECLAIM — taking the mailbox back does not resurrect an appointment the stand-down finalized", async () => {
    // `QAR-DESKTOP-CANNOT-RECLAIM-MAILBOX`'s interaction with this fix, decided rather than
    // discovered: the appointment does NOT come back. It was closed with a sentence the person
    // has already been shown, `send_at` and `send_key` are gone, and re-arming it on a reclaim
    // would deliver a message at a time nobody chose — hours or days late, after a sentence
    // telling them it had not been sent. The row is an ordinary draft; scheduling it again is one
    // action and is theirs to take.
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const mailbox = quietMailbox(meta);
    const first = await boot(dir, meta, mailbox);
    await first.start();
    const draftId = await scheduleOne(first);

    await meta.seedCloudClaim();
    await first.syncUntilQuiet();
    expect((await draftRow(first, draftId)).status).toBe("draft");
    const sentence = (await draftRow(first, draftId)).sendError;
    expect(sentence).toBe(STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]);

    // The person presses "Organize from this machine" — the ceremony the route exposes.
    const result = await requestOrganizerTakeover(first.db, { intent: "takeover",
      mailboxId: first.world.mailboxId, now: new Date(),
    });
    expect(result.outcome).toBe("authorized");
    expect(result.previousReason).toBe("organized_elsewhere:cloud");

    // ── THE PRESS LEAVES THE ROW STOOD DOWN, AND THAT IS THE POINT OF THE TWO-STEP ────────
    //
    // This process is still serving, still `stopped`, still holding no login. A row flipped to
    // `connected` here would advertise a mailbox nothing is organizing — and `ScheduleService`
    // and `SendService` refuse on `status = 'disabled'` and on nothing else, so they would begin
    // accepting sends for it in exactly that window. The stamp alone carries the request.
    const [pressed] = await first.db.select().from(mailboxes)
      .where(eq(mailboxes.id, first.world.mailboxId));
    // Mail 0083: the row that goes on telling the truth is a READER row, not a disabled one. The
    // stamp still travels alone, which is the whole of the two-step; what it must not do is flip
    // the role, because the role is what every write door consults.
    expect(pressed!.organizerRole, "the press made this install the organizer with no lease read")
      .toBe("reader");
    expect(pressed!.status).toBe("connected");
    expect(pressed!.takeoverAuthorizedAt).not.toBeNull();
    expect(first.organizerState().organizing,
      "the press re-armed a process that has already stood down").toBe(false);
    await first.stop();

    // Cloud released; this install relaunches and takes the mailbox back.
    meta.clear();
    const second = await boot(dir, meta, mailbox);

    // ── THE ROW IS STILL STOOD DOWN AT ASSEMBLY, AND ONLY THE LEASE MAY CLEAR IT ──────────
    //
    // A round of this fix cleared it here, arguing that assembly is the CLI's own timing. It is
    // not, for this process: `main.ts` announces the bridge and calls `start()` asynchronously,
    // and `start()` returns before the gate when no password is stored — so a row cleared at
    // assembly is a `connected` mailbox served to requests before any lease has been read, and
    // for the whole life of a passwordless launch.
    const [atBoot] = await second.db.select().from(mailboxes)
      .where(eq(mailboxes.id, second.world.mailboxId));
    expect(atBoot!.organizerRole,
      "the row was promoted before the lease was read — the write doors open in that window")
      .toBe("reader");
    expect(atBoot!.takeoverAuthorizedAt, "the request must survive to the gate").not.toBeNull();
    // …and the process agrees with its row. `organizerState()` is what the window renders, and a
    // relaunch that announced "organizing" here would be announcing a claim it has not made.
    expect(second.organizerState().organizing).toBe(false);
    expect(second.organizerState().reason).toBe("organized_elsewhere:cloud");

    await second.start();
    expect(second.organizerState().organizing,
      "the authorized takeover did not take effect on the next launch").toBe(true);

    // ── AND NOW, AFTER THE LEASE SAID ORGANIZE, ALL THREE COLUMNS MOVED TOGETHER ──────────
    //
    // `status` without `disabled_reason` is a TOMBSTONE: the next launch would mint a second
    // mailbox row for this address with none of this one's history. The stamp is spent in the
    // same statement — one becoming, not a standing right to seize this mailbox back later.
    const [granted] = await second.db.select().from(mailboxes)
      .where(eq(mailboxes.id, second.world.mailboxId));
    expect(granted!.status).toBe("connected");
    // THE ROLE IS THE PROMOTION (mail 0083). Without it the lease has made this install the
    // organizer while its own API refuses every write with `409 organized_elsewhere`, naming
    // itself out of the holder columns.
    expect(granted!.organizerRole).toBe("organizer");
    expect(granted!.disabledReason).toBeNull();
    expect(granted!.takeoverAuthorizedAt, "a spent request must not authorize a later seizure")
      .toBeNull();

    await second.syncUntilQuiet();

    // The appointment stays closed, and no send was ever attempted for it on either side of the
    // handover. This is the double-send boundary read from the reclaim end.
    const after = await draftRow(second, draftId);
    expect(after.status).toBe("draft");
    expect(after.sendAt, "a reclaim re-armed an appointment the person was told had failed").toBeNull();
    expect(after.sendKey).toBeNull();
    expect(after.sendError).toBe(sentence);
    expect(mailbox.sends).toHaveLength(0);
    expect(await second.db.select().from(outboundSends)).toHaveLength(0);
  }, 60_000);
});
