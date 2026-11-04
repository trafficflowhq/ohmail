import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, MailboxAdapter, NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar } from "../src/engine.js";
import {
  CREDIT_BURST_MS, INGEST_GAP_TURNS, INGEST_LANE_WEIGHT, createStoreScheduler, forPerson, inStoreLane,
  onPersonEdge,
} from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A PERSON GOES FIRST, AND THE DRAIN WAITS FOR THEM. A search's statements are admitted at once,
 * with no turn and no hold for the ingest, and an ingest statement queued while the search is in
 * flight runs when it ends — or at {@link PERSON_HOLD_MAX_MS}, whichever is first. The door marks
 * a search as a person and nothing else. Fake clock and fake statements, as in `store-lanes.test.ts`;
 * the reading on the real store is `search-ahead-of-drain.test.ts`'s. Watched red: the person branch
 * removed from `dispatch` or from `pump`, the bound ignored, the held ingest admitted, the door's
 * mark removed.
 */
const drains: Array<() => void> = [];
afterEach(() => { for (const release of drains.splice(0)) release(); });

function world(holdMaxMs?: number) {
  let release!: () => void;
  void inStoreLane("ingest", () => new Promise<void>((r) => { release = r; }));
  drains.push(release);
  let now = 0;
  const ran: string[] = [];
  const s = createStoreScheduler(
    { ingest: INGEST_LANE_WEIGHT, interactive: 1 }, () => now, CREDIT_BURST_MS, INGEST_GAP_TURNS, holdMaxMs,
  );
  const stmt = (lane: "ingest" | "interactive", ms: number, tag: string = lane): Promise<void> =>
    s.run(lane, async () => { ran.push(tag); await Promise.resolve(); now += ms; });
  return { ran, stmt, advance: (ms: number) => { now += ms; } };
}

/** Turns of the loop while `work` runs. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0;
  let probing = true;
  const probe = (): void => { setImmediate(() => { if (!probing) return; turns++; probe(); }); };
  probe();
  await work();
  probing = false;
  return turns;
}

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("a person's statements and the ingest", () => {
  it("serves a person at once where a reader ahead of its share is held for the ingest", async () => {
    const reader = world();
    for (let i = 0; i < 20; i++) await reader.stmt("interactive", 1);
    await reader.stmt("ingest", 9);
    const held = await turnsDuring(() => reader.stmt("interactive", 1));
    expect(held, `the control reader waited ${held} turns, so nothing is held here`).toBeGreaterThanOrEqual(INGEST_GAP_TURNS - 1);

    const person = world();
    for (let i = 0; i < 20; i++) await person.stmt("interactive", 1);
    await person.stmt("ingest", 9);
    const waited = await turnsDuring(() => forPerson(() => person.stmt("interactive", 1)));
    expect(waited, `the person's statement waited ${waited} turns`).toBe(0);
  });

  it("keeps the ingest waiting until the person's request ends, then runs it", async () => {
    const w = world();
    let ingest: Promise<void> | null = null;
    await forPerson(async () => {
      await w.stmt("interactive", 2, "search-1");
      ingest = w.stmt("ingest", 5, "drain");
      for (let i = 0; i < 5; i++) await turn();
      expect(w.ran, "the drain ran inside the person's request").not.toContain("drain");
      await w.stmt("interactive", 2, "search-2");
    });
    await ingest;
    expect(w.ran).toEqual(["search-1", "search-2", "drain"]);
  });

  it("lets the ingest run once a request has held it for the bound", async () => {
    const w = world(30);
    let done!: () => void;
    const stuck = forPerson(() => new Promise<void>((r) => { done = r; }));
    const ingest = w.stmt("ingest", 5, "drain");
    for (let i = 0; i < 5; i++) await turn();
    expect(w.ran, "the bound let the drain go before it was reached").not.toContain("drain");
    w.advance(31);
    await ingest;
    expect(w.ran).toEqual(["drain"]);
    done();
    await stuck;
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

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

describe("the door marks a search as a person, and nothing else", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("a search raises the edge on the local door; a list read does not", async () => {
    const meta = new MemoryMetaFolder();
    const dataDir = await freshDataDir("ohmail-person-door-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: (): MailboxAdapter & { leaseIo(): LeaseIo } => ({
        leaseIo: () => meta,
        async connect(): Promise<void> {},
        async close(): Promise<void> {},
        async capabilities(): Promise<ImapCapabilities> {
          return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
        },
        async ensureFolders(): Promise<void> {},
        async changesSince(): Promise<ChangeBatch> { return EMPTY; },
        async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
        async setFlags(): Promise<void> {},
        async scanSentRecipients(): Promise<string[]> { return []; },
        async watch(): Promise<() => Promise<void>> { return async () => {}; },
        async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
        async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
      }),
      searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    const edges: boolean[] = [];
    cleanups.push(onPersonEdge((waiting) => { edges.push(waiting); }));
    const ask = async (path: string): Promise<number> => (await sidecar.handle(new Request(`http://sidecar${path}`, {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }))).status;

    expect(await ask("/mailboxes")).toBe(200);
    expect(edges, "a list read was taken for a person").toEqual([]);
    expect(await ask("/search?q=harbour&parts=page&limit=5")).toBe(200);
    expect(edges, "the search was not taken for a person").toEqual([true, false]);
  }, 120_000);
});
