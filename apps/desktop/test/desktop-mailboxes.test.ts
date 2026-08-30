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
let bridgeReply: () => Response = () => new Response(null, { status: 202 });
/** Every request the pane put down the pipe, in order. */
let bridged: { url: string; method: string }[] = [];

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET" });
    return bridgeReply();
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
          h(ToastHost, null, h(DesktopMailboxes, { door })),
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

beforeEach(() => {
  FACTS = [MAILBOX];
  MIRRORED = 0;
  MAIL_STATE = { key: "quiet", clock: false, settled: true };
  FRESHNESS = { state: "current" };
  refreshed = 0;
  bridged = [];
  bridgeReply = () => new Response(null, { status: 202 });
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

    expect(bridged).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    // The strip at the foot of the rail reads the same route on a slower clock; the pane pushes it.
    expect(refreshed).toBe(1);
    // The row says what it did, and cannot be pressed again while it is pending.
    expect(buttonSaying(el, "Sync queued")?.disabled).toBe(true);
    // …and NOTHING left the webview to do it. The command channel was never touched.
    expect(invoked).toEqual([]);
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
    expect(bridged).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
    expect(invoked).toEqual([]);
  });

  it("keeps its own empty state, which names the local way to fix it", async () => {
    FACTS = [];
    const text = (await render("local")).textContent ?? "";
    expect(text).toContain("Desktop settings pane");
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
});
