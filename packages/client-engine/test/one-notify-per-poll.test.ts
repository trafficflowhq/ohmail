import { describe, expect, it } from "vitest";
import {
  BACKLOG_PUBLISH_PAGES,
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  OUTBOX_TYPE,
  STALE_RESUME_MS,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * ONE POLL, ONE NOTIFY. A drain's page, what its settle retires and its freshness stamp reach a
 * subscriber as ONE notify: React 19 commits two notifies as two renders of the whole shell, and
 * a snapshot between them shows the new rows under the old "as of". Watched red by putting the
 * page's own notify back ahead of the settle, by the echo sweep notifying on its own, by removing
 * the settle's publish, and by dropping the drain's `catch` publish (a throw then says nothing).
 */

const t0 = new Date("2026-09-28T12:00:00.000Z");
let seq = 0;

function create(id: string): SyncChange {
  const date = t0.toISOString();
  const entity = {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "snippet", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as unknown as EngineMessage;
  return { type: "message", op: "create", id, seq: ++seq, updatedAt: date, entity };
}

/** Serves the pages it is handed, one per request; `hasMore` while more are queued. */
function scripted() {
  const pages: Array<SyncChange[] | Error> = [];
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const next = pages.shift() ?? [];
      if (next instanceof Error) throw next;
      return {
        changes: { creates: next, updates: [], moves: [], deletes: [] },
        cursor: String(seq), hasMore: pages.length > 0, serverTime: t0.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return { adapter, serve: (...p: Array<SyncChange[] | Error>) => { pages.push(...p); } };
}

/** What each notify showed: the rows a reader can see and the freshness beside them. */
function watch(engine: OhmailEngine) {
  const seen: Array<{ rows: number; state: string; asOf: string | null }> = [];
  engine.subscribe(() => {
    const f = engine.freshness();
    seen.push({ rows: engine.read().list("message").length, state: f.state, asOf: f.asOf });
  });
  return seen;
}

async function rig(clock: { now: Date }) {
  const store = new MemoryMirrorStore();
  await store.load();
  const { adapter, serve } = scripted();
  const engine = new OhmailEngine({ adapter, store, now: () => clock.now });
  return { engine, store, serve };
}

describe("a drain publishes each step once", () => {
  it("one poll gives one notify, carrying both the rows and their stamp", async () => {
    const clock = { now: t0 };
    const { engine, serve } = await rig(clock);
    await engine.syncOnce();
    clock.now = new Date(t0.getTime() + STALE_RESUME_MS + 1);
    expect(engine.freshness().state, "the premise: the returning tab's stamp has aged").toBe("stale");

    const seen = watch(engine);
    serve([create("a"), create("b")]);
    await engine.syncOnce();
    expect(seen).toEqual([{ rows: 2, state: "current", asOf: clock.now.toISOString() }]);

    // A poll that lands nothing still announces its settle, once.
    clock.now = new Date(clock.now.getTime() + 8_000);
    await engine.syncOnce();
    expect(seen.slice(1)).toEqual([{ rows: 2, state: "current", asOf: clock.now.toISOString() }]);
  });

  it("a backlog publishes once per BACKLOG_PUBLISH_PAGES pages, and its settle once", async () => {
    const clock = { now: t0 };
    const { engine, serve } = await rig(clock);
    const seen = watch(engine);
    serve(...Array.from({ length: 20 }, (_, i) => [create(`b${i}`)]));
    await engine.syncOnce();
    const at = t0.toISOString();
    expect(BACKLOG_PUBLISH_PAGES).toBe(8);
    // No stamp for rows that are still arriving, and the settle's rows with theirs.
    expect(seen).toEqual([
      { rows: 8, state: "unknown", asOf: null },
      { rows: 16, state: "unknown", asOf: null },
      { rows: 20, state: "current", asOf: at },
    ]);
  });

  it("a drain that stops mid-backlog still publishes what it landed", async () => {
    const clock = { now: t0 };
    const { engine, serve } = await rig(clock);
    const seen = watch(engine);
    serve([create("c0")], [create("c1")], new Error("the network went"));
    await expect(engine.syncOnce()).rejects.toThrow("the network went");
    expect(seen).toEqual([{ rows: 2, state: "unknown", asOf: null }]);
  });

  it("a settle whose stamp cannot be written still publishes the page, under the old stamp", async () => {
    const clock = { now: t0 };
    const { engine, store, serve } = await rig(clock);
    await engine.syncOnce();
    const setMeta = store.setMeta.bind(store);
    let refuse = true;
    store.setMeta = (async (key: string, value: unknown) => {
      if (key === LAST_DRAIN_AT_META && refuse) { refuse = false; throw new Error("disk full"); }
      return setMeta(key, value);
    }) as typeof store.setMeta;

    const seen = watch(engine);
    clock.now = new Date(t0.getTime() + 8_000);
    serve([create("d0")]);
    await expect(engine.syncOnce()).rejects.toThrow("disk full");
    expect(seen).toEqual([{ rows: 1, state: "current", asOf: t0.toISOString() }]);
  });

  it("a poll carrying a verb's echo retires its overlay in the same one notify", async () => {
    // No echo body and a failed reconcile drain: the overlay waits for the next drain's sweep.
    const inner = new FixturesAdapter();
    let failSync = false;
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        if (failSync) { failSync = false; throw new Error("the network went"); }
        return inner.sync(params);
      },
      async mutate(m, o) {
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => DEMO_NOW });
    await engine.start();
    failSync = true;
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("confirmed");
    const waiting = () => store.entries(OUTBOX_TYPE).length;
    expect(waiting(), "the premise: the verb waits for its echo").toBe(1);

    let notifies = 0;
    engine.subscribe(() => { notifies += 1; });
    await engine.syncOnce();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(waiting(), "the sweep did not retire the verb").toBe(0);
    expect(store.get<EngineMessage>("message", "giulia")?.unread, "the echo is in the mirror").toBe(false);
    expect(notifies).toBe(1);
  });
});
