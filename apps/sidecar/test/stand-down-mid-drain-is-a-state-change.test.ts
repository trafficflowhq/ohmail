import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, MoveManyResult,
  NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  deriveRequestKey, formatClaim, formatRequest,
} from "@trafficflow/core/adapters/organizer-lease";
import type {
  LeaseIo, RawClaimMessage, RawMetaMessage, MetaRecordsList, RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A HAND-OVER IS A STATE CHANGE — the drain ENDS at its page, it does not FAIL
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `runSyncCycle` makes a mid-cycle stand-down terminal and throws it, which is what the hosted
 * worker's callers need: `reconcile-cron.ts` answers `OrganizerStandDownError` with its own
 * stand-down bookkeeping at three arms. On the LOCAL door nobody above answers it, so the throw
 * reached `syncUntilQuiet`'s catch — the idle ladder back to base, `sync_cycle_failed` from the
 * poll, and a refused press — and a person who moved organizing to their other machine was told
 * their sync had failed.
 *
 * These cases are about the door, not the cycle: the cycle's own refusal (no move, no flag, no
 * folder write past the page it stopped at) is `apps/worker/test/permit-through-the-cycle.test.ts`
 * and `apps/sidecar/test/lease-permit-stand-down-and-renew.test.ts`, and neither of them moves for
 * this. What is measured here is what the DRAIN does with it, and that an unreadable lease — the
 * other class the same boundary throws — is NOT given the same arm.
 */

/** The engine's clock, moved by hand so a permit's one-minute deadline is reachable in a test. */
let nowMs = Date.parse("2026-09-13T09:00:00.000Z");
const now = (): Date => new Date(nowMs);

const ADDRESS = "owner@trafficflow.test";
const PASSWORD = "mailbox-unreached-password";
const RIVAL = "ohmail-cloud:production";

/**
 * `ohmail/_meta` in memory, through the three accessors a real adapter exposes. ONE folder,
 * because that is what it is on the server: the claim that authorizes a write and the records the
 * write acts on live together, and a fixture that split them could not show a write landing after
 * the claim went.
 */
class MetaWorld {
  /** Every `ohmail/_meta` write this install asked the server for, in order. */
  readonly wire: string[] = [];
  /** Armed mid-cycle: every later claim read fails, which is what a dead socket looks like. */
  readsFail = false;
  private claims: RawClaimMessage[] = [];
  private readonly records = new Map<number, string>();
  private nextUid = 1;
  /** Set once the rival has taken the mailbox — the index in {@link wire} it happened at. */
  standDownAt: number | null = null;

  /** THE TAKEOVER, as the winning install's own gate leaves the folder. */
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

  /** What the wire recorded AFTER the mailbox changed hands. */
  writesAfterStandDown(): string[] {
    return this.standDownAt === null ? [] : this.wire.slice(this.standDownAt);
  }

  readonly lease: LeaseIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listClaims: async (): Promise<RawClaimMessage[]> => {
      if (this.readsFail) throw new Error("the connection to the mail server is gone");
      return this.claims.map((c) => ({ ...c }));
    },
    appendClaim: async (raw: string): Promise<void> => {
      this.wire.push("claim:append");
      this.claims.push({ ref: this.nextUid++, raw });
    },
    removeClaims: async (refs: readonly unknown[]): Promise<void> => {
      this.wire.push(`claim:remove(${refs.length})`);
      const gone = new Set(refs);
      this.claims = this.claims.filter((c) => !gone.has(c.ref));
    },
    uidValidity: (): number => 4_100,
  };

  readonly organizer: RequestOrganizerIo = {
    listMetaRecords: async (): Promise<MetaRecordsList> => {
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
 * What the adapter does while the cycle is running, armed by the test and spent by the first
 * cycle that sees it: `transfer` hands the mailbox to the rival at the instant the clock passes
 * the permit's deadline, `unreadable` takes the claim folder away at that same instant. Spent at
 * the cycle's first adapter call — `capabilities()` when the drain files before its walk, else
 * `changesSince` — because the whole subject lives between the gate that said organize and the
 * write boundary that finds out, and the first boundary is the filing before the walk.
 */
interface Rig {
  meta: MetaWorld;
  armed: "transfer" | "unreadable" | null;
  moves: number;
}

function rigAdapter(rig: Rig): (cfg: ImapConfig) => MailboxAdapter {
  const empty: ChangeBatch = {
    creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
  };
  const spend = (): void => {
    const armed = rig.armed;
    rig.armed = null;
    if (armed !== null) nowMs += 61_000;
    if (armed === "transfer") rig.meta.transferToRival();
    if (armed === "unreadable") rig.meta.readsFail = true;
  };
  const adapter: MailboxAdapter & Record<string, unknown> = {
    leaseIo: () => rig.meta.lease,
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
      spend();
      return { ...empty };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      rig.moves += 1;
      return { folder: toFolder, ref: locator.ref };
    },
    /* THE SERVER SHAPE MOST PEOPLE HAVE. With `moveMany` the filing goes through `fileChunk`,
       whose permit check sits outside its own try, so the refusal leaves the cycle as a throw —
       the path `lease-permit-stand-down-and-renew.test.ts`'s per-message case does not cover and
       the one a person on a MOVE-capable server takes. */
    async moveMany(
      locators: readonly NativeLocator[], toFolder: string,
    ): Promise<MoveManyResult> {
      rig.moves += locators.length;
      return {
        outcome: "batched", gone: [],
        moved: new Map(locators.map((l) => [l.ref, { folder: toFolder, ref: l.ref }])),
      };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  } as MailboxAdapter & Record<string, unknown>;
  return () => adapter;
}

describe("a stand-down mid-drain is a state change, not a failed drain", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    nowMs = Date.parse("2026-09-13T09:00:00.000Z");
  });

  /** Every line the engine logged this case, as event names. */
  const events = (lines: readonly string[]): string[] =>
    lines.map((l) => (JSON.parse(l) as { event?: string }).event ?? "");

  async function boot(rig: Rig, lines: string[]): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-standdown-");
    const logger = createSidecarLogger({ level: "info", sink: (l) => lines.push(l) });
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
      profileFlushIntervalMs: 0,
      adapterFactory: rigAdapter(rig),
      now,
      // BOTH sinks into one buffer: `log` is the engine's own two-argument seam (`sync_drain`,
      // `sync_cycle_failed`, `mailbox_connection_unavailable`) and `logger` is what the cycle
      // writes its `stood_down_mid_cycle` verdict through. A case reading only one of them could
      // not tell "the drain said nothing" from "the drain said it failed".
      log: diagnosticFor(logger),
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(nowMs), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    // Time passes between a launch and a poll, and the fixture has to say so: with the clock held
    // still the launch claim and the next gate's renewal carry one heartbeat and the confirm reads
    // the winner as a live clone of this install.
    nowMs += 5_000;
    return sidecar;
  }

  /** One filing waiting to go out — the write boundary the permit is asked at. */
  async function seedPendingFiling(s: Sidecar, uid: number): Promise<void> {
    const dedup = `mid:standdown-${uid}@rig.test`;
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

  const freshRig = (): Rig => ({ meta: new MetaWorld(), armed: null, moves: 0 });

  const requestKey = (): string => {
    const key = deriveRequestKey({ auth: { user: ADDRESS, pass: PASSWORD }, address: ADDRESS });
    if (key === null) throw new Error("this rig's mailbox has no request key");
    return key;
  };

  it("THE HAND-OVER — the press is answered, not refused, and the next pass reads as a reader", async () => {
    const rig = freshRig();
    const lines: string[] = [];
    const sidecar = await boot(rig, lines);
    expect(sidecar.organizerState().organizing, "the precondition: this install organizes")
      .toBe(true);

    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    await seedPendingFiling(sidecar, 51);
    rig.armed = "transfer";

    // THE WHOLE SUBJECT, in one line: a hand-over mid-drain is not a failed sync.
    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.meta.standDownAt, "the rival never took the mailbox").not.toBeNull();
    expect(rig.moves, "the filing went out — the permit was never asked, so nothing stood down")
      .toBe(0);
    expect(
      rig.meta.writesAfterStandDown(),
      "a stood-down organizer went on writing to a mailbox another install now organizes",
    ).toEqual([]);
    // WHAT THE DRAIN SAID. The cycle's own verdict, and none of the three lines a person is shown
    // "your sync failed" or "connection lost" over.
    expect(events(lines)).toContain("stood_down_mid_cycle");
    expect(events(lines), "a hand-over was filed as a failed cycle")
      .not.toContain("sync_cycle_failed");
    expect(events(lines), "a hand-over was filed as a dead connection")
      .not.toContain("mailbox_connection_unavailable");

    /* AND THE ROLE FOR THE NEXT PASS IS THE GATE'S OWN ANSWER — read back off the engine after a
       second drain rather than derived here. Nothing in the drain writes it: the gate re-reads the
       claim folder, finds the rival's claim standing, and answers reader. */
    await sidecar.syncMailbox(sidecar.world.mailboxId);
    expect(sidecar.organizerState().organizing, "the losing install still says it organizes")
      .toBe(false);
  });

  it("AND A LEASE THAT CANNOT BE READ IS NOT A HAND-OVER — the drain defers, nothing is demoted", async () => {
    /*
     * The other class the same boundary throws, and the reason the arm above names ONE class. An
     * unreadable lease is a question with no answer: it must keep leaving the drain, because that
     * is what counts toward the connection bound and what puts the mailbox's own unreadable state
     * on screen. One arm for both classes would turn every dead socket into a silent demotion.
     */
    const rig = freshRig();
    const lines: string[] = [];
    const sidecar = await boot(rig, lines);
    await seedPendingFiling(sidecar, 52);
    rig.armed = "unreadable";

    await expect(
      sidecar.syncMailbox(sidecar.world.mailboxId),
      "an unreadable lease left the drain as quietly as a hand-over",
    ).rejects.toBeInstanceOf(LeaseUnavailableError);

    expect(rig.moves, "a filing went out under a lease that could not be read").toBe(0);
    expect(
      sidecar.organizerState().organizing,
      "an unreadable lease demoted this install, which is a stand-down nobody asked for",
    ).toBe(true);
    expect(events(lines), "an unreadable lease was reported as a hand-over")
      .not.toContain("stood_down_mid_cycle");
  });

  it("POSITIVE CONTROL — an ordinary drain files its mail and keeps its lease", async () => {
    /*
     * Without this the two cases above would pass against a drain that refused every write, which
     * is the failure mode a refusal rule is most likely to ship as.
     */
    const rig = freshRig();
    const lines: string[] = [];
    const sidecar = await boot(rig, lines);
    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    await seedPendingFiling(sidecar, 53);

    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.moves, "the filing this pass was given never reached the mail server").toBe(1);
    expect(rig.meta.wire, "the request channel did not run on a pass that kept its lease")
      .toContain("meta:ack");
    expect(events(lines)).not.toContain("stood_down_mid_cycle");
    expect(sidecar.organizerState().organizing).toBe(true);
  });
});
