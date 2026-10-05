import { describe, expect, it } from "vitest";
import {
  MutationRejectedError, OhmailEngine, OUTBOX_TYPE, type EngineLocks, type EngineMutation, type MirrorStore,
} from "@ohmail/client-engine";

import { WindowOutboxStore, type OutboxFetch } from "../src/window-outbox-store.js";

/**
 * THE DESKTOP WINDOW KEEPS EVERY ROW. The window is the one writer of its outbox file, so its store
 * names no shared disk and per-row ownership stays off even with Web Locks at hand: no lock is
 * taken, no row is stamped, and the restore queues every row, one naming an owner included. The
 * control that the browser's owner filter is not the desktop's.
 */

/** The engine's outbox door as the sidecar keeps it: rows by `type:id`, puts and deletes atomic. */
function door(seed: Array<{ type: string; id: string; entity: unknown }> = []) {
  const rows = new Map(seed.map((r) => [`${r.type}:${r.id}`, r]));
  const fetch: OutboxFetch = async (_url, init) => {
    const i = (init ?? {}) as { method?: string; body?: string };
    if ((i.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ rows: [...rows.values()], next: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(i.body ?? "{}") as { puts: Array<{ type: string; id: string; entity: unknown }>; deletes: Array<{ type: string; id: string }> };
    for (const p of body.puts) rows.set(`${p.type}:${p.id}`, p);
    for (const d of body.deletes) rows.delete(`${d.type}:${d.id}`);
    return new Response(null, { status: 204 });
  };
  return { rows, fetch };
}

function registry() {
  const asked: string[] = [];
  const api: EngineLocks = {
    async request(name, _o, cb) { asked.push(name); return cb({ name }); },
    async query() { return { held: [] }; },
  };
  return { api, asked };
}

function server() {
  const delivered: string[] = [];
  const net = { offline: false };
  const adapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }),
    fetchBody: async () => null,
    mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (m.kind === "mail_send" && !delivered.includes(o.idempotencyKey)) delivered.push(o.idempotencyKey);
      return { changes: [], seq: null };
    },
  };
  return { adapter, delivered, net };
}

const SCOPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEND = {
  kind: "mail_send", inReplyTo: null, body: "Hello", subject: "Hello", mailboxId: "mb-1",
  to: [{ name: null, address: "bo@fake.test" }],
} as unknown as EngineMutation;
const entry = (id: string, key: string, owner?: string) => ({
  type: OUTBOX_TYPE, id,
  entity: { v: 3, id, key, n: 0, at: Date.now(), mutation: SEND, attempts: 0, ...(owner ? { owner } : {}) },
});

describe("the desktop window's outbox has no second writer, so ownership stays off", () => {
  it("with Web Locks at hand: no lock taken, every row restored (one naming an owner), one delivery each", async () => {
    const d = door([entry("e-1", "K-1"), entry("e-2", "K-2", "ohmail.engine.elsewhere.some-tab")]);
    const reg = registry();
    const srv = server();
    srv.net.offline = true;
    const store = new WindowOutboxStore({ scope: SCOPE, write: d.fetch });
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store, locks: reg.api } as never);
    await engine.start().catch(() => undefined);
    expect((store as MirrorStore).sharedDiskName?.() ?? null, "the window's store names no shared disk").toBeNull();
    expect({ asked: reg.asked, owner: (engine as unknown as { ownerName: string | null }).ownerName }).toEqual({ asked: [], owner: null });
    expect(engine.pendingMutations().map((p) => p.key).sort(), "the restore queues every row").toEqual(["K-1", "K-2"]);
    srv.net.offline = false;
    await engine.flushPending();
    expect(srv.delivered.sort()).toEqual(["K-1", "K-2"]);
  });

  it("a send pressed in the window is written with no owner, and a reload replays it once", async () => {
    const d = door();
    const srv = server();
    srv.net.offline = true;
    const first = new OhmailEngine({ adapter: srv.adapter as never, store: new WindowOutboxStore({ scope: SCOPE, write: d.fetch }), locks: registry().api } as never);
    await first.start().catch(() => undefined);
    const res = await first.mutate(SEND);
    expect([...d.rows.values()].map((r) => (r.entity as { owner?: string }).owner ?? null)).toEqual([null]);
    srv.net.offline = false;
    const again = new OhmailEngine({ adapter: srv.adapter as never, store: new WindowOutboxStore({ scope: SCOPE, write: d.fetch }), locks: registry().api } as never);
    await again.start().catch(() => undefined);
    await again.flushPending();
    expect(srv.delivered).toEqual([res.key]);
  });
});
