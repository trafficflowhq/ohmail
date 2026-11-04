import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar } from "../src/engine.js";
import { SEARCH_WARMUP_QUIET_MS, createSearchWarmup } from "../src/search-warmup.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE LAUNCH'S ONE WARM-UP SEARCH: armed by the first drain that comes back settled, never run
 * while a drain takes mail in, never twice, its answer dropped. The gate is driven with a counter
 * for a search; the wiring through the shipped engine with a mailbox that hands over a backlog.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function warmup(opts: { ingesting?: () => boolean; fail?: boolean; quietForMs?: () => number } = {}) {
  const lines: string[] = [];
  let calls = 0;
  const w = createSearchWarmup({
    search: async () => { calls += 1; if (opts.fail) throw new Error("store closed"); },
    ingesting: opts.ingesting ?? (() => false),
    quietForMs: opts.quietForMs ?? (() => Infinity),
    log: (event) => { lines.push(event); },
    waitMs: 5,
  });
  return { w, lines, calls: () => calls };
}

describe("the warm-up gate", () => {
  it("runs once on the first settled drain and never again in the launch", async () => {
    const g = warmup();
    expect(g.calls()).toBe(0);
    g.w.settled();
    await sleep(1);
    g.w.settled();
    g.w.settled();
    await sleep(1);
    expect(g.calls()).toBe(1);
    expect(g.lines).toEqual(["search_warmed"]);
    expect(g.w.state()).toBe("ran");
  });

  it("waits while a drain takes mail in, and runs once it stops", async () => {
    let ingesting = true;
    const g = warmup({ ingesting: () => ingesting });
    g.w.settled();
    await sleep(30);
    expect(g.calls(), "the warm-up ran while a drain was taking mail in").toBe(0);
    expect(g.w.state()).toBe("armed");
    ingesting = false;
    await sleep(30);
    expect(g.calls()).toBe(1);
  });

  it("a person who used the window in the last three seconds comes first: the launch skips it", async () => {
    let quiet = SEARCH_WARMUP_QUIET_MS - 1;
    const g = warmup({ quietForMs: () => quiet });
    g.w.settled();
    await sleep(1);
    quiet = Infinity;
    g.w.settled();
    await sleep(30);
    expect(g.calls(), "the warm-up took the store from a person using the window").toBe(0);
    expect(g.lines).toEqual(["search_warm_skipped"]);
    expect(g.w.state()).toBe("skipped");
    const idle = warmup({ quietForMs: () => SEARCH_WARMUP_QUIET_MS });
    idle.w.settled();
    await sleep(1);
    expect(idle.calls(), "three quiet seconds are enough").toBe(1);
  });

  it("a stopped launch never runs it, and a failed one is logged and not retried", async () => {
    const stopped = warmup({ ingesting: () => true });
    stopped.w.settled();
    stopped.w.stop();
    await sleep(30);
    expect(stopped.calls()).toBe(0);
    const failed = warmup({ fail: true });
    failed.w.settled();
    await sleep(1);
    failed.w.settled();
    await sleep(1);
    expect(failed.calls()).toBe(1);
    expect(failed.lines).toEqual(["search_warm_failed"]);
    expect(failed.w.state()).toBe("failed");
  });
});

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

/** `total` messages handed over `batch` at a time, then quiet: a first import's drain. */
function backloggedMailbox(total: number, batch: number): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  let served = 0;
  return () => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      const n = Math.min(batch, total - served);
      const creates = Array.from({ length: n }, (_, i) => {
        const uid = served + i + 1;
        return {
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${uid}` }, seen: false,
          raw: Buffer.from([`Message-ID: <warm-${uid}@x>`, `From: s${uid % 7}@x.example`, "To: owner@trafficflow.test",
            `Subject: msg ${uid}`, "Content-Type: text/plain", "", `message ${uid}`].join("\r\n")),
        };
      });
      served += n;
      return { creates, moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: served < total };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

describe("the shipped engine", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function launched(prefix: string) {
    const dataDir = await freshDataDir(prefix);
    const events: string[] = [];
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: backloggedMailbox(30, 10),
      log: (event: string) => { events.push(event); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    return { sidecar, events };
  }
  const settledLine = async (events: string[]) => {
    for (let i = 0; i < 100 && !events.some((e) => e.startsWith("search_warm")); i++) await sleep(50);
  };

  it("warms the search once, after the first drain has settled and never inside it", async () => {
    const { sidecar, events } = await launched("ohmail-search-warmup-");
    await sidecar.start();
    for (let i = 0; i < 100 && !events.includes("search_warmed") && !events.includes("search_warm_failed"); i++) await sleep(50);
    expect(events.filter((e) => e === "search_warm_failed")).toEqual([]);
    expect(events.filter((e) => e === "search_warmed"), "the settled launch never warmed its search").toHaveLength(1);
    expect(events.indexOf("search_warmed"), "the warm-up ran before the drain that took the mail had ended")
      .toBeGreaterThan(events.indexOf("sync_drain"));
  }, 120_000);

  it("a window read just before the first drain settles skips it for the launch", async () => {
    const { sidecar, events } = await launched("ohmail-search-warmup-person-");
    const read = await sidecar.handle(new Request("http://sidecar/messages?view=all&limit=5", { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));
    await read.text();
    expect(read.status, "the person's read never reached the door").toBe(200);
    await sidecar.start();
    await settledLine(events);
    expect(events.filter((e) => e.startsWith("search_warm")), "the warm-up ran over a person's read").toEqual(["search_warm_skipped"]);
  }, 120_000);
});
