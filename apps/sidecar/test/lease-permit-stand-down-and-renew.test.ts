import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, MoveManyResult,
  NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  deriveRequestKey, formatClaim, formatRequest, isMalformed, parseClaim,
} from "@trafficflow/core/adapters/organizer-lease";
import type { OrganizerClaim } from "@trafficflow/core/adapters/organizer-lease";
import type {
  LeaseIo, RawClaimMessage, RawMetaMessage, MetaRecordsList, RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PERMIT'S LAST VERDICT IS WHAT DECIDES THE POST-DRAIN WRITES — not the class of a throw
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A drain carries a {@link LeasePermit} and asks it at every write boundary. When the mailbox
 * changes hands mid-drain the permit is REVOKED and throws. Two things then happen, and only one
 * of them was ever looked at:
 *
 *   • the throw LEAVES the cycle — the batched filing boundary is outside its own try, by design;
 *   • or it is SWALLOWED — `fileOne`, `reconcileFlags` and `folderOpsPass` each catch everything
 *     but a fence, so the cycle finishes and reports success.
 *
 * The gate after the drain decided on the class of the held throw. So the swallowed shape passed
 * it by construction — `cycleError` is null — and the propagating shape passed it too, because
 * the denylist named two other classes. Either way a stood-down install went on to apply,
 * acknowledge and EXPUNGE mailbox requests while the new organizer organized the same mailbox.
 *
 * The invariant these cases hold: A CYCLE WHOSE PERMIT STOOD DOWN MAY NOT WRITE. The gate reads
 * the permit's own last verdict, so both shapes are refused by one fact rather than by a list of
 * error classes that the swallowing paths can walk around.
 *
 * The second half of the file is the other end of the same nonce: a permit that RENEWS mid-drain
 * writes a new claim, and the runtime that goes on holding the old nonce reads its own renewal as
 * a second copy of itself on the next gate.
 */

/** The engine's clock, moved by hand so a permit's one-minute deadline is reachable in a test. */
let nowMs = Date.parse("2026-09-13T09:00:00.000Z");
const now = (): Date => new Date(nowMs);

const ADDRESS = "owner@trafficflow.test";
const PASSWORD = "not-dialled-password-password";
const RIVAL = "ohmail-cloud:production";

/** Every `ohmail/_meta` write this install asked the server for, in order. */
type Wire = string[];

/**
 * `ohmail/_meta` in memory, seen through the two accessors a real `ImapAdapter` exposes: the
 * lease's claim io and the organizer's request io. ONE folder, because that is what it is on the
 * server — the claim that authorizes a write and the records the write acts on live together, and
 * a fixture that splits them cannot show a write landing after the claim went.
 */
class MetaWorld {
  readonly wire: Wire = [];
  /** Reads, kept apart from {@link wire}: the subject is what this install WROTE. */
  leaseReads = 0;
  metaReads = 0;
  private claims: RawClaimMessage[] = [];
  private readonly records = new Map<number, string>();
  private nextUid = 1;
  /** Set once the rival has taken the mailbox — the index in {@link wire} it happened at. */
  standDownAt: number | null = null;
  /** The next claim APPEND commits and its answer is lost — a socket reset after the server took it. */
  loseAnswer = false;
  /** The next claim APPEND never reaches the server. */
  dropNext = false;

  /** THE TAKEOVER, as the winning install's own gate leaves the folder: our claims expunged and
   *  the winner's claim standing, stamped with the press it rests on. */
  transferToRival(): void {
    this.claims = [{
      ref: this.nextUid++,
      raw: formatClaim({
        authorizedAt: new Date(nowMs - 1_000), capabilities: ["requests"],
        installId: RIVAL, kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: new Date(nowMs), claimedAt: new Date(nowMs - 60_000), nonce: "rival",
      }),
    }];
    this.standDownAt = this.wire.length;
  }

  /** One reader's decision, waiting in the folder for the organizer to apply and acknowledge. */
  seedRequest(mailboxId: string, key: string): void {
    this.records.set(this.nextUid++, formatRequest({
      requestId: randomUUID(), kind: "screener.decide", mailboxId,
      installId: "reader-install", organizerKind: "local", decidedAt: new Date(nowMs - 5_000),
      payload: {
        scope: "sender", address: "person@example.test", appliedFolder: "INBOX", decision: "yes",
      },
      key,
    }));
  }

  /** A claim under `installId` and `nonce` that something renewed at `heartbeatMs`. */
  plantClaim(installId: string, nonce: string, heartbeatMs: number): void {
    this.claims.push({
      ref: this.nextUid++,
      raw: formatClaim({
        authorizedAt: null, capabilities: ["requests"], installId, kind: "local",
        displayName: "organizing host", heartbeat: new Date(heartbeatMs),
        claimedAt: new Date(heartbeatMs - 60_000), nonce,
      }),
    });
  }

  /** The claims standing in the folder right now, parsed. */
  liveClaims(): Array<{ installId: string; nonce: string }> {
    return this.claims
      .map((c) => parseClaim(c.raw, c.ref))
      .filter((c): c is OrganizerClaim => c !== null && !isMalformed(c))
      .map((c) => ({ installId: c.installId, nonce: c.nonce }));
  }

  /** What the wire recorded AFTER the mailbox changed hands — the whole subject of case 1. */
  writesAfterStandDown(): string[] {
    return this.standDownAt === null ? [] : this.wire.slice(this.standDownAt);
  }

  readonly lease: LeaseIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listClaims: async (): Promise<RawClaimMessage[]> => {
      this.leaseReads += 1;
      return this.claims.map((c) => ({ ...c }));
    },
    appendClaim: async (raw: string): Promise<void> => {
      this.wire.push("claim:append");
      if (this.dropNext) { this.dropNext = false; throw new Error("the socket closed before the APPEND reached the server"); }
      this.claims.push({ ref: this.nextUid++, raw });
      if (this.loseAnswer) { this.loseAnswer = false; throw new Error("the socket closed before the APPEND was answered"); }
    },
    removeClaims: async (refs: readonly unknown[]): Promise<void> => {
      this.wire.push(`claim:remove(${refs.length})`);
      const gone = new Set(refs);
      this.claims = this.claims.filter((c) => !gone.has(c.ref));
    },
    /** The generation, because `makeLeaseIo` always names one (`lease-io-doubles.test.ts`). */
    uidValidity: (): number => 4_100,
  };

  readonly organizer: RequestOrganizerIo = {
    listMetaRecords: async (): Promise<MetaRecordsList> => {
      this.metaReads += 1;
      const records: RawMetaMessage[] = [...this.records.entries()].map(([ref, raw]) => ({ ref, raw }));
      return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
    },
    uidValidity: (): number => 4_100,
    ack: async (raw: string): Promise<void> => {
      this.wire.push("meta:ack");
      this.records.set(this.nextUid++, raw);
    },
    remove: async (refs: readonly unknown[]): Promise<void> => {
      this.wire.push("meta:expunge");
      for (const r of refs) if (typeof r === "number") this.records.delete(r);
    },
    sweepStaleAcks: async (): Promise<number> => {
      this.wire.push("meta:sweep");
      return 0;
    },
  };

  /**
   * The settings document's own half of the same folder. Present so the publish is a REAL append
   * here: without it `onOrganize` returns at `hasProfileIo` and the guard on that line could not
   * be watched fail — a guard on a no-op is not evidence.
   */
  readonly profile: ProfileIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listProfileMessages: async (): Promise<RawProfileMessage[]> => [],
    appendProfile: async (raw: string): Promise<void> => {
      this.wire.push("profile:append");
      this.records.set(this.nextUid++, raw);
    },
    removeProfiles: async (refs: readonly unknown[]): Promise<void> => {
      this.wire.push("profile:expunge");
      for (const r of refs) if (typeof r === "number") this.records.delete(r);
    },
  };
}

/**
 * What each case wants the adapter to do while the cycle is running.
 *
 * ARMED BY THE TEST, never by a cycle count: `start()` is free to run one drain or several, and a
 * rig keyed on "the second `changesSince`" fired inside the launch on some runs and inside the
 * measured pass on others — the same file passing and failing with nothing changed. The test arms
 * the seam after the launch has settled, and the first cycle to see it armed spends it.
 */
interface Rig {
  meta: MetaWorld;
  /**
   * Spent by the first cycle that sees it: `age` moves the clock past the permit's deadline,
   * `age+transfer` also hands the mailbox to the rival at that same instant.
   */
  armed: "age" | "age+transfer" | null;
  /** Whether the adapter can batch a filing — the ONE difference between the two shapes. */
  batched: boolean;
  cycles: number;
  moves: number;
}

function rigAdapter(rig: Rig): (cfg: ImapConfig) => MailboxAdapter {
  const empty: ChangeBatch = {
    creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
  };
  /* THE INSTANT THE MAILBOX CHANGES HANDS, and it is inside the cycle deliberately: the whole
     defect lives between the gate that said organize and the write boundary that finds out. The
     cycle's first adapter call spends it — `capabilities()` when the drain files before its walk
     (that filing is the first boundary), else `changesSince`. */
  const spend = (): void => {
    const armed = rig.armed;
    rig.armed = null;
    if (armed !== null) nowMs += 61_000;
    if (armed === "age+transfer") rig.meta.transferToRival();
  };
  const adapter: MailboxAdapter & Record<string, unknown> = {
    leaseIo: () => rig.meta.lease,
    /* The reader's APPEND-less look, over the same folder: a stood-down install peeks every pass. */
    leasePeekIo: () => ({ listClaims: rig.meta.lease.listClaims }),
    requestOrganizerIo: () => rig.meta.organizer,
    profileIo: () => rig.meta.profile,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      spend();
      return {
        move: true, uidplus: true, condstore: true, qresync: false, idle: true,
        specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      rig.cycles += 1;
      spend();
      return { ...empty };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      rig.moves += 1;
      return { folder: toFolder, ref: locator.ref };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  } as MailboxAdapter & Record<string, unknown>;
  /* ── THE ONE CAPABILITY THAT DECIDES WHICH SHAPE THE REFUSAL TAKES ─────────────────────────
   *
   * With `moveMany` the filing goes through `fileChunk`, whose permit check sits OUTSIDE its try
   * so a refusal aborts the whole cycle — the shape the review traced. Without it the same
   * filing falls to `fileOne`, whose check is INSIDE a catch that swallows everything but a
   * fence — so the cycle reports success and the held error is null. Same stand-down, same
   * instant, two different things for a class-based gate to look at. */
  if (rig.batched) {
    adapter.moveMany = async (
      locators: readonly NativeLocator[], toFolder: string,
    ): Promise<MoveManyResult> => {
      rig.moves += locators.length;
      return {
        outcome: "batched", gone: [],
        moved: new Map(locators.map((l) => [l.ref, { folder: toFolder, ref: l.ref }])),
      };
    };
  }
  return () => adapter;
}

describe("a drain whose permit stood down writes nothing more to the mailbox", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  /** Every event the engine logged this case — the drain's own words about the pass. */
  let logged: string[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    nowMs = Date.parse("2026-09-13T09:00:00.000Z");
    logged = [];
  });

  async function boot(rig: Rig): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-permit-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: PASSWORD },
      },
      address: ADDRESS,
      machineName: "organizing host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 24 * 3600 * 1000,
      /* The settings publish is debounced five minutes by default, which would make it absent
         from every pass here for a reason that has nothing to do with the lease — a guard on a
         write that never happens is not a guard. Zero makes it due on every organizing pass, so
         its presence and its absence both mean what the case says they mean. */
      profileFlushIntervalMs: 0,
      adapterFactory: rigAdapter(rig),
      now,
      log: (event) => { logged.push(event); },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    /* The precondition every case shares: somebody agreed to organize on this install, and the
       claim folder is EMPTY — so the first gate organizes and the permit below is this install's
       own. Written on the column rather than through the consent route, which is another file's
       subject; only on a fresh store, so a case that boots twice keeps the row it earned. */
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(nowMs), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    /* ── TIME PASSES BETWEEN A LAUNCH AND A POLL, AND THE FIXTURE HAS TO SAY SO ──────────────
     *
     * With the clock held still, the launch claim and the next gate's renewal carry the SAME
     * heartbeat to the millisecond, `coalesce` breaks that tie on the nonce, and the confirm
     * reads whichever copy won as a live clone of this install — a self-stand-down at the gate,
     * one run in two, with nothing in the case reaching its own subject. That is the state
     * `MIN_PERMIT_TTL_MS` names, produced here by a frozen clock rather than by the product. */
    nowMs += 5_000;
    return sidecar;
  }

  /**
   * ONE FILING WAITING TO GO OUT — the write boundary the permit is asked at.
   *
   * Written as rows rather than driven through the pipeline because what this file is about
   * starts after the decision: a row whose desired folder differs from its observed one, set by
   * us, pending, with a locator. That is exactly what `listPendingFolderStates` queues.
   */
  async function seedPendingFiling(s: Sidecar, uid: number): Promise<void> {
    const dedup = `mid:permit-${uid}@rig.test`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${uid}`,
      dedupKey: dedup,
      subject: `filing ${uid}`,
      fromAddress: "person@example.test",
      snippet: "a short extract of the mail",
      nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
      createdAt: new Date(nowMs),
    }).returning();
    await s.db.insert(folderState).values({
      messageId: m!.id,
      observedFolder: "INBOX",
      desiredFolder: "ohmail/Screener",
      lastSetBy: "us",
      reconcileStatus: "pending",
    });
  }

  function freshRig(over: Partial<Rig> = {}): Rig {
    return { meta: new MetaWorld(), armed: null, batched: true, cycles: 0, moves: 0, ...over };
  }

  /**
   * THE HAND-OVER WAS RECORDED, which is more than "no throw came out". Both shapes end here: the
   * next pass's role is the GATE's own derived answer — read back off the engine after one more
   * drain, never derived in this file — and the drain wrote none of the lines a person is shown
   * "your sync failed" or "connection lost" over.
   */
  async function expectTheDrainRecordedAHandover(sidecar: Sidecar): Promise<void> {
    await sidecar.syncMailbox(sidecar.world.mailboxId);
    expect(
      sidecar.organizerState().organizing,
      "the losing install still says it organizes the mailbox somebody else took",
    ).toBe(false);
    expect(logged, "a hand-over was recorded as a failed cycle").not.toContain("sync_cycle_failed");
    expect(logged, "a hand-over was recorded as a dead connection")
      .not.toContain("mailbox_connection_unavailable");
  }

  /** The engine derives the same value from the same two facts; a null here is a broken rig. */
  const requestKey = (): string => {
    const key = deriveRequestKey({ auth: { user: ADDRESS, pass: PASSWORD }, address: ADDRESS });
    if (key === null) throw new Error("this rig's mailbox has no request key");
    return key;
  };

  it("THE REVIEW'S OWN SEQUENCE — the refusal leaves the cycle, and the channel still ran", async () => {
    const rig = freshRig({ batched: true });
    const sidecar = await boot(rig);
    expect(sidecar.organizerState().organizing, "the precondition: this install organizes").toBe(true);

    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    await seedPendingFiling(sidecar, 41);
    rig.armed = "age+transfer";

    /* The refusal LEAVES THE CYCLE — the filing boundary's check is outside its own try, by
       design — and the DRAIN is what answers it. This line used to require the throw to reach the
       caller, which on a MOVE-capable server (most of them) told a person who had just moved
       organizing to their other machine that their sync had failed. A hand-over is a state change
       the drain records, never a failure it reports; see `engine.ts`'s cycle loop and
       `stand-down-mid-drain-is-a-state-change.test.ts`. */
    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.meta.standDownAt, "the rival never took the mailbox").not.toBeNull();
    /* THE PERMIT REALLY REFUSED, and that is proved by the filing not happening: the boundary is
       asked before the IMAP command, so a move on the wire would mean the re-read never ran and
       these cases would be measuring nothing. */
    expect(rig.moves, "the filing went out — the permit was never asked, so nothing stood down")
      .toBe(0);
    expect(
      rig.meta.writesAfterStandDown(),
      "a stood-down organizer went on writing to a mailbox another install now organizes",
    ).toEqual([]);
    await expectTheDrainRecordedAHandover(sidecar);
  });

  it("AND THE SHAPE A CLASS-BASED GATE CANNOT SEE — the same refusal, swallowed", async () => {
    /*
     * Identical in every respect but one: no `moveMany`, so the filing falls to the per-message
     * path whose catch swallows everything but a fence. The permit is revoked all the same; the
     * cycle reports success; the held error is NULL. A gate that asks what class the throw was
     * has nothing to look at, which is why the fix cannot be another class in the list.
     */
    const rig = freshRig({ batched: false });
    const sidecar = await boot(rig);
    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    await seedPendingFiling(sidecar, 42);
    /* A SETTING THIS PASS WOULD PUBLISH. The write-behind appends only when the document it
       serializes has changed, so without this the settings publish is absent for a reason that
       has nothing to do with the lease and the guard on that line could not be watched fail. */
    await sidecar.db.update(mailboxes).set({ signature: "— sent from the organizing host" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    rig.armed = "age+transfer";

    // No throw: this is the point of the case.
    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.meta.standDownAt, "the rival never took the mailbox").not.toBeNull();
    expect(rig.moves, "the filing went out — the permit was never asked, so nothing stood down")
      .toBe(0);
    expect(
      rig.meta.writesAfterStandDown(),
      "the cycle swallowed its own stand-down and the post-drain writes went out anyway",
    ).toEqual([]);
    await expectTheDrainRecordedAHandover(sidecar);
  });

  it("POSITIVE CONTROL — an ordinary drain still applies and acknowledges the reader's decision", async () => {
    /*
     * Without this the two cases above would pass against a gate that refused every write, which
     * is the failure mode a refusal rule is most likely to ship as.
     */
    const rig = freshRig();
    const sidecar = await boot(rig);
    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    await seedPendingFiling(sidecar, 43);
    rig.armed = "age";
    const before = rig.meta.wire.length;

    await sidecar.syncMailbox(sidecar.world.mailboxId);

    const thisPass = rig.meta.wire.slice(before);
    expect(
      thisPass.filter((w) => w.startsWith("meta:")),
      "the request channel did not run at all on a pass that kept its lease",
    ).toContain("meta:ack");
    expect(thisPass).toContain("meta:expunge");
    /* AND THE SETTINGS PUBLISH, which is the other post-drain write and rides the same fact. Its
       presence here is what makes its absence above mean something. */
    expect(thisPass, "the profile publish never ran on a pass that kept its lease")
      .toContain("profile:append");
    expect(rig.moves, "the filing this pass was given never reached the mail server").toBe(1);
    expect(sidecar.organizerState().organizing, "this install lost the mailbox for no reason")
      .toBe(true);
  });
});

describe("a renewal this install performed is this install's own claim", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    nowMs = Date.parse("2026-09-13T09:00:00.000Z");
  });

  async function boot(rig: Rig): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-renew-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: PASSWORD },
      },
      address: ADDRESS,
      machineName: "organizing host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 24 * 3600 * 1000,
      /* The settings publish is debounced five minutes by default, which would make it absent
         from every pass here for a reason that has nothing to do with the lease — a guard on a
         write that never happens is not a guard. Zero makes it due on every organizing pass, so
         its presence and its absence both mean what the case says they mean. */
      profileFlushIntervalMs: 0,
      adapterFactory: rigAdapter(rig),
      now,
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(nowMs), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    /* ── TIME PASSES BETWEEN A LAUNCH AND A POLL, AND THE FIXTURE HAS TO SAY SO ──────────────
     *
     * With the clock held still, the launch claim and the next gate's renewal carry the SAME
     * heartbeat to the millisecond, `coalesce` breaks that tie on the nonce, and the confirm
     * reads whichever copy won as a live clone of this install — a self-stand-down at the gate,
     * one run in two, with nothing in the case reaching its own subject. That is the state
     * `MIN_PERMIT_TTL_MS` names, produced here by a frozen clock rather than by the product. */
    nowMs += 5_000;
    return sidecar;
  }

  async function seedPendingFiling(s: Sidecar, uid: number): Promise<void> {
    const dedup = `mid:renew-${uid}@rig.test`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${uid}`,
      dedupKey: dedup,
      subject: `filing ${uid}`,
      fromAddress: "person@example.test",
      snippet: "a short extract of the mail",
      nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
      createdAt: new Date(nowMs),
    }).returning();
    await s.db.insert(folderState).values({
      messageId: m!.id,
      observedFolder: "INBOX",
      desiredFolder: "ohmail/Screener",
      lastSetBy: "us",
      reconcileStatus: "pending",
    });
  }

  it("a drain driven past the permit's deadline keeps organizing, with ONE claim standing", async () => {
    /*
     * No rival anywhere in this case. The permit's deadline passes at a write boundary, so it
     * re-reads — and the re-read RENEWS: a new claim with a new nonce, the old one expunged. The
     * runtime that goes on holding the old nonce then reads its own renewal as another copy of
     * itself, stands ITSELF down, and leaves that fresh claim in the folder for the next install
     * to be refused by.
     */
    const rig: Rig = {
      meta: new MetaWorld(), armed: null, batched: false, cycles: 0, moves: 0,
    };
    const sidecar = await boot(rig);
    const atLaunch = rig.meta.liveClaims();
    expect(atLaunch.length, "the launch gate wrote no claim").toBe(1);
    await seedPendingFiling(sidecar, 51);
    rig.armed = "age";

    // The pass that crosses the deadline and renews.
    await sidecar.syncMailbox(sidecar.world.mailboxId);
    expect(rig.moves, "the filing never reached its write boundary, so no permit was asked")
      .toBe(1);
    const afterRenew = rig.meta.liveClaims();
    expect(afterRenew[0]!.nonce, "the permit did not renew — the deadline was never crossed")
      .not.toBe(atLaunch[0]!.nonce);
    expect(afterRenew.length, "the renewal left more than one claim standing").toBe(1);
    expect(afterRenew[0]!.installId, "the claim in the folder is not this install's").not.toBe(RIVAL);
    const renewedNonce = afterRenew[0]!.nonce;

    /* A poll interval, so this gate and the renewal above do not share one millisecond — see the
       note in `boot`. */
    nowMs += 5_000;
    // THE NEXT GATE. Nothing has changed hands; the only new fact is the nonce this install
    // itself wrote a moment ago.
    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(
      sidecar.organizerState().organizing,
      "this install read its own renewal as a second copy of itself and stopped organizing",
    ).toBe(true);

    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(row!.organizerRole, "the row was demoted by a stand-down against this install's own claim")
      .toBe("organizer");

    const settled = rig.meta.liveClaims();
    expect(settled.length, "the folder holds more than one claim of this install's").toBe(1);
    expect(settled[0]!.nonce, "the claim did not advance — the gate wrote nothing")
      .not.toBe(renewedNonce);
  });

  const freshRig = (): Rig => ({ meta: new MetaWorld(), armed: null, batched: false, cycles: 0, moves: 0 });
  const roleOf = async (s: Sidecar): Promise<string> => {
    const [row] = await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId));
    return row!.organizerRole;
  };
  /** One poll: a pass whose gate throws is a pass, the next one is the subject. */
  const poll = async (s: Sidecar): Promise<void> => {
    nowMs += 5_000;
    await s.syncMailbox(s.world.mailboxId).catch(() => undefined);
  };

  it("the poll gate's renewal commits and loses its answer; the next pass still organizes", async () => {
    const rig = freshRig();
    const sidecar = await boot(rig);
    expect(rig.meta.liveClaims().length, "the launch gate wrote no claim").toBe(1);
    rig.meta.loseAnswer = true;
    await poll(sidecar);
    expect(rig.meta.loseAnswer, "the gate never appended on this pass").toBe(false);
    expect(rig.meta.liveClaims().length, "the committed renewal is not in the folder").toBe(2);
    await poll(sidecar);
    expect({
      organizing: sidecar.organizerState().organizing,
      role: await roleOf(sidecar),
      heldBy: sidecar.organizerState().heldBy,
    }, "this install read its own committed renewal as another copy of itself")
      .toEqual({ organizing: true, role: "organizer", heldBy: null });
  });

  it("a committed renewal whose answer was lost, then one that never landed: still organizing", async () => {
    const rig = freshRig();
    const sidecar = await boot(rig);
    rig.meta.loseAnswer = true;
    await poll(sidecar);
    expect(rig.meta.liveClaims().length, "the committed renewal is not in the folder").toBe(2);
    rig.meta.dropNext = true;
    await poll(sidecar);
    expect(rig.meta.dropNext, "the second pass never appended").toBe(false);
    await poll(sidecar);
    expect({ organizing: sidecar.organizerState().organizing, role: await roleOf(sidecar) },
      "the attempt that never landed made this install forget the one that did")
      .toEqual({ organizing: true, role: "organizer" });
  });

  it("a live claim under our id we never wrote stands us down; at its lapse we take it back, no press", async () => {
    const rig = freshRig();
    const sidecar = await boot(rig);
    const ours = rig.meta.liveClaims()[0]!;
    rig.meta.plantClaim(ours.installId, "sibling-nonce", nowMs + 1_000);
    await poll(sidecar);
    expect({ organizing: sidecar.organizerState().organizing, role: await roleOf(sidecar) },
      "a live claim wearing our id under a nonce we never minted must still stand us down")
      .toEqual({ organizing: false, role: "reader" });
    // The sibling stops renewing; this rig's window is a day.
    nowMs += 25 * 3600 * 1000;
    await poll(sidecar);
    await poll(sidecar);
    const settled = rig.meta.liveClaims();
    expect({
      organizing: sidecar.organizerState().organizing,
      role: await roleOf(sidecar),
      claims: settled.length,
      sibling: settled.some((c) => c.nonce === "sibling-nonce"),
    }, "this install's own lapsed claim was never taken back").toEqual({
      organizing: true, role: "organizer", claims: 1, sibling: false,
    });
  });
});
