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
    expect(bridged).toEqual([{ url: "/mailboxes/mbx-1/resync", method: "POST" }]);
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
    expect(bridged, "the press connected something instead of opening the flow").toEqual([]);
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
    expect(bridged, "the row's verb removed the mailbox with nothing confirmed").toEqual([]);

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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
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
    expect(bridged).toEqual([]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-2", method: "DELETE" }]);
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
    expect(bridged).toEqual([{ url: "/local/mailboxes/mbx-1", method: "DELETE" }]);
    expect(shellCommands, "the install stayed configured for a mailbox it no longer has")
      .toEqual(["engine_logout"]);
    /* AND THE GATE IS TOLD. Without this the window would go on rendering the app over an install
       with no door, and only a relaunch would show the door chooser. */
    expect(published.map((p) => p.state)).toEqual(["not_configured"]);
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
