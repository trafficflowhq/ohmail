import { randomUUID } from "node:crypto";
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
import { mintMessageId, normalizeMessageId } from "@trafficflow/core/mail";
import { drafts, mailboxes, messages, outboundSends } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A SEND STRANDED ON THIS COMPUTER IS SETTLED BY THE DRAIN — the standalone half of that change
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS MISSING, AND WHY IT WAS INVISIBLE ────────────────────────────────────────────
 *
 * The reconciling pass for stranded send reservations shipped with a route on the API host and a
 * tick on the self-hosted server, and NO standalone hook. On this door a `pending` reservation —
 * what a quit or a crash between "SMTP accepted" and "we wrote it down" leaves behind — had
 * nothing that would ever look at it again: no cron, no clock, only the drain, and the drain did
 * not call it. The Drafts row said "Sending…" for ever.
 *
 * It also could not simply be added, and that is the part worth recording: `runSendReconcilePass`
 * was exported from `@trafficflow/services` only, while this app imports the MAIL entry point, so
 * the hook would not have compiled. That is why the desktop engine bundle measured byte-identical
 * before and after the slice that shipped the pass — nothing in the bundle could reach it. The
 * barrel export landed with the hook.
 *
 * ── THE MIRROR ARM, WHICH IS WHY THIS NEEDS NO NETWORK ────────────────────────────────────
 *
 * The pass resolves in two ways. The IMAP arm dials and probes the Sent folder; the MIRROR arm
 * asks whether this account's own store already holds a message carrying the minted `Message-ID`
 * — which it does whenever the Sent-folder watch got there first — and settles the reservation
 * with one indexed read and no connection at all. This file drives the mirror arm, so the mailbox
 * below throws on `send` and on `fetchPart` and is never legitimately asked for either.
 *
 * ── WHY PGLITE AND NOT :5433 ──────────────────────────────────────────────────────────────
 *
 * `resurface-drain.test.ts`'s reason verbatim: PGlite IS production on the desktop. `db.ts` opens
 * it on disk under the user's home and this opens the same store through the same `createSidecar`.
 * The claims PGlite cannot host — two resolvers racing one reservation — are not this door's and
 * are proved against real Postgres over the same function in
 * `packages/services/test/send-reconcile-race.pg.test.ts`.
 *
 * ── THE MUTATION ──────────────────────────────────────────────────────────────────────────
 *
 * Delete `await reconcileStrandedSends();` from `drain()` in `apps/sidecar/src/engine.ts` and the
 * first case goes red with the reservation still `pending` and the draft still `sending` — the
 * measured state a standalone install was left in. Run and restored.
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

/**
 * A mailbox that cannot send and cannot be dialled for a part. Both throws are assertions rather
 * than stubs: the mirror arm must settle this reservation without a network, and the pass's own
 * adapter wrapper must make `send` unreachable — the structural double-send proof.
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
      throw new Error("the reconciler must never send — its adapter's `send` is wrapped to throw");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
  return { factory, sends };
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("the standalone drain settles a send this install stranded", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-reconcile-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function boot(dir: string, mailbox: ReturnType<typeof quietMailbox>): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "this computer",
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      log: () => {},
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    // Somebody agreed to organize — the precondition for a drain, not the subject here.
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return sidecar;
  }

  /**
   * The shape a crash leaves: a `sending` draft and a `pending` reservation older than the
   * staleness cutoff, with the minted id already in this account's own mirror (the Sent-folder
   * watch got there first). That last part is what lets the mirror arm settle it with no dial.
   */
  async function strandOne(
    sidecar: Sidecar, opts: { mirrored?: boolean; ageMs?: number } = {},
  ): Promise<{ sendId: string; draftId: string; minted: string }> {
    const at = new Date(Date.now() - (opts.ageMs ?? 11 * MIN));
    const minted = mintMessageId("reconcile.test");
    const [d] = await sidecar.db.insert(drafts).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      subject: "the stranded one", body: "the words",
      to: [{ name: null, address: "you@example.com" }],
      status: "sending", createdAt: at, updatedAt: at,
    }).returning();
    const [s] = await sidecar.db.insert(outboundSends).values({
      accountId: sidecar.world.accountId, idempotencyKey: randomUUID(), draftId: d!.id,
      mintedMessageId: minted, status: "pending", createdAt: at,
    }).returning();

    if (opts.mirrored !== false) {
      // THROUGH THE REAL NORMALIZATION — `messages.message_id_header` stores the id with the
      // angle brackets STRIPPED, and seeding the bracketed form would make the mirror arm match
      // here and never in production. the own fixture records paying for exactly that.
      const header = normalizeMessageId(minted);
      expect(header, "the minted id must normalize to a storable header").not.toBeNull();
      expect(header, "and the stored form is not the minted spelling").not.toBe(minted);
      await sidecar.db.insert(messages).values({
        accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
        messageIdHeader: header!, bodyHash: randomUUID(), dedupKey: randomUUID(),
        subject: "the stranded one", fromAddress: "owner@trafficflow.test",
        nativeLocator: { folder: "Sent", ref: "1:7" },
      });
    }
    return { sendId: s!.id, draftId: d!.id, minted };
  }

  const sendRow = async (sidecar: Sidecar, id: string) =>
    (await sidecar.db.select().from(outboundSends).where(eq(outboundSends.id, id)))[0]!;
  const draftRow = async (sidecar: Sidecar, id: string) =>
    (await sidecar.db.select().from(drafts).where(eq(drafts.id, id)))[0]!;

  it("resolves a stranded reservation on the first drain, without dialling", async () => {
    const mailbox = quietMailbox(new MemoryMetaFolder());
    const sidecar = await boot(await dataDir(), mailbox);
    const s = await strandOne(sidecar);

    // Before: exactly the state a standalone install used to be left in for ever.
    expect((await sendRow(sidecar, s.sendId)).status).toBe("pending");
    expect((await draftRow(sidecar, s.draftId)).status).toBe("sending");

    await sidecar.syncUntilQuiet();

    expect((await sendRow(sidecar, s.sendId)).status).toBe("sent");
    // And nothing was sent to do it — the mirror arm is a read.
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  /**
   * THE HOOK IS NOT GATED ON ORGANIZING, and this is the case that says why in behaviour rather
   * than in a comment. The two hooks beside it ARE gated, because an appointment and an away reply
   * are mail leaving the mailbox on the organizer's behalf. This one settles a reservation THIS
   * install wrote, by reading — so an install demoted to reader between pressing send and dying
   * must still be able to finish the sentence. Gated, that person's draft would say "Sending…" for
   * ever, because the organizer's install has no reservation of theirs to find.
   */
  it("settles it even when this install is only a READER", async () => {
    const mailbox = quietMailbox(new MemoryMetaFolder());
    const sidecar = await boot(await dataDir(), mailbox);
    const s = await strandOne(sidecar);

    await sidecar.db.update(mailboxes)
      .set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));

    await sidecar.syncUntilQuiet();

    expect((await sendRow(sidecar, s.sendId)).status).toBe("sent");
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);

  /**
   * A reservation younger than the staleness cutoff belongs to an invocation that may still be
   * running, and taking it is how a live send gets resolved out from under itself. The cutoff is
   * the pass's, not this door's — asserted here because the drain is where it now applies.
   */
  it("leaves a FRESH reservation alone — the cutoff is what separates stranded from in-flight", async () => {
    const mailbox = quietMailbox(new MemoryMetaFolder());
    const sidecar = await boot(await dataDir(), mailbox);
    const s = await strandOne(sidecar, { ageMs: 30_000 });

    await sidecar.syncUntilQuiet();

    expect((await sendRow(sidecar, s.sendId)).status).toBe("pending");
    expect((await draftRow(sidecar, s.draftId)).status).toBe("sending");
  }, 60_000);

  /**
   * THE LAST RUN'S RESERVATION IS NOT IN FLIGHT, however fresh. This engine holds the data
   * directory alone (the lock), so a row already `pending` when it opened the store was left by a
   * process that is gone — a quit that closed the store before a send's finalize, or a crash. The
   * first drain settles it rather than leaving a delivered message "Sending…" for ten minutes.
   * The case above is the other half: a row THIS run made keeps the cutoff.
   */
  it("settles at the first drain a reservation the LAST run left pending, however fresh", async () => {
    const dir = await dataDir();
    const first = await boot(dir, quietMailbox(new MemoryMetaFolder()));
    const s = await strandOne(first, { ageMs: 30_000 });
    await first.stop();

    const mailbox = quietMailbox(new MemoryMetaFolder());
    const next = await boot(dir, mailbox);
    await next.syncUntilQuiet();

    expect((await sendRow(next, s.sendId)).status, "the next start left it for the stale window").toBe("sent");
    expect((await draftRow(next, s.draftId)).status).toBe("sent");
    expect(mailbox.sends).toHaveLength(0);
  }, 60_000);
});
