import type { EngineMutation } from "@ohmail/wire";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  HttpAdapter,
  IndexedDbMirrorStore,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  SqlMirrorStore,
  type EngineAdapter,
  type MirrorStore,
  type SyncResponse,
} from "@ohmail/client-engine";
import { sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * A QUEUED PRESS OUTLIVES THE UPGRADE. The fixture holds queue records of all three versions a store
 * may still carry: `v: 1` as the builds before the failure-atomic records wrote them, `v: 2` as the
 * gate documents it (a `v: 1` with its failures counted), and `v: 3` exactly as release 1.0.12's own
 * engine wrote them for a move (plain, by a Screener card with `from`, by a rule press with
 * `pressRule`) and a delete. Its `requests` are what 1.0.12 sent when it replayed those records, on
 * both stores. This build must send the same requests, byte for byte: the body, the record's own key,
 * the press age. And what it writes for the same presses must be what 1.0.12 wrote, so a 1.0 window
 * on the same disk still reads it.
 */
const FIXTURE = new URL("./fixtures/outbox-records-1.0.json", import.meta.url);
const FIXTURE_SHA256 = "f406f604ed1e434266b680e7aaa3325576b8ead080a5bfc63e23914ba4e41901";

interface Sent { method: string; path: string; body: string | null; key: string | null; age: string | null }
interface Fixture {
  writtenBy: string;
  replayedAt: number;
  records: Array<{ v: number; id: string; key: string; n: number; at: number; mutation: EngineMutation }>;
  requests: Sent[];
}

const bytes = readFileSync(FIXTURE);
const fixture = JSON.parse(bytes.toString("utf8")) as Fixture;
/** The instant 1.0.12's presses were made at: this build presses at the same one. */
const PRESSED_AT = fixture.records.filter((r) => r.v === 3)[0]!.at;

/** A drain with nothing in it: the records name letters no mirror holds, and are sent all the same. */
const NOTHING_NEW: SyncResponse = {
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false,
  serverTime: new Date(PRESSED_AT).toISOString(),
};

/** The real HTTP adapter for every press, over a recording fetch. */
function recordingWire(sent: Sent[]): EngineAdapter {
  const http = new HttpAdapter({
    baseUrl: "http://h",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const path = String(url).replace("http://h", "");
      sent.push({
        method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? init.body : null,
        key: h.get("idempotency-key"), age: h.get("x-ohmail-press-age"),
      });
      return new Response(JSON.stringify({ id: path.split("/")[2], updatedAt: new Date(0).toISOString(), folder: "INBOX" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    sync: async () => NOTHING_NEW,
    mutate: (m, o) => http.mutate(m, o),
  };
}

async function replayed(store: MirrorStore, boot: (e: OhmailEngine) => Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const e = new OhmailEngine({ adapter: recordingWire(sent), store, now: () => new Date(fixture.replayedAt) });
  await boot(e);
  await e.syncOnce();
  // Every record went, and none is left behind or given up on.
  expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
  expect(e.abandoned()).toHaveLength(0);
  return sent;
}

describe("queue records written before 2.0 replay unchanged", () => {
  it("the fixture is the one release 1.0.12 wrote and replayed", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA256);
    expect(fixture.records.map((r) => r.v)).toEqual([1, 1, 2, 3, 3, 3, 3]);
    expect(fixture.requests).toHaveLength(fixture.records.length);
  });

  it("on the web's store (IndexedDB): the same requests 1.0.12 sent, in the same order", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbMirrorStore({ owner: "acct-r9", factory });
    await first.load();
    for (const r of fixture.records) await first.putLocal(OUTBOX_TYPE, r.id, r);
    first.close();
    const store = new IndexedDbMirrorStore({ owner: "acct-r9", factory });
    expect(await replayed(store, (e) => e.hydrate())).toEqual(fixture.requests);
    store.close();
  });

  it("on the phone's and the desktop's store (SQLite): the same requests 1.0.12 sent", async () => {
    const world = sqlWorld();
    const first = new SqlMirrorStore({ owner: "origin|acct-r9", open: world.open });
    await first.load();
    for (const r of fixture.records) await first.putLocal(OUTBOX_TYPE, r.id, r);
    first.close();
    const store = new SqlMirrorStore({ owner: "origin|acct-r9", open: world.open });
    await store.load();
    expect(await replayed(store, async (e) => { e.restoreOutbox(); })).toEqual(fixture.requests);
    store.close();
  });

  it("this build writes for the same presses exactly what 1.0.12 wrote: a 1.0 window reads it", async () => {
    const written = fixture.records.filter((r) => r.v === 3);
    const store = new MemoryMirrorStore();
    const wire: EngineAdapter = {
      ...recordingWire([]),
      mutate: async () => { throw new MutationRejectedError("network failure: connection reset", { code: "network", retryable: true }); },
    };
    const e = new OhmailEngine({ adapter: wire, store, now: () => new Date(PRESSED_AT) });
    await e.start();
    for (const r of written) expect((await e.mutate(r.mutation)).status).toBe("queued");
    const ours = store.entries<{ n: number; id: string; key: string }>(OUTBOX_TYPE).map((x) => x.entity).sort((a, b) => a.n - b.n);
    // Only the ids and keys are this run's own: the version, the act, the counts and the stamp are 1.0.12's.
    expect(ours.map((r) => ({ ...r, id: "-", key: "-" }))).toEqual(written.map((r) => ({ ...r, id: "-", key: "-" })));
  });
});
