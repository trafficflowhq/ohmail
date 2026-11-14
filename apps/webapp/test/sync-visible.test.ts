/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { REFUSAL_SUSTAIN_MS } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * A FAILING SYNC IS VISIBLE WITH ROWS PRESENT, IN EVERY VIEW.
 *
 * ── WHAT THIS FILE HAS TO BITE ──────────────────────────────────────────────────────────
 *
 * "Sync failed. Retrying." shipped, and `sync-liveness-shell.test.ts` proved it — by
 * mounting an Ohbox with `newForYou: []` and `previouslySeen: []`. That test could not fail
 * for the bug that was actually shipped, because the bug was that the sentence lived inside
 * the EMPTY state: a mailbox with rows in it never reached the branch, in any view, ever.
 * A green suite and a silently stale mailbox at the same time.
 *
 * So every assertion here is made with MAIL ON SCREEN, through the real `AppShell`, against
 * a real `HttpAdapter` whose `/sync` starts working and then stops. Three things are under
 * test and each one is a separate way to get this wrong:
 *
 *   1. the failure is SAID, with rows present, in Ohbox / Reads / Receipts / Screener;
 *   2. `terminal` (a refusal no retry can fix) does not claim to be retrying;
 *   3. a healthy loop says NOTHING — the guard that stops this becoming chrome nobody reads.
 *
 * ── HARNESS ACCOMMODATIONS, STATED ──────────────────────────────────────────────────────
 *
 * React as a global and `NEXT_PUBLIC_API_BASE` before any dynamic import: both for the
 * reasons `sync-liveness-shell.test.ts` sets out. `matchMedia` and `IntersectionObserver`
 * are jsdom gaps, stubbed at their narrowest — `matches: false` is the desktop layout, and
 * an observer that never fires simply means no card marks itself seen by scrolling, which
 * is the correct behaviour for a document nobody has scrolled.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = () => Response | Promise<Response>;

const ISO = "2026-08-02T09:00:00.000Z";

/** One real-shaped row. The views read `from.address`, `subject` and `folder` for real. */
const message = (id: string, folder: string, seq: number) => ({
  type: "message",
  op: "create",
  id,
  seq,
  updatedAt: ISO,
  entity: {
    id,
    accountId: "acct_live_1",
    mailboxId: "mb_1",
    threadId: null,
    messageIdHeader: null,
    subject: `subject of ${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date: ISO,
    folder,
    snippet: `snippet of ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {},
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: ISO,
  },
});

/**
 * A rule — the record of a screening decision, and since the consent model the ONLY thing that
 * puts a sender's mail in the Ohbox.
 *
 * This fixture needs them for a reason that is about the product and not about the harness: the
 * shell presents mail by who sent it, so an account with no rules has decided about nobody and
 * every undecided INBOX message presents in the Screener. That is correct for an account that
 * has not been through onboarding — and it is not the account this file is about, which is one
 * with mail settled in all four views. Without these two rows, `rowCount` reads zero in the
 * Ohbox and the whole file passes vacuously against an empty state, which is precisely the
 * failure its own header was written about.
 */
const rule = (match: string, seq: number) => ({
  type: "rule",
  op: "create",
  id: `rule_${match}`,
  seq,
  updatedAt: ISO,
  entity: {
    id: `rule_${match}`,
    kind: "sender",
    match,
    destination: "INBOX",
    priority: 0,
    provenance: "seeded-from-sent",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO,
    updatedAt: ISO,
  },
});

/** A mailbox that already has mail in all four list views — the case this guards. */
const populated = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          message("ohb1", "INBOX", 1),
          message("ohb2", "INBOX", 2),
          message("rd1", "ohmail/News", 3),
          message("rc1", "ohmail/Receipts", 4),
          message("sc1", "ohmail/Screener", 5),
          // The two Ohbox senders are consented; `sc1`'s deliberately is not, so the Screener
          // stays populated for the reason it exists.
          rule("ohb1@example.invalid", 6),
          rule("ohb2@example.invalid", 7),
        ],
        updates: [],
        moves: [],
        deletes: [],
      },
      cursor: "c1",
      hasMore: false,
      serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

let answer: Answer = populated;
/** What `POST /auth/refresh` answers — the catch-all's `200 {}` unless a case says otherwise. */
let refreshAnswer: (() => Response) | null = null;
let originalFetch: typeof globalThis.fetch;
let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  answer = populated;
  refreshAnswer = null;
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    /**
     * THE COLD-START READER IS ANSWERED SEPARATELY, AND WITH A 404 ON PURPOSE.
     *
     * A live engine takes `GET /sync/snapshot` before its first delta page. It has to be routed
     * before the `/sync` arm below, which is a substring match: the snapshot would otherwise be
     * handed `answer()` — a `/sync` PAGE, with no `asOfSeq` in it — and on a scripted queue that
     * silently consumes the very page these walks are about, leaving the shell rendering an
     * empty mailbox for reasons that have nothing to do with the subject.
     *
     * A 404 is the honest fixture here rather than a workaround: it is what a deployment that
     * has not shipped the reader answers, and the engine's documented response is to fall back
     * to `since=0` — the path this file has always exercised. The snapshot's own wiring is
     * proven in `snapshot-wired.test.ts`, against the real engine and the real wire.
     */
    if (url.includes("/sync/snapshot")) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no snapshot here" } }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/sync")) return answer();
    if (refreshAnswer !== null && url.includes("/auth/refresh")) return refreshAnswer();
    // The consent state, answered properly rather than by the catch-all below.
    //
    // The shell partitions mail by who sent it, and it refuses to do so until the server has
    // told it the dormancy window — so a mock that answers every url with `{}` leaves the
    // partition switched off and these walks silently stop covering it. This says what the
    // fixtures are: an ONBOARDED account (the review has been answered) on the default window.
    if (String(input).includes("/consent")) {
      return new Response(
        JSON.stringify({
          seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
          counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // jsdom ships no `CSS` object; the views use `CSS.escape` to look a row up by id. The ids
  // here need no escaping, so identity is a faithful stand-in for this test's inputs.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  // Also absent from jsdom's Element. The views scroll the cursor into view; there is no
  // layout here to scroll.
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Longest jittered draw, so the backoff ceilings are the delays.
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
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The shipped shell, live, wrapped in exactly what the Cloud and desktop entries wrap it in. */
async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

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
        now: new Date(ISO),
        children: h(ThemeProvider, {
          children: h(ToastHost, {
            children: h(AppShell, {
              demo: false,
              resolveOwner: async () => ({ kind: "owner", accountId: "acct_live_1" }) as const,
            }),
          }),
        }),
      }),
    );
    await Promise.resolve();
  });
  await tick(0);
  return container;
}

/** Move to a view the way the product does — the hash IS the route. */
async function goTo(view: string): Promise<void> {
  await act(async () => {
    window.location.hash = `#/${view}`;
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const rowCount = (el: HTMLElement): number => el.querySelectorAll(".row[data-id]").length;

describe("a failing sync is visible WITH ROWS PRESENT", () => {
  it("says so in Ohbox, Reads, Receipts and the Screener — not only where the list is empty", async () => {
    const container = await shell();

    // The premise, asserted rather than assumed: this mailbox has mail in it. Without this
    // the whole file could pass against the empty state it is here to stop relying on.
    expect(rowCount(container), "the fixture never landed — nothing below would prove anything")
      .toBeGreaterThan(0);
    expect(container.textContent ?? "").not.toContain(messages.sync.failing);

    // …and now the drains stop working, exactly as an outage does.
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    for (const view of ["ohbox", "reads", "receipts", "screener"]) {
      await goTo(view);
      const text = container.textContent ?? "";
      expect(text, `${view} said nothing about a failing sync`).toContain(messages.sync.failing);
      // No reassurance nobody asked for, and no invented remedy.
      expect(text, `${view} editorialised`).not.toMatch(/try again later|contact|sorry|don't worry/i);
    }

    // Back in the Ohbox, the rows are still there — the point of the gap is that a stale
    // list looks healthy, so the strip has to coexist with mail rather than replace it.
    await goTo("ohbox");
    expect(rowCount(container)).toBeGreaterThan(0);
  });

  it("it is not inside a scroller — it sits above the deck, where a list cannot carry it off", async () => {
    const container = await shell();
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    const bar = container.querySelector(".sync-bar");
    expect(bar).toBeTruthy();
    // Structural, because "does not scroll away" cannot be measured in jsdom: the strip must
    // be a sibling of the deck, so no view's overflow container is an ancestor of it.
    expect(bar!.closest(".deck"), "the strip was rendered inside the deck").toBeNull();
    expect(bar!.closest(".view"), "the strip was rendered inside a view").toBeNull();
    expect(bar!.parentElement!.classList.contains("shell")).toBe(true);
  });

  /**
   * ── THE COPY THAT IS ACTUALLY ON SCREEN AT A DESKTOP WIDTH ──────────────────────────────
   *
   * The sentence is rendered in two places and the stylesheet shows one of them: the rail's own
   * line wherever the rail is standing (at 1024px and up), the strip and the corner pill wherever it
   * is not. Every assertion above this one reads the STRIP — which is the copy the stylesheet
   * hides at every width a desktop browser is ever at.
   *
   * So the coverage had a hole the exact size of the product: deleting the rail's line from
   * `AppShell` left this whole file green while a failing sync said nothing at all on any screen
   * wider than 1023px. Found from a real browser at 1440, where a failing drain was reported
   * correctly in the rail and every DOM query that took the first match in document order got the
   * hidden strip instead.
   *
   * jsdom applies no stylesheet, so "which one is visible" is not a question that can be asked
   * here — `sync-notice-one-copy.test.ts` answers it against `app.css` itself. What IS assertable
   * here, and is the half that was missing, is that the rail placement EXISTS and carries the
   * same sentence: with both halves pinned, neither can be deleted in silence.
   */
  it("the RAIL carries the same sentence — the copy the stylesheet shows at 1024px and up", async () => {
    const container = await shell();
    expect(rowCount(container), "the fixture never landed").toBeGreaterThan(0);
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    const rail = container.querySelector(".rail-sync");
    expect(
      rail,
      "the rail has no sync line, so at 1024px and up — every desktop browser — a failing sync is " +
        "reported nowhere: the strip that says it is hidden at exactly those widths",
    ).toBeTruthy();
    expect(rail!.textContent ?? "", "the rail's line said something other than the failure")
      .toContain(messages.sync.failing);

    // The two shapes are one derivation, so they cannot disagree about the state. Asserted
    // rather than assumed: two independent switches over the same states is the drift
    // `SyncBar.tsx` spends forty lines arguing against, and this is where it would show.
    expect(container.querySelector(".sync-bar")!.getAttribute("role"))
      .toBe(rail!.getAttribute("role"));

    // It is inside the rail and NOT inside any view, so no list's scroller can carry it off —
    // the same structural claim the strip is held to, made where the rail's copy lives.
    expect(rail!.closest(".rail"), "the rail's sync line is not in the rail").toBeTruthy();
    expect(rail!.closest(".view"), "the rail's sync line was rendered inside a view").toBeNull();
  });
});

describe("terminal is not retrying", () => {
  it("a refusal no retry can fix says the loop has STOPPED, and offers the one remedy", async () => {
    const container = await shell();
    expect(rowCount(container)).toBeGreaterThan(0);

    // A 401 arrives from `HttpAdapter` as a MutationRejectedError with `retryable: false`
    // which is what `terminal` means: a revoked session, a deleted account.
    //
    // ── THE BODY IS NOW LOAD-BEARING, AND THIS FIXTURE WAS STALE ─────────────────────────
    // This read `new Response("{}", { status: 401 })` and went red when the auth-latch fix narrowed
    // `isTerminalRefusal` to `retryable === false && (401||403) && code !== null`. A bare `{}`
    // carries no envelope, so `code` is null — and under that narrowing a code-less 401 is
    // deliberately NOT terminal, because it is the shape Vercel's deployment protection and a
    // mid-alias `DEPLOYMENT_NOT_FOUND` return, which used to stop a signed-in user's sync
    // permanently. So the OLD fixture was asserting the very defect that fix removed.
    //
    // The assertions below are unchanged and the test's claim is unchanged: a genuine refusal
    // says STOPPED. Only the stimulus is corrected to what our API actually sends — the
    // `errorResponse` envelope from `packages/api/src/middleware.ts:212`, verified to be the ONLY
    // 401 the webapp's paths can produce, so `code` is always present on a real one.
    answer = () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    /* …AND THE REFRESH DOOR REFUSES TOO, which is what makes it a refusal no retry can fix. The
       catch-all answered it `200 {}`, a renewal that learned nothing; since a renewal fault answers
       offline (WEB-PRESS-REFUSED-ON-A-RENEWAL-FAULT-WHERE-THE-DESKTOP-KEEPS-IT, accepted), only a
       refused renewal leaves the 401 standing, so the stimulus says so. */
    refreshAnswer = () =>
      new Response(JSON.stringify({ error: { code: "refresh_expired", message: "refresh token expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await tick(30_000);

    // ── THE INTERMEDIATE STATE, ADDED BY THAT CHANGE — AND IT IS NOT A RETIMING ─────────────────
    //
    // This test used to assert "Sync stopped" right here, after 30 s. It now asserts the opposite
    // first, because the contract changed: it was reported that "Sync stopped — this session is
    // no longer authorized" appears and clears by itself, so the STRONG claim now waits for the
    // server to re-make the refusal one `REFUSAL_CONFIRM_MS` later. Simply advancing the clock and
    // keeping the old assertions would have shipped the whole new state with no coverage at the
    // one seam that matters — what the user is actually reading while it holds.
    //
    // WHAT IT MUST BE, and the three things it must not — the whole confirm seam in one place.
    //
    // It must NOT be silence: a refusal answered with nothing on screen is the 32 minutes of
    // 2026-08-03 in a different costume, so a `.sync-bar` HAS to be present and this assertion
    // fails the instant the confirm window goes truly empty again. It must NOT be the scary
    // "Sync failed. Retrying." — that was reported flashing over a healthy transient, and the
    // confirm window exists to keep it off a refusal that resolves inside it. And it must NOT be
    // the strong `stopped` claim, which one request has not yet earned. What is LEFT is the calm
    // true sentence the `catchingUp` arm renders: "Catching up…", a `status` region, no alert.
    const bar = container.querySelector(".sync-bar");
    const during = container.textContent ?? "";
    expect(bar, "a coded refusal was answered with silence for a minute").toBeTruthy();
    expect(during, "the calm confirm-window sentence never appeared").toContain("Catching up");
    expect(during, "the scary failure banner flashed over an unconfirmed refusal")
      .not.toContain(messages.sync.failing);
    expect(during, "the strong stopped claim was made on one request").not.toContain("Sync stopped");
    expect(
      bar!.classList.contains("stopped"),
      "one request told a signed-in user they are no longer authorized",
    ).toBe(false);
    expect(bar!.getAttribute("role")).toBe("status");

    // One confirm is refused the same way — and the claim STILL may not be made: sixty seconds
    // cannot tell "revoked" from "mid-deploy" (a real subscriber sat behind the quit-and-reopen
    // banner through a ~6-minute deploy window, ruling 2026-08-21). The calm sentence holds.
    await tick(61_000);
    expect(container.textContent ?? "", "one minute of refusal made the strong claim")
      .not.toContain("Sync stopped");

    // Re-made on every confirm across the whole sustain window ⇒ NOW the claim may be made.
    await tick(REFUSAL_SUSTAIN_MS);

    const text = container.textContent ?? "";
    expect(text).toContain("Sync stopped");
    // THE CLAIM UNDER TEST. The loop has disarmed itself; saying "Retrying." here would be
    // a false statement about what the app is doing.
    expect(text, "a stopped loop claimed to be retrying").not.toContain("Retrying.");
    expect(container.querySelector(".sync-bar.stopped")).toBeTruthy();
    expect(container.querySelector<HTMLAnchorElement>(".sync-bar.stopped a")!.getAttribute("href"))
      .toBe("/login");
    // Terminal is the one sync state worth interrupting for; retrying is not.
    expect(container.querySelector(".sync-bar")!.getAttribute("role")).toBe("alert");
  });

  it("a PLATFORM 401 with no envelope keeps retrying — it must never say STOPPED", async () => {
    // at the rendered-shell seam. `sync-liveness.test.ts` asserts this at the
    // SCHEDULER seam (does the loop keep issuing requests); this asserts what the user is TOLD,
    // which is the half the report actually complained about: a signed-in user reading
    // "this session is no longer authorized. Sign in" while every endpoint answered 200.
    //
    // It exists because correcting the fixture above would otherwise have deleted the only
    // coverage of the code-less case from this file. A bare 401 is what deployment protection and
    // a mid-alias 404 return — transient infrastructure, not a revoked session.
    const container = await shell();
    answer = () => new Response("{}", { status: 401 });
    await tick(30_000);

    const text = container.textContent ?? "";
    expect(text, "a platform 401 told a signed-in user their session was revoked").not.toContain("Sync stopped");
    expect(container.querySelector(".sync-bar.stopped")).toBeNull();
    // And it must not silently render nothing either: the honest state is "retrying".
    expect(container.querySelector(".sync-bar")!.getAttribute("role")).toBe("status");
  });

  it("a RETRYABLE outage renders the retrying strip, not the stopped one", async () => {
    // The control that keeps the distinction honest: if both states rendered the same
    // element, the assertion above would pass for the wrong reason.
    const container = await shell();
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    expect(container.querySelector(".sync-bar")).toBeTruthy();
    expect(container.querySelector(".sync-bar.stopped")).toBeNull();
    expect(container.querySelector(".sync-bar")!.getAttribute("role")).toBe("status");
  });
});

describe("a healthy sync says nothing", () => {
  it("no strip, no glyph, no reserved row — for as long as the drains keep landing", async () => {
    const container = await shell();
    // Ten minutes of successful eight-second polls.
    await tick(600_000);
    expect(container.querySelector(".sync-bar"), "the shell shouted at a healthy mailbox").toBeNull();
    expect(container.textContent ?? "").not.toContain("Sync");
  });

  it("one and two failures are still quiet — a blip is not an outage", async () => {
    let served = 0;
    answer = () => {
      served += 1;
      // The first drain lands (so there are rows), then two fail, then it recovers.
      if (served === 1 || served > 3) return populated();
      return new Response("{}", { status: 503 });
    };
    const container = await shell();
    expect(rowCount(container)).toBeGreaterThan(0);

    // 1 s and 2 s ceilings at the mocked draw — both failures have happened by here.
    await tick(11_000);
    expect(container.querySelector(".sync-bar"), "two failures were reported as an outage").toBeNull();
  });

  it("and the strip GOES when the mailbox recovers", async () => {
    let failing = true;
    answer = () => (failing ? new Response("{}", { status: 503 }) : populated());
    const container = await shell();
    await tick(30_000);
    expect(container.querySelector(".sync-bar")).toBeTruthy();

    failing = false;
    await tick(120_000);
    expect(container.querySelector(".sync-bar"), "a recovered mailbox kept the failure on screen")
      .toBeNull();
  });
});
