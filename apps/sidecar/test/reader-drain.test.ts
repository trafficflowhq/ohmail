import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { changeLog, mailboxes, messages, messageStates } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";
import {
  lineOf, span, withoutCommentsAndLiterals,
} from "../../../scripts/lib/source-scan.mjs";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A STOOD-DOWN INSTALL IS A READER, NOT A CORPSE — the drain runs, and `\Seen` still ships
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mail 0083 replaced "a demoted install stops syncing entirely" with a READER: connected, mirror
 * growing, `\Seen` its one IMAP write verb. `drain` was rewritten for it — it spreads
 * `role: organizing ? "organizer" : "reader"` into every cycle, under a comment that
 * says *"a demoted install keeps draining"* — and the gate ABOVE it was not:
 *
 *     if (!(await mayOrganize())) return 0;
 *
 * `mayOrganize()` answers false for a reader, `drain` is the only path to `runSyncCycle` on this
 * door, and `syncUntilQuiet` is the only path to `drain`. So the whole reader cycle was written
 * and unreachable. What a person got instead: a mirror frozen at the instant of the handover, and
 * — because `reconcileFlags` lives inside that same drain — read state that never left the laptop.
 * "I marked it read on the desktop and my mailbox never saw it", exactly.
 *
 * Two comments in one file disagreed about this and the one that ran was the gate. These are the
 * guards for the sentence the stand-down actually logs.
 *
 * ── THE COUNTERWEIGHT MATTERS AS MUCH AS THE CLAIM ──────────────────────────────────────────
 *
 * "The reader drains" is only safe beside "and it still writes nothing it may not write". The
 * adapter here records every server-facing verb, so the second test is an EXACT-SET assertion over
 * what the reader asked the mail server to do — not a spot check on the two verbs somebody thought
 * of.
 */

/**
 * `ohmail/_meta` in memory, pre-loaded with ANOTHER install's claim.
 *
 * `heartbeatAgeMs` is what makes the claim LIVE or STALE against `leaseStaleAfterMs`, and the
 * difference is the whole of the takeover story: a live holder must be refused even to a person
 * who asked for this machine, and a stale one is exactly the crashed-machine case the explicit
 * request exists for.
 */
class ForeignLease implements LeaseIo {
  private nextUid = 2;
  private readonly claims: RawClaimMessage[];
  /**
   * `authorizedAt` is the PRESS this holder's tenure rests on, and since 0.14.1 it is what decides
   * whether the holder keeps the mailbox against somebody who asks for it. Kind stopped ranking and
   * decision-table rule 5 is deleted, so "a live cloud claim refuses a local install" is no longer
   * a rule — what refuses one is a press this claim can point to that is NEWER than the asker's.
   *
   * Default `null`, which is the steady state of every mailbox nobody has pressed on, and is
   * exactly the holder a press now takes.
   */
  constructor(heartbeatAgeMs = 0, authorizedAt: Date | null = null) {
    this.claims = [{
      ref: 1,
      raw: formatClaim({
        authorizedAt, capabilities: ["requests"],
        installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: new Date(Date.now() - heartbeatAgeMs),
        claimedAt: new Date(Date.now() - 86_400_000), nonce: "seeded",
      }),
    }];
  }
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    // THE WINDOW, made reachable. `readMailboxLease` calls this BETWEEN the gate's stamp read and
    // the stand-down's write, which is exactly where a press has to land to be lost. A test cannot
    // reach that instant from outside; this hook is the instant.
    const hook = onLeaseRead;
    if (hook) { onLeaseRead = null; await hook(); }
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    reads.appendClaim += 1;
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /**
   * THE FOLDER'S UID GENERATION. The product's one `LeaseIo` — `makeLeaseIo` — always reports it,
   * and the takeover's confirm refuses when it is unnamed (a ref is a uid, and a uid means nothing
   * across a UIDVALIDITY change). A double that leaves the accessor out puts the gate in a state
   * no install reaches, and the press in these cases is real.
   */
  uidValidity(): number | bigint | null {
    return 4_100;
  }
}

/** Run once, INSIDE the lease read — see {@link ForeignLease.listClaims}. */
let onLeaseRead: (() => Promise<void>) | null = null;

/** The calls that would mean a drain or a lease gate ran. */
const reads = { changesSince: 0, appendClaim: 0 };

const EMPTY_CURSOR = { folders: {} };

/**
 * One message the server holds, as RFC822 bytes.
 *
 * REAL SOURCE and not a hand-built `NormalizedMessage`: `planChange` refuses a create with no
 * `raw` (`pipeline.ts` — "planChange requires change.raw"), and the whole point of this file is
 * that the pipeline runs at all on this door.
 */
function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <reader-${uid}@stranger.test>`,
    "From: stranger@elsewhere.test",
    "To: owner@trafficflow.test",
    `Subject: reader mail ${uid}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/** Every server-facing call the cycle made, in order. */
interface Wire { verb: string; detail: string }

function recordingMailbox(
  wire: Wire[], deliver: number[], heartbeatAgeMs = 0, later: number[] = [],
  /** The press the seeded holder's tenure rests on — see `ForeignLease`. */
  holderPressedAt: Date | null = null,
): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new ForeignLease(heartbeatAgeMs, holderPressedAt);
  let handed = false;
  /** Mail that arrives AFTER the launch drain — what a later POLL, and only a poll, can find. */
  let laterHanded = false;
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> { wire.push({ verb: "ensureFolders", detail: "" }); },
    async changesSince(): Promise<ChangeBatch> {
      reads.changesSince += 1;
      if (handed) {
        if (later.length === 0 || laterHanded) {
          return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
        }
        laterHanded = true;
        return {
          creates: later.map((uid) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
            raw: arrival(uid),
          })) as ChangeBatch["creates"],
          moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
        };
      }
      handed = true;
      return {
        creates: deliver.map((uid) => ({
          type: "create" as const,
          locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
          raw: arrival(uid),
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
      };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      wire.push({ verb: "move", detail: `${locator.ref}→${toFolder}` });
      return { folder: toFolder, ref: "7:41" };
    },
    async setFlags(locator: NativeLocator, flags: { seen?: boolean }): Promise<void> {
      wire.push({ verb: "setFlags", detail: `${locator.ref} seen=${String(flags.seen)}` });
    },
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

describe("a stood-down install keeps reading its mailbox", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const wire: Wire[] = [];
  afterEach(async () => {
    onLeaseRead = null;
    wire.length = 0;
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(
    deliver: number[], heartbeatAgeMs = 0,
    opts: { pollIntervalMs?: number; later?: number[]; holderPressedAt?: Date | null } = {},
  ): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-reader-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "reader host",
      pollIntervalMs: opts.pollIntervalMs ?? 60 * 60 * 1000,
      // A day's grace, and the seeded claim's heartbeat is NOW — so it reads as live and this
      // install stands down on every run. That is the whole precondition.
      leaseStaleAfterMs: 24 * 3600 * 1000,
      adapterFactory: recordingMailbox(
        wire, deliver, heartbeatAgeMs, opts.later ?? [], opts.holderPressedAt ?? null,
      ),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
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
    await sidecar.start();
    return sidecar;
  }

  it("stands down to READER — the precondition, asserted rather than assumed", async () => {
    const sidecar = await boot([41]);
    const [mb] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(mb!.organizerRole, "this install took a lease another install holds").toBe("reader");
    expect(mb!.status, "a reader is CONNECTED — a demotion is not a disconnection").toBe("connected");
  });

  it("LAUNCH: the first drain runs and the POLL TIMER is armed — without a caller asking", async () => {
    /*
     * The half `syncUntilQuiet`'s gate does not cover, and on a real install it is the half that
     * matters: nothing calls `syncUntilQuiet()` by hand. `start()`'s `!permitted` branch used to
     * `return` before the first drain, before the special-folder discovery AND before
     * `schedule()`, so a stood-down install came up with no timer at all — the gate would never run
     * again, and the "Organize from this machine" stamp its own route's header promises will be
     * *"spent on the very next poll"* had no poll to be spent on.
     *
     * Asserted through the mirror rather than by reading a timer handle: `boot()` awaits `start()`
     * and NOTHING here calls `syncUntilQuiet`, so a mirrored row can only have come from the
     * launch drain.
     */
    const sidecar = await boot([41, 42]);

    const rows = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    expect(
      rows.length,
      "`start()` returned before its first drain — a stood-down install comes up frozen",
    ).toBe(2);

    // …and the login is STILL OPEN, which the `priorStandDown` arm used to close. A closed
    // connection makes the next poll read the lease over a dead socket, which is the failure
    // `syncUntilQuiet`'s own `stopped` check documents.
    expect(wire.filter((w) => w.verb === "ensureFolders"),
      "a reader created somebody else's `ohmail/*` tree at launch").toEqual([]);

  });

  it("…and the POLL TIMER fires — mail that arrives after the launch is mirrored by nobody's call", async () => {
    /*
     * The half the test above cannot reach: it observes the SYNCHRONOUS launch drain, so deleting
     * `schedule()` leaves it green and the regression the pair is named for goes unguarded.
     *
     * Observed by waiting for the TIMER'S OWN WORK rather than by inspecting a handle —
     * `schedule()` calls `timer.unref()`, so an active-handle probe reads zero whether the timer
     * exists or not, which is the instrument that looked obvious and answers nothing.
     *
     * The adapter hands `41` to the launch drain and `42` only to a LATER `changesSince`. Nothing
     * in this test calls `syncUntilQuiet`. A second row can therefore only have come from a poll.
     */
    const sidecar = await boot([41], 0, { pollIntervalMs: 120, later: [42] });

    const deadline = Date.now() + 20_000;
    let rows = 0;
    while (Date.now() < deadline) {
      rows = (await sidecar.db.select().from(messages)
        .where(eq(messages.mailboxId, sidecar.world.mailboxId))).length;
      if (rows >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      rows,
      "no poll ever ran — `start()` armed no timer, so a reader's mirror freezes at its launch",
    ).toBe(2);
  });

  it("THE MIRROR GOES ON GROWING — the sentence the stand-down logs, held to", async () => {
    const sidecar = await boot([41, 42, 43]);

    await sidecar.syncUntilQuiet();

    const rows = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    expect(
      rows.length,
      "a stood-down install mirrored nothing — `syncUntilQuiet` returned before `drain`",
    ).toBe(3);
  });

  it("…and `\\Seen` still reaches the mail server, which is a reader's ONE write verb", async () => {
    const sidecar = await boot([41]);
    await sidecar.syncUntilQuiet();

    const [row] = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    expect(row, "nothing was mirrored, so there is nothing to mark read").toBeTruthy();

    // The wire the window sends — `HttpAdapter`'s `mark_seen`, byte for byte.
    const marked = await sidecar.handle(new Request("http://sidecar/messages", {
      method: "PATCH",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [row!.id], unread: false }),
    }));
    expect(marked.status, await marked.text().catch(() => "")).toBe(200);

    await sidecar.syncUntilQuiet();

    expect(
      wire.filter((w) => w.verb === "setFlags"),
      "the read never reached the mailbox — this is the reported symptom, on a reader",
    ).toEqual([{ verb: "setFlags", detail: "1:41 seen=true" }]);
  });

  it("…and the read goes out within a second of the press, with no drain and nothing else on the wire", async () => {
    const sidecar = await boot([41]);
    await sidecar.syncUntilQuiet();
    const [row] = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    wire.length = 0;
    Object.assign(reads, { changesSince: 0, appendClaim: 0 });

    const marked = await sidecar.handle(new Request("http://sidecar/messages", {
      method: "PATCH",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [row!.id], unread: false }),
    }));
    expect(marked.status).toBe(200);

    await vi.waitFor(() => expect(wire).toEqual([{ verb: "setFlags", detail: "1:41 seen=true" }]),
      { timeout: 1_000, interval: 10 });
    expect(reads, "a drain or a lease gate carried the reader's read").toEqual({ changesSince: 0, appendClaim: 0 });
  });

  it("PRESS WHILE RUNNING: the next poll spends the stamp and promotes — no relaunch", async () => {
    /*
     * and it is now this file's to hold.
     *
     * `POST /local/organizer/takeover` writes `takeover_authorized_at` and nothing else, while the
     * engine derived `takeoverAuthorized` ONCE at assembly. While a stood-down install had no poll
     * timer that was merely dormant — the row survived to the next launch and the gate read it
     * there, which is why the pane's copy said "quit and reopen" and was TRUE.
     *
     * Arming the reader's loop turned that dormant staleness DESTRUCTIVE: the poll asks the lease
     * with `takeover: "none"`, is correctly refused by the foreign claim the person is asking to
     * take over, and the refusal arm then CLEARS the stamp. The press is consumed by the one pass
     * that could not act on it, and a relaunch cannot recover it either — there is nothing left on
     * the row.
     *
     * The claim here is STALE (its heartbeat is two days old against a one-day grace), which is
     * the crashed-machine case the explicit request exists for. The lease refuses it without a
     * stamp and takes it with one, so "did the gate see the press?" is answerable from the
     * outcome rather than from a spy.
     */
    const sidecar = await boot([41], 2 * 24 * 3600 * 1000);
    // Stale or not, an install does NOT seize a mailbox somebody else claimed: the gate stands
    // down, and that is the precondition the press exists to change.
    expect(sidecar.organizerState().organizing, "a stale claim was seized without being asked for")
      .toBe(false);

    const asked = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    });
    expect(asked.outcome).toBe("authorized");

    // THE NEXT POLL. Nothing is relaunched; this is the same process and the same gate.
    await sidecar.syncUntilQuiet();

    expect(
      sidecar.organizerState().organizing,
      "the press was disarmed by the loop it was meant to arm — the gate read the row at assembly",
    ).toBe(true);

    // …and the stamp is gone because it was SPENT, not because a pass that could not use it threw
    // it away. One becoming, not a standing right to seize the mailbox back later.
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(row!.takeoverAuthorizedAt).toBeNull();
    expect(row!.organizerRole).toBe("organizer");
  });

  it("A HOLDER WITH A NEWER PRESS IS STILL REFUSED, and the request is ANSWERED rather than dropped", async () => {
    /*
     * The counterweight, and it is what stops the fix above from being "promote on request".
     * Exactly one install organizes a mailbox, and the refusal is an ANSWER to a request that was
     * actually put to the lease — the stamp is offered, refused, and cleared, in that order —
     * rather than a stamp thrown away by a pass that asked with no takeover at all.
     *
     * ── WHAT MAKES A HOLDER KEEP IT CHANGED IN 0.14.1, AND THE COUNTERWEIGHT DID NOT ─────────
     *
     * This row read *"a live holder keeps it whoever asks"*, which WAS the rule: decision-table
     * rule 5 refused a local install a live cloud claim, authorized or not. That rule is deleted.
     * The person it stranded is the ordinary one — somebody who has lost access to the machine
     * their hosted organizer runs on — and the remedy it named requires the side that has gone.
     *
     * So the refusal is exercised with the thing that actually outranks a press: a NEWER press.
     * Here the holder was pressed for a minute ago and this install's request is an hour old — a
     * stamp somebody left on the row and never spent — so the later decision holds. The row below
     * is the other half, and it is the release itself.
     */
    const holderPressedAt = new Date(Date.now() - 60_000);
    const sidecar = await boot([41], 0, { holderPressedAt });   // heartbeat NOW — a live holder
    expect(sidecar.organizerState().organizing).toBe(false);

    await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(Date.now() - 3_600_000),
    });
    await sidecar.syncUntilQuiet();

    expect(
      sidecar.organizerState().organizing,
      "a live organizer's mailbox was seized because somebody pressed a button",
    ).toBe(false);
    expect(sidecar.organizerState().reason).toBe("organized_elsewhere:cloud");
    // The request was answered: the stamp is spent rather than left to be re-offered for ever.
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(row!.takeoverAuthorizedAt).toBeNull();
    // And the mailbox is still THEIRS — the reader wrote nothing to it.
    expect(wire.filter((w) => w.verb !== "setFlags")).toEqual([]);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  …AND A LIVE HOLDER NOBODY PRESSED FOR DOES NOT KEEP IT — this IS the 0.14.1 release
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The same live claim, renewing, with no press behind it — which is the steady state of every
   * mailbox that has simply been organized somewhere for a while. A person asks for THIS machine
   * and gets it.
   *
   * The sentence this row deletes was *"a live organizer's mailbox was seized because somebody
   * pressed a button"*, and the word doing the work there is "seized". It is not a seizure: a
   * human on a door they are signed into asked for it, the losing side becomes a reader that keeps
   * its mail, its credentials and its mirror, and one press on the other machine reverses it.
   */
  it("a live holder that nobody pressed for is TAKEN by a press", async () => {
    const sidecar = await boot([41]);          // heartbeat NOW, no press on the claim
    expect(sidecar.organizerState().organizing).toBe(false);

    expect((await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    })).outcome).toBe("authorized");
    await sidecar.syncUntilQuiet();

    expect(sidecar.organizerState().organizing,
      "the press was refused by a claim nobody pressed for — rule 5 is back").toBe(true);
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(row!.organizerRole).toBe("organizer");
    // One becoming, not a standing right.
    expect(row!.takeoverAuthorizedAt).toBeNull();
  });

  it("A PRESS THAT LANDS MID-PASS SURVIVES — the stand-down clears the stamp it READ, not the row", async () => {
    /*
     * The TOCTOU the round found. The gate reads the stamp, then reads the LEASE — a network round
     * trip against the user's own IMAP server, seconds on a bad day. A press landing inside that
     * window writes a stamp this pass never saw and never offered to the lease, and an
     * unconditional clear in the stand-down would erase it: the route answered `authorized`, the
     * person carried on working, and the request is gone with nothing anywhere saying so. The same
     * class as the defect this whole round is about — a press consumed by a pass that could not
     * act on it — one window narrower.
     *
     * Driven by writing the stamp DIRECTLY between the two reads. The gate cannot be paused from
     * out here, so the window is reproduced rather than raced for: a stamp written after the pass
     * that stood down had already read the row is, by construction, one it never observed.
     */
    // A LIVE holder WITH A PRESS newer than either of the two below, so both are refused and the
    // pass this window lives in is a stand-down. (0.14.1: liveness alone no longer refuses one.)
    const sidecar = await boot([41], 0, { holderPressedAt: new Date("2026-09-02T23:59:00Z") });
    expect(sidecar.organizerState().organizing).toBe(false);

    // A stood-down reader does not read the lease again on its own — the row's memory outranks
    // the folder, and that arm returns before any read — so the pass that CAN be caught mid-read
    // is one a press has authorized. The first press, outside any read, is what makes the next
    // pass read the lease at all; the press under test is the SECOND one, landing inside that
    // read. Two distinct instants, because the stand-down's clear compares the stamp it read.
    const first = new Date("2026-09-02T10:00:00Z");
    const second = new Date("2026-09-02T10:00:01Z");
    expect((await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: first,
    })).outcome).toBe("authorized");

    // THE PRESS LANDS INSIDE THE LEASE READ — after this pass read the stamp column (it was
    // `first`) and before the stand-down writes.
    let asked: string | null = null;
    onLeaseRead = async () => {
      const r = await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
        mailboxId: sidecar.world.mailboxId, now: second,
      });
      asked = r.outcome;
    };
    await sidecar.syncUntilQuiet();
    expect(asked, "the press did not land inside the lease read — the window was not reproduced")
      .toBe("authorized");

    const [after] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(
      after!.takeoverAuthorizedAt,
      "a press that landed mid-pass was erased by a stand-down that never offered it to the lease",
    ).not.toBeNull();
    expect(
      after!.takeoverAuthorizedAt!.getTime(),
      "the stand-down kept the stamp it offered instead of the one it never saw",
    ).toBe(second.getTime());

    // …and the NEXT pass is the one that spends it: it reads the stamp, offers it, and the live
    // holder refuses. Spent by an offer, never discarded by a pass that made none.
    await sidecar.syncUntilQuiet();
    const [settled] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(settled!.takeoverAuthorizedAt).toBeNull();
    expect(sidecar.organizerState().organizing).toBe(false);
    expect(sidecar.organizerState().reason).toBe("organized_elsewhere:cloud");
  });

  it("the profile hold is still ORGANIZER-ONLY, now that a reader reaches the line", () => {
    /*
     * A SOURCE ASSERTION, and it is here because the behavioural one CANNOT exist at this seam.
     * `armHoldFromFolder` runs inside `profileSync`, which reads the organizer profile through a
     * port this file's fake adapter does not implement — so it no-ops here whatever the gate says,
     * and mutating the gate away leaves every other test in this file green. Measured, not assumed.
     *
     * `organizing` is the drain's PARAMETER since `GATE-CACHED-ROLE-ON-DOUBLE-FAILURE`: the gate
     * reads the role once per pass and hands it down, so these gates cannot be re-decided mid-pass
     * by a stop, a hand-back or a failed poll rewriting the engine's cached record.
     *
     * The invariant is stated as a fact about THIS FILE in
     * `packages/services/src/profile-import-service.ts`: *"its cycle never arms the hold
     * (`engine.ts`, `index.ts` — both skip `armHoldFromFolder` for a reader)"*. While the whole
     * drain was gated that was true by accident; the drain is now reachable by a reader, so the
     * line needs its own gate and this is what keeps it.
     */
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    expect(
      /if\s*\(\s*organizing\s*\)\s*await\s+profileSync\.armHoldFromFolder\([^)]*\)/.test(src),
      "engine.ts arms the incoming-organizer hold on a drain a READER can now reach",
    ).toBe(true);
    /* AND THE GUARD IS NOW TWO FACTS, not one: organizer-only, and not a pass whose permit stood
       down during the drain. The second half has a behavioural case of its own in
       `lease-permit-stand-down-and-renew.test.ts`, whose adapter carries a profile io; this
       keeps the half that file cannot reach, which is the READER. */
    expect(
      /if\s*\(\s*organizing\s*&&\s*!permitStoodDown\s*\)\s*await\s+profileSync\.onOrganize\([^)]*\)/
        .test(src),
      "engine.ts publishes the portable profile on a drain a READER can now reach",
    ).toBe(true);
    /*
     * AND THE SCHEDULED-SEND PASS, for the same reason and with a sharper consequence. It runs
     * inside `drain` BEFORE the role-aware cycles, so it was organizer-only by being unreachable
     * too. `SyncDeps.role` names it explicitly among what a reader skips "at the composition roots
     * above this file", and this is one of those roots.
     *
     * A stand-down CLOSES the appointments it can no longer keep, but that close is best-effort
     * and may fail — so a due appointment can survive into a reader launch, and an ungated pass
     * would claim and SEND it from an install the mailbox's organizer knows nothing about.
     *
     * Source rather than behaviour, and the reason is measurable: the behavioural file for this
     * (`scheduled-send-stand-down.test.ts`) is red at HEAD for that change,
     * so un-gating the pass reddens nothing there that is not already red. A guard that cannot
     * distinguish is not a guard.
     */
    expect(
      /if\s*\(\s*organizing\s*\)\s*await\s+sendScheduled\([^)]*\)/.test(src),
      "engine.ts runs the scheduled-send pass on a drain a READER can now reach",
    ).toBe(true);
  });

  it("AND WRITES NOTHING ELSE — the exact set of verbs a reader asked the server for", async () => {
    // The counterweight. "The reader drains" is only safe next to this, and it is an EXACT SET
    // rather than a spot check: `ensureFolders` and `move` are the two the lease exists to
    // prevent, and a future third verb has to be added here deliberately.
    const sidecar = await boot([41, 42]);
    await sidecar.syncUntilQuiet();
    await sidecar.syncUntilQuiet();

    expect(
      [...new Set(wire.map((w) => w.verb))].sort(),
      "a reader wrote to somebody else's mailbox",
    ).toEqual([]);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  …AND IT WRITES NOTHING TO ITS OWN STORE EITHER — the half the verb census cannot see
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The exact-set assertion above records what a reader asked the MAIL SERVER for, and a pass
   * that writes only to this install's PGlite file asks the server for nothing at all. That is
   * how `resurfaceDue` sat ungated under ten green cases: it flips `message_state` from
   * `bubbled_up` to `resurfaced`, clears `bubbleUpAt` and records the pair of change rows a live
   * window pins on, and the wire stays empty while it does it. A stood-down install doing that is
   * the invariant broken in the way a person sees — mail surfacing on a device somebody moved
   * organizing OFF, beside the real organizer surfacing it again at its own hour.
   *
   * The subject is the drain a reader actually runs, with a booking whose hour has already
   * passed, and the verdict is the mirror compared with itself.
   */

  /** The tables that carry mail, its triage state and the feed a window pins on. */
  async function mirror(sidecar: Sidecar): Promise<string> {
    const [msg, states, changes] = await Promise.all([
      sidecar.db.select().from(messages),
      sidecar.db.select().from(messageStates),
      sidecar.db.select().from(changeLog),
    ]);
    // `seq` is a bigint and `JSON.stringify` throws on one, which would read as a failing case
    // rather than as an instrument that cannot run.
    return JSON.stringify({ msg, states, changes },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }

  /**
   * A booking whose hour passed while this install was away — the row `bubbleUpPass` selects.
   * Seeded directly because the route that writes one is a service door this file never opens,
   * and the fact under test is the COLUMN the due-scan reads.
   */
  async function bookInThePast(sidecar: Sidecar, messageId: string): Promise<string> {
    const [row] = await sidecar.db.insert(messageStates).values({
      accountId: sidecar.world.accountId,
      messageId,
      state: "bubbled_up",
      bubbleUpAt: new Date(Date.now() - 3_600_000),
    }).returning({ id: messageStates.id });
    return row!.id;
  }

  it("A RESURFACE DUE IN THE PAST IS NOT FLIPPED BY A READER — and the mirror does not move at all", async () => {
    const sidecar = await boot([41]);
    const [msg] = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    expect(msg, "nothing was mirrored, so there is no message to book").toBeTruthy();
    const stateId = await bookInThePast(sidecar, msg!.id);

    // The adapter handed its mail to the LAUNCH drain and answers empty from here on, so this
    // drain brings in nothing — anything that moves below was written by a pass, not by the post.
    const before = await mirror(sidecar);
    await sidecar.syncUntilQuiet();
    const after = await mirror(sidecar);

    const [state] = await sidecar.db.select().from(messageStates)
      .where(eq(messageStates.id, stateId));
    expect(
      state!.state,
      "a stood-down install resurfaced mail on its own — `resurfaceDue` ran outside the organizer "
        + "gate, so this device surfaces items in parallel with the mailbox's real organizer",
    ).toBe("bubbled_up");
    expect(
      state!.bubbleUpAt,
      "the booking's hour was cleared by an install that does not organize this mailbox",
    ).not.toBeNull();
    expect(
      after,
      "a reader's drain WROTE to its own store: compare the two snapshots — the account passes "
        + "the drain schedules are `resurfaceDue`, `suggestNew` and `backfillStoredNames`, and the "
        + "source census below says which of them is gated",
    ).toBe(before);
  });

  /**
   * THE POSITIVE CONTROL, and it is the reason the case above is a guard rather than a way of
   * turning the feature off. The same due booking, the same drain, the same file — with the
   * install ORGANIZING. The row flips, once.
   *
   * Organizing is reached the way a person reaches it: a claim whose heartbeat is two days old
   * against a one-day grace, and a press. That is the path the `PRESS WHILE RUNNING` case above
   * establishes, so the promotion here is not a new mechanism.
   */
  it("…AND AN ORGANIZER DOES FLIP IT — exactly once, on one drain", async () => {
    const sidecar = await boot([41], 2 * 24 * 3600 * 1000);
    const [msg] = await sidecar.db.select().from(messages)
      .where(eq(messages.mailboxId, sidecar.world.mailboxId));
    const stateId = await bookInThePast(sidecar, msg!.id);
    expect(sidecar.organizerState().organizing, "the precondition is a STOOD-DOWN install")
      .toBe(false);

    expect((await requestOrganizerTakeover(sidecar.db, { intent: "takeover",
      mailboxId: sidecar.world.mailboxId, now: new Date(),
    })).outcome).toBe("authorized");
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing, "the press did not promote this install").toBe(true);

    const [flipped] = await sidecar.db.select().from(messageStates)
      .where(eq(messageStates.id, stateId));
    expect(
      flipped!.state,
      "an ORGANIZER left a due booking standing — the gate refuses the pass it exists to admit",
    ).toBe("resurfaced");
    expect(flipped!.bubbleUpAt, "a date left on a resurfaced row is a second flip waiting")
      .toBeNull();

    // ONCE. A pass that fired again would re-stamp `setAt` and write a second pair of change rows,
    // which is a row jumping back to the top of somebody's Ohbox for no arrival.
    const changesFor = async (): Promise<number> => (await sidecar.db.select().from(changeLog)
      .where(eq(changeLog.entityId, stateId))).length;
    expect(await changesFor(), "the flip did not reach the feed, so no live window moved").toBe(1);
    await sidecar.syncUntilQuiet();
    const [again] = await sidecar.db.select().from(messageStates)
      .where(eq(messageStates.id, stateId));
    expect(again!.setAt.getTime(), "the same booking was flipped twice").toBe(flipped!.setAt.getTime());
    expect(await changesFor(), "a second drain wrote the flip again").toBe(1);
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  EVERY ACCOUNT PASS THE DRAIN SCHEDULES, ENUMERATED FROM THE SOURCE
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The behavioural case above is the verdict, and it cannot be the whole guard: a pass added
   * later may write nothing in THIS fixture's state — `suggestNew` returns at its first line with
   * no model configured — and would then be admitted by a green run for a reason that has nothing
   * to do with the gate. So the call sites are ENUMERATED rather than listed: the file is scanned
   * for the CALL through `source-scan.mjs` (comments, strings and templates blanked, positions
   * kept), and each one is either gated or named here with why it is not.
   *
   * Adding a pass without the gate therefore reddens this by construction — it is neither gated
   * nor named — which is the property the three hand-written regexes above do not have.
   *
   * WHY THE TWO UNGATED ONES ARE NOT THE SAME DEFECT, stated so the exemption is a judgment
   * somebody made rather than a hole:
   *  - `backfillStoredNames` fills UNSET columns on this install's own rows from message bytes
   *    already on this disk. It repairs presentation, decides nothing, and gating it would leave
   *    a demoted install showing bare addresses for ever — the class `reconcileStrandedSends` is
   *    deliberately ungated for.
   *  - `backfillSenderChecks` is `backfillStoredNames`' class: it fills the identity fact (mail
   *    0148) on this install's own rows, decides nothing and moves nothing, and a reader computes
   *    the same fact for every message it ingests.
   *  - `suggestNew` buys a Screener suggestion for senders that just arrived. It writes no triage
   *    state and surfaces nothing in the mailbox; a suggestion is this device's own answer to its
   *    own queue.
   * `resurfaceDue` is neither: it writes the triage state the mailbox's organizer owns.
   */
  it("every pass the drain schedules through `onceForTheAccount` is gated, or named here", () => {
    const src = withoutCommentsAndLiterals(
      readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8"),
    );
    /**
     * The passes this file has looked at and decided may run on a reader — see the block above.
     * `backfillListAddresses` is `backfillSenderChecks`' class: it records the addresses lists post
     * as (mail 0150) from `List-Post` values already on this disk, decides nothing and moves nothing,
     * and a reader records the same fact for every message it ingests.
     */
    const UNGATED_BY_DECISION = new Set([
      "suggestNew", "backfillStoredNames", "backfillSenderChecks", "backfillListAddresses",
    ]);

    const found: Array<{ pass: string; line: number; gated: boolean }> = [];
    const CALL = "onceForTheAccount(";
    for (let at = src.indexOf(CALL); at !== -1; at = src.indexOf(CALL, at + 1)) {
      const [start, end] = span(src, at + CALL.length - 1);
      const arg = src.slice(start, end).trim();
      // `foo` and `() => foo(...)` both name `foo`; the arrow header is stripped first so the
      // parameter list of a future `(x) => pass(x)` cannot be read as the pass.
      const pass = /^[A-Za-z_$][\w$]*$/.test(arg)
        ? arg
        : (/^\([^)]*\)\s*=>\s*([A-Za-z_$][\w$]*)/.exec(arg)?.[1] ?? arg);
      const line = lineOf(src, at);
      const text = src.split("\n")[line - 1]!.trim();
      found.push({ pass, line, gated: text.startsWith(`if (organizing) await ${CALL}`) });
    }

    // An enumeration that found nothing passes every assertion below it, which is the shape a
    // renamed scheduler would take — so the count is the first thing asserted.
    expect(found.length, "no `onceForTheAccount` call was found: the scheduler was renamed and "
      + "this census now measures nothing").toBeGreaterThanOrEqual(3);

    expect(
      found.filter((f) => f.pass === "resurfaceDue").map((f) => f.gated),
      "the scheduled-resurface pass runs on a drain a READER reaches: a stood-down install's "
        + "database is a frozen mirror and flipping rows there surfaces items in parallel with "
        + "the mailbox's real organizer",
    ).toEqual([true]);

    /* THE GAP CATCH-UP is scheduled exactly once, behind the gate: it files mail as
       the organizer, and a reader's drain must never reach it. */
    expect(found.filter((f) => f.pass === "gapCatchupDue").map((f) => f.gated)).toEqual([true]);

    expect(
      found.filter((f) => !f.gated && !UNGATED_BY_DECISION.has(f.pass))
        .map((f) => `${f.pass} (engine.ts:${f.line})`),
      "an account pass runs on a drain a READER reaches without the organizer gate. Either put it "
        + "behind `if (organizing) await onceForTheAccount(…)` like `resurfaceDue`, or add it to "
        + "`UNGATED_BY_DECISION` above with the reason a reader may run it",
    ).toEqual([]);
  });
});
