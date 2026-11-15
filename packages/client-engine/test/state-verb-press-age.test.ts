import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  type EngineAdapter,
  type EngineMutation,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * A press the server answers for its AGE: the engine measures it at dispatch from the instant the
 * press was made (`entry.at`, persisted), so a restored entry's age is right across a restart. A
 * newer press for the same field owns the sentence: the older one settles `superseded` whether a
 * newer verb replaced it on the wire or the server refused it as stale.
 */
interface Call { kind: string; key: string; age: number | undefined; mutation: EngineMutation }

function wire(inner: FixturesAdapter) {
  const calls: Call[] = [];
  let fail: ((m: EngineMutation) => Error | null) | null = null;
  let gate: { open: Promise<void> } | null = null;
  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    sync: (p) => inner.sync(p),
    async mutate(m, o) {
      calls.push({ kind: m.kind, key: o.idempotencyKey, age: (o as { pressAgeMs?: number }).pressAgeMs, mutation: m });
      if (gate) { const g = gate; gate = null; await g.open; }
      const err = fail?.(m);
      if (err) throw err;
      const out = await inner.mutate(m, o);
      return { changes: [], seq: out.seq };
    },
  };
  return {
    adapter, calls,
    setFail: (f: typeof fail) => { fail = f; },
    gateNext: () => { let release!: () => void; gate = { open: new Promise<void>((r) => { release = r; }) }; return release; },
  };
}

const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

describe("the press age on the wire", () => {
  it("every state verb carries the age measured from its own press, a restored one included", async () => {
    let t = DEMO_NOW.getTime();
    const w = wire(new FixturesAdapter());
    const store = new MemoryMirrorStore();
    const e = new OhmailEngine({ adapter: w.adapter, store, now: () => new Date(t) });
    await e.start();
    w.setFail(() => new MutationRejectedError("network failure", { code: "network", retryable: true }));
    expect((await e.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" })).status).toBe("queued");
    expect(w.calls.at(-1)!.age).toBe(0);
    w.setFail(null);
    t += 25 * 60 * 60 * 1000;
    // The restart: a new engine over the same store restores the entry with its press instant.
    const w2 = wire(new FixturesAdapter());
    const e2 = new OhmailEngine({ adapter: w2.adapter, store, now: () => new Date(t) });
    await e2.hydrate();
    await e2.syncOnce();
    const replayed = w2.calls.find((c) => c.kind === "move")!;
    expect(replayed.age).toBe(25 * 60 * 60 * 1000);
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
  });

  it("a clock that jumped back measures the press as fresh, never negative", async () => {
    let t = DEMO_NOW.getTime();
    const w = wire(new FixturesAdapter());
    const e = new OhmailEngine({ adapter: w.adapter, store: new MemoryMirrorStore(), now: () => new Date(t) });
    await e.start();
    w.setFail(() => new MutationRejectedError("network failure", { code: "network", retryable: true }));
    await e.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" });
    w.setFail(null);
    t -= 60 * 60 * 1000;
    await e.syncOnce();
    expect(w.calls.filter((c) => c.kind === "triage_set").map((c) => c.age)).toEqual([0, 0]);
  });
});

describe("a newer press for the same field owns the sentence", () => {
  it("F: a move replaced on the wire and answered `network` settles superseded, row gone", async () => {
    const w = wire(new FixturesAdapter());
    const store = new MemoryMirrorStore();
    const e = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await e.start();
    const release = w.gateNext();
    w.setFail((m) => (m.kind === "move" && m.folder === "ohmail/Receipts"
      ? new MutationRejectedError("network failure", { code: "network", retryable: true }) : null));
    const a = e.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    await tick();
    const b = e.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("superseded");
    expect(ra.error).toBeUndefined();
    expect(rb.status).toBe("confirmed");
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
  });

  it("a stale_press refusal settles superseded: overlay and row go, no refusal record", async () => {
    const w = wire(new FixturesAdapter());
    const store = new MemoryMirrorStore();
    const e = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await e.start();
    w.setFail(() => new MutationRejectedError("a newer decision stands", { code: "stale_press", retryable: false, status: 409 }));
    const r = await e.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    expect(r.status).toBe("superseded");
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
    expect(e.abandoned()).toHaveLength(0);
  });

  it("E: a queued move and a later delete of one message are one decision about its placement", async () => {
    const w = wire(new FixturesAdapter());
    const e = new OhmailEngine({ adapter: w.adapter, store: new MemoryMirrorStore(), now: () => DEMO_NOW });
    await e.start();
    w.setFail(() => new MutationRejectedError("network failure", { code: "network", retryable: true }));
    expect((await e.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" })).status).toBe("queued");
    expect((await e.mutate({ kind: "message_delete", messageId: "giulia" })).status).toBe("queued");
    expect(e.pendingMutations().map((p) => p.mutation.kind)).toEqual(["message_delete"]);
    // The optimistic read: the retired move's overlay is gone with it, so the row reads deleted.
    expect(e.read().get("message", "giulia")).toBeUndefined();
    w.setFail(null);
    w.calls.length = 0;
    await e.syncOnce();
    expect(w.calls.map((c) => c.kind)).toEqual(["message_delete"]);
  });
});

describe("a glance goes per id", () => {
  const dto = (id: string) => ({ id, unread: false, updatedAt: new Date(0).toISOString() });
  const glanceAdapter = (staleIds: readonly string[], seen: string[]) => new HttpAdapter({
    baseUrl: "http://h",
    fetch: (async (url: string | URL | Request) => {
      const id = String(url).split("/").pop()!;
      seen.push(id);
      if (staleIds.includes(id)) {
        return new Response(JSON.stringify({ error: { code: "stale_press", message: "newer", retryable: false } }), {
          status: 409, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(dto(id)), { status: 200, headers: { "content-type": "application/json", "x-sync-seq": "7" } });
    }) as typeof fetch,
  });

  it("an id refused stale is skipped and the rest are still sent and echoed", async () => {
    const seen: string[] = [];
    const out = await glanceAdapter(["b"], seen).mutate({ kind: "feed_mark_seen", messageIds: ["a", "b", "c"] } as EngineMutation, { idempotencyKey: "k", pressAgeMs: 0 });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(("changes" in out ? out.changes : []).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("a glance whose every id was stale is refused stale_press, which the engine settles silent", async () => {
    const seen: string[] = [];
    const err = await glanceAdapter(["a", "b"], seen)
      .mutate({ kind: "feed_mark_seen", messageIds: ["a", "b"] } as EngineMutation, { idempotencyKey: "k", pressAgeMs: 0 })
      .then(() => null, (e: unknown) => e as MutationRejectedError);
    expect([seen, err?.code]).toEqual([["a", "b"], "stale_press"]);
  });
});
