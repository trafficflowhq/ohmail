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
import { auditLog, flagState, folderState, messageInstances, messages } from "@trafficflow/db";
import { HttpAdapter, OhmailEngine, type EngineMessage } from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

/* Every test here stands up its own PGlite store inside the test body — see the budget module. */
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE STANDALONE DOOR PUTS `\Seen` ON THE SERVER — the write-back the free tier owes.
 *
 * Reading a message in ohmail has to be reading it in the mailbox: open the same account in Apple
 * Mail or on a phone and the message must not be bold again. On a hosted account the always-on
 * worker is what keeps that true — `reconcileFlags` in `apps/worker/src/sync.ts` is the ONE code
 * path that adds the flag on a real server. A standalone install has no worker anywhere, so the
 * same promise is kept only if this process runs the same pass over its own mailbox.
 *
 * The API deliberately cannot open IMAP, so marking read is two facts written in one transaction
 * (`schema-mail.ts`, `flag_state`): `messages.unread`, which is what the window renders, and
 * `desired_seen`, which is what the reconciler owes the server. A door that writes the first and
 * never performs the second looks completely correct from inside the app and is wrong everywhere
 * else — and it stays wrong silently, because nothing in the app ever reads the mailbox's own
 * flag back.
 *
 * ── WHAT THIS TEST DRIVES ───────────────────────────────────────────────────────────────────
 *
 * A real standalone sidecar over on-disk PGlite (`createSidecar` — PGlite IS production on this
 * door), the real API route the desktop's client sends its read to, the real
 * `runSyncCycle`, and a mailbox adapter that RECORDS what the pass asked the server to do. The
 * adapter is the seam the engine already exposes for tests; everything above it is the shipped
 * path. The assertion is about the SERVER-facing call, not about a row in our own database,
 * because a row in our own database is exactly what was already right.
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
    wire.appendClaim += 1;
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

/** Every `\Seen` write the reconciler asked the server to perform. */
interface FlagWrite { locator: NativeLocator; seen: boolean | undefined }

/** What else the mailbox was asked, in order, and a hook in front of each STORE. */
const wire = {
  changesSince: 0, appendClaim: 0, events: [] as string[],
  beforeStore: null as ((seen: boolean | undefined) => Promise<void>) | null,
};

function recordingMailbox(sink: FlagWrite[]): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
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
      wire.changesSince += 1;
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    /* THE ASSERTION'S SUBJECT. `reconcileFlags` calls exactly this, and on a mailbox that is the
       user's own copy of their mail it is the only thing that makes a read durable. */
    async setFlags(locator: NativeLocator, flags: { seen?: boolean }): Promise<void> {
      await wire.beforeStore?.(flags.seen);
      sink.push({ locator, seen: flags.seen });
      wire.events.push(`setFlags ${String(flags.seen)}`);
    },
    async rearmWatch(): Promise<void> {
      wire.events.push("rearmWatch");
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

describe("the standalone door writes read-state back to the mailbox", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const flagWrites: FlagWrite[] = [];
  afterEach(async () => {
    flagWrites.length = 0;
    Object.assign(wire, { changesSince: 0, appendClaim: 0, events: [], beforeStore: null });
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-seen-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path — see the engine's
        // "NO PASSWORD, NO CONNECTION" branch.
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "seen host",
      // The poll timer never fires: every drain here is one this test asked for, so a write-back
      // is never a coincidence of scheduling.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: recordingMailbox(flagWrites),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    return sidecar;
  }

  /** One unread message sitting in the INBOX, with the locator a STORE needs to address it. */
  async function seedUnread(sidecar: Sidecar, subject: string, uid: number, folder = "INBOX"): Promise<string> {
    const dedup = `mid:${subject}@seen.test`;
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageIdHeader: dedup,
      bodyHash: `hash-${subject}`,
      dedupKey: dedup,
      subject,
      fromAddress: "someone@elsewhere.test",
      unread: true,
      nativeLocator: { folder, ref: `1:${uid}` },
    }).returning();
    /* A WATCHED INSTANCE, or the cycle's mail-0065 reaper tombstones a locator-bearing message
       with no `message_instances` row as mail the server no longer holds. */
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId,
      mailboxId: sidecar.world.mailboxId,
      messageId: m!.id,
      folder,
      uidvalidity: 1n,
      uid,
      isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id,
      desiredFolder: folder,
      observedFolder: folder,
      lastSetBy: "external",
      reconcileStatus: "reconciled",
    });
    return m!.id;
  }

  const auth = (s: Sidecar) => ({ authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" });

  it("marking a message read in the app sets \\Seen on the mailbox", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "please-read-me", 41);

    /* THE WIRE THE DESKTOP SENDS. `HttpAdapter`'s `mark_seen` mutation is one capped batch —
       `PATCH /messages { ids, unread }` — and this is that request, byte for byte, against the
       standalone engine's own route table. */
    const marked = await sidecar.handle(new Request("http://sidecar/messages", {
      method: "PATCH",
      headers: auth(sidecar),
      body: JSON.stringify({ ids: [id], unread: false }),
    }));
    expect(marked.status, await marked.text().catch(() => "")).toBe(200);

    // The read model moved — this half was never in doubt, and it is what the window renders.
    const [row] = await sidecar.db.select().from(messages).where(eq(messages.id, id));
    expect(row!.unread, "the app's own read model did not move").toBe(false);

    // And the INTENT was recorded, which is what the reconciler is owed.
    const [intent] = await sidecar.db.select().from(flagState).where(eq(flagState.messageId, id));
    expect(intent!.desiredSeen, "the read-state intent was not written").toBe(true);

    // The press's own push may already have settled it; a drain after it must not STORE again.
    await sidecar.syncUntilQuiet();

    /* THE CLAIM. Read in ohmail ⇒ `\Seen` in the mailbox. Without this the message is bold again
       in every other client the account is open in, and nothing in the app can tell. */
    expect(
      flagWrites.map((w) => ({ ref: (w.locator as { ref?: unknown }).ref, seen: w.seen })),
      "the standalone door never asked the mailbox to set \\Seen — read state stops at our own database",
    ).toEqual([{ ref: "1:41", seen: true }]);

    // …and the intent is settled, so a second drain does not re-STORE the same flag for ever.
    const [after] = await sidecar.db.select().from(flagState).where(eq(flagState.messageId, id));
    expect(after!.reconcileStatus).toBe("reconciled");
    expect(after!.observedSeen).toBe(true);
  });

  it("marking a message unread again sets the flag back off on the mailbox", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "read-then-not", 42);

    await sidecar.handle(new Request("http://sidecar/messages", {
      method: "PATCH", headers: auth(sidecar), body: JSON.stringify({ ids: [id], unread: false }),
    }));
    await sidecar.syncUntilQuiet();
    flagWrites.length = 0;

    await sidecar.handle(new Request("http://sidecar/messages", {
      method: "PATCH", headers: auth(sidecar), body: JSON.stringify({ ids: [id], unread: true }),
    }));
    await sidecar.syncUntilQuiet();

    /* The other direction is the same promise: putting a message back to unread here has to put
       it back to unread in the mailbox, or the two copies disagree and the server's own flag wins
       on the next inbound scan — the read snapping back that `applyExternalFlag`'s user-wins rule
       exists to prevent. */
    expect(
      flagWrites.map((w) => w.seen),
      "marking unread in the app never reached the mailbox",
    ).toEqual([false]);
  });

  /** The window's own client, composed as `createLocalEngine()` composes it, over the bridge. */
  function clientEngine(s: Sidecar): OhmailEngine {
    return new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "http://sidecar",
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return s.handle(new Request(new URL(href, "http://sidecar"), init));
        }) as unknown as typeof fetch,
        headers: () => ({ authorization: `Bearer ${s.sessionToken}` }),
      }),
      eagerBodies: true,
    });
  }

  it("a read taken in the CLIENT ENGINE — the window's own path — reaches the mailbox", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "engine-read", 43);

    /* Not the raw route this time: the real `OhmailEngine`, which is what the window actually
       drives. A mutation there is optimistic first and travels second, so this covers the half a
       direct `PATCH` cannot — that the intent leaves the window at all rather than sitting in the
       overlay as a flip nobody sent. */
    const engine = clientEngine(sidecar);
    await engine.start();
    expect(engine.store.get<EngineMessage>("message", id), "the message reached the window").toBeTruthy();

    await engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false });
    await sidecar.syncUntilQuiet();

    expect(
      flagWrites.map((w) => ({ ref: (w.locator as { ref?: unknown }).ref, seen: w.seen })),
      "a read taken in the window never reached the mailbox",
    ).toEqual([{ ref: "1:43", seen: true }]);
  });

  it("a GLANCE read — the per-message route a message open dispatches — reaches the mailbox", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "glance-read", 44);

    /* `feed_mark_seen` is what a message going by in a stream dispatches, and its wire side is
       `PATCH /messages/:id { unread: false, via: "glance" }` — a different route and a different
       service method from the batch above. A glance deliberately does NOT spend a resurface pin;
       what it must still do is owe the server the flag, because from the mailbox's point of view
       a message that has been read is a message that has been read. */
    const glanced = await sidecar.handle(new Request(`http://sidecar/messages/${id}`, {
      method: "PATCH",
      headers: auth(sidecar),
      body: JSON.stringify({ unread: false, via: "glance" }),
    }));
    expect(glanced.status, await glanced.text().catch(() => "")).toBe(200);

    await sidecar.syncUntilQuiet();

    expect(
      flagWrites.map((w) => ({ ref: (w.locator as { ref?: unknown }).ref, seen: w.seen })),
      "a glance read never reached the mailbox",
    ).toEqual([{ ref: "1:44", seen: true }]);
  });

  /* ── THE READ GOES OUT AT ONCE ───────────────────────────────────────────────────────────
     The boot polls hourly, so a STORE inside the bound can only come from the press's own push. */
  const BOUND = { timeout: 1_000, interval: 10 };
  const writes = () => flagWrites.map((w) => ({ ref: (w.locator as { ref?: unknown }).ref, seen: w.seen }));
  async function settle(s: Sidecar): Promise<void> {
    await s.syncUntilQuiet();
    flagWrites.length = 0;
    Object.assign(wire, { changesSince: 0, appendClaim: 0, events: [] });
  }
  const press = (s: Sidecar, path: string, body: unknown) => s.handle(new Request(`http://sidecar${path}`, {
    method: "PATCH", headers: auth(s), body: JSON.stringify(body),
  }));
  const intentOf = async (s: Sidecar, id: string) =>
    (await s.db.select().from(flagState).where(eq(flagState.messageId, id)))[0]!;

  it("a read reaches the mailbox within a second of the press, with no drain and no lease gate", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "prompt-read", 51);
    const glanced = await seedUnread(sidecar, "prompt-glance", 52);
    await settle(sidecar);

    expect((await press(sidecar, "/messages", { ids: [id], unread: false })).status).toBe(200);
    await vi.waitFor(async () => {
      expect(writes()).toEqual([{ ref: "1:51", seen: true }]);
      expect((await intentOf(sidecar, id)).reconcileStatus).toBe("reconciled");
    }, BOUND);

    // The glance route, `PATCH /messages/:id`, pushes the same way.
    expect((await press(sidecar, `/messages/${glanced}`, { unread: false, via: "glance" })).status).toBe(200);
    await vi.waitFor(() => expect(writes()).toEqual([{ ref: "1:51", seen: true }, { ref: "1:52", seen: true }]), BOUND);

    expect(wire.changesSince, "a drain carried the read, not the push").toBe(0);
    expect(wire.appendClaim, "the push renewed the organizer claim").toBe(0);
  });

  it("a read taken in the client engine reaches the mailbox within a second of the mutate", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "prompt-engine", 53);
    const engine = clientEngine(sidecar);
    await engine.start();
    await settle(sidecar);

    const pressedAt = performance.now();
    await engine.mutate({ kind: "mark_seen", messageIds: [id], unread: false });
    await vi.waitFor(() => expect(writes()).toEqual([{ ref: "1:53", seen: true }]), BOUND);
    expect(performance.now() - pressedAt).toBeLessThan(1_000);
    expect(wire.changesSince).toBe(0);
  });

  it("read then unread over a slow STORE: both go out in order and the last press wins", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "prompt-order", 54);
    await settle(sidecar);
    let entered = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    wire.beforeStore = async () => { entered += 1; if (entered === 1) await held; };
    try {
      expect((await press(sidecar, "/messages", { ids: [id], unread: false })).status).toBe(200);
      await vi.waitFor(() => expect(entered).toBe(1), BOUND);
      expect((await press(sidecar, "/messages", { ids: [id], unread: true })).status).toBe(200);
    } finally {
      release();
    }
    await vi.waitFor(async () => {
      expect(flagWrites.map((w) => w.seen)).toEqual([true, false]);
      const row = await intentOf(sidecar, id);
      expect([row.desiredSeen, row.observedSeen, row.reconcileStatus]).toEqual([false, false, "reconciled"]);
    }, BOUND);
  });

  it("the push puts the INBOX watch back after a STORE in another folder", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "prompt-archived", 55, "Archive");
    await settle(sidecar);

    expect((await press(sidecar, "/messages", { ids: [id], unread: false })).status).toBe(200);
    await vi.waitFor(() => expect(wire.events).toEqual(["setFlags true", "rearmWatch"]), BOUND);
  });

  it("a STORE the connection drops leaves the read owed, not deferred, and it goes out once on recovery", async () => {
    const sidecar = await boot();
    const id = await seedUnread(sidecar, "offline-read", 56);
    const flip = await seedUnread(sidecar, "offline-flip", 57);
    await settle(sidecar);
    let offline = true;
    let refused = 0;
    wire.beforeStore = async () => {
      if (!offline) return;
      refused += 1;
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    };

    expect((await press(sidecar, "/messages", { ids: [id], unread: false })).status).toBe(200);
    await vi.waitFor(() => expect(refused).toBe(1), BOUND);
    await sidecar.syncUntilQuiet();             // queued behind the push: it has finished
    const owed = await intentOf(sidecar, id);
    expect([owed.reconcileStatus, owed.attempts, owed.nextAttemptAt]).toEqual(["pending", 0, null]);
    const failed = (await sidecar.db.select().from(auditLog)).filter((a) => a.action === "reconcile.flags.failed");
    expect(failed, "an outage was booked as this letter's failure").toEqual([]);

    // Read then unread while still offline: nothing is owed for that letter.
    expect((await press(sidecar, "/messages", { ids: [flip], unread: false })).status).toBe(200);
    expect((await press(sidecar, "/messages", { ids: [flip], unread: true })).status).toBe(200);
    await sidecar.syncUntilQuiet();
    offline = false;
    await sidecar.syncUntilQuiet();

    expect(writes(), "after recovery: the owed read once, and nothing for the read taken back")
      .toEqual([{ ref: "1:56", seen: true }]);
  });
});
