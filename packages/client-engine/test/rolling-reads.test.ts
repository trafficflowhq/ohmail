import { expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, StoreTimelineWalker } from "../src/index.js";
import type { EngineMessage } from "@ohmail/wire";

const now = "2026-04-20T12:00:00.000Z";
const start = Date.parse(now);
const rows = Array.from({ length: 240 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(100000000000 - i)}`,
  accountId: "fixture", mailboxId: "mailbox", subject: `Fixture ${i}`, folder: "INBOX",
  date: new Date(start - 60_000 * i).toISOString(), updatedAt: now,
  from: { name: null, address: ["synthetic", "example.test"].join("@") }, to: [], cc: [],
  unread: true, attachmentCount: 0, hasAttachments: false, remoteContent: "none", snippet: "fixture",
} as EngineMessage));
const answer = (body: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers });
const refused = (message: string) => answer({ error: { code: "validation_failed", message } }, 400);
const body = (id: string) => ({ messageId: id, text: "fixture body", html: null, loadedRemoteContent: false });
const wait = () => new Promise((resolve) => setTimeout(resolve, 1));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await wait();
  expect(check()).toBe(true);
}
function fixture(bodyFetch: (ids: string[], urgent: boolean) => Promise<Response>) {
  let drained = false;
  const adapter = new HttpAdapter({
    baseUrl: "https://fixture.invalid",
    fetch: async (url, options) => {
      const request = new URL(url);
      if (request.pathname === "/sync") {
        const creates = drained ? [] : rows.map((entity, i) => ({
          type: "message", op: "create", id: entity.id, seq: i + 1, updatedAt: now, entity,
        }));
        drained = true;
        return answer({ cursor: "240", hasMore: false, serverTime: now,
          changes: { creates, updates: [], moves: [], deletes: [] },
        }, 200, { "x-ohmail-body-preload-limit": "40" });
      }
      if (request.pathname === "/messages/bodies") {
        return bodyFetch(request.searchParams.get("ids")!.split(","), options?.priority === "high");
      }
      if (request.pathname.startsWith("/messages/") && request.pathname.endsWith("/body")) {
        return bodyFetch([request.pathname.split("/")[2]!], options?.priority === "high")
          .then(async (res) => res.ok ? answer((await res.json()).items[0]) : res);
      }
      return answer({}, 404);
    },
  });
  const store = new MemoryMirrorStore();
  return { adapter, store, engine: new OhmailEngine({ adapter, store, now: () => new Date(now), eagerBodies: true }) };
}

it("warms readable bodies when a fresh sync is followed by an old body peer", async () => {
  const sizes: number[] = [];
  const { adapter, engine, store } = fixture(async (ids) => {
    sizes.push(ids.length);
    return ids.length > 20
      ? refused("at most 20 ids may be requested at once")
      : answer({ items: ids.map(body), nextCursor: null });
  });
  await engine.start();
  await engine.prefetchRecentBodies();
  expect(store.get<{ state: string }>("message_body", rows[0]!.id)?.state).toBe("ready");
  expect(adapter.bodyPreloadLimit()).toBe(20);
  expect(sizes[0]).toBe(40);
  expect(sizes).toContain(20);
});

it("preserves an unrelated validation refusal of a wide read", async () => {
  const calls: Array<{ size: number; urgent: boolean }> = [];
  const { adapter, engine } = fixture(async (ids, urgent) => {
    calls.push({ size: ids.length, urgent });
    return refused("ids must be a comma-separated list of message ids");
  });
  await engine.start();
  await expect(adapter.fetchBodies(rows.slice(0, 40).map(({ id }) => id), { urgent: true }))
    .rejects.toMatchObject({ status: 400, code: "validation_failed" });
  expect(calls).toEqual([{ size: 40, urgent: true }]);
  expect(adapter.bodyPreloadLimit()).toBe(40);
});

it("keeps the caller's priority on both legacy batches", async () => {
  const calls: Array<{ size: number; urgent: boolean }> = [];
  const { adapter, engine } = fixture(async (ids, urgent) => {
    calls.push({ size: ids.length, urgent });
    return ids.length > 20
      ? refused("at most 20 ids may be requested at once")
      : answer({ items: ids.map(body), nextCursor: null });
  });
  await engine.start();
  const ids = rows.slice(0, 40).map(({ id }) => id);
  expect((await adapter.fetchBodies(ids, { urgent: true })).map(({ messageId }) => messageId)).toEqual(ids);
  expect(calls).toEqual([40, 20, 20].map((size) => ({ size, urgent: true })));
});

it("fills the deep History window if a current timeline is followed by a legacy pager", async () => {
  const ranks: string[] = [];
  let legacy = true;
  const adapter = new HttpAdapter({
    baseUrl: "https://fixture.invalid",
    fetch: async (url) => {
      const request = new URL(url);
      if (request.pathname === "/messages/timeline") {
        return answer({ seek: true, total: rows.length, months: [
          { month: "2026-04", count: rows.length, first: { id: rows[0]!.id, date: rows[0]!.date } },
        ], undated: 0 });
      }
      if (request.pathname !== "/messages") return answer({}, 404);
      const cursor = request.searchParams.get("cursor");
      if (cursor !== null) {
        ranks.push(cursor);
        if (legacy) return refused("invalid cursor");
        const slot = Number(cursor.split("|")[1]);
        return answer({ items: rows.slice(slot, slot + 50), nextCursor: null });
      }
      const first = request.searchParams.get("beforeId");
      const index = first === null ? 0 : rows.findIndex(({ id }) => id === first) + 1;
      return answer({ items: rows.slice(index, index + 50), nextCursor: null });
    },
  });
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => new Date(now) });
  const walker = new StoreTimelineWalker(engine);
  walker.start();
  try {
    await until(() => walker.state() === "ready");
    walker.want(190, 215);
    await until(() => walker.rowAt(190, []) !== null);
    expect(walker.rowAt(190, [])).toMatchObject({ id: rows[190]!.id });
    walker.want(70, 85);
    await until(() => walker.rowAt(70, []) !== null);
    expect(walker.rowAt(70, [])).toMatchObject({ id: rows[70]!.id });
    expect(ranks).toEqual([expect.stringMatching(/^history:/)]);

    legacy = false;
    walker.start();
    await until(() => walker.state() === "ready");
    walker.want(190, 215);
    await until(() => walker.rowAt(190, []) !== null);
    expect(walker.rowAt(190, [])).toMatchObject({ id: rows[190]!.id });
    expect(ranks).toHaveLength(2);
  } finally {
    walker.stop();
  }
});
