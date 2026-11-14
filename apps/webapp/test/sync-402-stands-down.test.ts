/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type MessageBodyWire,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import {
  POLL_MS, SYNC_FAILURE_STREAK, reviveStandingDown, sameSyncStatus, startSyncScheduler, type SyncStatus,
} from "@ohmail/app-logic/session/sync-scheduler";
import { deriveMailState, seedGrowth, stripSpeaks, type MailStateInputs } from "@ohmail/app-logic/mail-state/mail-state";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A `402 subscription_required` IS A FACT ABOUT THE ACCOUNT, NOT A FAILED DRAIN. The loop
 * stands down on it: no failure counted, no retry, no timer, no red strip, until the account opens
 * and the revive restarts it. A 503 is still a failure (the control), and so is a 402 that is not
 * the access refusal. Driven through the real loop and a real engine.
 */

const EMPTY: SyncResponse = {
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "c1", hasMore: false, serverTime: "2026-09-26T00:00:00.000Z",
};

const refusal = (status: number, code: string, retryable = false): MutationRejectedError =>
  new MutationRejectedError("refused", { status, code, retryable });

class Scripted implements EngineAdapter {
  calls = 0;
  constructor(public answer: () => SyncResponse | Error) {}
  async sync(): Promise<SyncResponse> {
    this.calls += 1;
    const out = this.answer();
    if (out instanceof Error) throw out;
    return out;
  }
  async mutate(): Promise<MutationOutcome> { throw new Error("never mutates"); }
  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(): Promise<MessageBodyWire> { throw new Error("never reads a body"); }
}

function visibility() {
  const listeners = new Set<() => void>();
  let state: DocumentVisibilityState = "visible";
  return {
    get visibilityState() { return state; },
    addEventListener(_t: "visibilitychange", l: () => void) { listeners.add(l); },
    removeEventListener(_t: "visibilitychange", l: () => void) { listeners.delete(l); },
    set(next: DocumentVisibilityState) { state = next; for (const l of [...listeners]) l(); },
  };
}
function online() {
  const listeners = new Set<() => void>();
  return {
    addEventListener(_t: "online", l: () => void) { listeners.add(l); },
    removeEventListener(_t: "online", l: () => void) { listeners.delete(l); },
    fire() { for (const l of [...listeners]) l(); },
  };
}

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ladder = (sync: SyncStatus): string => deriveMailState({
  sync, failureStreak: SYNC_FAILURE_STREAK,
  mailboxes: [], mirrored: 0, pulled: 0, growth: seedGrowth(0),
  freshness: { state: "unknown", asOf: null }, engineFreshness: { state: "unknown", asOf: null },
  now: NOW, demo: false,
} satisfies MailStateInputs).key;

function run(adapter: Scripted) {
  const statuses: SyncStatus[] = [];
  const doc = visibility();
  const net = online();
  const stop = startSyncScheduler(new OhmailEngine({ adapter, store: new MemoryMirrorStore() }), {
    onStatus: (s) => statuses.push(s), report: () => {}, visibility: doc, online: net,
    backoffBaseMs: 1_000, backoffCapMs: 4_000, random: () => 1,
  });
  return { statuses, doc, net, stop, last: () => statuses[statuses.length - 1]! };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("a 402 subscription_required stands the loop down", () => {
  it("counts nothing, retries never, holds no timer, and the strip stays silent", async () => {
    const adapter = new Scripted(() => refusal(402, "subscription_required"));
    const { last, doc, net, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // A wake is not a revive: coming back to the tab or the network asks nothing.
    doc.set("hidden"); doc.set("visible"); net.fire();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(adapter.calls, "the loop kept asking an account the service refused").toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(last()).toMatchObject({ failures: 0, terminal: false, refused: false, standingDown: true });
    expect(ladder(last())).toBe("quiet");
    expect(stripSpeaks(ladder(last()) as Parameters<typeof stripSpeaks>[0])).toBe(false);
    stop();
  });

  it("the revive drains at once from where it stood, and the cadence comes back", async () => {
    const adapter = new Scripted(() => refusal(402, "subscription_required"));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().standingDown).toBe(true);
    adapter.answer = () => EMPTY;
    reviveStandingDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(2);
    expect(last()).toMatchObject({ failures: 0, standingDown: false, bootstrapping: false });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(adapter.calls, "the revived loop never polled again").toBe(3);
    stop();
  });

  it("a revive of a loop that is not standing down asks nothing extra", async () => {
    const adapter = new Scripted(() => EMPTY);
    const { stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    reviveStandingDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    stop();
  });

  it("the stand-down is its own published state, so the dedup cannot swallow it", () => {
    const base: SyncStatus = { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false };
    expect(sameSyncStatus(base, { ...base, standingDown: true })).toBe(false);
    expect(sameSyncStatus(base, { ...base, standingDown: false })).toBe(true);
  });
});

describe("the controls: a failure is still a failure", () => {
  it("a 503 on every drain climbs the streak and the strip says failing", async () => {
    const adapter = new Scripted(() => refusal(503, "db_busy", true));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().failures).toBeGreaterThanOrEqual(SYNC_FAILURE_STREAK);
    expect(last().standingDown).toBe(false);
    expect(ladder(last())).toBe("failing");
    stop();
  });

  it("a 402 that is not the access refusal (credits, say) is counted like any failure", async () => {
    const adapter = new Scripted(() => refusal(402, "ai_credits_exhausted"));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().failures).toBeGreaterThanOrEqual(SYNC_FAILURE_STREAK);
    expect(last().standingDown).toBe(false);
    stop();
  });
});

/**
 * THE WALL FOLLOWS THE STAND-DOWN. A drain's 402 reaches no access sink (the loop's transport is
 * not the client whose 402 raises the wall), so the roster read — a door that does — is asked at
 * once when the loop stands down rather than on the next beat of the facts poll.
 */
describe("a stand-down asks the roster at once", () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const h = React.createElement;

  async function probesWithin(answer: () => SyncResponse | Error, ms: number): Promise<number> {
    const { EngineProvider } = await import("../app/shell/engine.js");
    const { MailStateProvider } = await import("../app/shell/MailStateProvider.js");
    const engine = new OhmailEngine({ adapter: new Scripted(answer), store: new MemoryMirrorStore() });
    let probes = 0;
    const probe = async (): Promise<unknown[]> => { probes += 1; return []; };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC",
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never, { probe, mirrored: 0, children: h("i", null, "x") } as never),
        } as never),
      } as never));
    });
    for (let left = ms; left > 0; left -= 250) {
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    }
    await act(async () => { root.unmount(); });
    host.remove();
    return probes;
  }

  it("the 402 brings a second roster read inside a second", async () => {
    expect(await probesWithin(() => refusal(402, "subscription_required"), 1_000)).toBe(2);
  });

  it("a healthy drain does not (the control)", async () => {
    expect(await probesWithin(() => EMPTY, 1_000)).toBe(1);
  });
});

/**
 * AFTER A LIFT, A STALE 402 IS NOTHING FOR THE LOOP'S STREAK AND NOTHING FOR THE WALL — one decision.
 * The open verdict is heard through the real access read; another instance's cached refusal then
 * answers the next drain. The loop keeps draining (it has no wall to revive it), counts nothing (the
 * account is open), and the sink raises nothing. Past the window the same 402 stands the loop down
 * and raises the wall (the control).
 */
describe("one staleness decision for the loop and the wall", () => {
  const jsonRes = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const REFUSAL = { error: { code: "subscription_required", message: "not active", details: { reason: "payment_required" } } };
  let walls = 0;
  let stopSink: () => void = () => {};

  beforeEach(async () => {
    process.env.NEXT_PUBLIC_API_BASE = "/api";
    const api = await import("../app/api-client");
    api.forgetAccess();
    walls = 0;
    stopSink = api.onAccessRefused(() => { walls += 1; });
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/account/access")) return jsonRes({ metered: true, access: "open", canAddMailbox: true, mailboxes: 5 }, 200);
      return jsonRes(REFUSAL, 402);
    }));
    // The lift: the wall's fresh read answered open.
    await api.account.access({ fresh: true });
  });
  afterEach(async () => {
    stopSink();
    vi.unstubAllGlobals();
    (await import("../app/api-client")).forgetAccess();
  });

  it("inside the window: the next beat drains again, nothing stands down or counts, and no wall is raised", async () => {
    const adapter = new Scripted(() => refusal(402, "subscription_required"));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(adapter.calls, "the loop stood down on a stale refusal").toBe(2);
    expect(last()).toMatchObject({ standingDown: false, failures: 0 });
    // However many beats the stale cache lasts, the loop is not failing: the account is open.
    await vi.advanceTimersByTimeAsync(4_100);
    expect(adapter.calls, "the loop stopped asking").toBeGreaterThan(4);
    expect(last().failures, "a stale refusal counted toward the streak").toBe(0);
    expect(ladder(last())).not.toBe("failing");
    const { mailboxes } = await import("../app/api-client");
    await mailboxes.list().catch(() => undefined);
    expect(walls, "a stale 402 raised the wall").toBe(0);
    // And the cadence carries the loop to the answer once the cache has caught up.
    adapter.answer = () => EMPTY;
    await vi.advanceTimersByTimeAsync(8_100);
    expect(last()).toMatchObject({ failures: 0, standingDown: false });
    stop();
  });

  it("CONTROL: inside the window a 503 is still counted, and the strip says failing", async () => {
    const adapter = new Scripted(() => refusal(503, "db_busy", true));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().failures).toBeGreaterThanOrEqual(SYNC_FAILURE_STREAK);
    expect(ladder(last())).toBe("failing");
    stop();
  });

  it("CONTROL: past the window the same 402 stands the loop down and raises the wall", async () => {
    await vi.advanceTimersByTimeAsync(60_001);
    const adapter = new Scripted(() => refusal(402, "subscription_required"));
    const { last, stop } = run(adapter);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.calls).toBe(1);
    expect(last().standingDown).toBe(true);
    const { mailboxes } = await import("../app/api-client");
    await mailboxes.list().catch(() => undefined);
    expect(walls).toBe(1);
    stop();
  });
});
