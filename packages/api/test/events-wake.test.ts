import { describe, it, expect, afterEach } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type ChangeWakeHub, type SseConfig } from "@trafficflow/api";
import { resetSseCounters, sseLiveCounts } from "../src/routes/events.js";
import { makeDeps, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /events` WITH A WAKE HUB — the push half of the realtime channel.
 *
 * `packages/db` NOTIFYs at the `recordChanges` chokepoint (proven against real Postgres in
 * `packages/db/test/change-notify.pg.test.ts`); the host holds one LISTEN connection per
 * instance and fans out through `deps.changeWake`. What THIS file proves is the route's half
 * of the contract:
 *
 *   1. a pushed wake becomes an `event: sync` frame without waiting out a poll period —
 *      the latency upgrade is real, not the poll arriving early;
 *   2. the wake is ACCOUNT-SCOPED and SEQ-GUARDED: another account's wake and a stale seq
 *      both emit nothing;
 *   3. the subscription is released when the stream closes, both by lifetime and by client
 *      cancel — a leaked callback would pin every closed stream's closure for the instance's
 *      life and keep writing into dead controllers;
 *   4. the hub is a HINT: one that throws on subscribe changes nothing about the stream, and
 *      the poll loop keeps running underneath a healthy hub (reliability floor, not fallback).
 *
 * Every case presets the session (the subject is the stream machinery, not auth) and stubs
 * the db to the one query the poll makes, exactly as `events-cost.test.ts` does.
 */
const app = createApp(apiRoutes);

const PRESET_SESSION: ApiDeps["session"] = {
  accountId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  sessionId: "33333333-3333-3333-3333-333333333333",
  lastTwofaAt: null,
  scope: "full",
  via: "bearer",
  emailVerifiedAt: FIXED_NOW,
};
const ACCT = PRESET_SESSION!.accountId;

/** The poll's one query shape, scripted. A row answers `live: true` as production does for a live session. */
function pollDb(onPoll: () => Promise<Array<{ max: string | null; live: boolean }>>): ApiDeps["db"] {
  return {
    select: () => ({ from: () => ({ where: () => onPoll() }) }),
  } as unknown as ApiDeps["db"];
}

/** A hub the test drives by hand, recording its subscription lifecycle. */
function fakeHub() {
  const subs = new Map<string, Set<(seq: bigint) => void>>();
  let unsubscribed = 0;
  const hub: ChangeWakeHub = {
    subscribe(accountId, onWake) {
      let set = subs.get(accountId);
      if (!set) { set = new Set(); subs.set(accountId, set); }
      set.add(onWake);
      return () => {
        if (set!.delete(onWake)) unsubscribed += 1;
      };
    },
  };
  return {
    hub,
    wake(accountId: string, seq: bigint): void {
      for (const cb of [...(subs.get(accountId) ?? [])]) cb(seq);
    },
    live: (accountId: string) => (subs.get(accountId)?.size ?? 0),
    unsubscribedCount: () => unsubscribed,
  };
}

const HS = (d: ApiDeps, sse: SseConfig, hub: ChangeWakeHub | null): Promise<Response> =>
  app.handle(req("GET", "/events"), {
    ...d, session: PRESET_SESSION, idempotency: null, sse, changeWake: hub,
  });

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => { resetSseCounters(); });

describe("a pushed wake becomes a frame without a poll", () => {
  it("emits `event: sync` with the PUSHED seq while the poll period has not elapsed", async () => {
    const { deps } = await makeDeps();
    const { hub, wake } = fakeHub();
    let polls = 0;
    const db = pollDb(async () => { polls++; return [{ max: "5", live: true }]; });

    // pollMs far beyond the lifetime: any sync frame in this stream is push or nothing.
    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 60_000, lifetimeMs: 250 }, hub);
    setTimeout(() => wake(ACCT, 7n), 30);
    const text = await drain(res);

    expect(text, "the pushed wake never became a frame").toContain('event: sync\ndata: {"seq":7}');
    expect(polls, "the frame above must be push — the poll never ran past its baseline read").toBe(1);
  });

  it("another ACCOUNT's wake and a STALE seq both emit nothing", async () => {
    const { deps } = await makeDeps();
    const { hub, wake } = fakeHub();
    const db = pollDb(async () => [{ max: "5", live: true }]);

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 60_000, lifetimeMs: 250 }, hub);
    setTimeout(() => {
      wake("99999999-9999-9999-9999-999999999999", 50n);  // scoping: not this stream's account
      wake(ACCT, 5n);                                     // stale: the baseline read already covers it
      wake(ACCT, 4n);                                     // behind the baseline outright
    }, 30);
    const text = await drain(res);

    expect(text, "a wake that says nothing new still produced a frame").not.toContain("event: sync\n");
  });

  it("wakes are monotonic: a burst emits each ADVANCE once, replays never", async () => {
    const { deps } = await makeDeps();
    const { hub, wake } = fakeHub();
    const db = pollDb(async () => [{ max: "5", live: true }]);

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 60_000, lifetimeMs: 300 }, hub);
    setTimeout(() => { wake(ACCT, 7n); wake(ACCT, 7n); wake(ACCT, 6n); wake(ACCT, 9n); }, 30);
    const text = await drain(res);

    const frames = [...text.matchAll(/event: sync\ndata: (\{[^\n]*\})/g)].map((m) => m[1]);
    expect(frames).toEqual(['{"seq":7}', '{"seq":9}']);
  });
});

describe("the subscription is released with the stream", () => {
  it("lifetime close unsubscribes, and the slot count returns to zero with it", async () => {
    const { deps } = await makeDeps();
    const f = fakeHub();
    const db = pollDb(async () => [{ max: null, live: true }]);

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 60_000, lifetimeMs: 150 }, f.hub);
    await sleep(50);
    expect(f.live(ACCT), "the stream never subscribed").toBe(1);
    await drain(res);

    expect(f.live(ACCT), "a closed stream is still subscribed — every wake writes into a dead controller").toBe(0);
    expect(f.unsubscribedCount()).toBe(1);
    expect(sseLiveCounts().total).toBe(0);
  });

  it("client CANCEL unsubscribes too — the door the lifetime never reaches", async () => {
    const { deps } = await makeDeps();
    const f = fakeHub();
    const db = pollDb(async () => [{ max: null, live: true }]);

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 60_000, lifetimeMs: 60_000 }, f.hub);
    const reader = res.body!.getReader();
    await reader.read();                        // the retry hint — the stream is live
    await sleep(30);
    expect(f.live(ACCT)).toBe(1);
    await reader.cancel();
    await sleep(10);

    expect(f.live(ACCT), "an EventSource that navigated away stays subscribed for ever").toBe(0);
    expect(sseLiveCounts().total).toBe(0);
  });

  it("a stream cancelled while its first read is out never holds a wake subscription", async () => {
    const { deps } = await makeDeps();
    const f = fakeHub();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const db = pollDb(async () => { await held; return [{ max: null, live: true }]; });

    const res = await HS({ ...deps, db }, { heartbeatMs: 60_000, pollMs: 60_000, lifetimeMs: 60_000 }, f.hub);
    await res.body!.cancel();
    release();
    await sleep(20);

    expect(f.live(ACCT), "a cancelled stream subscribed after its first read").toBe(0);
    expect(sseLiveCounts().total).toBe(0);
  });
});

describe("the hub is a hint, never a dependency", () => {
  it("a hub that THROWS on subscribe changes nothing: the stream serves and the poll still wakes it", async () => {
    const { deps } = await makeDeps();
    const hub: ChangeWakeHub = {
      subscribe: () => { throw new Error("LISTEN is down"); },
    };
    let calls = 0;
    const db = pollDb(async () => {
      calls++;
      return [{ max: calls > 1 ? "9" : "5", live: true }];   // the poll observes an advance on its second read
    });

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 20, lifetimeMs: 250 }, hub);
    const text = await drain(res);

    expect(text, "a broken hub killed the stream").toContain("retry: 3000");
    expect(text, "the poll no longer carries a stream whose hub is broken")
      .toContain('event: sync\ndata: {"seq":9}');
  });

  it("the poll keeps running UNDER a healthy hub — the floor, not a fallback", async () => {
    const { deps } = await makeDeps();
    const f = fakeHub();
    let polls = 0;
    const db = pollDb(async () => { polls++; return [{ max: "5", live: true }]; });

    const res = await HS({ ...deps, db }, { heartbeatMs: 5_000, pollMs: 30, lifetimeMs: 250 }, f.hub);
    await drain(res);

    // Baseline read + several poll iterations, with a subscribed hub the whole time. Delete the
    // poll loop in favour of push and this goes red: push is a HINT, and a dead LISTEN must
    // degrade latency to pollMs, never to never.
    expect(polls, "the poll stopped under a healthy hub").toBeGreaterThan(3);
  });
});
