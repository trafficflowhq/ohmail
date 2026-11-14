/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ THE PRESS, END TO END: click → wire → busy until the SCAN → an outcome that is said ════
 *
 * The report (2026-08-29) was five words — "Pull new mail does nothing" — and the wire
 * half of it is pinned by `pull-wired.test.ts` (the sync gate had dropped the doorbell). THIS
 * file pins the behaviour a person can see, through the REAL seams: the real `OhmailEngine`
 * over the real `HttpAdapter` behind the real sync-gate wrapper, the real `usePullNewMail`
 * hook, both rendered placements, and the real `ToastHost`. Only the wire and the mailbox
 * probe are stubs.
 *
 *  · the press paints BUSY in the same commit (aria-busy, the spinning class, "Checking…") and
 *    puts exactly ONE `POST /sync/pull` on the wire — a second press mid-flight adds nothing;
 *  · busy HOLDS until the probe shows every rung mailbox's own `lastSyncAt` past its own
 *    baseline — the scan, not the POST round trip and not a timer;
 *  · a settle with nothing new says so, once: "Checked — nothing new." — the one outcome the
 *    mail itself cannot show (a dead control and a working quiet pull were indistinguishable,
 *    which is how the wire defect went unreported for three days);
 *  · the 30 s cap ends the watch honestly ("Still checking. New mail arrives on its own." —
 *    the stamp is durable, the spinner just stops claiming to watch);
 *  · new mail arriving silences both sentences — the rows are their own feedback.
 *
 * ── MUTATION-WATCHED (2026-08-29) ───────────────────────────────────────────────────────────
 *  · `setPulling(true)` deleted → "paints busy" red (aria-busy stayed false).
 *  · the settle loop's `baselines` comparison inverted (`<` for `>=`) → "holds busy" red
 *    (settled on the FIRST probe answer, whose stamp predates the baseline).
 *  · the quiet toast line deleted → "says nothing new" red.
 *  · `inFlight` latch removed → "one flight" red (two POSTs).
 * Round 2 (the review's two 2026-08-29):
 *  · the judgment drain reverted to an unbounded await → "half-open /sync" red (busy held past
 *    the judge cap) and "failed drain" red;
 *  · the two bounded drains collapsed to one → "stale coalesced drain" red (the quiet sentence
 *    rode the press-time drain's pre-commit page);
 *  · a failed drain judged as ok → "failed drain" red.
 * Each was watched, then the implementation was restored.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The DB-clock instants of the story: the ring's baseline, and stamps either side of it. */
const BASELINE = "2026-08-29T12:00:10.000Z";
const STAMP_BEFORE = "2026-08-29T12:00:00.000Z";
const STAMP_AFTER = "2026-08-29T12:00:12.000Z";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const quietSync = (cursor: string) => json(200, {
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor,
  hasMore: false,
  serverTime: BASELINE,
});

/** One arrived message — the "fresh" case's delivery, as the `/sync` page carries it: a
 * CHANGE row (`type`/`op`/`seq` around the entity), not a bare DTO. */
const arrival = {
  type: "message" as const,
  op: "create" as const,
  id: "fresh-1",
  seq: 7,
  updatedAt: STAMP_AFTER,
  entity: {
  id: "fresh-1",
  accountId: "acct",
  mailboxId: "mb-1",
  threadId: null,
  messageIdHeader: null,
  subject: "It arrived",
  from: { name: null, address: "sender@example.test" },
  to: [],
  cc: [],
  date: STAMP_AFTER,
  folder: "INBOX",
  snippet: "snippet",
  unread: true,
  hasAttachments: false,
  attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null,
  labels: [],
  remoteContent: "none",
  updatedAt: STAMP_AFTER,
  },
};

function facts(lastSyncAt: string | null): MailboxFacts[] {
  return [{
    id: "mb-1",
    address: "me@example.test",
    status: "connected",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt,
    createdAt: "2026-08-01T00:00:00.000Z",
  }];
}

let posts: string[];
/** What the probe answers next (a queue; the LAST entry repeats). */
let probeAnswers: Array<MailboxFacts[]>;
let probeAsks: number;
/** Whether the /sync page carries the arrival. */
let deliverArrival: boolean;
/** While true, /sync requests are HELD — their responses wait in `heldSync` for release(). */
let holdSync: boolean;
let heldSync: Array<() => void>;
/** While true, /sync answers 500. */
let failSync: boolean;
/** While true, /sync never answers at all (a half-open transport). */
let hangSync: boolean;
const originalFetch = globalThis.fetch;

function wire(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (method === "POST" && url === "/api/sync/pull") {
    posts.push(url);
    return json(202, {
      requested: 1,
      requestedAt: BASELINE,
      mailboxes: [{ id: "mb-1", requestedAt: BASELINE }],
    });
  }
  if (url.startsWith("/api/sync?")) {
    if (failSync) return json(500, { error: { code: "internal", message: "drain refused" } });
    if (deliverArrival) {
      deliverArrival = false;
      return json(200, {
        changes: { creates: [arrival], updates: [], moves: [], deletes: [] },
        cursor: "AB",
        hasMore: false,
        serverTime: STAMP_AFTER,
      });
    }
    return quietSync("AA");
  }
  return json(404, { error: { code: "not_found", message: `no stub for ${method} ${url}` } });
}

const probe = async (): Promise<MailboxFacts[]> => {
  probeAsks += 1;
  const i = Math.min(probeAsks - 1, probeAnswers.length - 1);
  return probeAnswers[i]!;
};

const roots: Root[] = [];

beforeEach(() => {
  posts = [];
  probeAnswers = [facts(STAMP_BEFORE)];
  probeAsks = 0;
  deliverArrival = false;
  holdSync = false;
  heldSync = [];
  failSync = false;
  hangSync = false;
  vi.useFakeTimers();
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/api/sync?") && hangSync) return new Promise<Response>(() => { /* half-open */ });
    if (u.startsWith("/api/sync?") && holdSync) {
      // The page is built AT REQUEST TIME and only its DELIVERY is held — a drain that read
      // before the commit must carry the pre-commit page, or the staleness under test is gone.
      const page = wire(u, init);
      return new Promise<Response>((res) => { heldSync.push(() => res(page)); });
    }
    return Promise.resolve(wire(u, init));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  for (const r of roots) {
    await act(() => r.unmount());
  }
  roots.length = 0;
  document.body.innerHTML = "";
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

/** The live construction, exactly as `engine-config.ts` shapes it: gate-wrapped HttpAdapter. */
async function mount(): Promise<{ container: HTMLElement; engine: OhmailEngine }> {
  const { createSyncGate } = await import("@ohmail/app-logic/session/sync-scheduler");
  const engine = new OhmailEngine({
    adapter: createSyncGate(null).guard(new HttpAdapter({ baseUrl: "/api" })),
  });
  const { EngineProvider } = await import("../app/shell/engine");
  const { PullNewMail, usePullNewMail } = await import("../app/shell/PullNewMail");

  function Harness(): React.ReactElement {
    const binding = usePullNewMail(probe);
    return h(React.Fragment, null,
      h(PullNewMail, { variant: "rail", binding, key: "r" }),
      h(PullNewMail, { variant: "topbar", binding, key: "t" }),
    );
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ToastHost, { children: h(EngineProvider, { demo: false, engine, children: h(Harness) }) }),
      }),
    );
  });
  return { container, engine };
}

const railButton = (c: HTMLElement): HTMLButtonElement => {
  const btn = c.querySelector<HTMLButtonElement>(".rail-pull");
  if (!btn) throw new Error("the rail placement did not render");
  return btn;
};

const press = async (c: HTMLElement): Promise<void> => {
  await act(async () => {
    railButton(c).click();
  });
};

/** Advance the settle clock one poll at a time, inside act, flushing each round's microtasks. */
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("the press, end to end", () => {
  it("paints busy in the same commit, rings ONCE, and a second press mid-flight adds nothing", async () => {
    const { container } = await mount();
    const btn = railButton(container);
    expect(btn.getAttribute("aria-busy")).toBe("false");

    await press(container);
    expect(btn.getAttribute("aria-busy"), "the press did not paint").toBe("true");
    expect(btn.className).toContain("pull-busy");
    expect(btn.textContent).toContain("Checking your mail server");
    // Both placements carry the one binding — the topbar copy is busy too.
    expect(container.querySelector(".tb-btn")?.getAttribute("aria-busy")).toBe("true");
    expect(posts, "the ring never left, or left twice").toHaveLength(1);

    await press(container); // mid-flight — the latch, not the disabled attribute, refuses it
    expect(posts).toHaveLength(1);
  });

  it("holds busy until the probe shows the SCAN (lastSyncAt past this mailbox's own baseline), then says 'nothing new' once", async () => {
    probeAnswers = [facts(STAMP_BEFORE), facts(STAMP_AFTER)];
    const { container } = await mount();
    const btn = railButton(container);

    await press(container);
    // First poll (2 s): the stamp predates the baseline — the scan has not happened; still busy.
    await advance(2_000);
    expect(probeAsks).toBe(1);
    expect(btn.getAttribute("aria-busy"), "settled on a stamp OLDER than the baseline").toBe("true");
    // Second poll: the worker's DB-clock stamp passed the baseline — the scan happened; settle.
    await advance(2_000);
    expect(probeAsks).toBe(2);
    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(document.body.textContent).toContain("Checked — nothing new.");
  });

  it("the 30 s cap ends the watch without claiming a scan it never saw", async () => {
    probeAnswers = [facts(STAMP_BEFORE)]; // never passes the baseline
    const { container } = await mount();
    const btn = railButton(container);

    await press(container);
    await advance(29_000);
    expect(btn.getAttribute("aria-busy"), "gave up before the advertised cap").toBe("true");
    await advance(2_000);
    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(document.body.textContent).toContain("Still checking. New mail arrives on its own.");
    expect(document.body.textContent).not.toContain("nothing new");
  });

  /* offline, the press spun 31-39 s and ended on nothing, or on "New mail arrives on
     its own" — false with no network. A rung mailbox whose server cannot be reached ends the watch
     at the probe that says so. Mutation watched red: the `unreachable` break and toast removed. */
  it("offline: the press ends at the probe that says the server cannot be reached, and says so", async () => {
    const offline = facts(STAMP_BEFORE).map((m) => ({ ...m, unreachableSince: STAMP_BEFORE }));
    probeAnswers = [offline];
    const { container } = await mount();
    const btn = railButton(container);
    await press(container);
    await advance(2_000);
    expect(btn.getAttribute("aria-busy"), "the press kept spinning over a server it cannot reach").toBe("false");
    expect(document.body.textContent).toContain(messages.sync.pullUnreachable);
    expect(document.body.textContent).not.toContain("New mail arrives on its own");
  });

  it("…and a settled connect error from the hosted door says the same", async () => {
    probeAnswers = [facts(STAMP_BEFORE).map((m) => ({ ...m, status: "error", errorCode: "connect" }))];
    const { container } = await mount();
    await press(container);
    await advance(2_000);
    expect(railButton(container).getAttribute("aria-busy")).toBe("false");
    expect(document.body.textContent).toContain(messages.sync.pullUnreachable);
  });

  it("a HALF-OPEN post-scan /sync cannot hold the gesture: busy clears at the judge cap, and nothing is claimed", async () => {
    /* A review finding (2026-08-29): the outcome drain was awaited UNBOUNDED, so a /sync that
       never answers held `pulling` and the single-flight latch for the tab's lifetime — every
       later click silently refused. The judge cap bounds the WAIT; the claim is withheld. */
    probeAnswers = [facts(STAMP_AFTER)];
    const { container } = await mount();
    await press(container);
    hangSync = true; // every post-press drain half-opens
    await advance(2_000); // settle observed
    await advance(10_000); // the judge cap on the flush drain
    await advance(500);
    expect(railButton(container).getAttribute("aria-busy"), "a hung drain held the gesture").toBe("false");
    expect(document.body.textContent).not.toContain("nothing new");
    expect(document.body.textContent).not.toContain("Still checking");
    // …and the latch is free: a new press rings again.
    hangSync = false;
    await press(container);
    expect(posts, "the latch never released — the second press could not ring").toHaveLength(2);
  });

  it("a FAILED post-scan drain proves nothing — no quiet sentence over a refused sync", async () => {
    probeAnswers = [facts(STAMP_AFTER)];
    const { container } = await mount();
    await press(container);
    failSync = true; // the judgment drains reject
    await advance(2_000);
    await advance(1_000);
    expect(railButton(container).getAttribute("aria-busy")).toBe("false");
    expect(document.body.textContent, "a failed drain was passed off as a quiet mailbox").not.toContain("nothing new");
  });

  it("the quiet sentence waits for a drain that STARTED after the scan — a stale coalesced drain cannot earn it", async () => {
    /* A review finding (2026-08-29): `syncOnce()` is single-flight, so the judgment's first
       await can return the PRESS-TIME drain — whose pages were read before the worker committed
       the arrivals. Held open here past the settle, then released with the quiet page it had
       already earned; only a drain STARTED after the settle serves the arrival. One await would
       judge the stale page and announce "nothing new" over mail that is already on the server. */
    probeAnswers = [facts(STAMP_AFTER)];
    const { container, engine } = await mount();
    holdSync = true; // the press-time drain's /sync is held open
    await press(container);
    await advance(2_000); // settle observed while the press drain is still in flight
    // The worker's arrivals commit; the held (stale) response releases with its quiet page.
    deliverArrival = true;
    holdSync = false;
    await act(async () => {
      for (const release of heldSync.splice(0)) release();
    });
    await advance(2_000);
    await advance(500);
    expect(railButton(container).getAttribute("aria-busy")).toBe("false");
    expect(engine.read().get("message", "fresh-1"), "the fresh post-scan drain never ran").toBeTruthy();
    expect(document.body.textContent, "a stale coalesced drain earned the quiet sentence").not.toContain("nothing new");
  });

  it("new mail silences the sentence — the rows are their own feedback", async () => {
    probeAnswers = [facts(STAMP_AFTER)]; // the scan settles on the first poll
    const { container, engine } = await mount();

    deliverArrival = true; // the press's own immediate drain delivers one message
    await press(container);
    await advance(2_000);
    expect(railButton(container).getAttribute("aria-busy")).toBe("false");
    // One extra flush: the settling drain and the scheduler's own poll can coalesce, and the
    // page's apply is a microtask chain the advancing act may return ahead of.
    await advance(0);
    expect(engine.read().get("message", "fresh-1"), "the arrival never landed — the case under test did not occur").toBeTruthy();
    expect(document.body.textContent).not.toContain("nothing new");
    expect(document.body.textContent).not.toContain("Still checking");
  });
});
