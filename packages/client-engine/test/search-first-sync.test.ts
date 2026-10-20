import { describe, expect, it, vi } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { mailboxes } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { FIXED_NOW, makeDeps, seedBody, seedMailbox, seedMessage, seedSession } from "../../api/test/helpers.js";
import { HttpAdapter } from "../src/adapters/http-adapter.js";
import { OhmailEngine } from "../src/engine.js";
import { MemoryMirrorStore } from "../src/store.js";
import { StoreSearchWalker } from "../src/store-timeline.js";
import type { FetchLike } from "../src/index.js";

/**
 * THE REAL SEARCH ROUTE OVER A STORE MID-IMPORT, through the transport and the
 * walker every surface reads. INBOX is in, the letter in Newsletters is not, and the backfill has
 * written its marker, so no index progress is sent: the answer's only coverage fact is
 * `importing`. Watched red at the base: the walker read the mid-import store as the whole mailbox.
 */
const app = createApp(apiRoutes);

async function world() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  for (let i = 0; i < 4; i++) {
    const m = await seedMessage(db, {
      accountId: s.accountId, mailboxId, folder: "INBOX", subject: `invoice ${74600 + i}`,
      date: new Date(FIXED_NOW.getTime() - i * 3_600_000),
    });
    await seedBody(db, { messageId: m.id, text: `the invoice for order ${74600 + i}` });
  }
  expect((await searchIndexBackfillPass({ db: db as never, accountId: s.accountId })).marked).toBe(true);
  // The estimate can be held, so a test can move the store between the page and the estimate.
  let hold: Promise<void> | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    if (hold !== null && String(url).includes("parts=estimate")) await hold;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
  };
  const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => FIXED_NOW });
  // This world's database holds the one mailbox, so the stamp needs no predicate (nor drizzle-orm).
  const stamp = () => db.update(mailboxes).set({ initialImportCompletedAt: FIXED_NOW });
  const holdEstimates = (): (() => void) => {
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    return release;
  };
  /** `GET /mailboxes` as the web's facts probe reads it: the one mailbox's first-import stamp. */
  const stampOnTheWire = async (): Promise<unknown> => {
    const res = await fetchImpl("http://localhost/mailboxes", { method: "GET" });
    const body = (await res.json()) as { items: Array<{ initialImportCompletedAt?: unknown }> };
    expect(body.items).toHaveLength(1);
    return body.items[0]!.initialImportCompletedAt;
  };
  return { adapter, engine, stamp, holdEstimates, stampOnTheWire };
}

/** The walker's reading once the page AND the estimate have answered (the estimate brings the facets). */
async function reading(engine: OhmailEngine, query: string) {
  const walker = new StoreSearchWalker(engine);
  walker.start({ query }, () => [], 0);
  await vi.waitFor(() => expect(walker.info()?.facets ?? null).not.toBeNull(), { timeout: 5_000 });
  const info = walker.info()!;
  walker.clear();
  return info;
}

describe("the search route says the store is still taking the mailbox in", () => {
  it("mid-import: every part on the wire, and the walker, read `importing`", async () => {
    const w = await world();
    expect(await w.stampOnTheWire(), "the sync line's fact: the first import is open").toBeNull();
    for (const parts of ["page", "estimate", "summary"] as const) {
      const wire = await w.adapter.searchServer("invoice 74600", { parts });
      expect(wire.importing, parts).toBe(true);
      expect(wire.indexed, parts).toBeUndefined();
    }
    const hit = await reading(w.engine, "invoice 74600");
    expect(hit.tier).toBe("exact");
    expect(hit.importing).toBe(true);
    const miss = await reading(w.engine, "delivery window 2059");
    expect(miss.tier).toBe("similar");
    expect(miss.importing).toBe(true);
  });

  it("the complete-store control: once the import is stamped, nothing on the wire and the walker reads whole", async () => {
    const w = await world();
    await w.stamp();
    expect(await w.stampOnTheWire(), "the sync line's fact: the first import is done").toBe(FIXED_NOW.toISOString());
    for (const parts of ["page", "estimate", "summary"] as const) {
      const wire = await w.adapter.searchServer("invoice 74600", { parts });
      expect("importing" in wire, parts).toBe(false);
    }
    const hit = await reading(w.engine, "invoice 74600");
    expect(hit.total).toBe(1);
    expect(hit.importing).toBe(false);
  });

  it("the latest answer's reading: an import that finishes between the page and the estimate reads whole", async () => {
    const w = await world();
    const release = w.holdEstimates();
    const walker = new StoreSearchWalker(w.engine);
    walker.start({ query: "invoice 74600" }, () => [], 0);
    await vi.waitFor(() => expect(walker.info()).not.toBeNull(), { timeout: 5_000 });
    expect(walker.info()!.importing, "the page answered mid-import").toBe(true);
    await w.stamp();
    release();
    await vi.waitFor(() => expect(walker.info()?.facets ?? null).not.toBeNull(), { timeout: 5_000 });
    expect(walker.info()!.importing, "the estimate answered over the whole mailbox").toBe(false);
    walker.clear();
  });

  /* ADDRESS-VIEW-WHOLE-MAILBOX-DURING-FIRST-SYNC: the address arm reads the same fact over the same route. */
  it("the address arm: the wire and the engine's outcome read `importing` mid-import, and not once stamped", async () => {
    const w = await world();
    const sender = "sender@example.com";
    const wire = await w.adapter.searchAddressServer(sender, {});
    expect(wire.total, "the seeded sender's mail").toBe(4);
    expect(wire.importing).toBe(true);
    expect(await w.engine.searchAddressServer(sender)).toMatchObject({ state: "ready", total: 4, importing: true });
    await w.stamp();
    const done = await w.engine.searchAddressServer(sender);
    expect(done.state).toBe("ready");
    expect("importing" in done).toBe(false);
    expect("importing" in (await w.adapter.searchAddressServer(sender, {}))).toBe(false);
    // No wait of its own: 0.3 s as a rule, 2.9 s once on a loaded CI VM, 43 s under 10% of a CPU.
  }, 90_000);
});
