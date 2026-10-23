/**
 * A SEND IS NEVER CUT AT THE HOLD'S CEILING: IT IS ANSWERED BY ITS OWN REQUEST, ONCE.
 *
 * Review of PR #201 (two HIGH, one MEDIUM): the 75 s ceiling ended a send's attempt the way it ends
 * a hung write's, counted from the request's start. A send's request carries its files: inline on
 * the phone and below 3 MB on the web, staged above that. Uploading them can take longer than 75 s
 * on a slow uplink, and the server reads nothing until they have arrived. The cut attempt was not
 * aborted. It finished and delivered the message, while the replay uploaded everything again:
 * - inline, every replay was cut in turn and the send never settled;
 * - staged, the replay's second upload of a stored file was refused, and a delivered message read
 *   "not sent".
 * A person's Try again on any other queued change did the same well inside the ceiling.
 *
 * Driven through the real HttpAdapter, on a fake clock with the shipped numbers, with the send
 * surface's two roads back in (its backoff flush and its late-answer collector). Past the ceiling
 * only the send's barrier goes; its request stays the one owner of its entry.
 * Mutations: the send ended at its ceiling (and by a press) like a write → cases 1, 2, 3 and 5 red;
 * `endHold` at any age → case 4 red; the send's barrier kept → cases 1 and 5 red; no drain after
 * the early release → case 1 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, OUTBOX_HOLD_CEILING_MS, OUTBOX_REPLAY_DEADLINE_MS,
  OUTBOX_TRY_AGAIN_ENDS_HOLD_MS, type ComposeAttachment, type EngineMutation, type MutationResult,
} from "@ohmail/client-engine";

const NOW = "2026-10-23T09:00:00.000Z";
const MIB = 1024 * 1024;
const STORAGE = "https://storage.test/";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const file = (bytes: number, filename: string): ComposeAttachment => ({
  filename, contentType: "application/octet-stream", contentBase64: Buffer.alloc(bytes, 7).toString("base64"),
});
const sendWith = (attachments: ComposeAttachment[]): EngineMutation => ({
  kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "the plans", body: "attached",
  to: [{ name: null, address: "to@example.test" }], cc: [], bcc: [], attachments,
} as unknown as EngineMutation);
const setAside: EngineMutation = { kind: "triage_set", messageId: "m1", state: "set_aside" } as EngineMutation;

/**
 * The hosted API and its storage, on the fake clock. `sendMs`: how long `POST /drafts/:id/send`
 * takes to answer (its body arriving, then the work); `putMs`: each storage upload. The server
 * delivers once per key, as `outbound_sends` does. Storage refuses a second upload of a stored
 * object (`x-upsert: false`) and a fresh sign over one, as the hosted storage does.
 */
function cloud(o: { sendMs?: number; putMs?: number }) {
  const t0 = Date.now();
  const log: Array<{ at: number; method: string; path: string }> = [];
  const stored = new Set<string>();
  const reserved = new Set<string>();
  let deliveries = 0;
  const fetchImpl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const key = new Headers(init.headers as HeadersInit | undefined).get("idempotency-key");
    const path = url.startsWith(STORAGE) ? url : new URL(url).pathname;
    log.push({ at: Date.now() - t0, method, path });
    if (path === "/sync") {
      return json({
        changes: {
          creates: [{
            type: "message", op: "create", id: "m1", seq: 1, updatedAt: NOW, entity: {
              id: "m1", accountId: "a1", mailboxId: "mbx-1", threadId: null, messageIdHeader: null, subject: "hi",
              from: { name: "Cy", address: "cy@example.invalid" }, to: [], cc: [], date: NOW, folder: "INBOX",
              snippet: "…", unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
              labels: [], remoteContent: "none", updatedAt: NOW,
            },
          }],
          updates: [], moves: [], deletes: [],
        },
        cursor: "1", hasMore: false, serverTime: NOW,
      });
    }
    if (method === "POST" && path === "/drafts") return json({ id: "row-1", bcc: [], mailboxId: "mbx-1" }, 201);
    if (path.endsWith("/send-attempt")) return json({ found: key !== null && reserved.has(key) });
    if (method === "POST" && path === "/attachments/staging") {
      // The ticket is the key it is minted under, and so is its object.
      const object = `o/${key}`;
      if (stored.has(object)) return json({ error: { code: "internal", message: "The resource already exists" } }, 500);
      return json({ id: `t/${key}`, uploadUrl: `${STORAGE}${object}`, uploadMethod: "PUT", uploadHeaders: { "x-upsert": "false" } }, 201);
    }
    if (url.startsWith(STORAGE)) {
      await later(o.putMs ?? 0);
      const object = url.slice(STORAGE.length);
      if (stored.has(object)) return json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 400);
      stored.add(object);
      return new Response("", { status: 200 });
    }
    if (method === "POST" && /^\/drafts\/[^/]+\/send$/.test(path)) {
      await later(o.sendMs ?? 0);
      if (key !== null && !reserved.has(key)) {
        reserved.add(key);
        deliveries += 1;
      }
      return json({ status: "sent", providerMessageId: "<p-1@example.test>" });
    }
    return json({});
  };
  const count = (method: string, re: RegExp): number => log.filter((c) => c.method === method && re.test(c.path)).length;
  return { log, fetchImpl, count, deliveries: () => deliveries };
}

async function world(o: { sendMs?: number; putMs?: number; stage?: boolean }) {
  const srv = cloud(o);
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    store,
    adapter: new HttpAdapter({
      baseUrl: "https://api.test", fetch: srv.fetchImpl as never, getCookie: () => null,
      ...(o.stage === true ? { stageAttachments: true } : {}),
    }),
  });
  await engine.start();
  return { engine, srv };
}

/**
 * `useMailSend`'s two roads back into the engine for one send, as `apps/webapp/app/shell/mail-send.ts`
 * runs them: a `queued` answer re-arms its backoff flush (5, 10, 20, 40, 60 s), and a waiting late
 * answer wakes its collector at once. Both call `flushPending`, which also dispatches the queue.
 */
function surface(engine: OhmailEngine) {
  const heard: string[] = [];
  let key: string | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const BACKOFF = [5_000, 10_000, 20_000, 40_000, 60_000];
  const arm = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void flush(); }, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  };
  const take = (r: MutationResult): void => {
    if (r.key !== key) return;
    heard.push(r.error?.code ? `${r.status}:${r.error.code}` : r.status);
    if (r.status === "queued") arm();
  };
  const flush = async (): Promise<void> => { for (const r of await engine.flushPending()) take(r); };
  const off = engine.subscribe(() => { if (engine.hasLateResults()) void flush(); });
  return {
    heard,
    press: async (m: EngineMutation): Promise<MutationResult> => {
      const pressed = engine.mutate(m);
      await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
      const r = await pressed;
      key = r.key;
      take(r);
      return r;
    },
    stop: (): void => { off(); if (timer !== null) clearTimeout(timer); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  // The upload's digest runs on the thread pool, outside the fake clock; its value is not read here.
  vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a send whose request outlasts the hold's ceiling", () => {
  it("1 — inline, 80 s to answer: one request, confirmed once; the change behind it goes at the ceiling", async () => {
    const { engine, srv } = await world({ sendMs: 80_000 });
    const ui = surface(engine);
    const pressed = await ui.press(sendWith([file(MIB, "plans.pdf")]));
    expect(pressed.status, "the send did not become the hold").toBe("queued");
    expect((await engine.mutate(setAside)).status, "a change behind the send went out beside it").toBe("queued");

    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS - OUTBOX_REPLAY_DEADLINE_MS);
    expect(srv.count("POST", /\/triage$/), "the change behind the send still waited past the ceiling").toBe(1);
    expect(srv.log.find((c) => c.path.endsWith("/triage"))!.at).toBeLessThan(80_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.heard, "the send was cut, re-sent or never confirmed").toEqual(["queued", "confirmed"]);
    expect(srv.count("POST", /\/send$/), "the send's body was uploaded again").toBe(1);
    expect(srv.deliveries()).toBe(1);
    // The drain its late answer owes (the draft's flip to sent) still follows it.
    expect(srv.log.some((c) => c.method === "GET" && c.path === "/sync" && c.at >= 80_000), "no drain followed the late answer")
      .toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(srv.count("POST", /\/send$/)).toBe(1);
    expect(engine.pendingMutations()).toEqual([]);
    ui.stop();
  });

  it("2 — staged, one file uploading for 100 s: one upload, one send, confirmed, never \"not sent\"", async () => {
    const { engine, srv } = await world({ putMs: 100_000, stage: true });
    const ui = surface(engine);
    await ui.press(sendWith([file(4 * MIB, "photos.zip")]));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ui.heard, "a delivered send was said otherwise").toEqual(["queued", "confirmed"]);
    expect(srv.count("PUT", /^https:\/\/storage\.test\//), "the file was uploaded again beside its first upload").toBe(1);
    expect(srv.count("POST", /\/send$/)).toBe(1);
    expect(srv.deliveries()).toBe(1);
    ui.stop();
  });

  it("3 — staged, two files of 50 s each: one ticket and one upload per file, one send, confirmed", async () => {
    const { engine, srv } = await world({ putMs: 50_000, stage: true });
    const ui = surface(engine);
    await ui.press(sendWith([file(2 * MIB, "a.bin"), file(2 * MIB, "b.bin")]));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ui.heard).toEqual(["queued", "confirmed"]);
    expect(srv.count("POST", /^\/attachments\/staging$/), "a file's ticket was asked for again").toBe(2);
    expect(srv.count("PUT", /^https:\/\/storage\.test\//)).toBe(2);
    expect(srv.count("POST", /\/send$/)).toBe(1);
    expect(srv.deliveries()).toBe(1);
    ui.stop();
  });
});

describe("Try again on another change while a send is on the wire", () => {
  it("4 — 20 s into a staged send of two 30 s uploads: the send is left alone and confirms; the change goes after it", async () => {
    const { engine, srv } = await world({ putMs: 30_000, stage: true });
    const ui = surface(engine);
    await ui.press(sendWith([file(2 * MIB, "a.bin"), file(2 * MIB, "b.bin")]));
    await vi.advanceTimersByTimeAsync(1_000);
    const change = await engine.mutate(setAside);
    expect(engine.queuedChanges().map((c) => c.id), "the change is not listed for Try again").toEqual([change.id]);
    await vi.advanceTimersByTimeAsync(8_000);

    const pressed = engine.retryQueued(change.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pressed)?.status, "Try again sent the change beside the send").toBe("queued");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ui.heard, "a healthy send was ended by a press on another row").toEqual(["queued", "confirmed"]);
    expect(srv.count("PUT", /^https:\/\/storage\.test\//), "a file was uploaded twice").toBe(2);
    expect(srv.count("POST", /\/send$/)).toBe(1);
    expect(srv.deliveries()).toBe(1);
    const sendAt = srv.log.find((c) => c.path.endsWith("/send"))!.at;
    expect(srv.log.find((c) => c.path.endsWith("/triage"))!.at, "the change left before the send it was made behind")
      .toBeGreaterThanOrEqual(sendAt);
    ui.stop();
  });

  it("5 — past the API's limit, Try again lets only the send's barrier go: the change leaves at once, the send is not sent again", async () => {
    const { engine, srv } = await world({ sendMs: 100_000 });
    const ui = surface(engine);
    await ui.press(sendWith([file(MIB, "plans.pdf")]));
    await vi.advanceTimersByTimeAsync(1_000);
    const change = await engine.mutate(setAside);
    await vi.advanceTimersByTimeAsync(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS - OUTBOX_REPLAY_DEADLINE_MS);

    const pressed = engine.retryQueued(change.id);
    await vi.advanceTimersByTimeAsync(10);
    // `null`: the drive the barrier's end starts took the press first.
    const r = await pressed;
    expect(r === null || r.status === "confirmed", `a press past the API's limit answered ${r?.status}`).toBe(true);
    const left = srv.log.find((c) => c.path.endsWith("/triage"))?.at;
    expect(left, "the change still waited for the send").toBeGreaterThanOrEqual(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS);
    expect(left).toBeLessThan(OUTBOX_HOLD_CEILING_MS);
    expect(srv.count("POST", /\/send$/), "the press ended the send and it went again").toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ui.heard).toEqual(["queued", "confirmed"]);
    expect(srv.count("POST", /\/send$/)).toBe(1);
    expect(srv.deliveries()).toBe(1);
    ui.stop();
  });
});
