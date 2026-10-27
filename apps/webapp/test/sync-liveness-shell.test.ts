/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * THE SEAM, exercised through the real provider.
 *
 * `sync-liveness.test.ts` drives `startSyncScheduler` directly, which proves the loop. It
 * cannot prove the thing that actually shipped broken, which is that NOTHING WAS WIRED: the
 * scheduler could be perfect and, like its predecessor, never be started, or be started twice,
 * or be started with a `document` it does not read.
 *
 * So this file mounts `EngineProvider` itself — live mode, a real `HttpAdapter`, a stubbed
 * `fetch` — and counts `/sync` requests over fake time. It is the assertion that would have
 * caught the original bug, and it is the reason the scheduler is not a prop from `CloudShell`:
 * a prop version of this test would pass while the real shell forgot to pass one.
 */

/**
 * TWO ACCOMMODATIONS FOR THE HARNESS, both stated rather than hidden.
 *
 * 1. `apps/webapp/tsconfig.json` sets `jsx: "preserve"` because Next owns that transform, and
 *    Next's SWC uses the AUTOMATIC runtime, which imports React itself. Vitest's esbuild
 *    reads the same tsconfig, finds no `react-jsx`, and emits classic `React.createElement`
 *    calls with no import to satisfy them. Publishing React as a global is what closes that
 *    gap for the modules imported below; it changes nothing about the shipped bundle. This
 *    file therefore writes `h(...)` instead of JSX, so it needs no transform of its own.
 * 2. `NEXT_PUBLIC_API_BASE` is read at module load by `engine-config.ts`, so it is set before
 *    anything is dynamically imported. A live engine with no base throws `EngineUnarmedError`
 *    on purpose — see `engine-armed.test.ts`.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = () => Response | Promise<Response>;

const emptyPage = (cursor = "c1", hasMore = false): Response =>
  new Response(
    JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor,
      hasMore,
      serverTime: "2026-08-02T00:00:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const pageOf = (ids: string[], cursor: string, hasMore: boolean): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: ids.map((id, i) => ({
          type: "message",
          op: "create",
          id,
          seq: i + 1,
          updatedAt: "2026-08-02T00:00:00.000Z",
          entity: { id, subject: id, folder: "ohmail/Screener", labels: [], unread: true },
        })),
        updates: [],
        moves: [],
        deletes: [],
      },
      cursor,
      hasMore,
      serverTime: "2026-08-02T00:00:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

let syncUrls: string[] = [];
let answer: Answer = () => emptyPage();
let originalFetch: typeof globalThis.fetch;
let visibility: DocumentVisibilityState = "visible";
let roots: Root[] = [];

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  syncUrls = [];
  answer = () => emptyPage();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    /**
     * THE COLD-START READER IS NEITHER COUNTED NOR SERVED HERE.
     *
     * This file counts DRAINS — `syncUrls.length` is "how many times did the poll fire" — and a
     * live engine now takes `GET /sync/snapshot` once before its first delta page. Routed before
     * the `/sync` arm (a substring match) for two reasons: it would otherwise be counted as a
     * drain, doubling every expectation below for a request the poll did not make; and it would
     * be handed `answer()`, a `/sync` page with no `asOfSeq`, which is not a snapshot.
     *
     * A 404 is the honest fixture rather than a way around the problem: it is what a deployment
     * without the reader answers, and the engine's documented response is the `since=0` path
     * this file has always driven. The snapshot's own wiring lives in `snapshot-wired.test.ts`.
     */
    if (url.includes("/sync/snapshot")) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no snapshot here" } }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    /**
     * NEITHER IS THE RULES-FIRST PASS. With the snapshot 404ing, the engine's cold start is the
     * degraded `since=0` bootstrap, which now opens with one `?types=rule` drain so decisions
     * land before the mail they govern (`bootstrap-rules-first.test.ts` owns that claim). It is
     * part of the same bootstrap, not a poll firing, so counting it would double the first
     * period's expectation for a request the scheduler did not schedule. Served an empty page of
     * its own rather than `answer()`, which belongs to the counted drains.
     */
    if (url.includes("/sync") && url.includes("types=rule")) {
      return pageOf([], "0", false);
    }
    if (url.includes("/sync")) {
      syncUrls.push(url);
      return answer();
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Longest jittered delay, so backoff timings are deterministic.
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  // Unconditionally, HERE: a test that defines a fake and then fails before its own cleanup
  // line would leak the fake into every later test in the file (measured — the wake-slice
  // rewrite found three tests red because of exactly this).
  for (const k of ["EventSource", "WebSocket", "XMLHttpRequest"]) {
    delete (globalThis as Record<string, unknown>)[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The narrowest fake the scheduler's `WakeStreamLike` accepts, recording its lifecycle. No
 * network, no events fired unless a test fires them — the stream's own protocol is proven in
 * `sync-wake.test.ts`; this file only proves the PROVIDER wires one up and tears it down.
 */
class FakeEventSource {
  static opened: string[] = [];
  static closed = 0;
  readonly readyState = 0;
  constructor(url: string) {
    FakeEventSource.opened.push(url);
  }
  addEventListener(): void {}
  close(): void {
    FakeEventSource.closed += 1;
  }
}

async function mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
    // `resolveOwner` is a promise; the shell renders nothing until it settles.
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { root, container };
}

const intl = (children: React.ReactNode): React.ReactElement =>
  h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children });

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function shell(
  children: React.ReactNode,
  opts: { strict?: boolean } = {},
): Promise<{ root: Root; container: HTMLElement }> {
  const { EngineProvider } = await import("../app/shell/engine.js");
  const tree = intl(
    h(EngineProvider, {
      demo: false,
      resolveOwner: async () => ({ kind: "owner", accountId: "acct_live_1" }) as const,
      children,
    }),
  );
  return mount(opts.strict ? h(React.StrictMode, { children: tree }) : tree);
}

describe("EngineProvider is where the wake signal lives", () => {
  it("polls on its own — no prop, no EventSource, no reload", async () => {
    await shell(null);
    expect(syncUrls, "the provider never drained at all").toHaveLength(1);

    await tick(8_000);
    expect(syncUrls).toHaveLength(2);
    await tick(8_000);
    expect(syncUrls).toHaveLength(3);

    // The cursor of record is carried, so these are catch-ups and not repeated bootstraps.
    expect(syncUrls[0]).toContain("since=0");
    expect(syncUrls[1]).toContain("since=c1");
  });

  it("attaches ONE EventSource on /events — the wake stream — and closes it with the shell", async () => {
    // REVERSED by the realtime-wake slice: this test used to assert `seen == []` under the
    // title "SSE is off in production and this slice does not use it". The client half now
    // ships: a live web shell holds one wake stream while visible (the server's flag decides
    // whether it answers; a refusal falls back to polling for the session — sync-wake.test.ts
    // proves that half at the scheduler seam).
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    FakeEventSource.opened = [];
    FakeEventSource.closed = 0;

    const at = (i: number) => new URL(FakeEventSource.opened[i]!, "https://ohmail.test");
    const { root } = await shell(null);
    await tick(1_000);
    expect(FakeEventSource.opened, "the provider never opened its wake stream").toHaveLength(1);
    expect(at(0).pathname).toBe("/api/events");
    const name = at(0).searchParams.get("stream");
    expect(name, "the stream carries no name of its own").toMatch(/^[0-9a-f]{32}$/);

    // A re-dial names the stream it left, so the server can end that one.
    await act(async () => { setVisibility("hidden"); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    await tick(1_000);
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(at(1).searchParams.get("stream"), "the re-dial named another stream").toBe(name);

    await act(() => {
      root.unmount();
    });
    roots = roots.filter((r) => r !== root);
    expect(FakeEventSource.closed, "an unmounted shell left its wake stream open").toBe(2);

    await shell(null);
    await tick(1_000);
    expect(FakeEventSource.opened).toHaveLength(3);
    expect(at(2).searchParams.get("stream"), "a new page reused the last page's name").not.toBe(name);
  });

  it("the demo attaches NO EventSource — same run, same fake, so the control is real", async () => {
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    FakeEventSource.opened = [];

    const { EngineProvider } = await import("../app/shell/engine.js");
    await mount(intl(h(EngineProvider, { demo: true, children: null })));
    await tick(8_000);
    expect(FakeEventSource.opened, "the demo held a connection to something").toEqual([]);
  });

  it("a hidden tab drops to the once-a-minute cadence, and focusing it drains at once", async () => {
    // REWRITTEN with the wake slice: "a hidden tab costs nothing" (zero syncs) became one
    // drain a minute, so the mailbox is at most a minute stale when somebody returns to it.
    visibility = "hidden";
    await shell(null);
    expect(syncUrls, "the mount drain hydrates and warms the mirror").toHaveLength(1);

    // Six FAST periods: silence. The 8 s cadence is a visible tab's.
    await tick(8_000 * 6);
    expect(syncUrls, "a background tab kept the visible cadence").toHaveLength(1);
    await tick(60_000 - 8_000 * 6);
    expect(syncUrls, "the hidden cadence never fired").toHaveLength(2);

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(syncUrls).toHaveLength(3);
  });

  it("StrictMode's double-invoked effect leaves exactly ONE loop", async () => {
    const { root } = await shell(null, { strict: true });
    // One drain per period, not two — the cleanup really ran between the paired effects.
    expect(syncUrls).toHaveLength(1);
    await tick(8_000);
    expect(syncUrls).toHaveLength(2);
    await tick(8_000);
    expect(syncUrls).toHaveLength(3);

    await act(() => {
      root.unmount();
    });
    roots = roots.filter((r) => r !== root);
    const after = syncUrls.length;
    await tick(60_000);
    expect(syncUrls.length, "an unmounted shell was still polling").toBe(after);
  });

  it("the demo never schedules anything", async () => {
    // The whole egress surface, not just `fetch` — the provider decides the demo's fate and
    // a scheduler leaking into it would be the one way `?demo=1` starts talking to a server.
    const egress: string[] = [];
    (globalThis as Record<string, unknown>).EventSource = class {
      constructor(u: string) { egress.push(`sse ${u}`); }
      close(): void {}
    };
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(u: string) { egress.push(`ws ${u}`); }
      close(): void {}
    };
    (globalThis as Record<string, unknown>).XMLHttpRequest = class {
      open(m: string, u: string): void { egress.push(`xhr ${m} ${u}`); }
      send(): void {}
      setRequestHeader(): void {}
    };

    const { EngineProvider } = await import("../app/shell/engine.js");
    await mount(intl(h(EngineProvider, { demo: true, children: null })));
    await tick(8_000 * 10);
    expect(syncUrls).toHaveLength(0);
    expect(egress).toEqual([]);
    expect(vi.getTimerCount(), "the demo armed a timer").toBe(0);

    for (const k of ["EventSource", "WebSocket", "XMLHttpRequest"]) {
      delete (globalThis as Record<string, unknown>)[k];
    }
  });
});

/**
 * ── WHERE THE BOOTSTRAP COUNTER WENT, AND WHY THE MOVE IS THE POINT ────────────────
 *
 * Four assertions used to live here, mounting `OhboxView` on its own and reading the pane's
 * own "Syncing your mailbox · 3 messages so far". They passed, and passing was the problem —
 * twice over:
 *
 *  1. The counter was gated on `SyncStatus.bootstrapping`, which means "this TAB's first drain
 *     has not completed". On a fresh Cloud account that is SECONDS, because the server-side
 *     mirror is empty. The WORKER's first import is a different clock: measured at minutes
 *     for a modest mailbox. So the pane fell silent within seconds and said
 *     nothing for the whole import — the thirty minutes a user spent reading "Waiting for
 *     first sync" somewhere else. A test that mounts a bare view over fake timers cannot see
 *     that, because it never has a worker.
 *  2. It was in a VIEW. `sync-visible.test.ts`'s header sets out what that costs: a sentence
 *     rendered by one pane is invisible in Reads, Receipts and the Screener, and the audit
 *     found that defect three times for exactly that reason.
 *
 * So the counter is the shell strip's `importing` state now, keyed on the MIRROR GROWING
 * (`app/shell/mail-state.ts`) rather than on a tab-local boolean. Every one of the four claims
 * survives, strengthened, in **`sync-progress.test.ts`**, which mounts the real `AppShell` with
 * a real `HttpAdapter` and a mailbox probe, so it also proves the wiring these did not:
 *
 *  · "counts what has landed, never a percentage"  → `sync-progress.test.ts`, + its
 *    no-percentage assertion, now made in every view rather than in an empty pane.
 *  · "says nothing once the drain has landed"       → (no flash on routine arrivals), which
 *    is a stricter statement of the same idea.
 *  · "after three failures the counter stops"       → the precedence arm: `failures >= 3`
 *    outranks every progress state, asserted with rows present.
 *  · "two failures is not yet a failure state"      → kept verbatim in `sync-visible.test.ts`,
 *    which already owned it for the strip.
 *
 * Nothing here was deleted to make anything pass. `pnpm vitest run apps/webapp/test` covers
 * more of this behaviour after this slice than before it.
 */
