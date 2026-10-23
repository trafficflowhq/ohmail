/**
 * THE DRAIN'S TWO READS UNDER A DEADLINE, ON THE DOOR THAT ASKS FOR ONE.
 *
 * `fetch` has no deadline of its own, and a `/sync` sent over a connection that died silently
 * (sleep, a network change) never answers: the drive that awaits it holds every later drain and
 * replay. With `syncDeadlines` the answer must come within `answerMs` and its body within `bodyMs`
 * after it; either one aborts the request and rejects as a retryable `timeout`. Two stages,
 * because a dense backlog page can take longer than the answer deadline to arrive on a slow link
 * while a dead connection never answers at all.
 * Mutations: the abort dropped → case 1's abort red; the body stage dropped (one timer for both) →
 * case 3 red (slow body) or case 2 red (stalled body); the option made the default → case 5 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpAdapter, MutationRejectedError, SYNC_ANSWER_TIMEOUT_MS, SYNC_BODY_TIMEOUT_MS,
} from "@ohmail/client-engine";

const DEADLINES = { answerMs: SYNC_ANSWER_TIMEOUT_MS, bodyMs: SYNC_BODY_TIMEOUT_MS };
const page = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "9", hasMore: false, serverTime: "x",
});
const snapshotPage = JSON.stringify({ asOfSeq: 9, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });

/** An answer whose body arrives in two halves, the second `ms` after the first. */
function slowBody(body: string, ms: number): Response {
  const enc = new TextEncoder();
  const half = Math.floor(body.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(body.slice(0, half)));
      setTimeout(() => { c.enqueue(enc.encode(body.slice(half))); c.close(); }, ms);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

/** A transport that never answers, and says when it was told to stop. */
function deadSocket(): { fetch: (u: string, init?: RequestInit) => Promise<Response>; aborted: () => boolean } {
  let aborted = false;
  return {
    fetch: (_u, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    }),
    aborted: () => aborted,
  };
}

function watch(p: Promise<unknown>): { readonly value: unknown } {
  const box = { value: "pending" as unknown };
  p.then((v) => { box.value = v; }, (err) => { box.value = err; });
  return box;
}

const adapterOn = (fetch: (u: string, init?: RequestInit) => Promise<Response>, deadlines: typeof DEADLINES | null = DEADLINES) =>
  new HttpAdapter({ baseUrl: "http://x", getCookie: () => null, fetch, ...(deadlines ? { syncDeadlines: deadlines } : {}) });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("GET /sync under the door's deadlines", () => {
  it("1 — no answer: a retryable timeout at the answer deadline, and the request is aborted", async () => {
    const dead = deadSocket();
    const out = watch(adapterOn(dead.fetch).sync({ since: "5" }));
    await vi.advanceTimersByTimeAsync(SYNC_ANSWER_TIMEOUT_MS - 1);
    expect(out.value).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(out.value).toBeInstanceOf(MutationRejectedError);
    expect((out.value as MutationRejectedError).code).toBe("timeout");
    expect((out.value as MutationRejectedError).retryable).toBe(true);
    expect(dead.aborted(), "the timed-out request was left running").toBe(true);
  });

  it("2 — a body that stalls is a timeout, its deadline counted from the answer", async () => {
    const out = watch(adapterOn(async () => slowBody(page, 10 * 60_000)).sync({ since: "5" }));
    await vi.advanceTimersByTimeAsync(SYNC_BODY_TIMEOUT_MS - 1);
    expect(out.value, "the body's deadline was the answer's").toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect((out.value as MutationRejectedError | string)).toBeInstanceOf(MutationRejectedError);
    expect((out.value as MutationRejectedError).code).toBe("timeout");
  });

  it("3 — CONTROL: a slow link whose body takes 50 s after a quick answer still lands", async () => {
    const out = watch(adapterOn(async () => slowBody(page, 50_000)).sync({ since: "5" }));
    await vi.advanceTimersByTimeAsync(50_001);
    expect((out.value as { cursor?: string }).cursor, "a slow but live page was cut off").toBe("9");
  });

  it("4 — the snapshot read takes the same deadline", async () => {
    const dead = deadSocket();
    const out = watch(adapterOn(dead.fetch).snapshot({}));
    await vi.advanceTimersByTimeAsync(SYNC_ANSWER_TIMEOUT_MS + 1);
    expect((out.value as MutationRejectedError).code).toBe("timeout");
    expect(dead.aborted()).toBe(true);
    const fine = watch(adapterOn(async () => slowBody(snapshotPage, 50_000)).snapshot({}));
    await vi.advanceTimersByTimeAsync(50_001);
    expect((fine.value as { asOfSeq?: number }).asOfSeq).toBe(9);
  });

  it("5 — CONTROL: without the option nothing changes (every other door)", async () => {
    const out = watch(adapterOn(deadSocket().fetch, null).sync({ since: "5" }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(out.value, "a door that asked for no deadline got one").toBe("pending");
  });
});
