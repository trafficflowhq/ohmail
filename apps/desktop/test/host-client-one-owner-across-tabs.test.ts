/**
 * THE PAIRED PAGE'S TABS SHARE ITS OUTBOX AND EACH ROW HAS ONE OWNER (the cross-window send
 * fix). Two engines over `HostOutboxStore` on ONE `IDBFactory` and one pairing, each holding its own
 * lock from ONE injected registry; the row's owner is read off the disk first. Here rather than
 * beside the desktop's tests because `fake-indexeddb` is this package's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import {
  MutationRejectedError, OhmailEngine, OUTBOX_TYPE, OUTBOX_WITHDRAWN_CODE,
  type EngineLocks, type EngineMutation, type MutationResult, type NoticeChannel,
} from "@ohmail/client-engine";

import { HostOutboxStore } from "../src/host-client/outbox-store.js";

const tick = (ms = 5): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`never reached: ${what}`);
}

function registry() {
  const held = new Set<string>();
  const api: EngineLocks = {
    async request(name, _o, cb) { held.add(name); return cb({ name }); },
    async query() { return { held: [...held].map((name) => ({ name })) }; },
  };
  return { api, close: (name: string) => { held.delete(name); } };
}

const msg = (id: string) => ({
  id, accountId: "acct", mailboxId: "mb-1", threadId: null, messageIdHeader: `<${id}@x>`, subject: "Invoice",
  from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date: new Date().toISOString(), folder: "INBOX",
  snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: new Date().toISOString(),
});

function host() {
  const reserved = new Set<string>();
  const deliveries: string[] = [];
  const net = { offline: false };
  // The browser's own word on the network, as a claim reads it: offline sends nothing, no wire fact.
  Object.defineProperty(globalThis.navigator, "onLine", { get: () => !net.offline, configurable: true });
  // The withdraw route over the same ledger: a key it holds is `already_sent`, any other tombstoned.
  const tombstones = new Set<string>();
  const adapter = {
    sync: async () => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      return {
        changes: { creates: [{ type: "message", id: "m-1", seq: 1, updatedAt: new Date().toISOString(), entity: msg("m-1") }], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: new Date().toISOString(),
      };
    },
    fetchBody: async () => null,
    withdrawSend: async (key: string) => {
      if (net.offline) return { outcome: "unreachable" as const };
      if (reserved.has(key)) return { outcome: "already_sent" as const, firstSend: { status: "sent", at: new Date().toISOString() } };
      tombstones.add(key);
      return { outcome: "withdrawn" as const };
    },
    mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (m.kind === "mail_send" && tombstones.has(o.idempotencyKey)) {
        throw new MutationRejectedError("cancelled before it left", { status: 409, code: "withdrawn", retryable: false });
      }
      if (m.kind === "mail_send" && !reserved.has(o.idempotencyKey)) { reserved.add(o.idempotencyKey); deliveries.push(o.idempotencyKey); }
      return { changes: [], seq: null };
    },
  };
  return { adapter, net, deliveries };
}

const SEND = {
  kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", mailboxId: "mb-1",
  to: [{ name: "Ada", address: "ada@fake.test" }],
} as unknown as EngineMutation;

type Tab = { store: HostOutboxStore; engine: OhmailEngine; name: () => string | null; silence: () => void };
/** One window's notice channel; `silence()` is the channel going dead: the window neither says nor hears. */
function channel() {
  let real: BroadcastChannel | null = null;
  let dead = false;
  const open = (name: string): NoticeChannel => {
    const ch = new BroadcastChannel(name);
    (ch as { unref?: () => void }).unref?.();
    real = ch;
    const face: NoticeChannel = { postMessage: (d) => { if (!dead) ch.postMessage(d); }, close: () => ch.close(), onmessage: null };
    ch.onmessage = (ev) => { if (!dead) face.onmessage?.({ data: ev.data }); };
    return face;
  };
  return { open, silence: () => { dead = true; real?.close(); } };
}
/** The registry as one window asks it, and the name that window's lock was granted under. */
function grantOf(locks: EngineLocks | null) {
  let granted: string | null = null;
  const api: EngineLocks | null = locks === null ? null : {
    request: (name, o, cb) => locks.request(name, o, (l) => { granted = name; return cb(l); }),
    query: () => locks.query(),
  };
  return { api, name: () => granted };
}
async function tab(factory: IDBFactory, locks: EngineLocks | null, h: ReturnType<typeof host>): Promise<Tab> {
  const said = channel();
  const lock = grantOf(locks);
  const store = new HostOutboxStore({ scope: "pair-1", live: () => true, factory, notices: said.open });
  const engine = new OhmailEngine({ adapter: h.adapter as never, store, locks: lock.api } as never);
  await engine.start().catch(() => undefined);
  return { store, engine, name: lock.name, silence: said.silence };
}
const rows = (t: Tab) => t.store.entries<{ key: string; owner?: string }>(OUTBOX_TYPE).map((e) => e.entity);

describe("the paired page's tabs: one owner per queued send", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  for (const order of ["B opens before A presses", "B opens after A presses"] as const) {
    it(`${order}: queued in A only, read by B, one delivery`, async () => {
      const factory = new IDBFactory(); const reg = registry(); const h = host();
      const A = await tab(factory, reg.api, h);
      let B: Tab | null = order === "B opens before A presses" ? await tab(factory, reg.api, h) : null;
      h.net.offline = true;
      const res = await A.engine.mutate(SEND);
      expect(rows(A).map((r) => r.owner), "the row names A's lock").toEqual([A.name()]);
      B ??= await tab(factory, reg.api, h);
      await until(() => rows(B!).some((r) => r.key === res.key), "B reads A's row");
      expect(B.engine.pendingMutations().map((p) => p.key), "B never queues it").not.toContain(res.key);
      h.net.offline = false;
      await A.engine.flushPending(); await B.engine.syncOnce();
      expect(h.deliveries).toEqual([res.key]);
    });
  }

  it("the owning tab closes: B adopts and delivers once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const h = host();
    const B = await tab(factory, reg.api, h);
    const A = await tab(factory, reg.api, h);
    h.net.offline = true;
    const res = await A.engine.mutate(SEND);
    expect(rows(A).map((r) => r.owner)).toEqual([A.name()]);
    reg.close(A.name()!);
    h.net.offline = false;
    await B.engine.syncOnce(); await B.engine.syncOnce();
    expect(h.deliveries).toEqual([res.key]);
  });

  for (const arm of ["withdrawn", "silent"] as const) {
    it(`Cancel in B, the owning tab ${arm === "silent" ? "silent" : "answers withdrawn"}: nothing is delivered`, async () => {
      const factory = new IDBFactory(); const reg = registry(); const h = host();
      const A = await tab(factory, reg.api, h);
      const B = await tab(factory, reg.api, h);
      h.net.offline = true;
      const res = await A.engine.mutate(SEND);
      expect(rows(A).map((r) => r.owner)).toEqual([A.name()]);
      await until(() => rows(B).some((r) => r.key === res.key), "B reads it");
      if (arm === "silent") A.silence();
      // The notice carries the SERVER's answer, so the answering arm asks with the network back; the
      // silent arm cancels offline, and its owed mark is what A's claim meets.
      if (arm === "withdrawn") h.net.offline = false;
      expect(await B.engine.withdrawQueued(res.key)).toBe("withdrawn");
      // A hears that the mark won and ends its own copy; a silent A meets the mark at its claim.
      if (arm === "withdrawn") await until(() => A.engine.pendingMutations().length === 0, "A ends its copy");
      h.net.offline = false;
      const late: MutationResult[] = [];
      for (const t of [A, B]) { await t.engine.syncOnce(); late.push(...await t.engine.flushPending()); }
      expect(h.deliveries).toEqual([]);
      expect(late.find((r) => r.key === res.key)?.error?.code).toBe(OUTBOX_WITHDRAWN_CODE);
    });
  }
});
