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
async function shell(recover?: (how: "signIn" | "reload") => void): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
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
              ...(recover ? { recover } : {}),
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

/**
 * What the strip said now stands in the frame's one notice slot, beside notices about other things (the desktop
 * offer): a connection state is one whose notice says one of the frame's connection sentences.
 */
const CONNECTION_TITLES = Object.values(messages.frame.connection as Record<string, { title?: unknown }>)
  .map((words) => words.title)
  .filter((title): title is string => typeof title === "string" && !title.includes("{"));
const connectionSaid = (el: HTMLElement): HTMLElement | null =>
  [...el.querySelectorAll<HTMLElement>("[role='status'][data-place]")]
    .find((n) => CONNECTION_TITLES.some((title) => (n.textContent ?? "").includes(title))) ?? null;

/** The connection notice that says the session is gone: the strip's stopped arm. */
const stoppedSaid = (el: HTMLElement): HTMLElement | null =>
  [...el.querySelectorAll<HTMLElement>("[role='status'][data-place]")]
    .find((n) => (n.textContent ?? "").includes(messages.frame.connection.signedOut.title)) ?? null;
/** The strip's sentences, as the notice says the same states. */
const FAILING = messages.frame.connection.reconnecting.title;
const STOPPED = messages.frame.connection.signedOut.title;

describe("a failing sync is visible WITH ROWS PRESENT", () => {
  it("says so in Ohbox, Reads, Receipts and the Screener — not only where the list is empty", async () => {
    const container = await shell();

    // The premise, asserted rather than assumed: this mailbox has mail in it. Without this
    // the whole file could pass against the empty state it is here to stop relying on.
    expect(rowCount(container), "the fixture never landed — nothing below would prove anything")
      .toBeGreaterThan(0);
    expect(container.textContent ?? "").not.toContain(FAILING);

    // …and now the drains stop working, exactly as an outage does.
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    for (const view of ["ohbox", "reads", "receipts", "screener"]) {
      await goTo(view);
      const text = container.textContent ?? "";
      expect(text, `${view} said nothing about a failing sync`).toContain(FAILING);
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

    // The strip is the frame's one notice; the deck is the frame's main column.
    const bar = connectionSaid(container);
    expect(bar).toBeTruthy();
    expect(bar!.closest(".fr-main"), "the strip was rendered inside the deck").toBeNull();
    expect(bar!.closest(".view"), "the strip was rendered inside a view").toBeNull();
    expect(bar!.closest(".oh-railfoot, .fr-railfoot, .fr-noticebar") !== null).toBe(true);
  });

  /* At a desktop width the frame's one notice stands in the rail's foot: the rail's line and the strip are one node. */
  it("the RAIL carries the same sentence — the copy the stylesheet shows at 1024px and up", async () => {
    const container = await shell();
    expect(rowCount(container), "the fixture never landed").toBeGreaterThan(0);
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    const said = connectionSaid(container);
    const rail = said?.closest("nav") ? said : null;
    expect(
      rail,
      "the rail has no sync line, so at 1024px and up — every desktop browser — a failing sync is " +
        "reported nowhere: the strip that says it is hidden at exactly those widths",
    ).toBeTruthy();
    expect(rail!.textContent ?? "", "the rail's line said something other than the failure")
      .toContain(FAILING);

    expect(connectionSaid(container)!.getAttribute("role"))
      .toBe(rail!.getAttribute("role"));

    expect(rail!.closest("nav"), "the rail's sync line is not in the rail").toBeTruthy();
    expect(rail!.closest(".view"), "the rail's sync line was rendered inside a view").toBeNull();
  });
});

describe("terminal is not retrying", () => {
  it("a refusal no retry can fix says the loop has STOPPED, and offers the one remedy", async () => {
    /* The web's host hands a way back (CloudShell: Sign in leads to the sign-in page); so does this one. */
    const recover = vi.fn<(how: "signIn" | "reload") => void>();
    const container = await shell(recover);
    expect(rowCount(container)).toBeGreaterThan(0);

    // A 401 arrives from `HttpAdapter` as a MutationRejectedError with `retryable: false`, which is what
    // `terminal` means: a revoked session, a deleted account. The body is load-bearing: a code-less 401 is
    // deliberately NOT terminal (deployment protection and a mid-alias return send it), so the stimulus is
    // the `errorResponse` envelope our API actually sends.
    answer = () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    /* …and the refresh door refuses too, which is what makes it a refusal no retry can fix: a renewal fault
       answers offline, so only a refused renewal leaves the 401 standing. */
    refreshAnswer = () =>
      new Response(JSON.stringify({ error: { code: "refresh_expired", message: "refresh token expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await tick(30_000);

    // THE CONFIRM WINDOW. Not silence (a refusal answered with nothing on screen), not the failure sentence
    // (it flashed over a healthy transient), and not the strong signed-out claim, which one request has not
    // earned. What is left is the calm true sentence: catching up, a status, no alert.
    const bar = connectionSaid(container);
    const during = container.textContent ?? "";
    expect(bar, "a coded refusal was answered with silence for a minute").toBeTruthy();
    expect(during, "the calm confirm-window sentence never appeared")
      .toContain(messages.frame.connection.behind.title);
    expect(during, "the failure sentence flashed over an unconfirmed refusal").not.toContain(FAILING);
    expect(during, "the strong stopped claim was made on one request").not.toContain(STOPPED);
    expect(stoppedSaid(container), "one request told a signed-in user they are signed out").toBeNull();
    expect(bar!.getAttribute("role")).toBe("status");
    expect(container.querySelector("[role='alert']")).toBeNull();

    // One confirm refused the same way, and the claim STILL may not be made: sixty seconds cannot tell
    // "revoked" from "mid-deploy". The calm sentence holds.
    await tick(61_000);
    const afterOne = container.textContent ?? "";
    expect(afterOne, "one minute of refusal made the strong claim").not.toContain(STOPPED);
    expect(afterOne).toContain(messages.frame.connection.behind.title);

    // Re-made on every confirm across the whole sustain window: NOW the claim may be made.
    await tick(REFUSAL_SUSTAIN_MS);

    const text = container.textContent ?? "";
    expect(text).toContain(STOPPED);
    // THE CLAIM UNDER TEST. The loop has disarmed itself; saying it reconnects would be false.
    expect(text, "a stopped loop claimed to be retrying").not.toContain(FAILING);
    expect(stoppedSaid(container)).toBeTruthy();
    // The one remedy: the host's own Sign in, which the host is asked for with "signIn".
    const words = messages.frame.connection;
    const signIn = [...stoppedSaid(container)!.querySelectorAll("button")].find((b) => b.textContent === words.act.signIn);
    expect(signIn, "a stopped loop offered no way back").toBeDefined();
    expect(recover).not.toHaveBeenCalled();
    await act(async () => { signIn!.click(); });
    expect(recover.mock.calls).toEqual([["signIn"]]);
    // Terminal is the one sync state worth interrupting for; retrying is not.
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent ?? "").toContain(STOPPED);
  });

  it("a PLATFORM 401 with no envelope keeps retrying — it must never say STOPPED", async () => {
    const container = await shell();
    answer = () => new Response("{}", { status: 401 });
    await tick(30_000);

    const text = container.textContent ?? "";
    expect(text, "a platform 401 told a signed-in user their session was revoked").not.toContain(STOPPED);
    expect(stoppedSaid(container)).toBeNull();
    // And it must not silently render nothing either: the honest state is "retrying".
    expect(connectionSaid(container)!.getAttribute("role")).toBe("status");
  });

  it("a RETRYABLE outage renders the retrying strip, not the stopped one", async () => {
    // The control that keeps the distinction honest: if both states rendered the same
    // element, the assertion above would pass for the wrong reason.
    const container = await shell();
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    expect(connectionSaid(container)).toBeTruthy();
    expect(stoppedSaid(container)).toBeNull();
    expect(connectionSaid(container)!.getAttribute("role")).toBe("status");
  });
});

describe("a healthy sync says nothing", () => {
  it("no strip, no glyph, no reserved row — for as long as the drains keep landing", async () => {
    const container = await shell();
    // Ten minutes of successful eight-second polls.
    await tick(600_000);
    expect(connectionSaid(container), "the shell shouted at a healthy mailbox").toBeNull();
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
    expect(connectionSaid(container), "two failures were reported as an outage").toBeNull();
  });


  it("and the strip GOES when the mailbox recovers", async () => {
    let failing = true;
    answer = () => (failing ? new Response("{}", { status: 503 }) : populated());
    const container = await shell();
    await tick(30_000);
    expect(connectionSaid(container)).toBeTruthy();

    failing = false;
    await tick(120_000);
    expect(connectionSaid(container), "a recovered mailbox kept the failure on screen")
      .toBeNull();
  });
});
