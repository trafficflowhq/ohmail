/**
 * A SEND THAT MADE ITS ROW REPLAYS THAT ROW. A press with no draft row creates one and then sends
 * it; the row's id lived only in the adapter, so a reload replayed the send with no row named and
 * `POST /drafts`, which ignores the key, made a second one (RESTORED-ROWLESS-SEND-REPLAY-MAKES-
 * ANOTHER-ROW). The row is persisted on the outbox entry before the send request goes.
 *
 * Two shapes: the send failed before the server took it (the row is still a draft), and the
 * server took it and the answer was lost (the row has left `draft`, so a PUT is refused).
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  HttpAdapter,
  IndexedDbMirrorStore,
  OhmailEngine,
  OUTBOX_TYPE,
} from "@ohmail/client-engine";

const REV = "a".repeat(64);
const SEND = {
  kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "numbers", body: "see below",
  to: [{ name: null, address: "to@example.test" }], cc: [], bcc: [],
} as unknown as EngineMutation;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => new Date(Date.parse("2026-09-29T08:00:00.000Z"));

/** One server for both sessions: `firstSend` decides what the first POST /send does. */
function server(firstSend: "network" | "committed-then-lost" | "hang") {
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  let rows = 0;
  const status = new Map<string, string>();
  const sentKeys = new Set<string>();
  const fetchImpl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = new URL(String(input), "http://x").pathname;
    const key = new Headers(init.headers as HeadersInit | undefined).get("idempotency-key");
    calls.push({ method, path, key });
    if (method === "POST" && path === "/drafts") {
      const id = `row-${++rows}`;
      status.set(id, "draft");
      return json({ id, bcc: [], mailboxId: "mbx-1", contentRevision: REV }, 201);
    }
    const put = /^\/drafts\/([^/]+)$/.exec(path);
    if (method === "PUT" && put) {
      if (status.get(put[1]!) !== "draft") return json({ code: "conflict", message: "draft is sending" }, 409);
      return json({ id: put[1], bcc: [], mailboxId: "mbx-1", contentRevision: REV });
    }
    const send = /^\/drafts\/([^/]+)\/send$/.exec(path);
    if (method === "POST" && send) {
      const first = calls.filter((c) => c.method === "POST" && c.path.endsWith("/send")).length === 1;
      if (first) {
        if (firstSend === "hang") return new Promise<Response>(() => { /* the tab dies around this */ });
        if (firstSend === "committed-then-lost") { status.set(send[1]!, "sent"); sentKeys.add(key ?? ""); }
        throw new TypeError("fetch failed");
      }
      // The reservation is keyed on the Idempotency-Key: a replay under it answers the stored result.
      status.set(send[1]!, "sent");
      sentKeys.add(key ?? "");
      return json({ status: "sent", providerMessageId: "p-1" });
    }
    return json({ items: [], cursor: null, hasMore: false });
  };
  return { calls, fetchImpl, sentKeys };
}

/** Resolves once the first send request is on the wire — the moment the tab dies in the hang shape. */
async function waitForSend(calls: Array<{ method: string; path: string }>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (calls.some((c) => c.method === "POST" && c.path.endsWith("/send"))) return;
    await new Promise<void>((r) => { setTimeout(r, 5); });
  }
  throw new Error("the send never reached the wire");
}

const count = (calls: Array<{ method: string; path: string }>, method: string, re: RegExp) =>
  calls.filter((c) => c.method === method && re.test(c.path)).length;

async function sessions(firstSend: "network" | "committed-then-lost" | "hang", owner: string) {
  const srv = server(firstSend);
  const factory = new IDBFactory();
  const store1 = new IndexedDbMirrorStore({ owner, factory });
  const e1 = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://x", fetch: srv.fetchImpl as never }) as never, store: store1, now,
  } as never);
  await e1.start().catch(() => undefined);
  const pressed = e1.mutate(SEND);
  const first = firstSend === "hang"
    ? await waitForSend(srv.calls).then(() => ({ status: "on_the_wire" as const }))
    : await pressed;
  const onDisk = store1.entries<{ mutation: EngineMutation }>(OUTBOX_TYPE).map((e) => e.entity);
  store1.close();

  const store2 = new IndexedDbMirrorStore({ owner, factory });
  const e2 = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://x", fetch: srv.fetchImpl as never }) as never, store: store2, now,
  } as never);
  await e2.hydrate();
  await e2.syncOnce().catch(() => undefined);
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => { setTimeout(r, 5); });
  const left = store2.entries<unknown>(OUTBOX_TYPE).length;
  store2.close();
  return { srv, first, onDisk, left };
}

describe("a send that made its row replays that row after a reload", () => {
  it("the send failed before the server took it: one row, and the replay sends it", async () => {
    const { srv, first, onDisk, left } = await sessions("network", "acct-replay-row-a");
    expect(first.status, "the first press did not queue on a network failure").toBe("queued");
    expect(onDisk, "the queued send is not on disk, so the reload measures nothing").toHaveLength(1);
    expect(count(srv.calls, "POST", /^\/drafts$/), "the replay created a second row for one message").toBe(1);
    expect(count(srv.calls, "POST", /^\/drafts\/row-1\/send$/), "the replay did not send the row it made").toBe(2);
    expect(srv.sentKeys.size, "the message went under more than one key").toBe(1);
    // As the session that made the row retries it: the row as created, never a PUT over it.
    expect(count(srv.calls, "PUT", /^\/drafts\/row-1$/)).toBe(0);
    expect(left, "the delivered send is still queued").toBe(0);
  }, 20_000);

  it("the tab died while the send was on the wire: the row was on disk before the request went", async () => {
    const { srv, first, left } = await sessions("hang", "acct-replay-row-c");
    expect(first.status).toBe("on_the_wire");
    expect(count(srv.calls, "POST", /^\/drafts$/), "the replay created a second row for one message").toBe(1);
    expect(count(srv.calls, "POST", /^\/drafts\/row-1\/send$/), "the replay did not send the row it made").toBe(2);
    expect(left).toBe(0);
  }, 20_000);

  it("the server took the send and the answer was lost: one row, and the replay finishes as sent", async () => {
    const { srv, left } = await sessions("committed-then-lost", "acct-replay-row-b");
    expect(count(srv.calls, "POST", /^\/drafts$/), "the replay created a second row for one message").toBe(1);
    expect(count(srv.calls, "POST", /^\/drafts\/row-1\/send$/), "the replay did not ask the row it made").toBe(2);
    expect(srv.sentKeys.size).toBe(1);
    expect(left, "a send the server took is still queued, or was refused over a row it cannot rewrite").toBe(0);
  }, 20_000);
});
