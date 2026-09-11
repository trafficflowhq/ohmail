/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * ═══ SETTINGS → MAILBOXES ON A DESKTOP INSTALL SIGNED IN TO A HOSTED ACCOUNT ═══════════════
 *
 * What was reported: the rows are there, nothing can be changed, and the pane says neither why
 * nor where to go instead. The list was correct and the silence was the defect.
 *
 * Why there is no edit control to add. The three routes that change a hosted mailbox —
 * `POST /mailboxes`, `PATCH /mailboxes/:id`, `DELETE /mailboxes/:id` — are step-up gated: the
 * account wants a second factor asserted within the last few minutes before it will store a
 * mailbox password. A browser tab can produce one, because it can put a password field on screen
 * and run a passkey against a real origin. A desktop install cannot: its session carries one such
 * assertion, stamped when the sign-in code was claimed, and nothing rotates that stamp forward.
 * The transport is not the obstacle — the engine's write-through proxy would carry the request and
 * the account would answer 403 — which is exactly why a control here would be a button that works
 * for five minutes and refuses for the life of the install.
 *
 * So the hosted door gets the list, one sentence, and a door to the browser. This file is the
 * assertion that all three are on screen, that the door is the app's own named-place mechanism,
 * and that the STANDALONE door — whose mailbox is configured on this machine and needs no account
 * at all — is not sent anywhere.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `cloud ?` guard around the hand-off row  → the standalone case goes red (a local
 *    install told to manage its own mailbox on a website it has no account on);
 *  · render the row on the local door only              → the hosted case goes red;
 *  · call `openWeb("account")` instead of `"mailboxes"` → the key case goes red;
 *  · replace `openWeb(…)` with `window.open(…)`         → the command case goes red, which is the
 *    one that matters: `window.open` is not granted to this window and a URL in the page is the
 *    thing the whole named-place table exists to prevent.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * The mailbox facts, supplied by replacing the hook rather than by standing up the provider.
 *
 * `MailStateProvider` is the shell's 30-second poller over `GET /mailboxes` and reads two further
 * contexts of its own; none of that is what this pane does. The pane reads ONE value, and this is
 * that value. Held in a mutable binding so each case can set it before mounting.
 */
let FACTS: MailboxFacts[] | null = null;
/** How many times the pane asked the shared poller to re-read. */
let refreshed = 0;
/**
 * MESSAGES IN THE MIRROR — the numerator of the holdings line. Published by the provider as the
 * input it was handed, never read off `state.count`, which most states leave at zero.
 */
let MIRRORED = 0;
/**
 * The ladder's verdict, as far as this pane reads it: `holdingsSpeak` asks whether the mirror has
 * been read (`settled`) and whether the loop is alive (not `stopped`, not `failing`). The resting
 * value is a settled, quiet install.
 */
let MAIL_STATE: { key: string; clock: boolean; settled: boolean } =
  { key: "quiet", clock: false, settled: true };
/**
 * The freshness verdict the pane passes on to `holdingsSpeak`. `unknown` is NOT a state key — the
 * ladder's stale arm does not fire for it — so it can only be refused through this.
 */
let FRESHNESS: { state: "unknown" | "stale" | "current" } = { state: "current" };

vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: MAIL_STATE,
    mailboxes: FACTS,
    mirrored: MIRRORED,
    freshness: FRESHNESS,
    refresh: () => { refreshed += 1; },
  }),
}));

/** What the bridge answered, per request. Set by the cases that press "Sync now". */
let bridgeReply: () => Response | Promise<Response> = () => new Response(null, { status: 202 });
/** Every request the pane put down the pipe, in order. */
let bridged: { url: string; method: string }[] = [];

/**
 * THE PANE'S REQUESTS MINUS ITS STANDING POLL — what a PRESS did, which is what these cases judge.
 *
 * The pane reads `GET /local/mailboxes/connections` on mount and every fifteen seconds after, to
 * learn whether this machine can reach each mailbox's server right now. That is background
 * traffic, not an action anybody took, and every exact-equality assertion below is about the one
 * thing a click sent down the pipe. Filtering it here keeps those assertions EXACT rather than
 * relaxing them into `toContain`, which is what would actually lose them: a press that fired two
 * requests instead of one would pass a containment check.
 *
 * The exemption is closed by {@link "the pane asks whether this machine can reach its mailboxes"}
 * below, which asserts the read HAPPENS. Without that, deleting the poll would make every case
 * here go green for a reason none of them is about.
 */
/**
 * ...FILTERED BY METHOD AND EXACT PATH, because the URL alone is not the request.
 *
 * This filtered on the URL only, which quietly widened the exemption past what it was for: the
 * pane's standing poll is one specific request — a GET to that path — and a filter that drops
 * every method drops a POST, a DELETE or a PATCH to the same URL too. An action that emitted one
 * of those would have been invisible to every exact-count assertion in this file, which is the
 * one thing they exist to catch.
 */
const pressed = (): { url: string; method: string }[] =>
  bridged.filter((c) => !(c.method === "GET" && c.url === "/local/mailboxes/connections"));

/** Shell commands the pane sent, in order. Today that is the sign-out and nothing else. */
let shellCommands: string[] = [];
/**
 * ── THE SAME EVENTS, IN THE VOCABULARY THE EARLIER CASES SPEAK ────────────────────────────────
 *
 * The single-mailbox sign-out cases were written against `loggedOut` / `shellStatuses` /
 * `logoutFails`, and every one of them still asserts something true: the door is cleared when the
 * last mailbox goes, it is NOT cleared while one remains, a failed clear is reported and is not
 * published as an engine state, and a shell with no sink is degraded rather than broken.
 *
 * They are DERIVED here rather than re-implemented, so there is one mock and one truth. Rewriting
 * four working cases to a second spelling of the same events would have been churn with a chance
 * of losing one of them; a second mock beside the first would be two things that can disagree
 * about what the pane did.
 *
 * What changed underneath them is only WHICH removal is the last one — `isLastLive` over the
 * roster instead of "the row the engine serves" — and that is asserted by the multi-mailbox cases
 * further down. `SERVED` is gone with the prop it stood for.
 */
const loggedOutCount = (): number => shellCommands.filter((c) => c === "engine_logout").length;
let logoutFails: string | null = null;
/** Whether the gate wired its status sink — false stands in for a shell that cannot be told. */
let SHELL_SINK = true;
/** What the sign-out answers with, or the error it throws. Set by the cases that press it. */
let logoutReply: () => Promise<{ state: string; mode?: string | null }> =
  async () => ({ state: "not_configured", mode: null });
/** The engine states the pane published upward — the gate's `onStatus`. */
let published: { state: string; mode?: string | null }[] = [];

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET" });
    return bridgeReply();
  },
  /* THE SHELL'S OWN SIGN-OUT, which the pane runs after removing the LAST mailbox. Mocked here
     rather than through `__TAURI_INTERNALS__` because that is where the real one lives — the
     module is already replaced for `bridgeFetch`, and a partial mock would leave this export
     `undefined`, which fails as a TypeError rather than as the assertion under test. */
  engineLogout: async () => {
    shellCommands.push("engine_logout");
    /* `logoutFails` is the earlier cases' way of driving the arm where the removal landed and the
       door configuration could not be cleared — the same arm `logoutReply` can throw for. */
    if (logoutFails !== null) throw new Error(logoutFails);
    return logoutReply();
  },
}));

/** Every command the window sent the shell, in order. The bridge is not otherwise exercised. */
let invoked: { command: string; payload?: Record<string, unknown> }[] = [];

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: unknown, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const MAILBOX: MailboxFacts = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-08-07T09:00:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/** Mailbox rows only. `.set-row` is also used by the pane's own notes, so counting it raw is one
 *  too many — measured, and the reason this helper exists rather than a bare selector. */
function addressRows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll(".set-row")].filter(
    (r) => (r.querySelector(".lab b")?.textContent ?? "").includes("@"),
  ) as HTMLElement[];
}

async function render(door: string | null): Promise<HTMLElement> {
  /* Imported inside, so the module graph is built after `vi.mock` is registered. */
  const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(
          ThemeProvider,
          { storageKey: "ohmail.theme" },
          h(ToastHost, null, h(DesktopMailboxes, {
            door,
            /* The gate's own sink. Withheld by the ONE case that drives a shell which cannot be
               told — see "a shell that cannot be told". */
            ...(SHELL_SINK
              ? {
                  onShellStatus: (next: { state: string; mode?: string | null }) => {
                    published.push(next);
                  },
                }
              : {}),
          })),
        ),
      ),
    );
  });
  return mountPoint;
}

/** A button by its label, so a second control cannot be mistaken for the one under test. */
function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const openButton = (el: HTMLElement) => buttonSaying(el, "Open ohmail.app");

/**
 * The Remove verb on the row for one address. `buttonExactly` answers the FIRST Remove in the
 * pane, which is the wrong control the moment there is more than one row — and every case about
 * which mailbox a removal names depends on pressing the right one.
 */
function rowRemove(el: HTMLElement, address: string): HTMLButtonElement {
  const row = [...el.querySelectorAll<HTMLElement>(".set-row")]
    .find((r) => (r.querySelector(".lab b")?.textContent ?? "").includes(address));
  if (!row) throw new Error(`no row for ${address}`);
  const verb = [...row.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").trim() === "Remove");
  if (!verb) throw new Error(`no Remove on the row for ${address}`);
  return verb;
}

/**
 * A button by its EXACT label. "Remove" and "Remove mailbox" are two different controls one
 * press apart, and `buttonSaying`'s `includes` cannot tell them apart — it would answer the
 * row's verb for both and the confirmation's assertions would pass without the panel existing.
 */
function buttonExactly(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null
  );
}

beforeEach(() => {
  FACTS = [MAILBOX];
  MIRRORED = 0;
  shellCommands = [];
  published = [];
  logoutReply = async () => ({ state: "not_configured", mode: null });
  MAIL_STATE = { key: "quiet", clock: false, settled: true };
  FRESHNESS = { state: "current" };
  refreshed = 0;
  bridged = [];
  bridgeReply = () => new Response(null, { status: 202 });
  logoutFails = null;
  SHELL_SINK = true;
  invoked = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      invoked.push({ command, ...(payload ? { payload } : {}) });
      return null;
    },
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("the desktop mailbox pane and a mail server it cannot reach", () => {
  /**
   * ── THE ROW MUST NOT SAY "UP TO DATE" OVER A SOCKET THAT HAS BEEN DEAD FOR AN HOUR ────────
   *
   * The engine holds one connection per mailbox and a desktop process outlives its sockets. When
   * one dies the engine re-dials on its own — but between the death and the heal the mirror stops
   * growing, and every sentence in the ladder above this one describes mail MOVING. "Up to date"
   * is true of a mirror that stopped an hour ago; "Reading only" reads nothing. The pane has to
   * say the fact instead.
   *
   * It is a fact and nothing else — no "signed out", no instruction. The mailbox is untouched,
   * the password is untouched, and the engine re-dials by itself; a sentence implying the person
   * must act would be asking for work that is not theirs.
   */
  it("says the mail server cannot be reached, and how long that has been true", async () => {
    bridgeReply = () => new Response(JSON.stringify({
      items: [{
        mailboxId: "mbx-1",
        reachable: false,
        unreachableSince: new Date(Date.now() - 20 * 60_000).toISOString(),
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const el = await render("local");
    const text = el.textContent ?? "";

    /* THE READ HAPPENED. This is what closes `pressed()`'s exemption: without this assertion,
       deleting the poll would make every exact-equality case in this file go green for a reason
       none of them is about. */
    expect(bridged).toContainEqual({ url: "/local/mailboxes/connections", method: "GET" });

    expect(text).toContain("Can't reach the mail server");
    // A DURATION and not a date. An outage that began twenty minutes ago rendered as "5 Sep 2026"
    // answers nothing a person opening Settings mid-outage is asking.
    expect(text).toContain("20 minutes ago");
    // …and the sentences it outranks are gone, rather than sitting beside it contradicting it.
    expect(text).not.toContain("Up to date");
    // No advice, no blame, no account language: this is not a sign-out and must never read as one.
    expect(text.toLowerCase()).not.toContain("sign in");
    expect(text.toLowerCase()).not.toContain("signed out");
  });

  /**
   * THE POLL ITSELF — its cadence, its independence from presses, and its END.
   *
   * `pressed()` filters this request out of every exact-equality assertion in this file, so the
   * poll is the one piece of traffic those cases cannot see. This is the case that watches it,
   * and it watches all three properties rather than only that it happens:
   *
   *  · ON MOUNT, once. A person opening Settings during an outage is who the line is for, so an
   *    interval with no leading read would leave the row lying for fifteen seconds.
   *  · A PRESS ADDS NOTHING HERE. If a press re-triggered the read, `pressed()` would still be
   *    exact — but the pane would be issuing a request per click for a poll it already has, and
   *    no assertion in this file could tell.
   *  · UNMOUNT STOPS IT. A poll that outlives its pane is a leak this codebase has had before:
   *    the interval keeps a closure, a `setState` and a bridge request alive for the life of the
   *    process, on a component nobody is looking at.
   */
  it("polls on mount, does not re-read on a press, and stops when the pane goes", async () => {
    bridgeReply = () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const reads = (): number =>
      bridged.filter((c) => c.url === "/local/mailboxes/connections").length;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      expect(reads(), "the pane waited a whole interval before asking").toBe(1);

      // ── A PRESS IS NOT A REASON TO RE-READ ─────────────────────────────────────────────
      await act(async () => { buttonSaying(el, "Sync now")!.click(); });
      expect(pressed()).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
      expect(reads(), "a press dragged the poll along with it").toBe(1);

      // ── THE CADENCE ────────────────────────────────────────────────────────────────────
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(reads(), "the interval never came round").toBe(2);

      // ── AND IT ENDS WITH THE PANE ──────────────────────────────────────────────────────
      await act(async () => { root!.unmount(); });
      root = null;
      const atUnmount = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(reads(), "the poll outlived the pane it belongs to").toBe(atUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * AN OLDER ANSWER MUST NOT OVERWRITE A NEWER ONE.
   *
   * Two reads are in flight whenever one takes longer than the interval, and an engine mid-
   * reconnect is exactly when one will. Promises settle in the order they FINISH, not the order
   * they started, so a slow first read can land second and put a stale answer on screen — the row
   * flipping back to "reachable" during an outage, and staying wrong until the next tick.
   */
  it("ignores a poll response that is older than one already shown", async () => {
    const reach = (unreachable: boolean): Response => new Response(JSON.stringify({
      items: [{
        mailboxId: "mbx-1",
        reachable: !unreachable,
        unreachableSince: unreachable ? new Date(Date.now() - 20 * 60_000).toISOString() : null,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    /* EVERY READ PARKS, and the test releases them OUT OF ORDER — which is the only thing that
       has to be true for this defect to happen in the field. */
    const parked: Array<(r: Response) => void> = [];
    bridgeReply = () => new Promise<Response>((resolve) => { parked.push(resolve); });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      expect(parked, "the mount read did not happen").toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(parked, "the interval never issued a second read").toHaveLength(2);

      // THE NEWER ONE LANDS FIRST and says the server is unreachable…
      await act(async () => { parked[1]!(reach(true)); });
      expect(el.textContent ?? "").toContain("Can't reach the mail server");

      // …and the OLDER one lands after it, saying everything is fine. It must be ignored.
      await act(async () => { parked[0]!(reach(false)); });
      expect(
        el.textContent ?? "",
        "a response that started earlier overwrote a newer one — the row lies until the next tick",
      ).toContain("Can't reach the mail server");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE FILTER EXEMPTS THE POLL, NOT THE URL.
   *
   * `pressed()` drops the pane's standing read so the exact-count assertions elsewhere stay
   * exact. It filtered on the URL alone, which is wider than the thing being exempted: the poll
   * is one specific request, a GET, and an action that sent a POST or a DELETE to the same path
   * would have been invisible to every assertion in this file.
   */
  it("does not hide a NON-GET request to the connections path", () => {
    bridged = [
      { url: "/local/mailboxes/connections", method: "GET" },
      { url: "/local/mailboxes/connections", method: "POST" },
    ];
    expect(
      pressed(),
      "a write to the poll's URL was filtered away with the poll",
    ).toEqual([{ url: "/local/mailboxes/connections", method: "POST" }]);
  });

  /**
   * AN ENGINE THAT DOES NOT SERVE THE ROUTE IS "CANNOT TELL", NEVER "UNREACHABLE".
   *
   * A desktop updates on its own schedule, so a window newer than its engine is an ordinary
   * state rather than a fault — and the served host transport does not carry the local routes at
   * all. The dangerous default is the other one: a pane that read silence as an outage would tell
   * somebody their mail had stopped every time an update landed.
   */
  it("falls back to the ordinary state when the engine does not answer the question", async () => {
    bridgeReply = () => new Response(null, { status: 404 });
    const text = (await render("local")).textContent ?? "";
    expect(text).toContain("Up to date");
    expect(text).not.toContain("Can't reach the mail server");
  });
});

describe("the desktop mailbox pane on the hosted door", () => {
  it("lists the mailboxes, says where they are managed, and offers the way there", async () => {
    const el = await render("cloud");
    const text = el.textContent ?? "";

    // THE LIST — the pane's original and still primary job.
    expect(text).toContain("someone@example.test");
    expect(text).toContain("Up to date");
    // It names the hosted mode with the SAME words a browser tab uses.
    expect(text).toContain("Cloud mailboxes");

    // THE NOTE. Not an apology and not a shrug: it says where, and it says why.
    expect(text).toContain("Mailboxes are managed in ohmail on the web");
    expect(text).toMatch(/second factor/);

    // THE AFFORDANCE.
    expect(openButton(el), "no way out to the browser").not.toBeNull();
  });

  it("the button opens the browser through the shell's named-place command", async () => {
    const el = await render("cloud");
    await act(async () => { openButton(el)!.click(); });

    // ONE command, and it carries a KEY. A `url` in this payload would mean the page decides
    // where the user's real browser goes, which is what the table on the Rust side exists to
    // prevent; the address for `mailboxes` is written there and nowhere in this bundle.
    expect(invoked).toEqual([{ command: "open_link", payload: { key: "mailboxes" } }]);
  });

  it("a refusal to open a browser is said on the pane, not swallowed", async () => {
    host.__TAURI_INTERNALS__!.invoke = async () => {
      throw new Error("no browser on this machine");
    };
    const el = await render("cloud");
    await act(async () => { openButton(el)!.click(); });
    expect(el.textContent ?? "").toContain("would not open a browser");
  });

  it("an account with no mailbox yet is pointed at the web, not at the Desktop pane", async () => {
    // The old empty-state sentence sent everybody to "the Desktop settings pane", which is where
    // a STANDALONE install picks a mail server. On the hosted door that pane switches doors; the
    // mailbox belongs to the account.
    FACTS = [];
    const text = (await render("cloud")).textContent ?? "";
    expect(text).toContain("Connecting one happens in ohmail on the web");
    expect(text).not.toContain("Desktop settings pane");
  });

  /**
   * ── THE ONE MUTATION THAT IS NOT STEP-UP GATED ───────────────────────────────────────────
   *
   * `POST /mailboxes/:id/resync` is the single writing route in `mailboxRoutes` with no `stepUp`
   * option, which is why it is the single thing this pane can change on a hosted account. It goes
   * down the pipe like every other request this window makes; the engine's proxy relays it with
   * the install's bearer. The webview opens nothing.
   */
  it("Sync now round-trips over the bridge and re-reads the shared facts", async () => {
    const el = await render("cloud");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });

    expect(pressed()).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    // The strip at the foot of the rail reads the same route on a slower clock; the pane pushes it.
    expect(refreshed).toBe(1);
    /* And the row is pressable again. This asserted the opposite; the pending it named never
       ended, because 202 is the only answer the route gives. */
    expect(
      buttonSaying(el, "Sync queued"),
      "the control is still holding a mark for a press the engine already has",
    ).toBeNull();
    expect(buttonSaying(el, "Sync now")?.disabled).toBe(false);
    // …and NOTHING left the webview to do it. The command channel was never touched.
    expect(invoked).toEqual([]);
  });

  it("a SECOND press after an accepted one is delivered", async () => {
    /* Pressable is not the same as PRESSED: a click on a disabled button emits nothing, so the
       count of what reached the pipe is the reading. */
    const el = await render("cloud");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });
    /* Named rather than asserted through a `!`: a control that is gone would otherwise fail as a
       TypeError and read as a broken fixture. */
    const again = buttonSaying(el, "Sync now");
    expect(again, "the control is no longer offering Sync now after an accepted press").not.toBeNull();
    await act(async () => { again!.click(); });

    expect(
      pressed(),
      "the second press never reached the engine — the button was still marked from the first",
    ).toEqual([
      { url: "/mailboxes/mbx-1/resync", method: "POST" },
      { url: "/mailboxes/mbx-1/resync", method: "POST" },
    ]);
  });

  it("a mailbox the engine is ALREADY syncing still offers Sync now", async () => {
    /* "Syncing" is a state, not a lock: nothing in this pane reads a sync state to disable the
       press, and this case is what keeps it that way. */
    FACTS = [{ ...MAILBOX, initialImportCompletedAt: null }];
    /* The hosted door: on the standalone one the bridge double's unreadable answer to the reach
       poll puts the row's unreachable arm above every progress state. */
    const el = await render("cloud");
    expect(el.textContent ?? "", "the fixture does not put the row mid-sync").toContain("Still catching up");
    expect(
      buttonSaying(el, "Sync now")?.disabled,
      "a cycle nobody asked for took the control away",
    ).toBe(false);
  });

  it("a refused resync says the ENGINE'S sentence and lets the row be pressed again", async () => {
    // The offline refusal, which is the one that actually happens: writes are paused, reads keep
    // serving. A second taxonomy composed in the pane is how somebody offline is told their
    // mailbox is broken, so the message is carried out of the body untouched.
    bridgeReply = () =>
      new Response(
        JSON.stringify({ error: { code: "offline_read_only", message: "this install is offline" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const el = await render("cloud");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });

    expect(el.textContent ?? "").toContain("this install is offline");
    // A row left disabled after a refusal is a control nobody can retry.
    expect(buttonSaying(el, "Sync now")?.disabled).toBe(false);
    expect(refreshed).toBe(0);
  });

  it("a DISCONNECTED mailbox is not offered a resync", async () => {
    // Nothing is opening it, so a pass over it is not a thing that can be asked for.
    FACTS = [{ ...MAILBOX, status: "disabled", disabledReason: null }];
    const el = await render("cloud");
    expect(buttonSaying(el, "Sync now")).toBeNull();
    expect(el.textContent ?? "").toContain("Disconnected");
  });

  it("offers NO Remove — a hosted mailbox is removed in the account's own ceremony", async () => {
    /* The hosted door's removal is `DELETE /mailboxes/:id`, which is step-up gated: the account
       wants a second factor asserted within the last few minutes before it will destroy a stored
       credential. A desktop install's session carries exactly one such assertion, stamped when
       its link code was claimed, and nothing rotates it forward. A button here would work for the
       first five minutes of an install's life and answer 403 for ever afterwards. The browser is
       where that ceremony can be run, and the hand-off row above is the way there. */
    const el = await render("cloud");
    expect(buttonExactly(el, "Remove")).toBeNull();
    expect(el.querySelector(".mbx-remove-list")).toBeNull();
  });

  it("says nothing at all until the engine has answered", async () => {
    // `null` is "we could not ask", never "there are none" — the distinction the probe is written
    // to preserve. Neither the empty-state sentence nor the hand-off may appear here.
    FACTS = null;
    const el = await render("cloud");
    const text = el.textContent ?? "";
    expect(text).toContain("Asking the mail engine");
    expect(text).not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });
});

describe("the desktop mailbox pane on the standalone door", () => {
  it("is untouched: the list, the local heading, and NO hand-off to a website", async () => {
    const el = await render("local");
    const text = el.textContent ?? "";

    expect(text).toContain("someone@example.test");
    expect(text).toContain("Local mailboxes on this computer");

    // A standalone install has no ohmail account. Sending it to a page it cannot sign in to would
    // be worse than saying nothing, and its mailbox is edited on this machine — the door chooser
    // writes it through the shell and sends the password over this same bridge, with no factor and
    // no server involved.
    expect(text).not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });

  it("keeps the resync, which the local engine serves out of its own route table", async () => {
    const el = await render("local");
    await act(async () => { buttonSaying(el, "Sync now")!.click(); });
    expect(pressed()).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    expect(invoked).toEqual([]);
  });

  it("keeps its own empty state, and it names the control this pane now has", async () => {
    /* IT USED TO SAY "choose one in the Desktop settings pane", which was the truth while the
       only way to connect a mailbox was the door chooser behind that pane. This pane connects
       them itself now, so the sentence points at its own button — and the button is on screen
       with no mailbox connected, which is the state it is most needed in. */
    FACTS = [];
    const el = await render("local");
    const text = el.textContent ?? "";
    expect(text).not.toContain("Desktop settings pane");
    expect(text).toContain("“Add mailbox” connects one");
    expect(buttonExactly(el, "Add mailbox"), "the empty pane names a control it does not offer")
      .not.toBeNull();
  });

  /* ══ ADD MAILBOX — the capability the sidecar grew and the window could not reach ═════════
   *
   * `POST /local/mailboxes` writes a further row, proves its password against its own server and
   * attaches a runtime for it. Without a control it is the shape this pane has been in before:
   * a route nothing calls, and a product claim with nothing behind it.
   *
   * Mutations watched red: drop the `firstRunDoorFor` gate → the hosted case reds (a button that
   * navigates somewhere blank); navigate to the bare `#/first-run` → the intent case reds, and
   * that is the one that matters, because a finished install derives to "nothing to do" and the
   * stage would open and close on the same render.
   */
  it("OFFERS ADD MAILBOX above the list, on the standalone door, at the add route", async () => {
    const el = await render("local");
    const add = buttonExactly(el, "Add mailbox");
    expect(add, "a standalone install cannot connect a second mailbox from this pane").not.toBeNull();

    await act(async () => { add!.click(); });
    /* `#/first-run/add`, NEVER the bare hash. The install has been through setup, so
       `deriveOnboardingStep` answers null for it — correctly — and the intent has to ride the
       route or the stage opens, finds the completion stamp and closes again on the same render. */
    expect(window.location.hash).toBe("#/first-run/add");
    expect(pressed(), "the press connected something instead of opening the flow").toEqual([]);
  });

  it("does not offer Add mailbox on the hosted door", async () => {
    // Mailboxes are the ACCOUNT's there and this window has no first-run host for that door, so
    // the button would navigate to a route that renders nothing at all.
    const el = await render("cloud");
    expect(buttonExactly(el, "Add mailbox")).toBeNull();
  });

  it("RUN SETUP AGAIN is a row control and it names its own mailbox", async () => {
    /* It was one row at the foot of the pane. The flow writes a consent stamp and a screening
       window for a NAMED mailbox, so a control at the foot of a list of two named neither — it
       re-ran setup for whichever row `facts[0]` happened to be. */
    FACTS = [
      { ...MAILBOX, id: "mbx-1", address: "first@example.test" },
      { ...MAILBOX, id: "mbx-2", address: "second@example.test" },
    ];
    const el = await render("local");
    const rows = addressRows(el);
    expect(rows.length).toBe(2);
    const second = [...rows[1]!.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim() === "Run setup");
    expect(second, "the second mailbox has no way to re-run its own setup").toBeDefined();
    await act(async () => { second!.click(); });
    expect(window.location.hash).toBe("#/first-run/again?mailbox=mbx-2");
  });

  /* ══ REMOVE — THE DOOR OUT, WHICH THIS PANE DID NOT HAVE ═════════════════════════════════
   *
   * WHAT WAS WALKED, on the released 0.13.6: the standalone mailbox row offered "Reading only"
   * and "Sync now" and nothing else. `DELETE /local/mailboxes/:id` had been served since the
   * removal was made to mean removal — release the organizer claim, wipe this machine's mirror,
   * stop the timer, close the login — and no client called it. The pane's own footnote said "you
   * can remove it and nothing is lost from the mailbox itself", and a release note described a
   * remove-then-re-add walk nobody standing at this door could perform. The walk could not be
   * performed at all, so the mirror-wipe fix shipped unproven from a user's chair.
   *
   * The mutations these cases were watched against:
   *  · drop the `!cloud` guard around the Remove button   → the hosted case reds (a desktop
   *    install offering a removal the account will answer 403 to, for the life of the install);
   *  · point the DELETE at the shared `/mailboxes/:id`    → the route case reds, and that is the
   *    step-up trap the whole `/local/*` family exists for;
   *  · render the confirmation's fifth line as the hosted `removeCopyStays` → the copy case reds
   *    with "stays in your account" on a machine that has no account;
   *  · remove the confirmation and wire the row's button straight to the DELETE → the ceremony
   *    case reds, having destroyed a stored password on one press.
   */
  it("OFFERS REMOVE, and it opens a confirmation rather than removing anything", async () => {
    const el = await render("local");
    const verb = buttonExactly(el, "Remove");
    expect(verb, "the standalone door still has no way to remove a mailbox").not.toBeNull();

    // THE PRESS IS NOT THE REMOVAL. On the hosted door the destructive press is two screens away
    // behind the account's second factor; here there is no factor to ask for, so the statement of
    // consequences IS the ceremony.
    await act(async () => { verb!.click(); });
    expect(pressed(), "the row's verb removed the mailbox with nothing confirmed").toEqual([]);

    const panel = el.querySelector('[role="alertdialog"]');
    expect(panel, "the confirmation is not an alertdialog").not.toBeNull();
    expect(panel!.textContent ?? "").toContain("Remove someone@example.test?");
  });

  it("STATES FIVE CONSEQUENCES, and the fifth is this door's and not the account's", async () => {
    /* TWO LIVE MAILBOXES, so this is the removal that is ONLY the route: the install stays
       configured, keeps organizing the other one, and the sixth consequence below would be
       false. The single-mailbox case is its own test. */
    FACTS = [MAILBOX, { ...MAILBOX, id: "mbx-2", address: "second@example.test" }];
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    const items = [...el.querySelectorAll(".mbx-remove-list li")].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(5);

    // The four that are true on both doors.
    expect(items[0]).toContain("ohmail stops organizing this mailbox.");
    expect(items[1]).toContain("Your mail is untouched.");
    expect(items[2]).toContain("password ohmail stored for this mailbox is deleted");
    expect(items[3]).toContain("Scheduled sends");

    /* AND THE ONE THAT DIFFERS. On the hosted door the copy already synced STAYS, because erasure
       there is account-scoped and there is no per-mailbox purge. On THIS door the route wipes the
       local mirror in the same request — that is the wipe the doubling fix added — so the hosted
       sentence would be false here, pointing the wrong way.

       IT NAMES THE MAILBOX NOW. "This computer's copy of the mail" was true of an install that
       held one; over two it reads as the whole machine's copy, which would be a panel promising
       an act four times the size of the one the request performs. */
    expect(items[4]).toContain("This computer's copy of this mailbox's mail is deleted");
    expect(el.textContent ?? "", "the hosted sentence is on a machine with no account")
      .not.toContain("stays in your account");
    expect(el.textContent ?? "", "the last-mailbox consequence is stated over a mailbox that remains")
      .not.toContain("returns to its setup screen");
  });

  it("STATES A SIXTH when it is the LAST mailbox, because the install loses its door", async () => {
    // One live row. Removing it leaves nothing for this install to open, so the pane signs the
    // door out afterwards — a bigger consequence than the five above, stated before the press.
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    const items = [...el.querySelectorAll(".mbx-remove-list li")].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(6);
    expect(items[5]).toContain("only mailbox on this computer");
    expect(items[5]).toContain("returns to its setup screen");
  });

  it("THE FIRST BULLET SAYS WHAT THIS INSTALL ACTUALLY DID — 'reads', on a reader", async () => {
    /* MEASURED on the released 0.13.7: the first consequence read "ohmail stops organizing this
       mailbox." on an install that had never organized it, one pane away from the banner saying
       so. The reader's bullet also answers the question the organizer's does not raise — if it
       was not organizing, what changes at the mailbox? Nothing, and it says so.

       `readerStandDown` on THIS ROW, not the roster-wide predicate the install panes use: the
       confirmation is about one mailbox and the pane has the row in hand. */
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T08:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    const items = [...el.querySelectorAll(".mbx-remove-list li")].map((n) => n.textContent ?? "");
    expect(items[0]).toBe(messages.mailboxes.removeStopsReader);
    expect(items[0], "the bullet claimed organizing this install never did")
      .not.toBe(messages.mailboxes.removeStops);
  });

  it("CONTROL: an ORGANIZER's first bullet is unchanged", async () => {
    // Which is what says the case above is about the ROLE and not about the Remove path.
    FACTS = [{ ...MAILBOX, organizerRole: "organizer", organizeConsentedAt: "2026-09-01T09:00:00.000Z" }];
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    const items = [...el.querySelectorAll(".mbx-remove-list li")].map((n) => n.textContent ?? "");
    expect(items[0]).toBe(messages.mailboxes.removeStops);
  });

  it("CONFIRM goes to the LOCAL route, and re-reads the shared facts", async () => {
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    /* `/local/mailboxes/:id`, NEVER the shared `DELETE /mailboxes/:id`. That one is `stepUp:
       true`, and on this door the launch session's second-factor stamp is written once at boot —
       so it answers 403 from five minutes after launch for the life of the process, which is
       every machine that has been open longer than a coffee. */
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(el.querySelector('[role="alertdialog"]'), "the panel stayed open on success").toBeNull();
    /* THE RE-READ IS NOT THIS CASE'S ANY MORE, and that is a correction rather than a weakening.
       This fixture is ONE mailbox and it is the one the engine serves, which is now the state in
       which removal ends the install's door: the shell is signed out and the gate replaces the
       whole surface, so asking the poller to re-read a pane that is going away says nothing. The
       re-read is asserted where it is still reachable — "A SECOND LIVE MAILBOX keeps the door",
       which removes one of two and stays in the app. */
    expect(loggedOutCount(), "the last mailbox went and the door configuration stayed").toBe(1);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
   *  REMOVING THE LAST MAILBOX ENDS THE INSTALL'S DOOR
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * MEASURED on the released 0.13.7, two real launches over one data directory: Remove cleared
   * the row, the credential, the organizer claim and this machine's mirror — and NOT
   * `config.json`, which is what the engine composes its dial from at every launch. So launch 2
   * minted a FRESH row for the same address and the shell opened saying
   *
   *     "Connected. The first sync has not finished yet."
   *
   * with the removed address in the status bar, an empty Ohbox offering "Load older mail", and a
   * Mailboxes row reading "Reading only · Organized by another install · Since —" beside "An
   * earlier entry for this address is no longer in use". The engine's log said
   * `stored_login_absent`; the Desktop pane said, honestly, that no password was stored. Two
   * panes, two answers, and the loud one was false.
   *
   * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────
   *
   *  · delete the `lastOne &&` block             → "the shell is told to forget the door" goes
   *    red with no command sent, which is the released behaviour exactly;
   *  · drop the `servedMailboxId === m.id` test  → a row the engine does not serve takes the
   *    door away from the one it does;
   *  · drop the every-other-row-is-a-tombstone test → "a SECOND live mailbox" goes red, taking
   *    the door away from a mailbox the person still has;
   *  · drop the `door !== "cloud"` test          → the hosted door signs a browser account out;
   *  · move the logout AHEAD of the DELETE       → "the removal is not conditional" goes red.
   *
   * All five were run.
   */
  it("THE SHELL IS TOLD TO FORGET THE DOOR when the last mailbox goes", async () => {
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    /* THE REMOVAL FIRST, AND ON THE LOCAL ROUTE — unchanged. Then the shell command that clears
       `config.json`, which is the half the removal cannot reach. */
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(loggedOutCount(), "the door configuration was left naming a mailbox nobody has").toBe(1);
    /* AND THE GATE IS HANDED THE NEW STATE. Without this the window keeps a mail client mounted
       over an engine that is `NotConfigured`; with it, the gate re-keys and routes to the door
       chooser — the same sink Settings → This install's sign-out feeds. */
    expect(published).toEqual([{ state: "not_configured", mode: null }]);
    expect(el.querySelector('[role="alertdialog"]'), "the panel stayed open on success").toBeNull();
  });

  it("THE REMOVAL IS NOT CONDITIONAL ON THE SHELL — a refused DELETE sends no command", async () => {
    /* The order is the contract: the person asked for the removal, so it goes first and its 200
       is required. A logout ahead of it would clear the door for a mailbox still connected. */
    bridgeReply = () => new Response(
      JSON.stringify({ error: { message: "this install is offline, so writes are paused" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(loggedOutCount(), "the door was cleared for a mailbox that is still connected").toBe(0);
    expect(published).toEqual([]);
  });

  it("A SECOND LIVE MAILBOX keeps the door — there is still something to open", async () => {
    FACTS = [MAILBOX, { ...MAILBOX, id: "mbx-2", address: "other@example.test" }];
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(loggedOutCount(), "the install was signed out of a mailbox the person still has").toBe(0);
    expect(refreshed, "the pane did not re-read after removing one of two").toBeGreaterThan(0);
  });

  it("a TOMBSTONE beside it is not something to open, so the door still goes", async () => {
    // `status !== "disabled"` is the live test the rest of this pane uses. A mailbox somebody
    // removed last week must not keep a door configuration alive for a mailbox nobody has.
    FACTS = [
      MAILBOX,
      { ...MAILBOX, id: "mbx-old", status: "disabled", disabledReason: "organized_elsewhere:cloud" },
    ];
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(loggedOutCount()).toBe(1);
  });

  it("A LOGOUT THAT FAILED says so — and does not claim the removal failed with it", async () => {
    /* The mailbox is gone either way; what is left is the stale door configuration, which is the
       released behaviour rather than a new fault. So the sentence names what did not happen and
       the panel closes on the act that did. */
    bridgeReply = () => new Response(null, { status: 200 });
    logoutFails = "The engine refused to clear the stored login (it answered 500)";
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(loggedOutCount()).toBe(1);
    expect(el.textContent ?? "").toContain("The engine refused to clear the stored login");
    expect(published, "a failed logout was reported to the gate as a new engine state")
      .toEqual([]);
  });

  it("A SHELL THAT CANNOT BE TOLD still removes the mailbox", async () => {
    // The prop is optional, so an older gate degrades to the released behaviour — the removal
    // happens and the door configuration survives it — rather than to a removal that refuses.
    SHELL_SINK = false;
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(loggedOutCount(), "the pane signed the install out with nowhere to report it").toBe(0);
    expect(refreshed).toBeGreaterThan(0);
  });

  it("a REFUSED removal says the engine's sentence and leaves the panel open", async () => {
    // Dropping somebody back to a list that still shows the mailbox says nothing about whether
    // the removal happened — the browser pane's rule, one surface over.
    bridgeReply = () => new Response(
      JSON.stringify({ error: { message: "this install is offline, so writes are paused" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(el.textContent ?? "").toContain("this install is offline, so writes are paused");
    expect(el.querySelector('[role="alertdialog"]'), "the confirmation vanished on a refusal")
      .not.toBeNull();
  });

  it("KEEP IT closes the confirmation and removes nothing", async () => {
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => { buttonExactly(el, "Keep it")!.click(); });
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(pressed()).toEqual([]);
  });

  it("EVERY LIVE ROW OFFERS REMOVE, and the route wipes the row it names", async () => {
    /* ── THIS CASE USED TO ASSERT THE OPPOSITE, AND BOTH VERSIONS WERE RIGHT AT THE TIME ────
     *
     * It read: *"a row the ENGINE DOES NOT SERVE offers no Remove — the wipe would not happen"*,
     * and gated on `servedMailboxId`. The local route released the claim and wiped this machine's
     * copy of the mail only `if (mailboxId === world.mailboxId)`; on any other row it tombstoned
     * and deleted the credential and nothing else, so offering the control there would have been
     * a panel promising an act the request does not perform.
     *
     * The route keys on the ROSTER now. Every live row has a runtime, and the DELETE releases,
     * wipes and stops whichever row it names — so the confirmation's consequences are true of
     * every row and the control belongs on every one of them. `status.mailboxId` still exists and
     * has NARROWED to meaning "the seed": gating on it would now hide the removal on every
     * mailbox but one, chosen by which address this install happened to be configured with.
     */
    FACTS = [
      { ...MAILBOX, id: "mbx-1", address: "first@example.test" },
      { ...MAILBOX, id: "mbx-2", address: "second@example.test" },
    ];
    const el = await render("local");
    const rows = addressRows(el);
    expect(rows.length).toBe(2);
    expect([...el.querySelectorAll("button")]
      .filter((b) => (b.textContent ?? "").trim() === "Remove").length).toBe(2);

    /* AND THE ROUTE NAMES THE ROW THE PRESS WAS ON. The second row's verb, not the first's —
       one confirmation, whose subject is the mailbox under it, addressed to that mailbox's id. */
    const secondVerb = [...rows[1]!.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim() === "Remove");
    await act(async () => { secondVerb!.click(); });
    expect(el.querySelectorAll('[role="alertdialog"]').length,
      "one press opened a confirmation on more than one row").toBe(1);
    expect(el.querySelector('[role="alertdialog"]')!.textContent ?? "")
      .toContain("Remove second@example.test?");

    bridgeReply = () => new Response(null, { status: 200 });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-2", method: "DELETE" }]);
    /* AND NO SIGN-OUT. A mailbox remains, so the install is still correctly configured for it;
       signing the door out here would take away a mailbox nobody asked to remove. */
    expect(shellCommands, "removing one of two signed the whole install out").toEqual([]);
  });

  it("REMOVING THE LAST ONE SIGNS THE DOOR OUT, so it survives a relaunch", async () => {
    /* ── `REMOVE-DOES-NOT-SURVIVE-A-RELAUNCH`, closed here ───────────────────────────────────
     *
     * The route's three acts are all about the ENGINE's store; none of them touches the SHELL's
     * settings file, and the settings file is what the engine composes its dial from at every
     * launch. Measured on the real sidecar over two launches: the removed address came back as a
     * consent-less reader row with no credential — nothing dialled, nothing organized, and a
     * person who had removed their mailbox found it listed again.
     *
     * The shell's own sign-out is what clears the door, and it runs AFTER the route: a stopped
     * engine cannot release a claim or wipe a mirror. */
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(pressed()).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(shellCommands, "the install stayed configured for a mailbox it no longer has")
      .toEqual(["engine_logout"]);
    /* AND THE GATE IS TOLD. Without this the window would go on rendering the app over an install
       with no door, and only a relaunch would show the door chooser. */
    expect(published.map((p) => p.state)).toEqual(["not_configured"]);
  });

  it("SAYS SENDING IS NOT SET UP, and says receiving works in the same breath", async () => {
    /* An outgoing server is not a reason to stop receiving: the local door stores the incoming
       credential when only the submission dial is refused. Nothing else on the row would show
       that — every other line is about receiving, and receiving is fine — so the state would be
       invisible until somebody tried to send. */
    FACTS = [{ ...MAILBOX, sendingUnsettledReason: "auth" }];
    const el = await render("local");
    const text = el.textContent ?? "";
    expect(text).toContain("Receiving works.");
    expect(text).toContain("Sending is not set up");
    expect(text, "the reason was not rendered from the taxonomy")
      .toContain("the outgoing server refused that password");
  });

  it("renders an UNKNOWN code from the taxonomy rather than printing it raw", async () => {
    // A server's own words are not this pane's to print, and a code this build has no wording for
    // is a deploy skew rather than a sentence.
    FACTS = [{ ...MAILBOX, sendingUnsettledReason: "something-new" }];
    const el = await render("local");
    const text = el.textContent ?? "";
    expect(text).toContain("Sending is not set up");
    expect(text).not.toContain("something-new");
  });

  it("says NOTHING about sending when it is set up", async () => {
    // The positive control: `null` is "settled", and it is what every mailbox connected before
    // this existed reports.
    FACTS = [{ ...MAILBOX, sendingUnsettledReason: null }];
    const el = await render("local");
    expect(el.textContent ?? "").not.toContain("Sending is not set up");
  });

  it("says NOTHING about organizing a mailbox nobody has agreed to yet", async () => {
    /* ── REVIEW FINDING ─────────────────────────────────────────────────────────────────────
     *
     * The role line was gated on `organizerRole !== "reader"`, and that column RESTS
     * `'organizer'` — it is the schema default, and the pane's own mapper coerces anything that
     * is not literally `"reader"` to it. So a mailbox that has been connected and never agreed to
     * read "Organized on this computer" while nothing was filed and `ohmail/*` did not exist.
     *
     * Reachable straight from this pane's own new control: Add mailbox, complete the connect,
     * cancel at the consent screen. `organizeConsentedAt` is the truth-condition and it was
     * already on the facts. MUTATION: drop the `organizeConsentedAt` clause and this reds. */
    FACTS = [{ ...MAILBOX, organizerRole: "organizer", organizeConsentedAt: null }];
    const el = await render("local");
    expect(el.textContent ?? "", "the pane claimed to organize a mailbox nobody agreed to")
      .not.toContain("Organized on this computer");
  });

  it("and says it once consent exists", async () => {
    // The positive control, so the case above cannot pass because the line is simply gone.
    FACTS = [{
      ...MAILBOX, organizerRole: "organizer", organizeConsentedAt: "2026-09-02T10:00:00.000Z",
    }];
    const el = await render("local");
    expect(el.textContent ?? "").toContain("Organized on this computer");
  });

  it("A LEGACY STOOD-DOWN ROW COUNTS as a mailbox — no sixth consequence, no sign-out", async () => {
    /* ── REVIEW FINDING ─────────────────────────────────────────────────────────────────────
     *
     * `isLastLive` filtered on `status !== "disabled"`, which excludes the pre-role engine's
     * stand-down shape — `disabled` WITH a reason — and `claimable` deliberately INCLUDES it: such
     * a row is rendered with a state line and a working "Organize here instead". So on an upgraded
     * install holding one live mailbox beside one legacy stood-down one, removing the live mailbox
     * announced "this is the only mailbox on this computer" with the other visibly listed a row
     * away, and then signed the door out — deleting the only route back to the one still there.
     *
     * MUTATION: filter on `status !== "disabled"` again and both assertions red. */
    FACTS = [
      { ...MAILBOX, id: "mbx-live", address: "live@example.test" },
      {
        ...MAILBOX,
        id: "mbx-legacy",
        address: "legacy@example.test",
        status: "disabled",
        disabledReason: "organized_elsewhere:unknown",
        legacyStandDown: true,
      },
    ];
    bridgeReply = () => new Response(null, { status: 200 });
    const el = await render("local");
    // The legacy row is on screen and claimable — which is why it is a mailbox and not a tombstone.
    expect(el.textContent ?? "").toContain("legacy@example.test");

    await act(async () => { rowRemove(el, "live@example.test").click(); });
    const panel = el.querySelector('[role="alertdialog"]')!.textContent ?? "";
    expect(panel, "the confirmation called it the only mailbox with another one listed")
      .not.toContain("only mailbox on this computer");

    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(shellCommands, "the door was signed out with a mailbox still held").toEqual([]);
  });

  it("a sign-out that fails still reports it, because the removal already happened", async () => {
    // The mailbox is gone either way; what failed is the tidying that keeps it gone. Silence here
    // would leave the stale door to be discovered on the next launch.
    bridgeReply = () => new Response(null, { status: 200 });
    logoutReply = async () => { throw new Error("the shell would not sign out"); };
    const el = await render("local");
    await act(async () => { buttonExactly(el, "Remove")!.click(); });
    await act(async () => {
      buttonExactly(el, "Remove mailbox")!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(el.textContent ?? "").toContain("the shell would not sign out");
    expect(refreshed, "the pane went on showing a mailbox it had just removed").toBeGreaterThan(0);
  });

  it("a DISCONNECTED row offers no Remove — there is nothing left to remove", async () => {
    // Same rule as the resync withheld one line over: the row is already a tombstone, and the
    // service refuses a `disabled` row anyway.
    FACTS = [{ ...MAILBOX, status: "disabled", disabledReason: null }];
    const el = await render("local");
    expect(buttonExactly(el, "Remove")).toBeNull();
  });

  it("an install that has not chosen a door yet is treated as standalone, not hosted", async () => {
    // `door` is `status?.mode ?? null`. Only the string "cloud" earns the hand-off; anything else
    // — null, an unset mode, a mode a newer engine invented — must not put a link to a hosted
    // account in front of somebody who may not have one.
    const el = await render(null);
    expect(el.textContent ?? "").not.toContain("Mailboxes are managed in ohmail on the web");
    expect(openButton(el)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE HOLDINGS LINE — WHAT THIS COMPUTER HOLDS, AS A FACT AND NOT AS AN ALARM
   ══════════════════════════════════════════════════════════════════════════════════════════

   Reported 2026-08-30 with a screenshot: the rail carried a permanent amber warning triangle
   reading "This device holds N of the account's M messages. / Settings → Mailboxes", in every
   view, for as long as the two numbers differed. The report was that it reads as a constant
   warning rather than as information, and the ruling is that partial-by-design is not a warning
   state: the Cloud mirror is a WINDOW over the hosted account and the mail outside it is
   reachable on demand through the reach-past doors, so nothing is missing.

   The strip state is gone (`mail-state.test.ts` holds that half). What is asserted here is the
   other half — that the FACT did not go with it, that it landed on the pane the banner used to
   point at, and that it carries no warning mark.

   ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────

    · delete the holdings paragraph              → the partial case goes red;
    · drop the `held === null` guard             → the caught-up and no-counts cases go red
                                                   (they render "5,000 of 5,000", or the word
                                                   "undefined" where a number belongs);
    · read `state.count` instead of `mirrored`   → the numerator case goes red;
    · swap `set-note-inline` for `SettingsNote`  → the no-iconography case goes red;
    · re-add the strip's amber copy anywhere     → the no-warning-words case goes red. */

/** A mailbox that reports the account's own count for itself, as the Cloud door's engine does. */
const counted = (hosted: number): MailboxFacts => ({ ...MAILBOX, hostedMessageCount: hosted });

describe("the holdings line — a windowed copy stated plainly, on the pane, with no alarm", () => {
  it("states BOTH numbers and the promise that the rest loads on demand", async () => {
    FACTS = [counted(73_525)];
    MIRRORED = 5_107;
    const text = (await render("cloud")).textContent ?? "";
    // The reported pair, formatted as the locale writes them.
    expect(text).toContain("5,107");
    expect(text).toContain("73,525");
    // The load-bearing half. Without it the sentence is a bare shortfall, which is the banner
    // again in a quieter font: the reason a partial copy is fine is that the rest is reachable.
    expect(text).toContain("nothing is missing");
    expect(text.toLowerCase()).toContain("load");
  });

  it("carries NO warning mark and none of the banner's words", async () => {
    FACTS = [counted(73_525)];
    MIRRORED = 5_107;
    const el = await render("cloud");
    const line = [...el.querySelectorAll("p")]
      .find((p) => (p.textContent ?? "").includes("73,525"));
    expect(line, "the holdings sentence is not on the pane at all").toBeTruthy();
    // `set-note-inline` is the pane's plain informational paragraph. `SettingsNote` leads with an
    // icon, and the one thing this line must not do is carry a mark of any kind.
    expect(line!.className).toBe("set-note-inline");
    expect(line!.querySelector("svg")).toBeNull();
    expect(el.textContent ?? "").not.toContain("⚠");
    // The strip's own sentence, verbatim, must not have followed the fact over here.
    expect(el.textContent ?? "").not.toContain("This device holds");
  });

  it("a caught-up device says NOTHING — a line reading N of N is noise", async () => {
    FACTS = [counted(5_000)];
    MIRRORED = 5_000;
    const text = (await render("cloud")).textContent ?? "";
    expect(text).not.toContain("5,000");
  });

  it("a numerator that has passed the total is a stale reading, so it is not quoted", async () => {
    // A mailbox removed on the account keeps its mail locally, so the numerator can legitimately
    // exceed a correct denominator. The honest answer is silence, never an even fraction.
    FACTS = [counted(5_000)];
    MIRRORED = 5_400;
    const text = (await render("cloud")).textContent ?? "";
    expect(text).not.toContain("5,400");
    expect(text).not.toContain("5,000");
  });

  it("no hosted counts — a local-only install — says nothing, and never reads absent as zero", async () => {
    FACTS = [MAILBOX];
    MIRRORED = 5_107;
    const text = (await render("local")).textContent ?? "";
    expect(text).not.toContain("5,107");
    expect(text).not.toContain("nothing is missing");
  });

  it("ONE silent mailbox withdraws the whole claim — a partial sum is a WRONG total", async () => {
    FACTS = [counted(60_000), MAILBOX];
    MIRRORED = 5_107;
    const text = (await render("cloud")).textContent ?? "";
    expect(text).not.toContain("60,000");
    expect(text).not.toContain("5,107");
  });

  it("A MIRROR NOBODY HAS READ YET SAYS NOTHING — not \"holds 0 of your M messages\"", async () => {
    // The window's engine starts with an EMPTY in-memory mirror and fills it page by page, while
    // the mailbox probe answers on its own clock. A pane open across a cold launch would otherwise
    // count up from zero, in a sentence about a machine whose store is already full.
    FACTS = [counted(73_525)];
    MIRRORED = 0;
    MAIL_STATE = { key: "awaiting", clock: true, settled: false };
    const text = (await render("cloud")).textContent ?? "";
    expect(text).not.toContain("73,525");
    expect(text).not.toContain("nothing is missing");
  });

  it("a FROZEN loop says nothing — it cannot keep the sentence's promise", async () => {
    // "The rest load when you reach them" is a network read over the same session. On a stopped
    // session or a sustained run of failed drains that is a promise this device cannot keep, and
    // the strip is already saying so in stronger words.
    for (const key of ["stopped", "failing"]) {
      FACTS = [counted(73_525)];
      MIRRORED = 5_107;
      MAIL_STATE = { key, clock: false, settled: true };
      const text = (await render("cloud")).textContent ?? "";
      expect(text, `${key} still promised on-demand loading`).not.toContain("5,107");
      if (root) await act(async () => { root!.unmount(); });
      mountPoint?.remove();
      root = null;
    }
  });

  it("A DOOR WHOSE CURRENCY IS UNKNOWN SAYS NOTHING — it cannot know the promise is good", async () => {
    // The freshness probe hanging or refusing while the local feed serves perfectly: no key on the
    // ladder is wrong, and nothing on screen knows whether the account is reachable.
    FACTS = [counted(73_525)];
    MIRRORED = 5_107;
    FRESHNESS = { state: "unknown" };
    const text = (await render("cloud")).textContent ?? "";
    expect(text).not.toContain("73,525");
    expect(text).not.toContain("nothing is missing");
  });

  it("THE LOCAL DOOR NEVER SHOWS IT, even holding a previous account's counts", async () => {
    // The stale-facts window: `MailStateProvider` does not clear the mailbox facts when the engine
    // is swapped and `readMailboxFacts` keeps one identity across the switch, so a Cloud install
    // re-pointed at the local door carries the OLD account's `hostedMessageCount` for up to one
    // 30-second poll. Under "Local mailboxes on this computer" that total would be paired with the
    // new door's count and would promise a reach-past this door has no account to reach into.
    FACTS = [counted(73_525)];
    MIRRORED = 5_107;
    const text = (await render("local")).textContent ?? "";
    expect(text).not.toContain("73,525");
    expect(text).not.toContain("5,107");
    expect(text).not.toContain("nothing is missing");
    // And the local pane is otherwise untouched.
    expect(text).toContain("Local mailboxes on this computer");
  });

  it("the copy sentence about whose mail this is stays exactly where it was", async () => {
    // The holdings line sits BESIDE that sentence and does not replace it: one says how much is
    // here, the other says that what is here is a copy nobody depends on.
    FACTS = [counted(73_525)];
    MIRRORED = 5_107;
    const text = (await render("cloud")).textContent ?? "";
    expect(text).toContain("Your mail lives on your mail server.");
  });

  /* ── ONE ROW PER ADDRESS ON THIS PANE TOO ───────────────────────────────────────────────
   *
   * A stood-down mailbox is reconnected by connecting the same address again — this pane offers no
   * re-enable, and the unique index is partial precisely so that reconnect works — which leaves
   * the dead row on the account for ever. Rendering the facts raw put "Handed over to another
   * install" beside "Up to date" for ONE address.
   *
   * It became urgent when the sync rail started folding: the rail then said the mailbox was fine
   * while this pane still showed its stand-down, which is the two-contradictory-sentences defect
   * the fold was introduced to end, moved onto the desktop. Both fold with `addressKey` now.
   *
   * Mutation-checked: replace `foldByAddress(facts)` with `facts.map(...)` and the first case
   * reds on the row count; drop the `superseded` note and the second reds. */
  it("a reconnected address is ONE row, not the dead one beside the live one", async () => {
    FACTS = [
      { ...MAILBOX, id: "mbx-dead", address: "Someone@Example.TEST", status: "disabled",
        disabledReason: "organized_elsewhere:local" },
      { ...MAILBOX, id: "mbx-live", address: "someone@example.test", status: "connected" },
    ];
    const el = await render("cloud");
    expect(addressRows(el).length,
      "the tombstone rendered as a peer of the row that replaced it").toBe(1);
    const text = el.textContent ?? "";
    expect(text, "the dead row's address won over the live one").toContain("someone@example.test");
    expect(text, "the earlier entry is not accounted for at all")
      .toContain("An earlier entry for this address is no longer in use.");
  });

  it("but a stand-down with NO live row keeps its own row and its reason", async () => {
    /* The half the fold must not swallow: an account whose only mailbox was stood down has to see
     * it. Collapsing this to a footnote would be the same defect from the other side. */
    FACTS = [
      { ...MAILBOX, id: "mbx-dead", address: "someone@example.test", status: "disabled",
        disabledReason: "organized_elsewhere:local" },
    ];
    const el = await render("cloud");
    expect(addressRows(el).length).toBe(1);
    expect(el.textContent ?? "", "a lone stood-down mailbox lost its own row")
      .toContain("someone@example.test");
  });

  it("and whitespace does NOT fold — the index keeps that row active, so the pane keeps it too", async () => {
    FACTS = [
      { ...MAILBOX, id: "mbx-a", address: "  someone@example.test  ", status: "disabled",
        disabledReason: "organized_elsewhere:local" },
      { ...MAILBOX, id: "mbx-b", address: "someone@example.test", status: "connected" },
    ];
    const el = await render("cloud");
    expect(addressRows(el).length,
      "a trimmed fold hid a mailbox the database is willing to keep active").toBe(2);
  });
});

/**
 * ═══ A STANDING STOP REQUEST IS ON THE ROW, AND THE PANE'S OWN NOTES END WHEN THE ROW ANSWERS ═══
 *
 * ── THE DEFECT, MEASURED LIVE ON A REAL PROVIDER AT RC3 ─────────────────────────────────────
 *
 * "Stop organizing here, keep the mail" is recorded as a request and honoured by the engine's own
 * next pass — and on a provider that refused the release's folder read, that pass retried on
 * every poll for a whole session. For all of it the row kept `organizerRole: "organizer"`, so
 * this pane rendered the ordinary "organized here" description with the ordinary "Stop
 * organizing" button: the person's press showed no trace, on a mailbox deliberately filing
 * nothing while the request stood. The engine now projects the request (`releaseRequestedAt`),
 * the description names the state, and the stop control is withheld while the ask it would make
 * is already standing.
 *
 * ── AND THE "ASKED FOR" NOTES WERE FOR EVER ─────────────────────────────────────────────────
 *
 * `released` and `reclaimed` are this pane's own per-press notes, and the comment beside them
 * claimed "the row is what ends them". Nothing did: the note rendered on the row's every later
 * state, including long after the request completed — "Asked for … within a minute" beside a row
 * whose release had finished an hour ago, or had lapsed, is a false state in the exact direction
 * item 8 is about. Each note now renders only while the row has NOT answered: the stop note ends
 * when the row carries the request (the description takes over) or the role moves; the takeover
 * note ends when the role says organizer.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 *  · WATCHED RED before the render arms existed: the pending case failed with the ordinary
 *    description and a live stop button; the notes cases failed with "Asked for" standing over
 *    rows that had long since answered — the released build's behaviour exactly.
 *  · Delete the `releaseRequestedAt` arm from `organizerBlock`'s description and the pending
 *    case reds; drop the field from the wire mapper and it reds one seam earlier (the facts
 *    census reds too — the wire row must carry every `MailboxFacts` key).
 */
describe("a standing stop request is on the row, and the pane's notes end when the row answers", () => {
  const mailboxCopy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;
  const ORGANIZING: MailboxFacts = {
    ...MAILBOX,
    organizerRole: "organizer",
    organizeConsentedAt: "2026-08-01T09:00:00.000Z",
  };

  /** Re-render the SAME root so the pane's own state (its per-press notes) survives while the
   *  facts under it move — the shape of the engine's next poll answering. `render()` would mount
   *  a fresh pane and silently discard the very state these cases are about. */
  async function repaint(door: string): Promise<void> {
    const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
    await act(async () => {
      root!.render(
        h(
          IntlProvider,
          /* `as never` because `h(Provider, props, child)` passes children positionally, which
             the overloads type as a missing `children` prop — the same shape the file's own
             `render()` helper carries; cast here so this copy adds no new noise. */
          { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
          h(
            ThemeProvider,
            { storageKey: "ohmail.theme" } as never,
            h(ToastHost, null, h(DesktopMailboxes, {
              door,
              onShellStatus: (next: { state: string; mode?: string | null }) => {
                published.push(next);
              },
            })),
          ),
        ),
      );
    });
  }

  it("a pending stop says so and withholds the stop control", async () => {
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    const el = await render("local");
    const said = el.textContent ?? "";
    expect(said, "a pressed stop shows no trace on the row — the live RC3 shape")
      .toContain(mailboxCopy.stopOrganizingPending!);
    expect(said, "the ordinary organized description stands beside a pending stop")
      .not.toContain(mailboxCopy.stateOrganizingHere!);
    expect(buttonSaying(el, mailboxCopy.stopOrganizingHandBack!),
      "the pane offers to write the very ask that is already standing").toBeNull();
  });

  /**
   * THE COUNTERMAND HAS A DOOR NOW — "stop, then change your mind before the release lands".
   *
   * The engine has always had the arm (`organizer_claim_release_yielded_to_press`): a takeover
   * stamped while a release is still being carried out wins, nothing is recorded as released, and
   * the next poll organizes here again. Nothing in the product could reach it — the stop verb is
   * withheld once the row carries the request, and there was no second button. The takeover door
   * admits exactly this row (`already_organizing` needs a NULL request), so the button is what
   * was missing.
   */
  it("a pending stop offers the takeover, which is the countermand's only door", async () => {
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    const el = await render("local");
    const btn = buttonSaying(el, "Organize here");
    expect(btn, "a row with a pending stop offers no way to change your mind").not.toBeNull();
    expect(el.textContent ?? "", "the countermand offers no account of what it does")
      .toContain(mailboxCopy.organizeHereCountermandWhat!);
    // It reaches the takeover door, which is what the engine's release arm compares against.
    bridgeReply = () => new Response(JSON.stringify({ outcome: "authorized" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    await act(async () => { btn!.click(); });
    await act(async () => { buttonExactly(el, "Organize here")!.click(); });
    expect(pressed(), "the countermand pressed something other than the takeover door")
      .toEqual([{ url: "/local/organizer/takeover", method: "POST" }]);
  });

  it("an ordinary organizer still reads as organized here — the positive control", async () => {
    FACTS = [ORGANIZING];
    const el = await render("local");
    const said = el.textContent ?? "";
    expect(said, "the ordinary organized row lost its own description")
      .toContain(mailboxCopy.stateOrganizingHere!);
    expect(said, "the pending sentence leaked onto a row with nothing pending")
      .not.toContain(mailboxCopy.stopOrganizingPending!);
    expect(buttonSaying(el, mailboxCopy.stopOrganizingHandBack!),
      "the ordinary organizer lost its stop control").not.toBeNull();
  });

  it("the stop note ends when the row answers — pending first, then the release", async () => {
    FACTS = [ORGANIZING];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    const el = await render("local");

    // The press, through the pane's own two-step ceremony.
    await act(async () => { buttonSaying(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });
    expect(el.textContent ?? "", "the press left no note while the row has not yet answered")
      .toContain(mailboxCopy.stopOrganizingQueued!);

    // The engine's poll catches up: the row now carries the request. The note's sentence
    // ("within a minute") yields to the row's own ("waiting for the server to confirm").
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    await repaint("local");
    expect(el.textContent ?? "", "the note and the row promise two different clocks at once")
      .not.toContain(mailboxCopy.stopOrganizingQueued!);
    expect(el.textContent ?? "").toContain(mailboxCopy.stopOrganizingPending!);

    // The release completes: reader, release stamped, request spent. Only the row's own released
    // sentence remains — a note promising "within a minute" here is the false state exactly.
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T09:12:00.000Z",
      releaseRequestedAt: null,
    }];
    await repaint("local");
    const done = el.textContent ?? "";
    expect(done, "the 'Asked for' note outlived the request it was about")
      .not.toContain(mailboxCopy.stopOrganizingQueued!);
    expect(done, "the completed release lost its own sentence")
      .toContain(mailboxCopy.stateReleased!.slice(0, mailboxCopy.stateReleased!.indexOf("{when}")));
  });

  it("the takeover note ends when the role says organizer", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T08:00:00.000Z",
    }];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "authorized" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const el = await render("local");

    await act(async () => { buttonSaying(el, "Organize here")!.click(); });
    /* The opener is withheld while its well is open, so the exact label finds the confirm. */
    await act(async () => { buttonExactly(el, "Organize here")!.click(); });
    expect(el.textContent ?? "", "the press left no note while the row has not yet answered")
      .toContain(mailboxCopy.organizeHereQueued!);

    // The gate's next pass promotes: the row says organizer, and the note's promise is kept.
    FACTS = [ORGANIZING];
    await repaint("local");
    expect(el.textContent ?? "", "the 'Asked for' note outlived the takeover it was about")
      .not.toContain(mailboxCopy.organizeHereQueued!);
    expect(el.textContent ?? "").toContain(mailboxCopy.stateOrganizingHere!);
  });

  /**
   * A PRESS IS THE NEWEST WORD UNTIL ANOTHER PRESS IS MADE — IN BOTH DIRECTIONS.
   *
   * `release()` has always deleted the takeover's note on a stop. The mirror was missing, so a
   * stop followed by a takeover brought the STOP's note back the moment the takeover restored the
   * role and cleared the request stamp — the pane going on promising a stop that was withdrawn.
   *
   * The map delete is the whole fix. A durable `!takeoverStanding(m)` term was written beside it
   * and REMOVED after measurement: `reclaim()` writes the `reclaimed` entry and deletes the
   * `released` one together, so the state that term guarded is unreachable and its removal
   * changed no answer here. The case below moves `organizerReleasedAt` so nothing but the delete
   * can answer it.
   */
  it("a stop then a takeover leaves no stop note — the map's half, stamp moved", async () => {
    FACTS = [ORGANIZING];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    const el = await render("local");
    await act(async () => { buttonSaying(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });
    expect(el.textContent ?? "", "the stop press left no note of its own")
      .toContain(mailboxCopy.stopOrganizingQueued!);

    // The release completed, so the row is a released reader and offers the takeover.
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T08:00:00.000Z",
      releaseRequestedAt: null,
    }];
    await repaint("local");
    bridgeReply = () => new Response(JSON.stringify({ outcome: "authorized" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    await act(async () => { buttonSaying(el, "Organize here")!.click(); });
    await act(async () => { buttonExactly(el, "Organize here")!.click(); });

    // The gate promoted. `organizerReleasedAt` has MOVED since the press, so the standing-takeover
    // stamp cannot answer here and the map delete is the only thing that can.
    FACTS = [{ ...ORGANIZING, organizerReleasedAt: "2026-09-07T10:30:00.000Z" }];
    await repaint("local");
    const said = el.textContent ?? "";
    expect(said, "the withdrawn stop's note came back over a row that is organizing again")
      .not.toContain(mailboxCopy.stopOrganizingQueued!);
    expect(said, "the promoted row lost its own description").toContain(mailboxCopy.stateOrganizingHere!);
  });

  it("a stop with no takeover after it still shows its note — the positive control", async () => {
    FACTS = [ORGANIZING];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    const el = await render("local");
    await act(async () => { buttonSaying(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });
    expect(el.textContent ?? "", "the rule suppressed a stop note nothing had withdrawn")
      .toContain(mailboxCopy.stopOrganizingQueued!);
  });
});

/**
 * ═══ THE READER ROW'S THREE STATES — "ORGANIZED BY ANOTHER INSTALL" WITH NO OTHER INSTALL ═══
 *
 * MEASURED on the released build: a mailbox connected on this computer with no organizing
 * consent, `ohmail/_meta` empty (read three times), so the four holder columns are unwritten and
 * the wire's `organizedBy` is `null`. This pane's row then said *"Since —. This computer reads
 * the mailbox; it moves nothing and screens nothing"* — a date line with no date, and a sentence
 * about reading that stops one clause short of the fact somebody in that state needs: nothing is
 * organizing the mailbox, and one press changes that.
 *
 * The cause is the same on all three reader surfaces: the state "nobody holds it" fell through to
 * a sentence written for "a holder we cannot name". `reader-holder.ts` is the shared answer, and
 * the two `FirstRun` surfaces carry the other two cases (`apps/webapp/test/reader-row-states`).
 *
 * WATCH IT FAIL: restore `readerSinceUnknown` as the released arm's fallback and the first case
 * goes red with the em-dash date line, which is the released behaviour exactly. The other two are
 * green either way — they are what says this changed the holder-less state and nothing else.
 */
describe("the reader row's three states, and the one that had no holder at all", () => {
  const mailboxCopy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;
  /** The sentence every "since" line ends with — the half that must not survive state (a). */
  const READS_MAILBOX = mailboxCopy.readerSinceUnknown!.replace("Since {since}. ", "");
  /** How every dated sentence on this pane opens. Absent from both holder-less states. */
  const SINCE = "Since ";

  /**
   * THE ROW'S OWN LABEL AND DESCRIPTION, exactly. `toContain` cannot separate the undated
   * sentence from the dated one — `readerReadsOnly` IS `readerSinceUnknown` minus its date
   * clause, so it is a substring of it and a containment check passes for both states.
   */
  const orgRow = (el: HTMLElement): { label: string; description: string } => {
    /* The role CHIP: its caption is the label, and the node its `aria-describedby` points at is
       the sentence. Read through the description link on purpose — the same path a screen reader
       takes — so a chip whose sentence is present but not linked reads as having none. */
    const node = el.querySelector(".mbx-org .mbx-chip .gloss-t");
    if (!node) {
      throw new Error("no role chip on the row; chips: "
        + [...el.querySelectorAll(".mbx-chip .gloss-cap")]
          .map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    const said = document.getElementById(node.getAttribute("aria-describedby") ?? "");
    return {
      label: (node.querySelector(".gloss-cap")?.textContent ?? "").trim(),
      description: (said?.textContent ?? "").trim(),
    };
  };

  /** A reader row, with the holder columns each case is about. */
  const readerWith = (organizedBy: MailboxFacts["organizedBy"]): MailboxFacts => ({
    ...MAILBOX,
    organizerRole: "reader",
    organizedBy,
    organizerState: "held",
    organizeConsentedAt: null,
  });

  it("(a) NOBODY holds it → no date line, and the press is named", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const said = el.textContent ?? "";
    expect(said, "a date line over a holder that was never recorded")
      .not.toContain(READS_MAILBOX);
    expect(said, "the state nobody organizes the mailbox in has no sentence of its own")
      .toContain(mailboxCopy.readerNobodyReads!);
    expect(said, "the row lost the label for the state it is in")
      .toContain(mailboxCopy.stateNotOrganized!);
  });

  it("(b) CONTROL: a recorded holder with no name still names the install and the date", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "local", name: null, since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const said = (await render("local")).textContent ?? "";
    expect(said).toContain(
      mailboxCopy.readerLabel!.replace("{name}", mailboxCopy.readerHolderUnknown!),
    );
    expect(said, "an unnamed holder was demoted to nobody")
      .not.toContain(mailboxCopy.readerNobodyReads!);
  });

  it("(c) CONTROL: a NAMED holder is unchanged", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "local", name: "omarchy", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const said = (await render("local")).textContent ?? "";
    expect(said).toContain(mailboxCopy.readerLabel!.replace("{name}", "omarchy"));
    expect(said).toContain(READS_MAILBOX);
    expect(said).not.toContain(mailboxCopy.readerNobodyReads!);
  });

  it("(a) CONTROL: the no-holder row carries the READS SENTENCE, not just the label", async () => {
    /* Asked at review whether this pane shows only the label. It does not: the banner's
       description is the same sentence the browser's rows render, from the same key. Asserted by
       EQUALITY on the rendered node so "it is in there somewhere" cannot stand in for it. */
    FACTS = [readerWith(null)];
    expect(orgRow(await render("local"))).toEqual({
      label: mailboxCopy.stateNotOrganized!,
      description: mailboxCopy.readerNobodyReads!,
    });
  });

  it("a holder recorded with NO kind and NO name is a holder, not 'nothing organizes this'", async () => {
    /* THE CLASSIFICATION DEFECT. `organizedBy` exists — something wrote a holder column — and
       both `kind` and `name` are empty, which the old `kind || name` test read as "no holder".
       The pane then said "Nothing organizes this mailbox" over a row that has one, and offered
       the takeover as the primary verb on a mailbox somebody else is organizing. */
    FACTS = [readerWith({ kind: null, name: null, since: "2026-08-30T09:00:00.000Z" })];
    const row = orgRow(await render("local"));
    expect(row.label, "a recorded holder was reported as nobody")
      .toBe(mailboxCopy.readerLabel!.replace("{name}", mailboxCopy.readerHolderUnknown!));
    expect(row.label).not.toBe(mailboxCopy.stateNotOrganized!);
    expect(row.description, "the holder-less sentence over a row with a holder")
      .not.toBe(mailboxCopy.readerNobodyReads!);
    expect(row.description, "a recorded date was dropped").toContain(SINCE);
    expect(row.description, "the date printed as an em dash").not.toContain("Since —");
  });

  it("a real holder with NO DATE gets the undated sentence, not an em dash", async () => {
    /* THE DATE DEFECT, and it is the em dash the walk photographed one row over: `day(null)` is
       "—" by design (it is interpolated into sentences, and a dash is readable), which is right
       for a tooltip and wrong for the one clause that promises a date. */
    FACTS = [readerWith({ kind: "cloud", name: "ohmail Cloud", since: null })];
    let row = orgRow(await render("local"));
    expect(row.description, "a date line with no date in it").not.toContain(SINCE);
    expect(row).toEqual({
      label: mailboxCopy.readerLabel!.replace("{name}", "ohmail Cloud"),
      description: mailboxCopy.readerReadsOnly!,
    });

    FACTS = [readerWith({ kind: "local", name: "omarchy", since: null })];
    row = orgRow(await render("local"));
    expect(row.description, "a date line with no date in it").not.toContain(SINCE);
    expect(row).toEqual({
      label: mailboxCopy.readerLabel!.replace("{name}", "omarchy"),
      description: mailboxCopy.readerReadsOnly!,
    });
  });

  it("CONTROL: a DATED holder keeps its date, on both kinds", async () => {
    // The other half of the rule: the undated arm is chosen by the date's absence and nothing
    // else, so a row that has one still opens with it.
    for (const kind of ["cloud", "local"] as const) {
      const name = kind === "cloud" ? "ohmail Cloud" : "omarchy";
      FACTS = [readerWith({ kind, name, since: "2026-08-30T09:00:00.000Z" })];
      const row = orgRow(await render("local"));
      expect(row.label).toBe(mailboxCopy.readerLabel!.replace("{name}", name));
      expect(row.description, `the ${kind} holder lost its date`).toContain(SINCE);
      expect(row.description).not.toContain("Since —");
      expect(row.description, `the ${kind} holder took the undated sentence`)
        .not.toBe(mailboxCopy.readerReadsOnly!);
    }
  });
});

/**
 * ═══ THE PANE MUST NOT SAY A FALSE THING ABOUT WHO ORGANIZES A MAILBOX ═════════════════════
 *
 * Six claims, each measured by walking the released 0.14.1 build. They are gathered in one
 * describe because they share a subject — the row telling the truth about the outage, the holder
 * and the standing asks — and because the first of them decides where the others are fixed: the
 * report said the outage sentence never reaches a row this install only reads, and the code says
 * the outage arm sits ABOVE the reader arm. One of those is wrong.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 * Each case names the mutation that reddens it in its own comment. Every case here was watched
 * red before its fix, EXCEPT the two marked as controls, which were green before anything moved —
 * that is a finding rather than a formality, and it is asserted rather than described so it
 * cannot rot into a claim.
 */
describe("the pane tells the truth about the outage, the holder and the standing asks", () => {
  const mailboxCopy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;

  /** A reach answer for one mailbox, as `/local/mailboxes/connections` serves it. */
  const reachAnswer = (over: Record<string, unknown>): Response => new Response(JSON.stringify({
    items: [{ mailboxId: "mbx-1", reachable: true, unreachableSince: null, ...over }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  /** Re-render the SAME root, so the pane's per-press notes survive the facts moving under them. */
  async function repaint(door: string): Promise<void> {
    const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
    await act(async () => {
      root!.render(
        h(
          IntlProvider,
          { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
          h(
            ThemeProvider,
            { storageKey: "ohmail.theme" } as never,
            h(ToastHost, null, h(DesktopMailboxes, {
              door,
              onShellStatus: (next: { state: string; mode?: string | null }) => {
                published.push(next);
              },
            })),
          ),
        ),
      );
    });
  }

  /**
   * (1) THE GATE. The report says the outage sentence never reaches a row
   * this install only READS — measured against a mailbox ohmail Cloud organizes, where the engine
   * had recorded the outage and the row read "Reading only" throughout a five-minute cut.
   *
   * `stateOf` puts the outage arm ABOVE the reader arm and says so in a comment. MEASURED before
   * anything below it changed: this case is GREEN. The ladder is not where the reported silence
   * comes from, so it is not touched; what remains for the pane is the case below — the probe
   * that maps every non-OK answer to silence.
   *
   * It stays as a standing case rather than being deleted, because the arm it pins has no other
   * one: every existing outage case in this file uses the DEFAULT row, which is an organizer, so
   * moving the outage arm below the reader arm would red nothing without this.
   */
  it("(1) GATE — a reader row whose server is unreachable says so, not 'Reading only'", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    bridgeReply = () => reachAnswer({
      reachable: false,
      unreachableSince: new Date(Date.now() - 20 * 60_000).toISOString(),
    });

    const text = (await render("local")).textContent ?? "";
    expect(bridged, "the pane never asked the reach question on a reader row")
      .toContainEqual({ url: "/local/mailboxes/connections", method: "GET" });
    expect(text, "the outage sentence never reached a row this install only reads")
      .toContain("Can't reach the mail server");
    expect(text, "the outage lost its duration").toContain("20 minutes ago");
    expect(text, "'Reading only' stood beside a dead socket, describing mail that is not moving")
      .not.toContain(mailboxCopy.stateReading!);
  });

  /**
   * (2) THE PROBE'S SILENCE. It maps EVERY non-OK status to `{}`,
   * and `{}` is the pane's word for "cannot tell" — so an engine answering 500 about its own
   * sockets renders as a mailbox that is up to date. 404 is genuinely "cannot tell" (a window
   * newer than its engine, an ordinary state on a desktop); 401 and 5xx are the route ANSWERING,
   * and answering badly, which is a different fact.
   *
   * ── AND THE SENTENCE IS ABOUT THE QUESTION, NOT ABOUT THE MAIL SERVER ────────────────────
   *
   * This first rendered `desktopStateUnreachable` — "Can't reach the mail server" — which is a
   * claim about the person's PROVIDER, and nothing here has learned anything about their
   * provider: what answered badly is the engine on this machine, asked about its own sockets. A
   * stale bearer after an engine restart answers 401 for every poll, so every row would announce
   * an outage at a mail server that is working perfectly, while mail carries on arriving. The
   * honest sentence names the question that could not be answered.
   *
   * WATCH IT FAIL: restore the single `if (!res.ok) return {}` and this case reddens with
   * "Up to date" over an engine that cannot say anything about its own connections; point the
   * faulted arm back at `desktopStateUnreachable` and it reddens on the outage claim.
   */
  it("(2) an engine that answers BADLY about its own sockets says so, and claims no outage", async () => {
    FACTS = [MAILBOX];
    bridgeReply = () => new Response(null, { status: 500 });

    const text = (await render("local")).textContent ?? "";
    expect(text, "a 500 from the engine's own connection route rendered as a working mailbox")
      .not.toContain(mailboxCopy.desktopStateUpToDate!);
    expect(text, "the row said nothing at all about a question that was answered badly")
      .toContain(mailboxCopy.desktopStateUnknown!);
    expect(text, "an unanswered question was reported as the person's mail server being down")
      .not.toContain(mailboxCopy.desktopStateUnreachable!);
    expect(text, "a slice with no per-row answer invented a duration for the outage")
      .not.toContain("Last answered");
  });

  /**
   * (2c) AND ONE BAD POLL DOES NOT STICK. The faulted state is the slice the last answer
   * produced and nothing more, so the next good poll replaces it. This is what stands in place of
   * a debounce: the arm claims nothing that would need to be withdrawn, and a transient 5xx is
   * one interval of "cannot check" rather than a false outage that outlives its cause.
   */
  it("(2c) the next good poll clears a faulted slice", async () => {
    FACTS = [MAILBOX];
    let answer = (): Response => new Response(null, { status: 500 });
    bridgeReply = () => answer();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      expect(el.textContent ?? "").toContain(mailboxCopy.desktopStateUnknown!);

      answer = () => reachAnswer({ reachable: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      const healed = el.textContent ?? "";
      expect(healed, "a transient refusal outlived the poll that answered it")
        .not.toContain(mailboxCopy.desktopStateUnknown!);
      expect(healed).toContain(mailboxCopy.desktopStateUpToDate!);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * (2d) A 200 THAT IS NOT A VERDICT IS NOT AN EMPTY ROSTER. `body.items ?? []` read `{}`,
   * `{"items": null}`, a bare array and a text body as "the engine answered about no mailboxes" —
   * the SILENT slice, one line below the status check that was added to stop exactly this: every
   * row keeps its last ordinary state, so a dead socket goes on reading "Up to date" for as long
   * as the malformed answer keeps arriving.
   *
   * The last row is the one that keeps this from being a check that fires on everything: an
   * engine holding no runtimes answers `{"items": []}`, which IS a verdict.
   *
   * WATCH IT FAIL: drop the `Array.isArray(items)` half of the decision and every faulted row
   * below reddens; drop the whole check and the empty-roster row reddens with it.
   */
  it("(2d) a 200 whose body is not a roster is a non-verdict, and an empty roster is not", async () => {
    FACTS = [MAILBOX];
    const json = (text: string): Response => new Response(text, {
      status: 200, headers: { "content-type": "application/json" },
    });

    for (const [what, res] of [
      ["an object with no items at all", () => json("{}")],
      ["items explicitly null", () => json('{"items":null}')],
      ["a bare array", () => json("[]")],
      ["a string body", () => json('"ok"')],
    ] as const) {
      bridgeReply = res;
      const text = (await render("local")).textContent ?? "";
      expect(text, `${what} was read as an engine that answered about no mailboxes`)
        .toContain(mailboxCopy.desktopStateUnknown!);
      expect(text, `${what} left the row claiming it was up to date`)
        .not.toContain(mailboxCopy.desktopStateUpToDate!);
      await act(async () => { root!.unmount(); });
      root = null;
    }

    // …and the genuine empty roster is a verdict: nothing is said about this row, so it keeps
    // the state it had, and nothing on screen says the engine could not be asked.
    bridgeReply = () => json('{"items":[]}');
    const empty = (await render("local")).textContent ?? "";
    expect(empty, "an engine holding no runtimes was treated as a broken answer")
      .not.toContain(mailboxCopy.desktopStateUnknown!);
    expect(empty).toContain(mailboxCopy.desktopStateUpToDate!);
  });

  /**
   * (2b) THE OTHER HALF, and the one that must not move: a 404 is a window newer than its engine,
   * which is an ordinary state on a desktop that updates on its own schedule. Reading it as an
   * outage would tell somebody their mail had stopped every time an update landed.
   */
  it("(2b) CONTROL — a 404 stays 'cannot tell', and the row keeps its ordinary state", async () => {
    FACTS = [MAILBOX];
    bridgeReply = () => new Response(null, { status: 404 });

    const text = (await render("local")).textContent ?? "";
    expect(text, "a route this engine does not serve was read as an outage")
      .toContain(mailboxCopy.desktopStateUpToDate!);
    expect(text).not.toContain("Can't reach the mail server");
    expect(text, "silence was reported as a question that could not be answered")
      .not.toContain(mailboxCopy.desktopStateUnknown!);
  });

  /**
   * (2e) ONE UNREADABLE ENTRY IS A FACT ABOUT ONE ROW.
   *
   * `const it = raw as {…}` followed by `it.mailboxId` THREW on a `null` element, and the throw
   * left `readMailboxReachVia` entirely — past the poll's `.then`, so `setReach` was never called
   * and whatever slice was on screen stayed. After a healthy read that means a mailbox whose
   * socket has since died goes on saying "Up to date", and so does every row AFTER the bad
   * element, for as long as the roster keeps carrying it. One unreadable entry silenced the
   * answer about every other mailbox.
   *
   * The roster is read element by element now: an element naming a row it cannot describe marks
   * THAT row unanswered, one naming no row at all is dropped, and the rest publish.
   *
   * WATCH IT FAIL: restore `const it = raw as {…}` with no object guard and the first case throws;
   * fold the unreadable element into `reachable: false` and the second reds on the outage claim.
   */
  it("(2e) a bad element does not silence its neighbours, and does not speak for them", async () => {
    const dead = new Date(Date.now() - 20 * 60_000).toISOString();
    const roster = (...entries: unknown[]): Response => new Response(
      JSON.stringify({ items: entries }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    /* A NULL BEFORE THE DEAD ROW — the reviewer's own sequence. The element names no row, so it
       is dropped, and the row after it publishes its outage. */
    FACTS = [MAILBOX];
    bridgeReply = () => roster(null, {
      mailboxId: "mbx-1", reachable: false, unreachableSince: dead,
    });
    let text = (await render("local")).textContent ?? "";
    expect(text, "an unreadable entry silenced the answer about a different mailbox")
      .toContain("Can't reach the mail server");
    expect(text).toContain("20 minutes ago");
    await act(async () => { root!.unmount(); });
    root = null;

    /* AN ELEMENT THAT NAMES THIS ROW AND CANNOT BE READ speaks for it — and says the one thing
       that is true, which is that the question went unanswered. NOT an outage: nothing here has
       learned anything about the person's mail server. */
    bridgeReply = () => roster({ mailboxId: "mbx-1", reachable: "yes" });
    text = (await render("local")).textContent ?? "";
    expect(text, "an entry that could not be read was reported as a mailbox that is fine")
      .not.toContain(mailboxCopy.desktopStateUpToDate!);
    expect(text, "the row said nothing about an entry it could not read")
      .toContain(mailboxCopy.desktopStateUnknown!);
    expect(text, "an unreadable entry claimed an outage at a server it learned nothing about")
      .not.toContain(mailboxCopy.desktopStateUnreachable!);
    await act(async () => { root!.unmount(); });
    root = null;

    /* AND A WELL-FORMED NEIGHBOUR IS UNAFFECTED BY EITHER — the half that says this is per-row
       rather than a slice that gave up more quietly. */
    FACTS = [MAILBOX, { ...MAILBOX, id: "mbx-2", address: "other@example.test" }];
    bridgeReply = () => roster(
      null,
      { mailboxId: "mbx-1", reachable: "yes" },
      { mailboxId: "mbx-2", reachable: true },
    );
    const el = await render("local");
    const rows = addressRows(el);
    expect(rows, "the pane folded the two addresses into one row").toHaveLength(2);
    expect(rows[0]!.textContent ?? "", "the unreadable row lost its own sentence")
      .toContain(mailboxCopy.desktopStateUnknown!);
    expect(rows[1]!.textContent ?? "", "a healthy neighbour was dragged down by a bad element")
      .toContain(mailboxCopy.desktopStateUpToDate!);
  });

  /**
   * (3) A STANDING STOP WITH NO CONSENT STAMP — two reports and one defect: `offerRelease`
   * requires `organizeConsentedAt`, and when it is false the WHOLE organizer block returns null —
   * taking the pending sentence with it. An install that became the organizer through the gate's
   * promotion, or one whose row predates the consent column, is exactly that shape: it organizes
   * the mailbox, a stop can be asked for through another door, and the row says "Organizing" with
   * nothing about the ask standing against it.
   *
   * WATCH IT FAIL: restore `if (role === "organizer" && !offerRelease) return null`.
   */
  it("(3) a standing stop request is on the row even when the consent stamp is absent", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "organizer",
      organizeConsentedAt: null,
      releaseRequestedAt: "2026-09-07T09:00:00.000Z",
    }];
    const el = await render("local");
    const text = el.textContent ?? "";
    expect(text, "a pressed stop showed no trace on a row with no consent stamp")
      .toContain(mailboxCopy.stopOrganizingPending!);
    expect(text, "the ordinary organized sentence stood beside a pending stop")
      .not.toContain(mailboxCopy.stateOrganizingHere!);
    /* THE HALF THAT WAS RIGHT. The stop CONTROL stays withheld while the flag is absent — the
       route would refuse it — so this is a row that states its situation and offers nothing. */
    expect(buttonSaying(el, mailboxCopy.stopOrganizingHandBack!),
      "a control was offered on a row the route refuses").toBeNull();
  });

  /**
   * (3b) CONTROL — a consent-less organizer with NOTHING pending still renders no block. The fix
   * widens the exception by exactly one fact, and a block that appeared unconditionally would put
   * a state banner and a withheld control on every legacy row.
   */
  it("(3b) CONTROL — a consent-less organizer with nothing pending shows no banner", async () => {
    FACTS = [{ ...MAILBOX, organizerRole: "organizer", organizeConsentedAt: null }];
    const el = await render("local");
    expect(el.querySelector(".mbx-org"),
      "a row with nothing to say about organizing grew a banner").toBeNull();
  });

  /**
   * (3c) THE SAME WIDENING, ON THE HOSTED DOOR — pinned because it is a consequence rather than an
   * accident, and because nothing else in this file would notice it.
   *
   * The release is a standalone-door CONTROL: on the hosted door these rows mirror an account whose
   * organizing is the service's, and the browser is where that is given up. But a standing stop is
   * a FACT about the row, not a control, and it is as true there as anywhere — so the sentence
   * renders and the verb still does not. Suppressing it would be hiding a true standing state on
   * the one door where this window cannot offer any way to check it.
   */
  it("(3c) a hosted row carrying a standing stop says so, and still offers no verb", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "organizer",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      releaseRequestedAt: "2026-09-07T09:00:00.000Z",
    }];
    const el = await render("cloud");
    expect(el.textContent ?? "", "the hosted row said nothing about a stop that is standing")
      .toContain(mailboxCopy.stopOrganizingPending!);
    expect(buttonSaying(el, mailboxCopy.stopOrganizingHandBack!),
      "the hosted door grew a release control it cannot report the outcome of").toBeNull();
  });

  /**
   * (3d) CONTROL — and an ordinary hosted row still grows no organizer banner at all, which is
   * what every other hosted case in this file has always seen.
   */
  it("(3d) CONTROL — an ordinary hosted row has no organizer banner", async () => {
    FACTS = [{ ...MAILBOX, organizerRole: "organizer", organizeConsentedAt: "2026-08-01T09:00:00.000Z" }];
    const el = await render("cloud");
    expect(el.querySelector(".mbx-org"),
      "the hosted door grew a banner about organizing that it cannot act on").toBeNull();
  });

  /**
   * (3e) A STAMP NEVER CHANGES A ROLE — the hosted door's reclassification, which the widening
   * above made visible.
   *
   * `claimable` refuses every row on the hosted door (the release is a standalone-door control),
   * so `role` answers `organizer` for a row the WIRE calls a reader. With a retained
   * `releaseRequestedAt` on such a row — reachable when a mailbox is organized here, a stop is
   * asked for, and the mailbox goes back to being organized in the cloud with the stamp still on
   * the row — this block said "Organizing · Stopping on the next pass" about the service's
   * organizer. That attributes one install's press to another, on the door where the person has
   * no other way to check.
   *
   * The stamp says a request was made; the ROLE says whose it was. The block consults the DTO's
   * role, so a reader row with a stamp is a reader here.
   *
   * WATCH IT FAIL: gate the block on `m.releaseRequestedAt` alone again.
   */
  it("(3e) a hosted READER row with a retained stop stamp is still a reader", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      releaseRequestedAt: "2026-09-07T09:00:00.000Z",
    }];
    const el = await render("cloud");
    const said = el.textContent ?? "";
    expect(said, "a stop asked for by another install was reported as the holder's")
      .not.toContain(mailboxCopy.stopOrganizingPending!);
    expect(said, "the row claimed this computer organizes a mailbox the wire calls a reader")
      .not.toContain(mailboxCopy.stateOrganizingHere!);
    expect(buttonSaying(el, mailboxCopy.stopOrganizingHandBack!),
      "a reader row grew a control over somebody else's organizing").toBeNull();
    expect(el.querySelector(".mbx-org"),
      "the hosted reader row grew an organizer banner off a stamp").toBeNull();
    /* THE ROW ITSELF still says what it is — the state line is not the block. */
    expect(said, "the reader row lost its own state").toContain(mailboxCopy.stateReading!);
  });

  /**
   * (4) THE NOTE THAT OUTLIVES ITS PRESS. The takeover note renders while
   * `reclaimed.has(id)` and the role is not `organizer` — which is true again AFTER a stop, so an
   * "Asked for … within a minute" note from a press that was honoured an hour ago comes back over
   * a released row, and the same map hides the "Organize here" button behind it. The person is
   * shown a promise about a press they have since undone, and no way to press again.
   *
   * WATCH IT FAIL: drop the `reclaimed` clear from the release confirm handler.
   */
  it("(4) a stop clears the takeover note it undoes, and leaves the way back", async () => {
    const READER = {
      ...MAILBOX,
      organizerRole: "reader" as const,
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T08:00:00.000Z",
    };
    FACTS = [READER];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "authorized" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const el = await render("local");

    // ── THE TAKEOVER, through the pane's own two-step ceremony.
    await act(async () => { buttonSaying(el, "Organize here")!.click(); });
    await act(async () => { buttonExactly(el, "Organize here")!.click(); });
    expect(el.textContent ?? "", "the takeover press left no note").toContain(
      mailboxCopy.organizeHereQueued!,
    );

    // The gate promotes: the note's promise is kept and it ends.
    FACTS = [{
      ...MAILBOX,
      organizerRole: "organizer",
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
    }];
    await repaint("local");
    expect(el.textContent ?? "").not.toContain(mailboxCopy.organizeHereQueued!);

    // ── AND NOW THE STOP, which is a NEWER press about the same mailbox.
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    await act(async () => { buttonSaying(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });

    // The release lands: reader again, release stamped, nothing holds the mailbox.
    FACTS = [READER];
    await repaint("local");
    const done = el.textContent ?? "";
    expect(done, "a note promising a takeover 'within a minute' came back over a stop that undid it")
      .not.toContain(mailboxCopy.organizeHereQueued!);
    expect(buttonSaying(el, "Organize here"),
      "the stale takeover note hid the only way back onto the mailbox").not.toBeNull();
  });

  /**
   * (5) THE BLANK HOLDER. `holderOf` falls back with `??`, so an EMPTY
   * name — a holder recorded by an install that sent no display name — renders as nothing at all:
   * "Organized by " with the sentence ending mid-air. `readerHolder` already treats `""` as
   * unnamed, so the row is correctly CLASSIFIED as having a holder and then names it blankly.
   *
   * WATCH IT FAIL: restore `m.organizedBy?.name ?? …`.
   */
  it("(5) a holder that sent an empty name is unnamed, not blank", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "local", name: "", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const label = (el.querySelector(".mbx-org .mbx-chip .gloss-cap")?.textContent ?? "").trim();
    const said = (el.querySelector(".mbx-org .mbx-chip .gloss-pop")?.textContent ?? "").trim();
    expect(label, "the row named its holder with an empty string").toBe(
      mailboxCopy.readerLabel!.replace("{name}", mailboxCopy.readerHolderUnknown!),
    );
    /* THE NAME'S HALF ONLY: `dayStamp` renders in the app's own format register, so pinning the
       whole sentence would test the formatter. The clause AFTER the date is the one this case is
       about, and it opened with " · ." when the name was empty. */
    const named = mailboxCopy.readerSinceLocal!;
    expect(said, "the date line ended mid-sentence where the name should be")
      .toContain(named.slice(named.indexOf("· {name}"))
        .replace("{name}", mailboxCopy.readerHolderUnknown!));
  });

  /**
   * (5b) CONTROL — a holder that DID send a name keeps it, on both the label and the date line.
   */
  it("(5b) CONTROL — a named holder is still named", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "local", name: "omarchy", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const label = (el.querySelector(".mbx-org .mbx-chip .gloss-cap")?.textContent ?? "").trim();
    expect(label).toBe(mailboxCopy.readerLabel!.replace("{name}", "omarchy"));
    expect(el.textContent ?? "").toContain("omarchy");
  });

  /**
   * (6) A WORD WITH NOTHING BEHIND IT. On a row nothing organizes, the button offers
   * to organize here INSTEAD OF — and there is nothing to be instead of. The row's own sentence
   * already names the press as "Organize here", so the catalogue and the button disagree on one
   * screen.
   *
   * WATCH IT FAIL: point both arms at one key again.
   */
  it("(6) the press on a row nobody organizes is 'Organize here', with no 'instead'", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const press = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Organize here"));
    expect(press, "the row nobody organizes offered no way to organize it").toBeTruthy();
    expect((press!.textContent ?? "").trim(),
      "the button offered an alternative to a holder that does not exist")
      .toBe(mailboxCopy.organizeHere!);
    expect((press!.textContent ?? "").toLowerCase(),
      "'instead' on a row with nothing to be instead of").not.toContain("instead");
  });

  /**
   * (6b) CONTROL — a row somebody else DOES organize keeps "instead", because there it is true.
   */
  it("(6b) CONTROL — a row with a named holder keeps 'Organize here instead'", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const press = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Organize here"));
    expect((press?.textContent ?? "").trim(),
      "the takeover of a held mailbox lost the word that makes it a takeover")
      .toBe(mailboxCopy.organizeHereInstead!);
  });

  /**
   * (6c) THE SAME RESIDUE ONE PRESS DEEPER. The confirm well states what the takeover costs the
   * other side — "{name} stops organizing it on its next pass" — and `holderOf` supplies "another
   * install" when nothing holds the mailbox. So the row that has just been corrected to say
   * "Organize here" opened a well describing a consequence for a machine that does not exist.
   *
   * WATCH IT FAIL: point the released arm back at `organizeHereWhat`.
   */
  it("(6c) the confirm well on a row nobody organizes names nobody", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").includes("Organize here"))!.click();
    });
    const well = (el.querySelector(".mbx-handover-what")?.textContent ?? "").trim();
    expect(well, "the well never opened").not.toBe("");
    expect(well, "the consequence was described for an install that does not exist")
      .toBe(mailboxCopy.organizeHereWhatNobody!);
    expect(well.toLowerCase(), "a holder was named on a row that has none")
      .not.toContain(mailboxCopy.readerHolderUnknown!.toLowerCase());
  });

  /**
   * (6d) CONTROL — a row somebody DOES hold keeps the sentence about them, name and all.
   */
  it("(6d) CONTROL — the well still names a real holder", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").includes("Organize here"))!.click();
    });
    const well = (el.querySelector(".mbx-handover-what")?.textContent ?? "").trim();
    expect(well).toBe(mailboxCopy.organizeHereWhat!.replace("{name}", "ohmail Cloud"));
  });

  /**
   * (4b) THE OTHER WAY A TAKEOVER PRESS IS SUPERSEDED — a stop made somewhere else. This pane
   * never sees the press, only its effect: the row comes back a reader with a NEW release stamp.
   * The note's own clear (in the release handler) cannot fire here, so this is what the stamp
   * comparison in `takeoverStanding` is for, and it is the case that makes that comparison's
   * contrary state reachable.
   *
   * WATCH IT FAIL: drop the `releasedAt` comparison and answer `reclaimed.has(m.id)`.
   */
  it("(4b) a release recorded elsewhere ends the takeover note here too", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T08:00:00.000Z",
    }];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "authorized" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const el = await render("local");
    await act(async () => { buttonSaying(el, "Organize here")!.click(); });
    await act(async () => { buttonExactly(el, "Organize here")!.click(); });
    expect(el.textContent ?? "").toContain(mailboxCopy.organizeHereQueued!);

    /* No press here: the row simply comes back with a release nobody at this window made. */
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T09:30:00.000Z",
    }];
    await repaint("local");
    expect(el.textContent ?? "", "a takeover promise outlived a release made elsewhere")
      .not.toContain(mailboxCopy.organizeHereQueued!);
    expect(buttonSaying(el, "Organize here"),
      "the superseded note kept the way back hidden").not.toBeNull();
  });

  /**
   * (7) CONTROL — the released row's date, checked at the PANE and green before anything moved.
   *
   * The walk read "Nothing organizes this mailbox" with no date after a stop. The DTO carries
   * `organizerReleasedAt` (`mailbox-service.ts`, projected unconditionally beside its four
   * neighbours) and the sidecar's release stamps it in the same statement that writes the reader
   * role (`engine.ts`, the yield arm), and this case says the pane renders it. So the pane is not
   * where that silence comes from either: what the walk photographed is a row whose wire carried
   * no stamp.
   *
   * It is kept as a control because the arm has a real way to be lost — the `organizerReleasedAt`
   * spread in `readMailboxFactsVia` — and nothing else in this file drives it.
   */
  it("(7) CONTROL — a released row carries the day this install let the mailbox go", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T09:12:00.000Z",
    }];
    const said = (await render("local")).textContent ?? "";
    expect(said, "the row lost the label for the state it is in")
      .toContain(mailboxCopy.stateNotOrganized!);
    /* THE SENTENCE'S OPENING, not the whole string: `dayStamp` renders in the app's own format
       register, so pinning a spelling here would test the formatter rather than the arm. The
       DATE ITSELF is asserted by the em-dash check below, which is the failure this row is
       about — a released row with no date in it. */
    expect(said, "the one sentence that dates something the person here did")
      .toContain(mailboxCopy.stateReleased!.slice(0, mailboxCopy.stateReleased!.indexOf("{when}")));
    expect(said, "the released row printed an em dash where its date belongs")
      .not.toContain(mailboxCopy.stateReleased!.replace("{when}", "—"));
  });
});

/**
 * ═══ A ROW NOTHING ANSWERED ABOUT MUST NOT READ AS A HEALTHY ONE ═══════════════════════════
 *
 * MEASURED, on Windows, 2026-09-09: during a nine-minute cut of port 993
 * the Settings row for the mailbox that install organizes read "Up to date" for eleven samples of
 * eleven, while the engine's own log held the death (`mailbox_connection_unavailable`,
 * ECONNRESET, detected by the adapter's own event), six `mailbox_reconnect_failed` and
 * twenty-four `sync_cycle_failed`. The engine was RIGHT: its outage clock was armed at the death
 * and never cleared — the one drain that returned in the span landed 664 ms BEFORE it, so the one
 * site that clears the clock did not run — and the row's "Last checked" stamp, which comes from
 * the shared facts poller, froze at the death second and went fresh at the reconnect second. The
 * two halves of one row disagreed for nine minutes.
 *
 * WHAT THE VALUE NEEDS is the pane's own reach poll, and `readMailboxReachVia` answered a SILENT
 * slice — `{rows:{}, faulted:false}` — for a transport that threw and for a 404 alike. With no
 * record for the row and no fault on the slice, `stateOf`'s outage arm cannot be entered and the
 * ladder falls through to "Up to date". So the fix is the poll's own state, named:
 * `unasked | verdict | silent | faulted`, plus WHICH silence, and one rule over the absence —
 * `reachUnknownForRow`.
 *
 * ── EVERY ARM OF THAT RULE HAS A CASE HERE, AND EACH WAS WATCHED RED ────────────────────────
 *
 *  · `case "silent": return slice.reason === "transport-threw"` → true unconditionally reddens
 *    the 404 control; false unconditionally reddens the Windows case, which is the red-before;
 *  · `case "verdict": return organizedHere` → true unconditionally reddens the Cloud-organized
 *    control; false unconditionally reddens the filed-row case;
 *  · `case "unasked": return false` → true reddens the first-paint control;
 *  · `case "faulted": return true` → false reddens the 500 case;
 *  · and restoring the whole arm to `if (!r && reach.faulted)` reddens the Windows case, the
 *    filed-row case and nothing else.
 */
describe("the pane says it cannot check, rather than that the mailbox is up to date", () => {
  const copy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;

  /**
   * THE SHAPE OF THE ROW THAT WAS MEASURED — one whose own description says THIS COMPUTER
   * FILES IT.
   *
   * `organizeConsentedAt` and not the role alone, because that is what `organizesHere` reads and
   * what the guest's row rendered ("Organized on this computer"): the role column rests at
   * `'organizer'`, so a row that was connected and never agreed to would otherwise qualify.
   */
  const FILED: MailboxFacts = {
    ...MAILBOX,
    organizerRole: "organizer",
    organizeConsentedAt: "2026-08-01T09:00:00.000Z",
  };

  const roster = (items: unknown[]): Response => new Response(JSON.stringify({ items }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  /** A bridge that rejects, in the shell's own words. */
  const throwing = (message: string) => () => { throw new Error(message); };

  /**
   * THE RED-BEFORE. The bridge's refusal is quoted from the shell that produces it
   * (`MAX_PENDING_REQUESTS`, `apps/desktop/src-tauri/src/engine.rs`) — a request the shell
   * refuses to send is never sent, so it leaves nothing in the engine's log either, which is why
   * the Windows reading could be measured on screen and attributed to neither half afterwards.
   */
  it("THE WINDOWS READING — a bridge that throws never leaves the row saying 'Up to date'", async () => {
    FACTS = [FILED];
    bridgeReply = throwing("32 requests are already waiting on the engine; this one was not sent");

    const text = (await render("local")).textContent ?? "";
    expect(bridged, "the pane never asked the reach question at all")
      .toContainEqual({ url: "/local/mailboxes/connections", method: "GET" });
    expect(text, "a row nothing answered about read as a healthy mailbox — the Windows reading")
      .not.toContain(copy.desktopStateUpToDate!);
    expect(text, "the row said nothing about a question that never arrived")
      .toContain(copy.desktopStateUnknown!);
    expect(text, "a question that never arrived was reported as the person's server being down")
      .not.toContain(copy.desktopStateUnreachable!);
    expect(text, "a slice with no per-row answer invented a duration for an outage")
      .not.toContain("Last answered");
  });

  /**
   * THE OTHER SILENCE, AND IT MUST NOT MOVE: a 404 is an engine older than the route, which is an
   * ordinary state on a desktop that updates on its own schedule. The desktop's own frame door
   * serves this route in the same build as the window, so a 404 there cannot be that build's
   * engine refusing — which is exactly why the two silences are told apart rather than merged.
   */
  it("CONTROL — a 404 stays ordinary, even on a row this computer files", async () => {
    FACTS = [FILED];
    bridgeReply = () => new Response(null, { status: 404 });

    const text = (await render("local")).textContent ?? "";
    expect(text, "an engine older than the route was read as a question that could not be asked")
      .not.toContain(copy.desktopStateUnknown!);
    expect(text).toContain(copy.desktopStateUpToDate!);
  });

  /**
   * THE FIRST PAINT. `unasked` is not a silence: nothing has been asked yet. Read as one, the
   * sentence would appear for a tick every time somebody opened Settings — a false alarm wearing
   * a true one's words, which is the failure this whole file is about, inverted.
   *
   * Driven with a read that never settles, which is the state the pane is in between mounting and
   * its first answer.
   */
  it("CONTROL — before the first answer lands the row keeps its ordinary state", async () => {
    FACTS = [FILED];
    bridgeReply = () => new Promise<Response>(() => { /* never settles */ });

    const text = (await render("local")).textContent ?? "";
    expect(text, "the pane announced it could not check before it had asked")
      .not.toContain(copy.desktopStateUnknown!);
    expect(text).toContain(copy.desktopStateUpToDate!);
  });

  /**
   * A VERDICT THAT DOES NOT NAME A ROW THIS COMPUTER FILES. The engine answers this route from
   * every runtime it holds, and a mailbox it organizes has one, so the absence is a missing
   * answer rather than an answer — and "Up to date" would be a claim with nothing behind it.
   */
  it("a roster that skips a row this computer files is a missing answer, not a healthy one", async () => {
    FACTS = [FILED];
    bridgeReply = () => roster([{ mailboxId: "some-other-row", reachable: true, unreachableSince: null }]);

    const text = (await render("local")).textContent ?? "";
    expect(text, "a row the engine said nothing about read as a working mailbox")
      .not.toContain(copy.desktopStateUpToDate!);
    expect(text).toContain(copy.desktopStateUnknown!);
  });

  /**
   * AND THE ROW THAT MUST NOT MOVE — a mailbox ohmail Cloud organizes. This install holds no
   * connection for it, so the roster naming no record for it is the ORDINARY answer, and the row
   * reads what it read before this change. Measured on the same pass, on a mailbox organized in
   * ohmail Cloud: ten readings of ten, "Organized by ohmail Cloud". A rule that fired on every
   * absent record would have replaced that sentence with "Can't check the mail server right now".
   */
  it("CONTROL — a Cloud-organized row keeps its sentence when the roster has no record", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    bridgeReply = () => roster([]);

    const text = (await render("local")).textContent ?? "";
    expect(text, "a row this install does not organize was told this install could not check it")
      .not.toContain(copy.desktopStateUnknown!);
    expect(text, "the reader sentence was replaced by a fact about somebody else's connection")
      .toContain(copy.stateReading!);
  });

  /** The arm that already worked, kept: the engine answered and it was not a verdict. */
  it("CONTROL — an engine that answers 500 about its own sockets still says so", async () => {
    FACTS = [FILED];
    bridgeReply = () => new Response(null, { status: 500 });

    const text = (await render("local")).textContent ?? "";
    expect(text).toContain(copy.desktopStateUnknown!);
    expect(text).not.toContain(copy.desktopStateUpToDate!);
  });

  /** THE POSITIVE HALF, both ways: a verdict about this row decides the row. */
  it("CONTROL — a verdict about this row is what the row renders, either way", async () => {
    FACTS = [FILED];
    bridgeReply = () => roster([{ mailboxId: "mbx-1", reachable: true, unreachableSince: null }]);
    let text = (await render("local")).textContent ?? "";
    expect(text, "a healthy verdict was overridden by the absence rule").toContain(copy.desktopStateUpToDate!);
    expect(text).not.toContain(copy.desktopStateUnknown!);
    await act(async () => { root!.unmount(); });
    root = null;

    bridgeReply = () => roster([{
      mailboxId: "mbx-1",
      reachable: false,
      unreachableSince: new Date(Date.now() - 20 * 60_000).toISOString(),
    }]);
    text = (await render("local")).textContent ?? "";
    expect(text, "the outage sentence lost its place to the absence rule")
      .toContain("Can't reach the mail server");
    expect(text, "an answered outage was reported as an unanswerable question")
      .not.toContain(copy.desktopStateUnknown!);
    expect(text).toContain("20 minutes ago");
  });

  /**
   * ═══ A WAIT HAS A BOUND, AND AN ANSWER HAS AN AGE ══════════════════════════════════════
   *
   * MEASURED on BOTH desktop surfaces in the 0.16.0 pass. With the network cut and the engine's
   * own log holding `mailbox_connection_unavailable` and five failed re-dials, the connection row
   * read "Up to date": 151 s under the cut plus 152 s after the link came back on Windows, and
   * for the life of a mount on Linux, in two of four measured cuts. Nothing measurable separated
   * the failing runs from the passing ones — and the fix needs no such condition, because two
   * arms of the ladder produce that reading and neither depends on the cause of the silence.
   *
   *  · `unasked` — the mount's wait — had nothing that ended it. A first poll that never
   *    RESOLVES is not the same as one that fails: it writes no slice at all, so the ladder fell
   *    through to "Up to date" for as long as the pane stayed open.
   *  · A verdict had no age. Once a healthy roster landed, polls that stopped landing left that
   *    answer standing, and a stopped roster is what an outage looks like from here.
   *
   * ── WHY EVERY ARM BELOW SITS A WHOLE CADENCE EITHER SIDE OF THE BOUND ────────────────────
   *
   * The render's clock advances on the poll's interval and nowhere else, so the sentence can only
   * appear AT a tick — a case pinned to the exact millisecond of the bound would be measuring the
   * test's own elapsed time (`shouldAdvanceTime` moves the fake clock with the real one). Two
   * cadences is inside the bound with 15 s to spare; four is outside it with 15 s to spare.
   *
   * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ───────────────────────────────────────
   *
   *  · `case "unasked": return overdue` → `return false`, the shipped line, reddens the bounded
   *    wait and nothing else;
   *  · deleting `if (r && reachStale(reach, now))` reddens the aged verdict and nothing else;
   *  · dropping `setNow(Date.now())` from the interval reddens BOTH — the clock is the only thing
   *    that ticks when no answer is arriving, and without it the bound can never be reached;
   *  · dropping the `organizedHere &&` gate on `overdue` reddens the reader control, which is
   *    the row this install holds no connection for and must not speak about.
   */
  it("A FIRST POLL THAT NEVER ANSWERS is news at the bound, and ordinary before it", async () => {
    const { REACH_POLL_MS, REACH_STALE_MS } = await import("../src/DesktopMailboxes.js");
    FACTS = [FILED];
    /* THE HUNG READ, which is the state the pane is in between mounting and its first answer —
       and, when the question stops arriving, for the life of the mount. */
    bridgeReply = () => new Promise<Response>(() => { /* never settles */ });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      const said = (): string => el.textContent ?? "";
      expect(REACH_STALE_MS, "the bound is the cadence plus its grace").toBe(REACH_POLL_MS * 3);

      /* WITHIN THE BOUND — a wait of two cadences is still a wait, and the sentence must not
         appear for it: this is the arm that keeps a healthy first paint quiet. */
      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "the pane announced it could not check while the wait was ordinary")
        .not.toContain(copy.desktopStateUnknown!);
      expect(said()).toContain(copy.desktopStateUpToDate!);

      /* PAST IT — the first poll has not resolved in four cadences, and that is news. */
      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "a first poll that never answered still read as a healthy mailbox")
        .not.toContain(copy.desktopStateUpToDate!);
      expect(said()).toContain(copy.desktopStateUnknown!);
      /* AND IT IS NOT AN OUTAGE. Nothing has been learned about the person's mail server: the
         question never came back, which is this install's fact and not their provider's. */
      expect(said(), "a question that never came back was reported as the person's server down")
        .not.toContain(copy.desktopStateUnreachable!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("A HEALTHY VERDICT STOPS BEING ONE once nothing refreshes it", async () => {
    const { REACH_POLL_MS } = await import("../src/DesktopMailboxes.js");
    FACTS = [FILED];
    bridgeReply = () => roster([{ mailboxId: "mbx-1", reachable: true, unreachableSince: null }]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      const said = (): string => el.textContent ?? "";
      expect(said(), "a fresh answered verdict is the positive control — it says the state")
        .toContain(copy.desktopStateUpToDate!);

      /* AND NOW THE ANSWERS STOP ARRIVING while the last one says everything is fine. This is the
         Windows reading: five minutes of "Up to date" over a connection the engine had given up
         on, with the row's own poll no longer landing. */
      bridgeReply = () => new Promise<Response>(() => { /* never settles */ });
      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "one missed cadence withdrew an answer that is still current")
        .toContain(copy.desktopStateUpToDate!);

      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "a verdict nothing has refreshed for four cadences still read as healthy")
        .not.toContain(copy.desktopStateUpToDate!);
      expect(said()).toContain(copy.desktopStateUnknown!);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * AN OUTAGE THE ENGINE REPORTED OUTRANKS ITS OWN AGE — the row learns it as `reachable: false`,
   * which is the roster's spelling of the engine's `mailbox_connection_unavailable`. "Can't
   * check" would be a WEAKER sentence than the one already earned, and the stamp beside it says
   * how old it is, so nothing is being claimed that the row does not date.
   */
  it("CONTROL — an answered outage keeps its own sentence at any age", async () => {
    const { REACH_POLL_MS } = await import("../src/DesktopMailboxes.js");
    FACTS = [FILED];
    bridgeReply = () => roster([{
      mailboxId: "mbx-1",
      reachable: false,
      unreachableSince: new Date(Date.now() - 20 * 60_000).toISOString(),
    }]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      const said = (): string => el.textContent ?? "";
      expect(said()).toContain(copy.desktopStateUnreachable!);

      bridgeReply = () => new Promise<Response>(() => { /* never settles */ });
      await act(async () => { vi.advanceTimersByTime(4 * REACH_POLL_MS); });
      expect(said(), "an answered outage was downgraded to an unanswerable question by its age")
        .toContain(copy.desktopStateUnreachable!);
      expect(said()).not.toContain(copy.desktopStateUnknown!);
      expect(said()).not.toContain(copy.desktopStateUpToDate!);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * AND THE ROW THAT MUST NOT MOVE, AGAIN — a mailbox ohmail Cloud organizes. This install holds
   * no connection for it, so its own poll going quiet says nothing about that mailbox at all.
   * The bound is gated on the row's claim for exactly this reason; ungated it would put "Can't
   * check the mail server right now" on every hosted row a minute after the pane opened.
   */
  it("CONTROL — a row this install does not file keeps its sentence past the bound", async () => {
    const { REACH_POLL_MS } = await import("../src/DesktopMailboxes.js");
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    bridgeReply = () => new Promise<Response>(() => { /* never settles */ });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      await act(async () => { vi.advanceTimersByTime(4 * REACH_POLL_MS); });
      const said = el.textContent ?? "";
      expect(said, "a row this install does not organize was told this install could not check it")
        .not.toContain(copy.desktopStateUnknown!);
      expect(said, "the reader sentence was replaced by a fact about somebody else's connection")
        .toContain(copy.stateReading!);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE POLL SAYS WHERE IT LANDED — the instrument, and the reason it exists: before it, a
   * silence and a healthy verdict produced the same screen AND the same nothing anywhere else.
   * It is the web inspector's line and not the engine's log (the window has no route into that),
   * which is stated here so nobody reads it as a field instrument it is not.
   */
  it("the poll reports its landing, once per change, with which silence it was", async () => {
    FACTS = [FILED];
    const said: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      said.push(args.map((a) => String(a)).join(" "));
    });
    const lines = (): string[] => said.filter((l) => l.includes("ohmail reach poll:"));
    bridgeReply = throwing("the engine is still starting");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render("local");
      expect(lines().length, "the landing was never reported").toBe(1);
      expect(lines()[0], "the state the row was derived from was not named")
        .toContain('"where":"silent"');
      expect(lines()[0], "which silence it was is the whole diagnosis")
        .toContain('"reason":"transport-threw"');
      expect(lines()[0], "the transport's own account of the refusal was dropped")
        .toContain("the engine is still starting");
      expect(lines()[0], "the row the answer was owed about was not counted")
        .toContain('"withoutRecord":1');

      /* THE SAME LANDING AGAIN IS NOT NEWS: at four polls a minute a line each would bury the
         transition anybody is reading the log for. */
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(lines().length, "an unchanged landing was reported twice").toBe(1);

      /* …AND A LANDING THAT DIFFERS IS. Without this the de-duplication would be indistinguishable
         from a line that only ever fires once. */
      bridgeReply = () => roster([{
        mailboxId: "mbx-1", reachable: false, unreachableSince: new Date().toISOString(),
      }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(lines().length, "the poll's recovery into a verdict went unreported").toBe(2);
      expect(lines()[1]).toContain('"where":"verdict"');
      expect(lines()[1], "an answered outage was not counted as one").toContain('"unreachable":1');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE READER'S OWN ARMS, without a render: each landing carries the state, the reason and the
   * status it was reached by. The pane's sentence is derived from these three, so they are pinned
   * here rather than inferred from the screen.
   */
  it("every landing carries its state, its reason, its status AND WHEN IT LANDED", async () => {
    const { readMailboxReachVia } = await import("../src/DesktopMailboxes.js");
    const answers = (res: () => Response | Promise<Response>) =>
      readMailboxReachVia(async () => res());
    /* THE CLOCK IS PINNED, because every landing now carries the instant it was made — the age
       the row's sentence is derived from. Unpinned these five equalities could not name it, and
       an `expect.any(Number)` would stop asserting the stamp at all. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const at = Date.now();

    expect(await answers(() => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }))).toEqual({ rows: {}, state: "verdict", reason: null, status: 200, detail: null, at });

    expect(await answers(() => new Response(null, { status: 404 })))
      .toEqual({ rows: {}, state: "silent", reason: "route-absent", status: 404, detail: null, at });

    expect(await answers(() => new Response(null, { status: 401 })))
      .toEqual({ rows: {}, state: "faulted", reason: "refused", status: 401, detail: null, at });

    expect(await answers(() => new Response("not json", {
      status: 200, headers: { "content-type": "application/json" },
    }))).toEqual({
      rows: {}, state: "faulted", reason: "unparseable-body", status: 200, detail: null, at,
    });

    expect(await answers(() => new Response("{}", {
      status: 200, headers: { "content-type": "application/json" },
    }))).toEqual({ rows: {}, state: "faulted", reason: "not-a-roster", status: 200, detail: null, at });
    vi.useRealTimers();

    const threw = await readMailboxReachVia(() => { throw new Error("the engine has stopped"); });
    expect(threw.state).toBe("silent");
    expect(threw.reason).toBe("transport-threw");
    expect(threw.status, "a question that never arrived reported a status it never got").toBeNull();
    expect(threw.detail).toBe("Error: the engine has stopped");

    /* A THROWN VALUE IS SOMEBODY ELSE'S STRING — bounded, and a non-Error still says something. */
    const long = await readMailboxReachVia(() => { throw new Error("x".repeat(400)); });
    expect((long.detail ?? "").length, "an unbounded line went into the log").toBeLessThanOrEqual(241);
    const odd = await readMailboxReachVia(() => { throw "just a string"; });
    expect(odd.detail).toContain("just a string");
  });
  /**
   * ═══ THE THREE ANSWERS, ON ONE ROW, IN ORDER ══════════════════════════════════════════════
   *
   * Every case above mounts the pane already in one state. This one drives a SINGLE mount through
   * the ladder a person sees, because the transitions are where the row went wrong: a healthy
   * answer, the engine's own dial failing with the age beside it climbing, the link coming back,
   * and then the window's question to its engine going unanswered.
   *
   * THE LAST STATE IS NOT REACHABLE BY CUTTING A NETWORK, and that is why it is asserted here.
   * "Can't reach the mail server" is the ENGINE answering that it cannot reach the provider — cut
   * the link and the engine says so within a cycle, dates it, and the row is right. "Can't check
   * the mail server right now" answers a different fault: the window asked the engine in its own
   * process and nothing came back, over a pipe no network carries. Driving one fault produces the
   * other sentence, so the two are separated by the shape of the silence and not by a cut.
   *
   * HOW TO WATCH IT FAIL: delete the age test on a landed verdict (`if (r && reachStale(reach,
   * now))`) and leg (d) reads "Up to date" past the bound; drop the `transport-threw` half of
   * `reachUnknownForRow`'s `silent` arm and leg (e) reads "Up to date" over a request that was
   * refused before it was sent.
   */
  it("one row, three answers: healthy, an outage it dates, and a question nothing answered", async () => {
    const { REACH_POLL_MS, REACH_STALE_MS } = await import("../src/DesktopMailboxes.js");
    /* THE FIGURES, from the source: the cadence the engine's own poll sets, and the age past
       which an answer nothing has refreshed stops being an answer. The legs below are timed in
       cadences, so the wall-clock bound is pinned here rather than left to arithmetic. */
    expect(REACH_POLL_MS, "the reach cadence moved").toBe(15_000);
    expect(REACH_STALE_MS, "the bound on an unrefreshed answer moved").toBe(45_000);

    /* THE SENTENCES, FROM THE CATALOGUE AND NOT FROM MEMORY. A literal here would go on passing
       after the copy changed, which is the one thing a copy assertion is for. The age inside the
       clause is `Intl.RelativeTimeFormat`'s and not the catalogue's, so it is derived from the
       same formatter the stamp uses — what this case asserts about it is that it CLIMBS. */
    const justNow =
      (messages as unknown as { relativeTime: { justNow: string } }).relativeTime.justNow;
    const lastAnswered = (when: string): string =>
      copy.desktopStateLastAnswered!.replace("{when}", when);
    const minutesAgo = (n: number): string =>
      new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-n, "minute");
    const lastCheckedClause = copy.desktopLastChecked!.split("{when}")[0]!;

    FACTS = [FILED];
    let answer: () => Response | Promise<Response> =
      () => roster([{ mailboxId: "mbx-1", reachable: true, unreachableSince: null }]);
    bridgeReply = () => answer();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const el = await render("local");
      const said = (): string => el.textContent ?? "";

      /* ── (a) THE ENGINE ANSWERS ───────────────────────────────────────────────────────────
         "Last checked" is the shared facts poller's clause and it is on the row in every state
         below, which is why it cannot carry an outage by itself: it froze at the death second
         while the cell beside it went on reading "Up to date". The cell is the half under test. */
      expect(said(), "a healthy roster did not produce the healthy sentence")
        .toContain(copy.desktopStateUpToDate!);
      expect(said(), "the row lost its own last-checked clause").toContain(lastCheckedClause);
      expect(said()).not.toContain(copy.desktopStateUnknown!);
      expect(said()).not.toContain(copy.desktopStateUnreachable!);

      /* ── (b) THE ENGINE'S DIAL FAILS ──────────────────────────────────────────────────────
         What a dead connection to the mail server looks like from here: the engine reports it
         once and the row states the fact and dates it from the engine's first observation. */
      const died = Date.now();
      answer = () => roster([{
        mailboxId: "mbx-1",
        reachable: false,
        unreachableSince: new Date(died).toISOString(),
      }]);
      /* THE ASYNC TIMER FORM WHERE THE POLL MUST LAND — and the plain one in (d), where it must
         not: the async form drains the microtasks a read settles on, so a read that never
         resolves would be settled by the helper instead of staying pending in the product. */
      await act(async () => { await vi.advanceTimersByTimeAsync(REACH_POLL_MS); });
      expect(said(), "an outage the engine reported was not on the row")
        .toContain(copy.desktopStateUnreachable!);
      expect(said(), "the row claimed health over a connection the engine had given up on")
        .not.toContain(copy.desktopStateUpToDate!);
      expect(said(), "an answered outage was reported as a question nothing answered")
        .not.toContain(copy.desktopStateUnknown!);
      expect(said(), "the outage carried no age at all").toContain(lastAnswered(justNow));

      /* AND THE AGE CLIMBS, on the poll's own cadence and with nothing else moving. Sampled a
         cadence clear of each rounding edge: the render's clock advances on the interval and
         nowhere else, so a sample pinned to the edge would be measuring elapsed test time. */
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * REACH_POLL_MS); });
      expect(said(), "the age beside the outage stopped counting")
        .toContain(lastAnswered(minutesAgo(1)));
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * REACH_POLL_MS); });
      expect(said(), "the age froze after its first minute")
        .toContain(lastAnswered(minutesAgo(2)));
      expect(minutesAgo(1), "the two samples are the same clause, so nothing was measured")
        .not.toBe(minutesAgo(2));

      /* ── (c) THE LINK COMES BACK ──────────────────────────────────────────────────────────
         The engine answers a reachable roster and the row clears within one poll. This is also
         the state leg (d) has to start from: an outage the engine REPORTED keeps its own
         sentence however old it gets, which is the control two cases above. */
      answer = () => roster([{ mailboxId: "mbx-1", reachable: true, unreachableSince: null }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(REACH_POLL_MS); });
      expect(said(), "the outage sentence outlived the answer that cleared it")
        .not.toContain(copy.desktopStateUnreachable!);
      expect(said()).toContain(copy.desktopStateUpToDate!);

      /* ── (d) THE QUESTION STOPS COMING BACK ───────────────────────────────────────────────
         With the last thing the engine said being that everything is fine. A read that never
         resolves writes no slice, so nothing re-renders on it and the answer on screen is the
         only thing left: past the bound it is not an answer any more. */
      answer = () => new Promise<Response>(() => { /* never settles */ });
      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "two cadences of silence withdrew an answer that is still current")
        .toContain(copy.desktopStateUpToDate!);
      await act(async () => { vi.advanceTimersByTime(2 * REACH_POLL_MS); });
      expect(said(), "the row claimed health past the bound, on an answer nothing refreshed")
        .not.toContain(copy.desktopStateUpToDate!);
      expect(said()).toContain(copy.desktopStateUnknown!);
      /* AND IT IS NOT AN OUTAGE: nothing here has learned anything about the mail server. */
      expect(said(), "an unanswered question was reported as the provider being down")
        .not.toContain(copy.desktopStateUnreachable!);

      /* ── (e) THE SILENCE THE PIPE ACTUALLY PRODUCES ───────────────────────────────────────
         The request is refused before it is sent, so the engine never sees the question and
         writes nothing about it either. News at the first poll rather than at the bound — this
         answer is FRESH, so the age test cannot be what puts the sentence on the row, and the
         only thing that can is the refusal itself. */
      answer = throwing("32 requests are already waiting on the engine; this one was not sent");
      await act(async () => { await vi.advanceTimersByTimeAsync(REACH_POLL_MS); });
      expect(said(), "a request the pipe refused left the row saying it could check")
        .toContain(copy.desktopStateUnknown!);
      expect(said(), "a refused request read as a healthy mailbox")
        .not.toContain(copy.desktopStateUpToDate!);
      expect(said()).not.toContain(copy.desktopStateUnreachable!);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * ═══ THE COMPACT CARD — THE ROLE IS A CHIP, AND THE SENTENCE IS ITS DESCRIPTION ═══════════
 *
 * The organizer banner under every mailbox row — a bold label, a two-line sentence and a capsule,
 * once per mailbox — is one chip now. The chip is a button: its caption is the role's label, and
 * the sentence that stood under the label is its ACCESSIBLE DESCRIPTION, opened beside the chip
 * on hover, focus or a press. What that changes for a screen reader is the point: the banner
 * rendered label and sentence as two sibling text nodes inside one note, and an accessibility-tree
 * walk of the row on Linux heard "Organizing" and never the sentence. `aria-describedby` from the
 * chip to the sentence's node is what a reader computes a description from, and it is asserted
 * here rather than the text — every earlier case in this file asserts the sentences by
 * `textContent`, which is exactly why the missing description was invisible to all of them.
 *
 * The state cell — "Up to date", or the outage sentence — is a live region for the same reason: a
 * bare span is dropped from the tree on the same platform, and it carries the one fact on the row
 * a person most needs.
 *
 * The stop is one chip on two clocks. This window's own "asked for" note used to be a verdict line
 * under a banner that still read "Organizing"; the row's request stamp then replaced the banner's
 * sentence a poll later. Both read "Stopping" now, and the chip's sentence says which clock it is
 * on. The conditions are the note's and the description's, unchanged.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *  · drop the chip's `caption` (a label beside a bare glyph) → every description case reds: the
 *    trigger has no `aria-describedby`; the `textContent` cases above stay green, which is the
 *    blindness this describe exists to end;
 *  · point the pending arm back at `stateOrganizingHere` → the pending chip case reds alone;
 *  · drop `role="status"` from the state cell → both cell cases red, nothing else;
 *  · render the quiet verb without its glyph → the verb case reds on the missing description.
 */
describe("the compact card — the role chip, its description, the quiet verb and the state cell", () => {
  const mailboxCopy = (messages as unknown as { mailboxes: Record<string, string> }).mailboxes;
  const ORGANIZING: MailboxFacts = {
    ...MAILBOX,
    organizerRole: "organizer",
    organizeConsentedAt: "2026-08-01T09:00:00.000Z",
  };

  /** The chip: its trigger, its caption, and the node its description points at. */
  const chip = (el: HTMLElement) => {
    const btn = el.querySelector<HTMLButtonElement>(".mbx-org .mbx-chip .gloss-t");
    if (!btn) throw new Error("no role chip on the row");
    const id = btn.getAttribute("aria-describedby");
    const said = id ? document.getElementById(id) : null;
    return {
      btn,
      label: (btn.querySelector(".gloss-cap")?.textContent ?? "").trim(),
      said,
      description: (said?.textContent ?? "").trim(),
      state: btn.closest(".mbx-org")?.getAttribute("data-state") ?? null,
      role: btn.closest(".mbx-org")?.getAttribute("data-role") ?? null,
    };
  };

  /** The row's state cell — the live region inside the value slot. */
  const cell = (el: HTMLElement): HTMLElement | null =>
    el.querySelector<HTMLElement>('.set-row .set-val [role="status"]');

  async function repaint(door: string): Promise<void> {
    const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
    await act(async () => {
      root!.render(
        h(
          IntlProvider,
          { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
          h(
            ThemeProvider,
            { storageKey: "ohmail.theme" } as never,
            h(ToastHost, null, h(DesktopMailboxes, { door })),
          ),
        ),
      );
    });
  }

  it("an organizer row's chip reads Organizing, and its DESCRIPTION is the filing sentence", async () => {
    FACTS = [ORGANIZING];
    const el = await render("local");
    const c = chip(el);
    expect(c.label).toBe(mailboxCopy.stateOrganizing!);
    expect(c.role).toBe("organizer");
    expect(c.state, "an ordinary organizer carries no stop state").toBeNull();
    expect(c.said, "aria-describedby does not resolve to a node — a reader gets no description")
      .not.toBeNull();
    expect(c.said!.getAttribute("role")).toBe("tooltip");
    expect(c.description).toBe(mailboxCopy.stateOrganizingHere!);
    // Present and closed: the description has to be computable BEFORE anything is opened.
    expect(c.said!.hidden).toBe(true);
    expect(c.btn.getAttribute("aria-expanded")).toBe("false");
    // The banner is gone from this pane — the chip is the container now, not a second copy.
    expect(el.querySelector(".mbx-org .set-banner")).toBeNull();
  });

  it("a press opens the sentence beside the chip; Escape closes it", async () => {
    FACTS = [ORGANIZING];
    const el = await render("local");
    const c = chip(el);
    await act(async () => { c.btn.click(); });
    expect(c.said!.hidden).toBe(false);
    expect(c.btn.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      c.btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(c.said!.hidden).toBe(true);
  });

  it("while a stop stands the chip reads Stopping, the stop verb is gone and the countermand stands in its place", async () => {
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    const el = await render("local");
    const c = chip(el);
    expect(c.label).toBe(mailboxCopy.chipStopping!);
    expect(c.state).toBe("pending");
    expect(c.description).toBe(mailboxCopy.stopOrganizingPending!);
    expect(c.description).not.toBe(mailboxCopy.stateOrganizingHere!);
    expect(buttonExactly(el, mailboxCopy.stopOrganizingHandBack!),
      "the verb was offered on a row that already carries the ask").toBeNull();
    /* This case asserted `.mbx-verb` ABSENT — the state the countermand row calls the defect: with
       the stop verb withheld and nothing in its place, the engine's "changed my mind" arm was
       unreachable from the product. The claim is narrowed to what it was really about (the STOP
       verb is not re-offered) and the new consumer is named: the takeover, which is the door that
       arm reads. */
    const verb = el.querySelector(".mbx-verb");
    expect(verb, "the countermand's slot is empty again").not.toBeNull();
    expect(verb!.textContent ?? "").toContain(mailboxCopy.organizeHere!);
  });

  it("a press flips the chip to Stopping with the asked-for sentence, with no verdict line", async () => {
    FACTS = [ORGANIZING];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    const el = await render("local");
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });
    let c = chip(el);
    expect(c.label, "the press left no trace on the chip").toBe(mailboxCopy.chipStopping!);
    expect(c.state).toBe("queued");
    expect(c.description).toBe(mailboxCopy.stopOrganizingQueued!);
    expect(el.querySelector(".mbx-org .set-verdict"),
      "the asked-for sentence is rendered twice — on the chip and as a verdict line").toBeNull();

    // The poll brings the stamp: same chip, the row's own clock.
    FACTS = [{ ...ORGANIZING, releaseRequestedAt: "2026-09-07T09:00:00.000Z" }];
    await repaint("local");
    c = chip(el);
    expect(c.label).toBe(mailboxCopy.chipStopping!);
    expect(c.state).toBe("pending");
    expect(c.description).toBe(mailboxCopy.stopOrganizingPending!);
  });

  it("a reader row's chip names the holder and describes since when; its verb is the takeover", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: { kind: "local", name: "omarchy", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: null,
    }];
    const el = await render("local");
    const c = chip(el);
    expect(c.role).toBe("reader");
    expect(c.label).toBe(mailboxCopy.readerLabel!.replace("{name}", "omarchy"));
    /* The clause after the date, as the blank-holder case reads it: the date itself is the
       formatter's and is not pinned here. */
    const named = mailboxCopy.readerSinceLocal!;
    expect(c.description).toContain(named.slice(named.indexOf("· {name}")).replace("{name}", "omarchy"));
    expect(buttonExactly(el, mailboxCopy.organizeHereInstead!)).not.toBeNull();
    expect(buttonExactly(el, mailboxCopy.stopOrganizingHandBack!),
      "a reader row grew a stop verb over somebody else's organizing").toBeNull();
    expect(el.querySelector(".mbx-verb")).toBeNull();
  });

  it("a released row's chip says nothing organizes it, dated; the verb is the primary remedy", async () => {
    FACTS = [{
      ...MAILBOX,
      organizerRole: "reader",
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-08-01T09:00:00.000Z",
      organizerReleasedAt: "2026-09-07T09:12:00.000Z",
    }];
    const el = await render("local");
    const c = chip(el);
    expect(c.role).toBe("released");
    expect(c.label).toBe(mailboxCopy.stateNotOrganized!);
    expect(c.description.startsWith(
      mailboxCopy.stateReleased!.slice(0, mailboxCopy.stateReleased!.indexOf("{when}")),
    ), c.description).toBe(true);
    const press = buttonExactly(el, mailboxCopy.organizeHere!);
    expect(press).not.toBeNull();
    expect(press!.classList.contains("primary"), "the remedy on a row nothing files is not primary").toBe(true);
  });

  it("the quiet verb carries its own (i) naming what follows, and the two go together", async () => {
    FACTS = [ORGANIZING];
    const el = await render("local");
    const verb = buttonExactly(el, mailboxCopy.stopOrganizingHandBack!);
    expect(verb, "the ordinary organizer lost its stop verb").not.toBeNull();
    const pair = verb!.closest(".mbx-verb")!;
    const glyph = pair.querySelector<HTMLButtonElement>(".gloss-t");
    expect(glyph, "the verb has no (i)").not.toBeNull();
    // No caption on this gloss, so the sentence is the glyph's NAME — a reader focusing the
    // glyph hears the consequences whole.
    expect(glyph!.getAttribute("aria-label")).toBe(mailboxCopy.stopOrganizingHandBackWhat!);
    // The verb still opens the confirm well with its own, unchanged sentence — and the verb and
    // its (i) are withheld together while the well is open.
    await act(async () => { verb!.click(); });
    expect((el.querySelector(".mbx-handover-what")?.textContent ?? "").trim())
      .toBe(mailboxCopy.stopOrganizingWhat!);
    expect(el.querySelector(".mbx-verb")).toBeNull();
    expect(buttonExactly(el, mailboxCopy.stopOrganizingHandBack!)).toBeNull();
  });

  it("the state cell is a live region — Up to date on a healthy row", async () => {
    FACTS = [MAILBOX];
    // A healthy roster, not the resting `202` with no body — that one is the engine answering
    // badly, and the cell says so (the case two above this describe pins it).
    bridgeReply = () => new Response(JSON.stringify({
      items: [{ mailboxId: "mbx-1", reachable: true, unreachableSince: null }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const el = await render("local");
    const c = cell(el);
    expect(c, "the state cell is a bare span — dropped from the accessibility tree").not.toBeNull();
    expect((c!.textContent ?? "").trim()).toBe(mailboxCopy.desktopStateUpToDate!);
  });

  it("… and the outage sentence, with its duration, when the server cannot be reached", async () => {
    FACTS = [MAILBOX];
    bridgeReply = () => new Response(JSON.stringify({
      items: [{
        mailboxId: "mbx-1",
        reachable: false,
        unreachableSince: new Date(Date.now() - 20 * 60_000).toISOString(),
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const el = await render("local");
    const c = cell(el);
    expect(c).not.toBeNull();
    // The VERDICT is the live node's whole text; the duration stands beside it in the cell.
    expect((c!.textContent ?? "").trim()).toBe(mailboxCopy.desktopStateUnreachable!);
    const wholeCell = el.querySelector(".set-row .set-val")?.textContent ?? "";
    expect(wholeCell).toContain("Can't reach the mail server");
    expect(wholeCell).toContain("20 minutes ago");
    // One live region per row's state, and the chip's description is not one of them.
    expect(el.querySelectorAll('.set-row .set-val [role="status"]').length).toBe(1);
  });

  /**
   * THE STAMP TICKS OUTSIDE THE LIVE NODE. With "Last answered 3 minutes ago" inside the
   * announced sentence, an outage was read out again every minute — the stamp moved, so the
   * region spoke — for as long as the outage lasted. The verdict is what the live node holds;
   * the clause with the duration stands beside it, in the tree, never announced.
   *
   * WATCH IT FAIL: put the stamp back into the announced sentence — the second reading differs
   * from the first by one minute.
   */
  it("the live node's text is stable across a minute of outage; the duration ticks beside it", async () => {
    FACTS = [MAILBOX];
    const t0 = Date.now();
    bridgeReply = () => new Response(JSON.stringify({
      items: [{
        mailboxId: "mbx-1",
        reachable: false,
        unreachableSince: new Date(t0 - 20 * 60_000).toISOString(),
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const el = await render("local");
    const first = (cell(el)!.textContent ?? "").trim();
    expect(first).toBe(mailboxCopy.desktopStateUnreachable!);
    expect(el.querySelector(".set-row .set-val")?.textContent ?? "").toContain("20 minutes ago");

    // A minute later the pane paints again (any poll, any state change elsewhere does this).
    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    await repaint("local");
    expect(el.querySelector(".set-row .set-val")?.textContent ?? "", "the duration stopped counting")
      .toContain("21 minutes ago");
    expect((cell(el)!.textContent ?? "").trim(), "the live node re-announced the minute")
      .toBe(first);
    // And the duration is in the tree, not a bare span: a reader who reaches the cell hears it.
    expect(el.querySelector('.set-row .set-val [role="note"]')?.textContent ?? "")
      .toContain("21 minutes ago");
  });

  /**
   * THE PRESS IS ANNOUNCED. The "asked for" note was a live-region verdict, so a reader heard the
   * stop's answer at the press; the chip that replaced it changed silently — a caption inside a
   * button is presentational and cannot be a live region. The chip's label is repeated in a
   * polite live node beside it, seen by nobody, which speaks when the label moves.
   *
   * WATCH IT FAIL: drop the `.mbx-say` node — no live node in the role line at all.
   */
  it("the role line has a polite live node whose text changes to Stopping at the press", async () => {
    FACTS = [ORGANIZING];
    bridgeReply = () => new Response(JSON.stringify({ outcome: "requested" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
    const el = await render("local");
    const live = () => el.querySelector<HTMLElement>('.mbx-org [role="status"]');
    expect(live(), "no live node in the role line").not.toBeNull();
    expect((live()!.textContent ?? "").trim()).toBe(mailboxCopy.stateOrganizing!);
    // Outside the chip's button: a button's descendants are presentational.
    expect(live()!.closest("button")).toBeNull();

    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingHandBack!)!.click(); });
    await act(async () => { buttonExactly(el, mailboxCopy.stopOrganizingConfirm!)!.click(); });
    expect((live()!.textContent ?? "").trim(), "the press changed nothing a reader is told")
      .toBe(mailboxCopy.chipStopping!);
    // And it says what the chip says — the two are one label.
    expect((live()!.textContent ?? "").trim()).toBe(chip(el).label);
  });
});
