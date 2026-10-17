import fs, { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, MailboxAdapter, NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openLocalDb } from "../src/db.js";
import { forWindow } from "../src/store-lanes.js";

/**
 * A CHECKPOINT WAITS FOR THE WINDOW. It holds the engine's one thread, nearly all of it fsync: 0.4 to
 * 1.8 s on the 74k rig store, which a request waited out. A stall per fsync makes this small store's
 * disk a large one's; a request is timed from when it was asked, since a blocked loop fires late.
 * WATCHED FAILING: no `untilWindowQuiet` wait in `db.ts` (or the base): a request waits it out and the
 * ceiling case starts at once. No `deferMaxMs`: starved. Deadline taken at the gate, not the ask: a
 * ceiling late behind the handed-on fold. No `waiting`: the second ask runs its own. `onWait` never
 * told (or read before the chain, as the PR's first head did): a click after the ask holds the drain.
 */

/** A disk stall per fsync: what turns a small store's checkpoint into a 74k one's. */
const FSYNC_STALL_MS = 12;
/** A request answered in its own time, with room for a loaded runner; the stalled checkpoint is several times it. */
const ANSWER_BOUND_MS = 150;
const QUIET_MS = 300;
const PERSON_EVERY_MS = 60;
/** The drain of ten messages on the stalled disk; holding for its checkpoint keeps it past the person's 2.2 s. */
const DRAIN_BOUND_MS = 1_500;

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

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** A mailbox that hands over whatever `mail.owed` says, a page at a time, then is quiet. */
function mailbox(mail: { owed: number; next: number }): () => MailboxAdapter & { leaseIo(): LeaseIo } {
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
      const n = Math.min(mail.owed, 50);
      mail.owed -= n;
      const creates = Array.from({ length: n }, () => {
        const uid = mail.next++;
        return {
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${uid}` }, seen: false,
          raw: Buffer.from([`Message-ID: <window-${uid}@x>`, `From: s${uid % 30}@x.example`, "To: owner@trafficflow.test",
            `Subject: harbour ${uid}`, "Content-Type: text/plain", "", `harbour letter ${uid} `.repeat(60)].join("\r\n")),
        };
      });
      return { ...EMPTY, creates, hasBacklog: mail.owed > 0 };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

interface Span { at: number; ms: number }

/** The engine over a fresh store with mail in it, every CHECKPOINT statement timed where it reaches PGlite. */
async function launch(cleanups: Array<() => Promise<void> | void>, deferMaxMs: number) {
  const mail = { owed: 120, next: 1 };
  const spans: Span[] = [];
  /** Told as the drain asks for its checkpoint, before the store's chain reads the window. */
  const hooks: { onAsk: (() => void) | null } = { onAsk: null };
  const dataDir = await freshDataDir("ohmail-ckpt-window-");
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
    address: "owner@trafficflow.test",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    adapterFactory: mailbox(mail),
    searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
    store: async (dir, opts) => {
      const store = await openLocalDb(dir, { ...opts, upkeepGate: { quietMs: QUIET_MS, deferMaxMs } });
      const client = (store.db as unknown as { $client: Record<string, unknown> }).$client;
      for (const name of ["exec", "query"]) {
        const run = client[name] as (...a: unknown[]) => Promise<unknown>;
        client[name] = async function (this: unknown, ...a: unknown[]) {
          if (typeof a[0] !== "string" || !/^\s*CHECKPOINT\b/i.test(a[0])) return run.apply(this, a);
          const at = performance.now();
          try { return await run.apply(this, a); } finally { spans.push({ at, ms: performance.now() - at }); }
        };
      }
      const ask = store.checkpoint;
      return Object.assign(store, {
        checkpoint: (onWait?: () => void) => { hooks.onAsk?.(); return ask(onWait); },
      });
    },
    log: () => {},
  });
  cleanups.push(async () => {
    await sidecar.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await sidecar.start();
  await sidecar.syncUntilQuiet();

  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fsync = f.fsyncSync!;
  f.fsyncSync = function (this: unknown, ...a: unknown[]) {
    const end = performance.now() + FSYNC_STALL_MS;
    while (performance.now() < end) { /* the disk */ }
    return fsync.apply(this, a);
  };
  cleanups.push(() => { f.fsyncSync = fsync; });
  return { sidecar, mail, spans, hooks };
}

/** A person: a list or an open every {@link PERSON_EVERY_MS} for `forMs`, each timed from when it was asked. */
async function person(sidecar: Sidecar, forMs: number): Promise<{ waits: number[]; endedAt: number }> {
  const waits: number[] = [];
  const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
  const list = await (await sidecar.handle(new Request("http://sidecar/messages?view=all&limit=50", { headers: auth }))).json() as { items: Array<{ id: string }> };
  expect(list.items.length, "the store holds no mail to open").toBeGreaterThan(0);
  const ends = performance.now() + forMs;
  let asked = performance.now();
  for (let i = 0; asked < ends; i++) {
    const path = i % 2 === 0 ? "/messages?view=all&limit=50" : `/messages/${list.items[i % list.items.length]!.id}`;
    const res = await sidecar.handle(new Request(`http://sidecar${path}`, { headers: auth }));
    expect(res.status).toBe(200);
    await res.text();
    waits.push(performance.now() - asked);
    asked += PERSON_EVERY_MS;
    const ahead = asked - performance.now();
    if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
    else asked = performance.now();
  }
  return { waits, endedAt: performance.now() };
}

describe("the store's checkpoint and the window", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("answers a person's requests in their own time while a drain's checkpoint is due, and takes it once they pause", async () => {
    const { sidecar, mail, spans } = await launch(cleanups, 30_000);
    const before = spans.length;
    const browsing = person(sidecar, 2_500);
    await new Promise((r) => setTimeout(r, 300));
    mail.owed += 10;
    const drainAt = performance.now();
    await sidecar.syncUntilQuiet();
    const drainMs = performance.now() - drainAt;
    const { waits, endedAt } = await browsing;
    while (spans.length === before && performance.now() - endedAt < 10_000) await new Promise((r) => setTimeout(r, 25));

    const taken = spans.slice(before);
    expect(taken.length, "the drain's checkpoint never ran").toBeGreaterThan(0);
    expect(taken[0]!.ms, "the emulated disk did not make the checkpoint slow, so nothing here is measured")
      .toBeGreaterThan(ANSWER_BOUND_MS * 2);
    expect(Math.max(...waits), `requests waited ${waits.map((w) => w.toFixed(0)).join(", ")} ms`).toBeLessThan(ANSWER_BOUND_MS);
    expect(taken[0]!.at, "the checkpoint ran while the person was still asking").toBeGreaterThanOrEqual(endedAt);
    expect(drainMs, "the drain waited for the checkpoint it handed on").toBeLessThan(DRAIN_BOUND_MS);
  }, 120_000);

  it("takes the checkpoint at its ceiling, counted from the first ask, when the person never pauses", async () => {
    const DEFER_MAX_MS = 1_500;
    const { sidecar, mail, spans } = await launch(cleanups, DEFER_MAX_MS);
    const before = spans.length;
    const browsing = person(sidecar, 5_000);
    await new Promise((r) => setTimeout(r, 300));
    mail.owed += 10;
    const askedAt = performance.now();
    await sidecar.syncUntilQuiet();
    // A second drain asks again while the first checkpoint still waits; it joins that one.
    await new Promise((r) => setTimeout(r, 300));
    mail.owed += 10;
    await sidecar.syncUntilQuiet();
    const { endedAt } = await browsing;

    const taken = spans.slice(before).filter((sp) => sp.at < endedAt);
    expect(taken.length, "a person who never paused starved the checkpoint").toBeGreaterThan(0);
    expect(taken[0]!.at - askedAt, "the checkpoint did not wait for the window").toBeGreaterThanOrEqual(DEFER_MAX_MS - 100);
    expect(taken[0]!.at - askedAt, "the ceiling was not counted from the first ask").toBeLessThan(DEFER_MAX_MS + 1_000);
    expect(taken.length, "the second ask queued a checkpoint of its own behind the first").toBe(1);
  }, 120_000);
  it("releases the drain when a person's request starts after it asks and before its checkpoint's turn", async () => {
    const { sidecar, mail, spans, hooks } = await launch(cleanups, 30_000);
    let release = (): void => {};
    hooks.onAsk = () => {
      hooks.onAsk = null;
      void forWindow(() => new Promise<void>((r) => { release = r; }));
    };
    const before = spans.length;
    mail.owed += 10;
    const drainAt = performance.now();
    await sidecar.syncUntilQuiet();
    const drainMs = performance.now() - drainAt;
    const ranInside = spans.length - before;
    const releasedAt = performance.now();
    release();
    expect(hooks.onAsk, "the drain never asked for its checkpoint").toBeNull();
    expect(drainMs, "the drain waited for the checkpoint the person's request held").toBeLessThan(DRAIN_BOUND_MS);
    expect(ranInside, "the checkpoint ran inside the person's request").toBe(0);
    while (spans.length === before && performance.now() - releasedAt < 10_000) await new Promise((r) => setTimeout(r, 25));
    expect(spans.length, "the held checkpoint never ran once the window went quiet").toBeGreaterThan(before);
    expect(spans[before]!.at).toBeGreaterThanOrEqual(releasedAt + QUIET_MS - 50);
  }, 120_000);
});
