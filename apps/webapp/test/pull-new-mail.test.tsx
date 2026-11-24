/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
import { FrameReports } from "@ohmail/app/frame";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import frameEn from "../../../packages/app/messages/frame.en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ THE PRESS, END TO END: click → wire → busy until the SCAN → an outcome that is said ════
 *
 * The report (2026-08-29) was five words — "Pull new mail does nothing" — and the wire
 * half of it is pinned by `pull-wired.test.ts` (the sync gate had dropped the doorbell). THIS
 * file pins the behaviour a person can see, through the REAL seams: the real `OhmailEngine`
 * over the real `HttpAdapter` behind the real sync-gate wrapper, the real `usePullNewMail`
 * hook, both rendered placements, and the real `FrameReports`. Only the wire and the mailbox
 * probe are stubs.
 *
 *  · the press paints BUSY in the same commit (aria-busy, the spinning class, "Checking…") and
 *    puts exactly ONE `POST /sync/pull` on the wire — a second press mid-flight adds nothing;
 *  · busy HOLDS until the probe shows every rung mailbox's own `lastSyncAt` past its own
 *    baseline — the scan, not the POST round trip and not a timer;
 *  · a settle with Up to date says so, once: "Checked — Up to date." — the one outcome the
 *    mail itself cannot show (a dead control and a working quiet pull were indistinguishable,
 *    which is how the wire defect went unreported for three days);
 *  · the 30 s cap ends the watch honestly ("Checking continues. New mail arrives on its own." —
 *    the stamp is durable, the spinner just stops claiming to watch);
 *  · new mail arriving silences both sentences — the rows are their own feedback.
 *
 * ── MUTATION-WATCHED (2026-08-29) ───────────────────────────────────────────────────────────
 *  · `setPulling(true)` deleted → "paints busy" red (aria-busy stayed false).
 *  · the settle loop's `baselines` comparison inverted (`<` for `>=`) → "holds busy" red
 *    (settled on the FIRST probe answer, whose stamp predates the baseline).
 *  · the quiet toast line deleted → "says Up to date" red.
 *  · `inFlight` latch removed → "one flight" red (two POSTs).
 * Round 2 (the review's two 2026-08-29):
 *  · the judgment drain reverted to an unbounded await → "half-open /sync" red (busy held past
 *    the judge cap) and "failed drain" red;
 *  · the two bounded drains collapsed to one → "stale coalesced drain" red (the quiet sentence
 *    rode the press-time drain's pre-commit page);
 *  · a failed drain judged as ok → "failed drain" red.
 * Each was watched, then the implementation was restored.
 * The late answer (a server that says it is not fetching):
 *  · the `behind` branch removed → "answers at once" red (busy held, the probe asked, "Still
 *    checking" at the cap); `managed` ignored → the self-hosted case red (it said Cloud).
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
/** The ring's word on fetching: `undefined` leaves the key off, as an older server does. */
let ringFetching: { behind: boolean; since: string | null } | null | undefined;
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
      ...(ringFetching === undefined ? {} : { fetching: ringFetching }),
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
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  posts = [];
  ringFetching = undefined;
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
async function mount(managed?: boolean, openMailbox = vi.fn()): Promise<{ container: HTMLElement; engine: OhmailEngine }> {
  const { createSyncGate } = await import("@ohmail/app-logic/session/sync-scheduler");
  const engine = new OhmailEngine({
    adapter: createSyncGate(null).guard(new HttpAdapter({ baseUrl: "/api" })),
  });
  const { EngineProvider } = await import("../app/shell/engine");
  /* RE-POINTED TO THE NEW SHELL (RULING-NEW-SHELL-FIRST D (1)): the hook is bound as the mail ground binds it
     (`packages/app/src/mail/ground/PullMount.tsx`: one `usePullNewMail` a frame, its words the new catalogue's `sync`,
     which says the same as the web's), and the button is the kit's rail entry fed as the ground's foot feeds it
     (`mail/ground/MailRail.ts`: the label `pull` or `pulling`, `busy`, the press). Today's two placements (rail foot,
     topbar) are the frame's two draws of the one fed foot (`frame/RailHost.tsx`): the kit's `RailFoot` where an
     account is known, the bare entry where none is. */
  const { usePullNewMail } = await import("@ohmail/app-logic/session/pull-new-mail");
  const { RailEntry, RailFoot } = await import("@ohmail/ui/mail");
  const { TextProvider, useText } = await import("@ohmail/app/text");
  const { ManagedServiceContext } = await import("@ohmail/app-logic/doors/managed-service");

  function Harness(): React.ReactElement {
    const ts = useText("sync");
    const binding = usePullNewMail(probe);
    const pull = binding.available
      ? {
          label: ts(binding.pulling ? "pulling" : (binding.result?.key ?? "pull")),
          busy: binding.pulling,
          onPress: binding.result?.mailboxId ? () => openMailbox(binding.result?.mailboxId) : binding.pull,
        }
      : undefined;
    return h(React.Fragment, null,
      h("div", { "data-placement": "rail", key: "r" },
        h(RailFoot, { pull, account: { name: "Me", address: "me@example.test", note: "1 mailbox", title: "Mailboxes" } })),
      h("div", { "data-placement": "topbar", key: "t" },
        pull ? h(RailEntry, { kind: "tool", icon: "pull", busy: pull.busy, title: pull.label, onPress: pull.onPress, children: pull.label }) : null),
    );
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      /* The web's page stands its catalogue (the capsule's own words read it) and the new shell's text above both. */
      h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children:
      h(TextProvider, {
        locale: "en",
        messages: frameEn as never,
        timeZone: "UTC",
        children: h(FrameReports, {
          children: h(EngineProvider, {
            demo: false, engine,
            // Absent is what a host that says nothing gets; the self-hosted and desktop hosts say false.
            children: managed === undefined
              ? h(Harness)
              : h(ManagedServiceContext.Provider, { value: managed, children: h(Harness) }),
          }),
        }),
      }),
      }),
    );
  });
  return { container, engine };
}

/** The rail's Pull new mail: the kit's entry in the foot (re-pointed from today's `.rail-pull`). */
const railButton = (c: HTMLElement): HTMLButtonElement => {
  const btn = c.querySelector<HTMLButtonElement>('[data-placement="rail"] button.oh-railentry');
  if (!btn) throw new Error("the rail placement did not render");
  return btn;
};
/** The second placement of the one binding (re-pointed from today's `.tb-btn`). */
const topbarButton = (c: HTMLElement): HTMLButtonElement | null =>
  c.querySelector<HTMLButtonElement>('[data-placement="topbar"] button.oh-railentry');
/** Busy as a screen reader hears it: the kit says it by `aria-busy="true"` and leaves the attribute off at rest. */
const busy = (btn: Element | null): "true" | "false" => (btn?.getAttribute("aria-busy") === "true" ? "true" : "false");

function expectInline(container: HTMLElement, words: string): void {
  expect(railButton(container).textContent).toContain(words);
  expect(topbarButton(container)?.textContent).toContain(words);
  expect(document.querySelector(".oh-toast")).toBeNull();
}

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
    expect(busy(btn)).toBe("false");

    await press(container);
    expect(busy(btn), "the press did not paint").toBe("true");
    /* The spinning mark: the kit turns the entry's sign while `aria-busy="true"` stands (`rail-entry.css`). */
    expect(btn.matches('.oh-railentry[aria-busy="true"]') && btn.querySelector(".oh-railentry-sign") !== null).toBe(true);
    expect(btn.textContent).toContain("Checking…");
    // Both placements carry the one binding — the topbar copy is busy too.
    expect(busy(topbarButton(container))).toBe("true");
    expect(posts, "the ring never left, or left twice").toHaveLength(1);

    await press(container); // mid-flight — the latch, not the disabled attribute, refuses it
    expect(posts).toHaveLength(1);
  });

  it("holds busy until the probe shows the SCAN (lastSyncAt past this mailbox's own baseline), then says 'Up to date' once", async () => {
    probeAnswers = [facts(STAMP_BEFORE), facts(STAMP_AFTER)];
    const { container } = await mount();
    const btn = railButton(container);

    await press(container);
    // First poll (2 s): the stamp predates the baseline — the scan has not happened; still busy.
    await advance(2_000);
    expect(probeAsks).toBe(1);
    expect(busy(btn), "settled on a stamp OLDER than the baseline").toBe("true");
    // Second poll: the worker's DB-clock stamp passed the baseline — the scan happened; settle.
    await advance(2_000);
    expect(probeAsks).toBe(2);
    expect(busy(btn)).toBe("false");
    expectInline(container, "Up to date");
  });

  it("the 30 s cap ends the watch without claiming a scan it never saw", async () => {
    probeAnswers = [facts(STAMP_BEFORE)]; // never passes the baseline
    const { container } = await mount();
    const btn = railButton(container);

    await press(container);
    await advance(29_000);
    expect(busy(btn), "gave up before the advertised cap").toBe("true");
    await advance(2_000);
    expect(busy(btn)).toBe("false");
    expectInline(container, "Checking continues");
    expect(document.body.textContent).not.toContain("Up to date");
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
    expect(busy(btn), "the press kept spinning over a server it cannot reach").toBe("false");
    expectInline(container, "Open Mailboxes");
    expect(document.body.textContent).not.toContain("New mail arrives on its own");
  });

  it("…and a settled connect error from the hosted door says the same", async () => {
    probeAnswers = [facts(STAMP_BEFORE).map((m) => ({ ...m, status: "error", errorCode: "connect" }))];
    const { container } = await mount();
    await press(container);
    await advance(2_000);
    expect(busy(railButton(container))).toBe("false");
    expectInline(container, "Open Mailboxes");
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
    expect(busy(railButton(container)), "a hung drain held the gesture").toBe("false");
    expect(document.body.textContent).not.toContain("Up to date");
    expect(document.body.textContent).not.toContain("Checking continues");
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
    expect(busy(railButton(container))).toBe("false");
    expect(document.body.textContent, "a failed drain was passed off as a quiet mailbox").not.toContain("Up to date");
  });

  it("the quiet sentence waits for a drain that STARTED after the scan — a stale coalesced drain cannot earn it", async () => {
    /* A review finding (2026-08-29): `syncOnce()` is single-flight, so the judgment's first
       await can return the PRESS-TIME drain — whose pages were read before the worker committed
       the arrivals. Held open here past the settle, then released with the quiet page it had
       already earned; only a drain STARTED after the settle serves the arrival. One await would
       judge the stale page and announce "Up to date" over mail that is already on the server. */
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
    expect(busy(railButton(container))).toBe("false");
    expect(engine.read().get("message", "fresh-1"), "the fresh post-scan drain never ran").toBeTruthy();
    expect(document.body.textContent, "a stale coalesced drain earned the quiet sentence").not.toContain("Up to date");
  });

  it("new mail silences the sentence — the rows are their own feedback", async () => {
    probeAnswers = [facts(STAMP_AFTER)]; // the scan settles on the first poll
    const { container, engine } = await mount();

    deliverArrival = true; // the press's own immediate drain delivers one message
    await press(container);
    await advance(2_000);
    expect(busy(railButton(container))).toBe("false");
    // One extra flush: the settling drain and the scheduler's own poll can coalesce, and the
    // page's apply is a microtask chain the advancing act may return ahead of.
    await advance(0);
    expect(engine.read().get("message", "fresh-1"), "the arrival never landed — the case under test did not occur").toBeTruthy();
    expect(document.body.textContent).not.toContain("Up to date");
    expect(document.body.textContent).not.toContain("Checking continues");
  });
});

/**
 * THE SERVER SAYS IT IS NOT FETCHING. The press ran its watch to the cap and ended on "Still
 * checking. New mail arrives on its own." for 26 hours in which nothing was checking. The ring's
 * answer now says so, and the press says it at once.
 */
describe("the press, when the server says new mail is not being fetched", () => {
  const LATE = { behind: true, since: "2026-08-28T17:40:00.000Z" };

  /* The press says what the ring's answer says. The server answers a pull by the rule of its rows
     (any mailbox it is on duty to fetch, also one it reads for another organizer), so the row here
     says what the ring says; the press reads the ring alone and has no role test of its own. */
  it.each([
    ["a mailbox this server organizes", "organizer"],
    ["a mailbox it reads for another organizer", "reader"],
  ] as const)("answers at once with the truth for %s: no watch, no waiting line, the latch free", async (_what, organizerRole) => {
    ringFetching = LATE;
    probeAnswers = [facts(STAMP_BEFORE).map((m) => ({ ...m, organizerRole, fetching: LATE }))];
    const { container } = await mount();
    await press(container);
    await advance(0);
    expect(busy(railButton(container)), "the press kept spinning").toBe("false");
    expect(busy(topbarButton(container))).toBe("false");
    expectInline(container, frameEn.sync.pullPaused);
    // Nothing is watched and nothing waits: the cap passes with no probe read and no second sentence.
    await advance(31_000);
    expect(probeAsks, "the watch ran anyway").toBe(0);
    expect(document.body.textContent).not.toContain(frameEn.sync.pullPending);
    expect(document.body.textContent).not.toContain(frameEn.sync.pullCurrent);
    // The request is stamped and the next press rings again.
    await press(container);
    expect(posts).toHaveLength(2);
  });

  it("answers a paused check on the button", async () => {
    ringFetching = LATE;
    const { container } = await mount();
    await press(container);
    await advance(0);
    expect(railButton(container).textContent).toContain("Not now, checking resumes by itself");
    expect(topbarButton(container)?.textContent).toContain("Not now, checking resumes by itself");
    expect(document.querySelector(".oh-toast")).toBeNull();
  });

  it("says so with no time on record too", async () => {
    ringFetching = { behind: true, since: null };
    const { container } = await mount();
    await press(container);
    await advance(0);
    expectInline(container, frameEn.sync.pullPaused);
    expect(busy(railButton(container))).toBe("false");
  });

  it("on a self-hosted server the same label describes the pause", async () => {
    ringFetching = LATE;
    const { container } = await mount(false);
    await press(container);
    await advance(0);
    expectInline(container, frameEn.sync.pullPaused);
    expect(document.body.textContent, "a self-hosted server was called Cloud").not.toMatch(/Cloud/);
  });

  it.each([
    ["not behind", { behind: false, since: "2026-08-29T11:59:00.000Z" }],
    ["null: this server does not say", null],
  ] as const)("CONTROL: %s keeps today's watch and its sentences", async (_what, fetching) => {
    ringFetching = fetching;
    probeAnswers = [facts(STAMP_BEFORE), facts(STAMP_AFTER)];
    const { container } = await mount();
    await press(container);
    await advance(2_000);
    expect(busy(railButton(container)), "the watch was skipped").toBe("true");
    await advance(2_000);
    expect(busy(railButton(container))).toBe("false");
    expectInline(container, frameEn.sync.pullCurrent);
    expect(document.body.textContent).not.toContain(frameEn.sync.pullPaused);
  });
});
