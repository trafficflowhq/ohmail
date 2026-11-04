import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { changeLog, messageInstances, messages, messageStates } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LAUNCH WINDOW — A DUE BOOKING WAITS FOR THE FIRST POLL
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The resurfacing pass is scoped to the mailboxes this install ORGANIZES, and that set is read
 * through the runtime's `organizer` accessor, which is a mask that can only WITHHOLD: a claim
 * given up, a hand-back, a stop — and a poll timer not yet armed, which is the state the LAUNCH
 * drain runs in (`start()` arms the timer after the launch sequence returns). So a booking whose
 * hour passed while the app was closed is not flipped inside the launch; the first poll flips it,
 * ≤ `pollIntervalMs` later, and flips it once.
 *
 * That is a deliberate consequence of taking the mask rather than the raw gate answer, and it is
 * pinned here for one reason: it is invisible. Reading the raw field instead would flip at launch
 * and every other case in this suite would stay green, while an install that had just handed a
 * mailbox over would flip rows in it for one drain. With this case, that change is red.
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
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** A mailbox with nothing in it: every drain settles in one cycle and moves no mail of its own. */
function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter {
  const meta = new MemoryMetaFolder();
  return () => ({
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

describe("a due resurface across the launch window", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** The install, NOT started: the booking below is seeded before the launch drain ever runs. */
  async function make(): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-resurface-launch-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "launch window host",
      // Long enough that no timer fires by itself: every drain here is one this test asked for.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    // The door this file is about is one that organizes: a fresh row is a consent-less reader.
    await grantOrganizeConsent(sidecar);
    return sidecar;
  }

  /** A message put away until an hour that has already passed, with the instance the reaper wants. */
  async function seedDue(sidecar: Sidecar): Promise<string> {
    const dedup = "mid:launch-window@resurface.test";
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
      messageIdHeader: dedup, bodyHash: "hash-launch-window", dedupKey: dedup,
      subject: "until an hour that has passed", fromAddress: "someone@elsewhere.test",
      nativeLocator: { folder: "INBOX", ref: "1:7" },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageId: m!.id,
      folder: "INBOX", uidvalidity: 1n, uid: 7, isPrimary: true,
    });
    const [st] = await sidecar.db.insert(messageStates).values({
      accountId: sidecar.world.accountId, messageId: m!.id, state: "bubbled_up",
      bubbleUpAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning();
    return st!.id;
  }

  it("is left standing by the launch drain and flipped once by the first poll", async () => {
    const sidecar = await make();
    const stateId = await seedDue(sidecar);

    // THE LAUNCH. Its drain reaches the pass like any other, and the install does organize this
    // mailbox — the assertion below says so — so what withholds the flip is the launch window
    // itself: the poll timer is armed after this returns.
    await sidecar.start();
    expect(sidecar.organizerStates()[sidecar.world.mailboxId]?.organizing,
      "the install is not organizing after start — this case would then be measuring a reader")
      .toBe(true);

    const [atLaunch] = await sidecar.db.select().from(messageStates)
      .where(eq(messageStates.id, stateId));
    expect(atLaunch!.state,
      "the launch drain resurfaced a booking before the install had finished starting — the " +
      "scope is being read from something the launch window cannot withhold").toBe("bubbled_up");
    expect(atLaunch!.bubbleUpAt).not.toBeNull();

    // THE FIRST POLL — the same call the armed timer makes.
    await sidecar.syncUntilQuiet();

    const [afterPoll] = await sidecar.db.select().from(messageStates)
      .where(eq(messageStates.id, stateId));
    expect(afterPoll!.state, "the booking never came back at all").toBe("resurfaced");
    expect(afterPoll!.bubbleUpAt).toBeNull();

    // ONCE: the pair of changes one flip emits, and a second poll adds nothing.
    await sidecar.syncUntilQuiet();
    const changes = await sidecar.db.select().from(changeLog)
      .where(and(
        eq(changeLog.accountId, sidecar.world.accountId),
        eq(changeLog.entityId, stateId),
      ))
      .orderBy(asc(changeLog.seq));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.op).toBe("update");
  });
});
