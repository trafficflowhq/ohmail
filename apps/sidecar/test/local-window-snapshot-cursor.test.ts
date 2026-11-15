import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, messageInstances, messages } from "@trafficflow/db";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, SNAPSHOT_REFUSAL_HOLD_BASE_MS, SnapshotCursorRefusedError,
  type EngineMessage, type SyncSnapshotPage,
} from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { STORE_GENERATION_FILE } from "../src/db.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE LOCAL WINDOW'S CURSOR AFTER A SNAPSHOT, over the real local door (PGlite, the shipped route
 * table) and the window's own engine as `bridge-fetch.ts` builds it. A store past its first run
 * refuses a delta cursor that names no run (`SyncService.assertSameStoreRun`), and a run ends
 * uncleanly whenever the previous launch left its record open (`readStoreGeneration`). The 0.22.0
 * adapter dropped the snapshot page's `storeGeneration`, so from the first unclean end on every
 * drain paid two 410s, a wipe and a whole snapshot (the Windows rig, 2026-09-22).
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return () => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(locator) { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

/** What the window asked the door, by route, and what the door answered. */
interface Wire { snapshots: number; pulls: number; refused410: number }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The previous launch's record left open — what a kill, a crash or a power loss leaves. */
function endRunUncleanly(dataDir: string, generation: number): void {
  writeFileSync(join(dataDir, STORE_GENERATION_FILE), JSON.stringify({ generation, open: true }));
}

async function boot(dataDir: string, lines: Array<[string, Record<string, unknown>]> = []): Promise<Sidecar> {
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
    address: "owner@trafficflow.test",
    machineName: "window host",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    adapterFactory: quietMailbox(),
    log: (event, detail) => { lines.push([event, (detail ?? {}) as Record<string, unknown>]); },
  });
  await sidecar.start();
  return sidecar;
}

async function newDataDir(): Promise<string> {
  const dataDir = await freshDataDir("ohmail-window-cursor-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** A few messages and one real change-log row, so the snapshot's seq is not zero. */
async function seed(sidecar: Sidecar): Promise<void> {
  const auth = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };
  const ids: string[] = [];
  for (let uid = 1; uid <= 3; uid++) {
    const dedup = `mid:window-${uid}@cursor.test`;
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageIdHeader: dedup,
      bodyHash: `hash-${uid}`, dedupKey: dedup, subject: `window ${uid}`, fromAddress: "someone@elsewhere.test",
      unread: true, nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageId: m!.id,
      folder: "INBOX", uidvalidity: 1n, uid, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external", reconcileStatus: "reconciled",
    });
    ids.push(m!.id);
  }
  const marked = await sidecar.handle(new Request("http://sidecar/messages", {
    method: "PATCH", headers: auth, body: JSON.stringify({ ids: [ids[0]], unread: false }),
  }));
  expect(marked.status).toBe(200);
}

/**
 * The window's engine over the door, counting what it asked, with the desktop's failure sink.
 * `door` is read per request so a relaunched engine is the same window's next door. `dropRun`
 * rebuilds each snapshot page the way the 0.22.0 adapter did — without `storeGeneration`.
 */
async function windowEngine(
  door: () => Sidecar, wire: Wire, opts: { dropRun?: boolean; now?: () => Date } = {},
): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore }> {
  const store = new MemoryMirrorStore();
  await store.load();
  const ask = async (url: string, init?: RequestInit): Promise<Response> => {
    const s = door();
    return s.handle(new Request(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${s.sessionToken}` },
    }));
  };
  const adapter = new HttpAdapter({
    baseUrl: "http://sidecar",
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/sync/snapshot") wire.snapshots += 1;
      if (path === "/sync") wire.pulls += 1;
      const res = await ask(url, init);
      if (path === "/sync" && res.status === 410) wire.refused410 += 1;
      return res;
    },
    syncFailureSink: async (record) => {
      await ask("http://sidecar/local/window/sync-failed", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
      });
    },
  });
  if (opts.dropRun) {
    const real = adapter.snapshot.bind(adapter);
    adapter.snapshot = async (params) => {
      const { storeGeneration: _dropped, ...page } = await real(params);
      return page as SyncSnapshotPage;
    };
  }
  return { engine: new OhmailEngine({ adapter, store, ...(opts.now ? { now: opts.now } : {}) }), store };
}

async function drains(engine: OhmailEngine, n: number, between: () => void = () => {}): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    try { await engine.syncOnce(); out.push("ok"); } catch (err) { out.push((err as Error).name); }
    between();
  }
  return out;
}

describe("the local window's cursor after a snapshot", () => {
  it("a store past its first run: the cursor its snapshot issues is accepted on the very next pull", async () => {
    const dataDir = await newDataDir();
    endRunUncleanly(dataDir, 1);
    const sidecar = await boot(dataDir);
    cleanups.push(() => sidecar.stop());
    await seed(sidecar);
    const wire: Wire = { snapshots: 0, pulls: 0, refused410: 0 };
    const { engine } = await windowEngine(() => sidecar, wire);
    expect(await drains(engine, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(wire).toEqual({ snapshots: 1, pulls: 4, refused410: 0 });
  });

  /** The positive control for the expiring event: a FIRST run admits a cursor naming no run. */
  it("a first run admits the run-less cursor, which is why the week before read no 410", async () => {
    const dataDir = await newDataDir();
    const sidecar = await boot(dataDir);
    cleanups.push(() => sidecar.stop());
    await seed(sidecar);
    const wire: Wire = { snapshots: 0, pulls: 0, refused410: 0 };
    const { engine } = await windowEngine(() => sidecar, wire, { dropRun: true });
    expect(await drains(engine, 3)).toEqual(["ok", "ok", "ok"]);
    expect(wire.refused410).toBe(0);
  });

  it("a run that ends uncleanly under a live window costs one 410 and one re-snapshot, then accepts", async () => {
    const dataDir = await newDataDir();
    let sidecar = await boot(dataDir);
    await seed(sidecar);
    const wire: Wire = { snapshots: 0, pulls: 0, refused410: 0 };
    const { engine, store } = await windowEngine(() => sidecar, wire);
    expect(await drains(engine, 1)).toEqual(["ok"]);
    await sidecar.stop();
    endRunUncleanly(dataDir, 1);
    sidecar = await boot(dataDir);
    cleanups.push(() => sidecar.stop());

    expect(await drains(engine, 3)).toEqual(["ok", "ok", "ok"]);
    expect(wire).toEqual({ snapshots: 2, pulls: 5, refused410: 1 });
    expect(store.entries<EngineMessage>("message").length).toBe(3);
  });

  /**
   * WATCHED RED at base: four drains asked for eleven snapshot pages and met eight 410s. The door
   * refuses the cursor its own snapshot issued (the 0.22.0 page shape at a second run), so the
   * window takes one snapshot, keeps its rows, names the refusal in the engine's log, and takes
   * no snapshot again until the hold ends.
   */
  it("a door refusing its own snapshot's cursor is answered once, not on every drain", async () => {
    const dataDir = await newDataDir();
    endRunUncleanly(dataDir, 1);
    const lines: Array<[string, Record<string, unknown>]> = [];
    const sidecar = await boot(dataDir, lines);
    cleanups.push(() => sidecar.stop());
    await seed(sidecar);
    const clock = { t: Date.now() };
    const wire: Wire = { snapshots: 0, pulls: 0, refused410: 0 };
    const { engine, store } = await windowEngine(() => sidecar, wire, { dropRun: true, now: () => new Date(clock.t) });

    const held = await drains(engine, 4, () => { clock.t += 10_000; });
    expect(wire, "each held drain is one refused pull and no snapshot").toEqual({ snapshots: 1, pulls: 4, refused410: 4 });
    expect(held).toEqual(Array(4).fill("SnapshotCursorRefusedError"));
    expect(store.entries<EngineMessage>("message").length, "the snapshot's rows were wiped").toBe(3);

    // The window's report reaches the engine's log under its own name.
    engine.reportSyncFailure(new SnapshotCursorRefusedError(), 1);
    await new Promise((r) => setTimeout(r, 50));
    const reported = lines.filter(([e]) => e === "window_sync_failed");
    expect(reported.map(([, d]) => d.reason)).toEqual(["snapshot_cursor_refused"]);

    // The hold ends: one 410 is answered by one snapshot again.
    clock.t += SNAPSHOT_REFUSAL_HOLD_BASE_MS;
    expect(await drains(engine, 1)).toEqual(["SnapshotCursorRefusedError"]);
    expect(wire.snapshots).toBe(2);
  });
});
