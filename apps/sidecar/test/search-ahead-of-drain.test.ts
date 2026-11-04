import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { freshDataDir } from "./_datadir.js";
import {
  ImapAdapter, type ChangeBatch, type FetchedPart, type ImapCursor, type MailboxAdapter, type NativeLocator,
  type OutboundMessage, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { ingestIsRunning } from "../src/store-lanes.js";

/**
 * A SEARCH IS NEVER QUEUED BEHIND A DRAIN. The shipped drain over the shipped `ImapAdapter`, whose
 * client hands its rows over the way imapflow does under backpressure (a nextTick each, CPU spent on
 * each): a search typed while an idle drain enumerates the mailbox comes back within its own time
 * plus {@link OVER_BOUND_MS}. At the base it waited the enumeration out (+585 to
 * +774 ms on the Windows guest). Controls: the import before it lands every message once and in
 * order, and no page read while a drain runs is torn. Watched red: the turn removed from
 * `slicedFetch`, the door's search not marked as a person (`asPerson`).
 */
const OVER_BOUND_MS = 20;
const MESSAGES = 1_500;
const ROW_CPU_MS = 0.3;
const PROBES_PER_DRAIN = [20, 120, 260];
const IDLE_DRAINS = 3;
/* The server's HIGHESTMODSEQ. An unchanged folder is no longer read in full (PERF-026), so each
   measured drain moves it first: a flag touched elsewhere, the drain that still enumerates. */
let serverModseq = 50n;

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

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* the response parse */ }
}

const rawOf = (uid: number): Buffer => Buffer.from([`Message-ID: <drain-${uid}@x>`, `From: s${uid % 40}@x.example`,
  "To: owner@trafficflow.test", `Date: ${new Date(Date.UTC(2026, 0, 1, 0, 0, uid)).toUTCString()}`,
  `Subject: harbour note ${uid}`, "Content-Type: text/plain", "", `harbour letter ${uid}`].join("\r\n"));

/** An imapflow-shaped client over one INBOX of {@link MESSAGES}; `onEnumerate` sees each whole-folder read. */
function imapflowShapedClient(onEnumerate: () => void) {
  const box = { path: "INBOX", uidValidity: 100n, uidNext: MESSAGES + 1, highestModseq: 50n, exists: MESSAGES };
  return {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: box as typeof box | false,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      box.highestModseq = serverModseq;
      this.mailbox = path === "INBOX" ? box : { ...box, path, exists: 0, uidNext: 1, highestModseq: 0n };
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      if (this._path !== "INBOX" || options?.changedSince) return;
      const uids = (): number[] => (Array.isArray(range) ? range : String(range).split(",").map(Number));
      if (query?.source) {
        for (const uid of uids()) yield { uid, flags: new Set<string>(), envelope: { messageId: `<drain-${uid}@x>` }, source: rawOf(uid) };
        return;
      }
      if (query?.size) { for (const uid of uids()) yield { uid, size: rawOf(uid).length }; return; }
      onEnumerate();
      for (let uid = 1; uid <= MESSAGES; uid++) {
        await new Promise<void>((r) => process.nextTick(r));
        busy(ROW_CPU_MS);
        yield { uid };
      }
    },
  };
}

/** The shipped adapter over that client, behind the sidecar's adapter seam with an in-memory lease folder. */
function shippedAdapter(onEnumerate: () => void): () => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return () => {
    const real = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: imapflowShapedClient(onEnumerate) });
    return {
      leaseIo: () => meta,
      connect: () => real.connect(),
      async close(): Promise<void> {},
      capabilities: () => real.capabilities(),
      async ensureFolders(): Promise<void> {},
      changesSince: (cursor: ImapCursor): Promise<ChangeBatch> => real.changesSince(cursor),
      async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
    };
  };
}

interface Reading { overMs: number; ids: string[]; duringDrain: boolean }

/** One first page, timed at the door: what the window measures, less the server's own time. */
async function searchOnce(sidecar: Sidecar): Promise<Reading> {
  const duringDrain = ingestIsRunning();
  const t0 = performance.now();
  const res = await sidecar.handle(new Request("http://sidecar/search?q=harbour&parts=page&limit=50", {
    headers: { authorization: `Bearer ${sidecar.sessionToken}` },
  }));
  const wall = performance.now() - t0;
  expect(res.status).toBe(200);
  const body = await res.json() as { ms: number; items: Array<{ id: string }> };
  return { overMs: wall - body.ms, ids: body.items.map((m) => m.id), duringDrain };
}

describe("a search typed while a drain reads the mailbox", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("comes back within its own time plus a few ms, and the drain still lands everything", async () => {
    const pending: Array<Promise<Reading>> = [];
    let sidecarRef: Sidecar | null = null;
    let measuring = false;
    const factory = shippedAdapter(() => {
      if (!measuring || sidecarRef === null) return;
      const s = sidecarRef;
      for (const at of PROBES_PER_DRAIN) pending.push(new Promise((r) => setTimeout(r, at)).then(() => searchOnce(s)));
    });
    const dataDir = await freshDataDir("ohmail-search-ahead-of-drain-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const launch = async (): Promise<Sidecar> => {
      const s = await createSidecar({
        dataDir,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
        address: "owner@trafficflow.test",
        pollIntervalMs: 60 * 60 * 1000,
        leaseStaleAfterMs: 60_000,
        adapterFactory: factory,
        searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
        log: () => {},
      });
      await s.start();
      await s.syncUntilQuiet();
      return s;
    };
    // The import, then a RELAUNCH over its store: the measured drains are an installed app's idle
    // ones, with a scheduler that has not just watched the ingest take ten seconds of the store.
    await (await launch()).stop();
    const sidecar = await launch();
    cleanups.push(() => sidecar.stop());
    sidecarRef = sidecar;

    // THE IMPORT LANDED EVERYTHING, ONCE AND IN ORDER — the drain these searches will cut into.
    const rows = await sidecar.db.execute(sql`select id, message_id_header as mid from messages order by date asc`);
    const all = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Array<{ id: string; mid: string }>;
    expect(all.map((r) => r.mid)).toEqual(Array.from({ length: MESSAGES }, (_, i) => `drain-${i + 1}@x`));
    const idle = await searchOnce(sidecar);

    measuring = true;
    for (let i = 0; i < IDLE_DRAINS; i++) {
      serverModseq++;
      expect(await sidecar.syncUntilQuiet(), "an idle drain never ran").toBeGreaterThan(0);
    }
    const readings = await Promise.all(pending);
    measuring = false;

    const during = readings.filter((r) => r.duringDrain);
    expect(during.length, "no search was typed while a drain ran").toBeGreaterThanOrEqual(IDLE_DRAINS * 2);
    const worst = Math.max(...during.map((r) => r.overMs));
    expect(worst, `searches typed during a drain waited ${during.map((r) => r.overMs.toFixed(0)).join(", ")} ms `
      + `beyond their own time (idle: ${idle.overMs.toFixed(0)})`).toBeLessThanOrEqual(OVER_BOUND_MS);

    // NO TORN PAGE: every page read while a drain ran is whole and names rows the store holds.
    const known = new Set(all.map((r) => r.id));
    for (const r of readings) {
      expect(new Set(r.ids).size, "a page carried a row twice").toBe(r.ids.length);
      expect(r.ids.length, "a page came back short").toBe(50);
      for (const id of r.ids) expect(known.has(id), "a page named a row the store does not hold").toBe(true);
    }
    const after = await sidecar.db.execute(sql`select count(*)::int as n from messages`);
    const n = ((Array.isArray(after) ? after : (after as { rows: unknown[] }).rows) as Array<{ n: number }>)[0]!.n;
    expect(n, "an idle drain wrote or lost a message").toBe(MESSAGES);
  }, 300_000);
});
