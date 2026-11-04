import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, MetaFolderStamp, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messageInstances, messages, threads,
} from "@trafficflow/db";
import { runAwayResponderPass } from "@trafficflow/services";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ ONE REPLY PER MESSAGE, ACROSS TWO INSTALLS ═══════════════════════════════════════════
 * The away pass used to ask the CONNECTION whether a delivery was still this install's to make;
 * choose another organizer mid-pass and the healthy socket let every remaining reply go out
 * beside the new organizer's own. Both installs are real `createSidecar` runtimes over ONE
 * `ohmail/_meta`, so the handover runs through the production gate. TO WATCH IT FAIL: delete the
 * pass's ask at the dial (step 3c, `away-responder-pass.ts`) and the dial case sends a reply from
 * the install the mailbox has just left; drop `stillOrganizing` from `answerAway` and the first
 * case answers the second message twice — the measured defect.
 */

/** An in-memory `ohmail/_meta` shared by both installs, stamped the way an IMAP STATUS stamps it. */
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
  /* THE CHEAP HALF OF THE PERMIT'S QUESTION, and the reason this double can measure the fix at
     all: without it `movedSince()` answers "this connection cannot say" for ever, the permit never
     re-reads inside its TTL, and a handover lands on a receipt nothing asks about. A claim is an
     APPEND, so a claim raises `uidNext` — exactly what the server reports. */
  async stampMeta(): Promise<MetaFolderStamp> {
    return { uidValidity: 4_100, uidNext: this.nextUid, messages: this.claims.length };
  }

  /** The handover, written the way the product writes one: somebody pressed "Organize here". */
  async seedHandover(): Promise<void> {
    await this.appendClaim(formatClaim({
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "handover",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));
  }

  /** Everything released — the state an empty folder describes. */
  clear(): void {
    this.claims.length = 0;
  }
}

/**
 * The handover, landed at the ONE moment a reservation stands: the permit re-reads the folder's
 * stamp at each ask, and the first ask it makes while a `pending` row exists is the pass's own
 * ask at the dial. So the reservation is committed and nothing has been dialled.
 */
class HandoverAtTheDial extends MemoryMetaFolder {
  handedOver = false;
  constructor(private readonly reserved: () => Promise<boolean>) { super(); }
  override async stampMeta(): Promise<MetaFolderStamp> {
    if (!this.handedOver && await this.reserved()) {
      await this.seedHandover();
      this.handedOver = true;
    }
    return super.stampMeta();
  }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** The mailbox both installs dial: it reads the shared lease folder and records every send. */
function sharedMailbox(meta: MemoryMetaFolder, onSend?: () => Promise<void>) {
  const sends: OutboundMessage[] = [];
  type Dialled = MailboxAdapter & { leaseIo(): LeaseIo; messageInSent(): Promise<boolean> };
  const factory = (_cfg: ImapConfig): Dialled => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    forceClose(): void {},
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
    async messageInSent(): Promise<boolean> {
      return false;
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(m: OutboundMessage): Promise<SendResult> {
      sends.push(m);
      // The interleave, on the FIRST delivery only: the handover lands while the pass is running,
      // which is the one moment the connection check cannot see.
      if (onSend && sends.length === 1) await onSend();
      return {
        providerMessageId: `sent-${sends.length}`,
        sentLocator: { folder: "Sent", ref: `1:${sends.length}` },
        raw: Buffer.from("From: nobody\r\n\r\nsent"),
      };
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
  return { factory, sends };
}

const HOUR = 60 * 60 * 1000;
const ADDRESS = "owner@trafficflow.test";
const CORRESPONDENT = "writer@example.test";

describe("an away reply asks the lease at the send boundary", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(
    prefix: string, mailbox: ReturnType<typeof sharedMailbox>, lines: string[],
  ): Promise<Sidecar> {
    const dir = await freshDataDir(prefix);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: ADDRESS, pass: "mailbox-unreached-password" },
      },
      address: ADDRESS,
      machineName: prefix,
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      // A durable key, so the launch SEALS the password: without it there is no credential row and
      // every reply is `deferred` for want of a send path, which is a pass that measures nothing.
      keks: { 1: randomBytes(32) },
      log: (event: string) => { lines.push(event); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    // Somebody agreed to organize here: the precondition of every case, not part of what is tested.
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return sidecar;
  }

  /** A live responder that answers everybody in the Ohbox, one reply per message. */
  async function seedResponder(s: Sidecar): Promise<void> {
    await s.db.insert(awayResponders).values({
      accountId: s.world.accountId,
      enabled: true,
      enabledAt: new Date(Date.now() - 2 * HOUR),
      body: "Back Monday.",
      audience: "everyone",
      throttle: "always",
      piles: ["INBOX"],
    });
  }

  /** One arrived message, filed in the Ohbox — the shape `awayEligibility` admits. */
  async function seedArrival(s: Sidecar, key: string, at: Date): Promise<void> {
    const [t] = await s.db.insert(threads).values({
      accountId: s.world.accountId, rootMessageIdHeader: `<${key}@example.test>`,
    }).returning();
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      threadId: t!.id,
      messageIdHeader: `<${key}@example.test>`,
      bodyHash: `hash-${key}`,
      dedupKey: `dedup-${key}`,
      subject: `about ${key}`,
      fromAddress: CORRESPONDENT,
      snippet: "a short extract",
      nativeLocator: { folder: "INBOX", ref: `1:${key.length}` },
      date: at,
      createdAt: at,
    }).returning();
    await s.db.insert(messageBodies).values({ messageId: m!.id, text: "hello", headers: {} });
    await s.db.insert(folderState).values({
      messageId: m!.id, observedFolder: "INBOX", desiredFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled",
    });
    // The copy the server holds: without one the sync's reaper takes the letter as gone.
    await s.db.insert(messageInstances).values({
      accountId: s.world.accountId, mailboxId: s.world.mailboxId, messageId: m!.id,
      folder: "INBOX", uidvalidity: 1n, uid: key.length, isPrimary: true,
    });
  }

  /**
   * The Sent copy the mailbox now holds — what makes an answered thread visible to the OTHER
   * install. It is how one reply per message survives a handover at all: the ledger is per-install,
   * the mailbox is not.
   */
  async function ingestSentCopy(s: Sidecar, key: string, at: Date): Promise<void> {
    const [t] = await s.db.select().from(threads)
      .where(eq(threads.rootMessageIdHeader, `<${key}@example.test>`));
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      threadId: t!.id,
      messageIdHeader: `<reply-${key}@trafficflow.test>`,
      bodyHash: `hash-reply-${key}`,
      dedupKey: `dedup-reply-${key}`,
      subject: `Re: about ${key}`,
      fromAddress: ADDRESS,
      snippet: "Back Monday.",
      nativeLocator: { folder: "Sent", ref: `2:${key.length}` },
      date: at,
      createdAt: at,
    }).returning();
    await s.db.insert(messageBodies).values({ messageId: m!.id, text: "Back Monday.", headers: {} });
  }

  const OLDER = new Date(Date.now() - 30 * 60_000);
  const NEWER = new Date(Date.now() - 20 * 60_000);

  it("TWO INSTALLS — the lease moves mid-pass and each message is answered exactly once", async () => {
    const meta = new MemoryMetaFolder();
    const aLines: string[] = [];
    const bLines: string[] = [];

    // The second install is built and seeded first: the handover has to land from inside the first
    // install's own pass, which is the only moment this defect exists in.
    const second = sharedMailbox(meta);
    const b = await boot("ohmail-away-lease-b-", second, bLines);
    await seedResponder(b);
    await seedArrival(b, "first", OLDER);
    await seedArrival(b, "second", NEWER);

    let handedOver = false;
    /* Declared ahead of the hook that reads it: the hook runs inside the first install's own pass,
       which is after this binding is assigned. */
    let a: Sidecar;
    const first = sharedMailbox(meta, async () => {
      // The first reply has gone out, so the mailbox holds its Sent copy and both mirrors see it.
      await ingestSentCopy(a, "first", new Date());
      await ingestSentCopy(b, "first", new Date());
      // Somebody moves organizing to the other computer. The first install's socket is untouched.
      await meta.seedHandover();
      handedOver = true;
    });
    a = await boot("ohmail-away-lease-a-", first, aLines);
    await seedResponder(a);
    await seedArrival(a, "first", OLDER);
    await seedArrival(a, "second", NEWER);

    await a.start();
    await a.syncUntilQuiet();

    expect(handedOver, "the handover never ran — the first install sent nothing at all").toBe(true);
    expect(a.organizerState(), "the first install did not stand down").toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });

    // The mailbox moves on to the second install, which is what a person's other computer is.
    meta.clear();
    await b.start();
    await b.syncUntilQuiet();
    expect(b.organizerState().organizing, "the second install never took the mailbox").toBe(true);

    // ── ONE REPLY PER MESSAGE, COUNTED ACROSS BOTH INSTALLS ──────────────────────────────
    const answered = [...first.sends, ...second.sends].map((m) => m.subject);
    expect(answered.filter((s) => s === "Re: about first"),
      "the first message was answered more than once").toHaveLength(1);
    expect(answered.filter((s) => s === "Re: about second"),
      "both installs answered the second message — the defect this file exists for").toHaveLength(1);
    // And each was answered by the install that held the mailbox at the time.
    expect(first.sends.map((m) => m.subject)).toEqual(["Re: about first"]);
    expect(second.sends.map((m) => m.subject)).toEqual(["Re: about second"]);

    // The pass ended by name, on the loser's own log.
    expect(aLines.filter((e) => e === "away_responder_stood_down"),
      "the refusal was not recorded once").toHaveLength(1);


    /* ── AND THE LOSER SPENT NOTHING ON THE REPLY IT WITHHELD ────────────────────────────
     * One row, for the message it did answer. The refusal is asked BEFORE the reservation, so
     * the second message has no ledger row on this install at all — it is still a candidate
     * here, which is what the comeback case below spends. */
    const aRows = await a.db.select().from(awayReplies);
    expect(aRows.map((r) => r.outcome),
      "the losing install spent a reservation on a reply it never sent").toEqual(["sent"]);
  }, 120_000);

  it("THE MAILBOX COMES BACK — the reply the loser withheld is still owed, and still goes", async () => {
    /* ═══ THE ROW THIS FILE'S SECOND HALF EXISTS FOR ═══════════════════════════════════════
     * A refusal AFTER the reservation is spent used to record the reply `unverified` in the losing
     * install's own ledger and never offer it again THERE (the dial case below: it now releases). It costs nothing while the install
     * that took the mailbox answers the message — and it costs the correspondent their reply the
     * moment that install answers nothing and the mailbox comes back. Nobody else is booted here
     * on purpose: the handover is written into the shared folder the way the product writes one,
     * and then released, which is what a person moving organizing away and back again does. */
    const meta = new MemoryMetaFolder();
    const lines: string[] = [];
    const mailbox = sharedMailbox(meta, async () => { await meta.seedHandover(); });
    const a = await boot("ohmail-away-comeback-", mailbox, lines);
    await seedResponder(a);
    await seedArrival(a, "first", OLDER);
    await seedArrival(a, "second", NEWER);

    await a.start();
    await a.syncUntilQuiet();

    // The handover landed inside the pass, from its own first delivery.
    expect(a.organizerState(), "the install did not stand down").toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });
    expect(mailbox.sends.map((m) => m.subject)).toEqual(["Re: about first"]);
    expect(lines.filter((e) => e === "away_responder_stood_down"),
      "the stand-down was recorded more than once").toHaveLength(1);

    // Nothing was spent on the message it withheld — one row, for the one reply it sent.
    expect((await a.db.select().from(awayReplies)).map((r) => r.outcome)).toEqual(["sent"]);
    const [withheld] = await a.db.select({ deletedAt: messages.deletedAt }).from(messages)
      .where(eq(messages.subject, "about second"));
    expect(withheld?.deletedAt ?? null, "the precondition: the withheld letter is still on the server").toBeNull();

    /* AND THE REPLY IS STILL OWED. The state above was produced by the REAL lease adapter over a
       real handover; this runs the same shared pass over the store it left behind. The mailbox is
       put back to `organizer` because the stand-down demoted it, and TAKING A MAILBOX BACK is the
       lease gate's own act rather than this pass's — driving that gate over a memory claim folder
       is `organizer-lease`'s subject and is not measured here. At base this sends nothing whatever
       the role says: the withheld reply's ledger row is already `unverified` and terminal, so the
       correspondent stays unanswered for as long as nobody else answers them. */
    meta.clear();
    await a.db.update(mailboxes).set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, a.world.mailboxId));
    const later: OutboundMessage[] = [];
    const out = await runAwayResponderPass(a.db as never, {
      openSendAdapter: async () => ({
        send: async (m: OutboundMessage) => { later.push(m); return { providerMessageId: "p-1" }; },
        messageInSent: async () => false,
        close: async () => {},
      }) as never,
      mailboxIds: [a.world.mailboxId],
    });

    expect(later.map((m) => m.subject),
      "the reply the loser withheld is gone — the correspondent is never answered here again")
      .toEqual(["Re: about second"]);
    expect(out.sent).toBe(1);
    expect(out.refusedNotOrganizer,
      "a pass with no lease question refused anyway").toBe(0);
  }, 120_000);

  it("THE DIAL — a handover after the reservation releases it, and the reply goes out once", async () => {
    let a: Sidecar;
    const meta = new HandoverAtTheDial(async () =>
      (await a.db.select().from(awayReplies).where(eq(awayReplies.outcome, "pending"))).length > 0);
    const aLines: string[] = [];
    const bLines: string[] = [];
    const first = sharedMailbox(meta);
    const second = sharedMailbox(meta);
    const b = await boot("ohmail-away-dial-b-", second, bLines);
    await seedResponder(b);
    await seedArrival(b, "first", OLDER);
    await seedArrival(b, "second", NEWER);
    a = await boot("ohmail-away-dial-a-", first, aLines);
    await seedResponder(a);
    await seedArrival(a, "first", OLDER);
    await seedArrival(a, "second", NEWER);

    await a.start();
    await a.syncUntilQuiet();

    expect(meta.handedOver, "the handover never landed at the dial").toBe(true);
    expect(a.organizerState()).toMatchObject({ organizing: false, reason: "organized_elsewhere:cloud" });
    expect(first.sends, "the install the mailbox had just left sent a reply").toEqual([]);
    // RELEASED: no ledger row and no throttle state for the reply it withheld.
    expect(await a.db.select().from(awayReplies), "the loser kept a reservation").toEqual([]);
    expect(await a.db.select().from(awaySenderState), "the loser kept the person's throttle").toEqual([]);

    meta.clear();
    await b.start();
    await b.syncUntilQuiet();
    const answered = [...first.sends, ...second.sends].map((m) => m.subject).sort();
    expect(answered, "a message was answered twice, or not at all").toEqual(
      ["Re: about first", "Re: about second"],
    );
  }, 120_000);

  it("THE ORDINARY PASS — a held lease answers every candidate it should", async () => {
    const meta = new MemoryMetaFolder();
    const lines: string[] = [];
    const mailbox = sharedMailbox(meta);
    const a = await boot("ohmail-away-held-", mailbox, lines);
    await seedResponder(a);
    await seedArrival(a, "first", OLDER);
    await seedArrival(a, "second", NEWER);

    await a.start();
    await a.syncUntilQuiet();

    expect(a.organizerState().organizing).toBe(true);
    expect(mailbox.sends.map((m) => m.subject),
      "a pass holding its lease withheld a reply it owed").toEqual(
      ["Re: about first", "Re: about second"],
    );
    expect(lines).not.toContain("away_responder_stood_down");
  }, 120_000);
});
