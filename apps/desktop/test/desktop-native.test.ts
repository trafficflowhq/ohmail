/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  LINK_CODE_EVENT,
  MENU_NAVIGATE_EVENT,
  MENU_COMMANDS,
  MENU_COMMAND_EVENT,
  MENU_VIEWS,
  badgeCount,
  codeOfLinkPayload,
  notify,
  onMenuCommand,
  onMenuNavigate,
  openWeb,
  setBadge,
  commandOfMenuPayload,
  viewOfMenuPayload,
} from "../src/native.js";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import { DesktopSettings } from "../src/DesktopSettings.js";
import { MACHINE_WORD } from "../src/platform.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * THE NATIVE CHROME AND THE INSTALL PANE, driven rather than described.
 *
 * Three claims are checked here that nothing else can see:
 *
 *  1. the menu's event drives the SAME navigation the client's own keyboard drives, and a payload
 *     this bundle does not recognise drives nothing;
 *  2. the dock badge is the count the client publishes, floored and clamped in one place;
 *  3. "Sign out" actually calls `engine_logout`. That one is the reason this file mounts React at
 *     all: a settings pane whose button looks right and calls nothing is precisely the failure
 *     shape the shared `SettingsView` had for tag rename before it was wired, and no amount of
 *     source-text assertion distinguishes a wired button from a decorative one.
 */

/* React's own `act`, taken off the namespace rather than from `react-dom/test-utils` — the
   latter is deprecated in React 18.3 and warns on import. The flag is what stops every render
   below printing "the current testing environment is not configured to support act(...)". */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: Invoke;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}

const host = globalThis as unknown as Host;

interface Asked {
  command: string;
  payload?: Record<string, unknown>;
}

/**
 * A stand-in shell that records what it was asked and replays whatever it registered as an event
 * listener. `transformCallback` is the runtime's own handle-minting call; the fake keeps the
 * function so a test can fire the event the real shell would emit.
 */
function shellAnswering(answer: (asked: Asked) => unknown = () => undefined) {
  const asked: Asked[] = [];
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      return answer({ command, payload });
    },
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
  };
  return {
    asked,
    /** Deliver an event the way the runtime does — the payload wrapped in its envelope. */
    emit(event: string, payload: unknown) {
      const listen = asked.find(
        (a) => a.command === "plugin:event|listen" && a.payload?.event === event,
      );
      if (!listen) throw new Error(`nothing is listening for ${event}`);
      callbacks.get(listen.payload!.handler as number)!({ event, id: 1, payload });
    },
  };
}

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("the menu's navigation", () => {
  it("drives the client's own routing, and nothing else", async () => {
    const shell = shellAnswering();
    const went: string[] = [];
    await onMenuNavigate((view) => went.push(view));

    const listen = shell.asked.find((a) => a.command === "plugin:event|listen")!;
    expect(listen.payload!.event).toBe(MENU_NAVIGATE_EVENT);
    expect(listen.payload!.target).toEqual({ kind: "Any" });

    shell.emit(MENU_NAVIGATE_EVENT, "screener");
    expect(went).toEqual(["screener"]);
  });

  /**
   * A NAME THIS BUNDLE DOES NOT KNOW DOES NOTHING.
   *
   * The shell and the window are two artifacts and can be one version apart. Navigating to a view
   * the client has never heard of would land on its fallback route, which reads as the menu item
   * going to the wrong place — worse than the item doing nothing, because it looks deliberate.
   */
  it("refuses a view it does not recognise rather than falling back", async () => {
    const shell = shellAnswering();
    const went: string[] = [];
    await onMenuNavigate((view) => went.push(view));

    shell.emit(MENU_NAVIGATE_EVENT, "somewhere-else");
    shell.emit(MENU_NAVIGATE_EVENT, "");
    shell.emit(MENU_NAVIGATE_EVENT, null);
    shell.emit(MENU_NAVIGATE_EVENT, 3);
    expect(went).toEqual([]);
  });

  it("reads the payload in both shapes the runtime delivers", () => {
    expect(viewOfMenuPayload("ohbox")).toBe("ohbox");
    expect(viewOfMenuPayload({ payload: "ohbox" })).toBe("ohbox");
    expect(viewOfMenuPayload({ payload: "nope" })).toBeNull();
    expect(viewOfMenuPayload(undefined)).toBeNull();
  });

  it("knows the five places the menu lists and no more", () => {
    expect([...MENU_VIEWS]).toEqual(["ohbox", "reads", "receipts", "screener", "triage"]);
  });

  /** Outside the app there is no menu — and no failure either. */
  it("is silent when there is no shell to listen to", async () => {
    await expect(onMenuNavigate(() => undefined)).resolves.toBeUndefined();
    await expect(notify("t", "b")).resolves.toBeUndefined();
    await expect(setBadge(3)).resolves.toBeUndefined();
  });
});

describe("the badge and the notification", () => {
  it("floors and clamps the count in one place", () => {
    expect(badgeCount(0)).toBe(0);
    expect(badgeCount(-4)).toBe(0);
    expect(badgeCount(2.7)).toBe(2);
    expect(badgeCount(Number.NaN)).toBe(0);
    expect(badgeCount(11)).toBe(11);
  });

  it("sends the clamped count to the shell, not the raw one", async () => {
    const shell = shellAnswering();
    await setBadge(-1);
    expect(shell.asked).toEqual([{ command: "set_badge", payload: { count: 0 } }]);
  });

  it("hands the notification's words over whole", async () => {
    const shell = shellAnswering();
    await notify("ohmail", "One new message for you.");
    expect(shell.asked).toEqual([
      { command: "notify", payload: { title: "ohmail", body: "One new message for you." } },
    ]);
  });
});

describe("Settings → this install", () => {
  const h = React.createElement;
  let hostEl: HTMLDivElement;
  let root: Root;

  const SERVING: EngineStatus = {
    state: "serving",
    mode: "local",
    address: "mila@example.com",
    mailboxId: "mbx-1",
    credentialState: "ready",
  };

  const mount = async (status: EngineStatus, onStatus: (s: EngineStatus) => void = () => {}) => {
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    await act(async () => {
      /* THE PANE'S MODEL FORM READS THE CATALOGUE, so it needs the provider the real shell
         wraps every window in (`DesktopLocale`). The real catalogue, not a stub: a stub would
         let this file assert words the app does not ship. */
      root.render(
        h(
          NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
          h(DesktopSettings, {
            status,
            onStatus,
            onSwitchDoor: () => {},
            onSignIn: () => {},
          }),
        ),
      );
    });
  };

  const click = async (label: string) => {
    const button = [...hostEl.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    );
    if (!button) throw new Error(`no button labelled "${label}" — found: ${
      [...hostEl.querySelectorAll("button")].map((b) => b.textContent).join(" | ")
    }`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  afterEach(async () => {
    await act(() => root.unmount());
    hostEl.remove();
  });

  it("shows the door, the mailbox and the login state", async () => {
    await mount(SERVING);
    const text = hostEl.textContent ?? "";
    expect(text).toContain("mila@example.com");
    /* The door's name carries THIS build's own word for the machine — "Mac"/"PC"/"computer",
       from `platform.ts`. Here the define is absent, so the word is the unbranded one; what the
       assertion pins is that the pane renders the platform word and not a hardcoded "Mac",
       which is exactly what the released 0.12.0 Linux AppImage got wrong. The mapping itself
       (darwin → Mac, win32 → PC, linux → computer) is `desktop-platform.test.ts`'s. */
    expect(text).toContain(`On this ${MACHINE_WORD}`);
    expect(text).not.toContain("On this Mac");

    /* THE CREDENTIAL ROW IS NOT CALLED THE SAME THING ON BOTH DOORS, and this case used to
       assert that it was. It said "Signed in" here — on a STANDALONE install, where there is no
       sign-in, no session and no account: the credential is the mailbox password this computer
       holds for an IMAP server. "Login / Signed in" invited somebody to look for an account they
       do not have, and its `absent` twin said "Signed out" about a state that has no signing-in
       to undo. The hosted door keeps both words, because there they are true — pinned in the
       next case, so the two doors are held apart rather than merely accommodated. */
    expect(text).toContain("Mailbox password");
    expect(text).toContain("Stored");
    expect(text, "the standalone door named a sign-in it does not have").not.toContain("Signed in");

    /* AND THE ENGINE ROW IS ABSENT WHILE THE ENGINE IS SERVING. "Mail engine: Running" was a
       permanent row stating the ordinary case on every healthy install, which is a line nobody
       reads — including on the day it stops saying it. Its states are pinned below. */
    expect(text, "a healthy install still carries a row that only ever says Running")
      .not.toContain("Mail engine");
  });

  it("shows the mail engine only when it is the problem", async () => {
    await mount({ ...SERVING, state: "failed", reason: "the engine exited" });
    const text = hostEl.textContent ?? "";
    expect(text).toContain("Mail engine");
    // The sentence is the one for THIS state — "stopped and did not come back" is false of an
    // engine that is still coming up, which is why there is a sentence per state.
    expect(text).toContain("stopped and did not come back");

    await act(() => root.unmount());
    hostEl.remove();
    await mount({ ...SERVING, state: "starting" });
    const starting = hostEl.textContent ?? "";
    expect(starting).toContain("Mail engine");
    expect(starting).toContain("coming up");
    expect(starting, "a starting engine was described as one that did not come back")
      .not.toContain("did not come back");
  });

  it("names the OTHER door when the install came in by it", async () => {
    await mount({ ...SERVING, mode: "cloud", credentialState: "absent" });
    const text = hostEl.textContent ?? "";
    expect(text).toContain("ohmail Cloud");
    // The hosted door DOES have a session, so it keeps the sign-in vocabulary.
    expect(text).toContain("Account session");
    expect(text).toContain("Signed out");
    // A cloud install that has lost its session is offered the way back.
    expect([...hostEl.querySelectorAll("button")].map((b) => b.textContent)).toContain("Sign in");
  });

  it("does not offer a hosted sign-in on a local install", async () => {
    await mount({ ...SERVING, credentialState: "absent" });
    expect([...hostEl.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Sign in");
  });

  /**
   * THE BOOT CONTRACT'S SENTENCE — the half of that closure that is not the refusal.
   *
   * The engine withholds a password proved against a different server than it is configured for
   * (`apps/sidecar/src/credential-host.ts`) and reports `foreign-host`. Whether it is REFUSED does
   * not depend on this window at all; what depends on this window is whether the person is told
   * something true about why their mail stopped.
   *
   * Two wrong answers are available and both are worse than saying nothing, which is why this is
   * asserted negatively as well as positively:
   *
   *  · the `default` arm — "The mail engine did not say… Nothing is wrong." That is what a window
   *    with no case for this state prints, because the Rust shell folds an unrecognised value into
   *    `Unknown`. "Nothing is wrong" over a mailbox that has stopped syncing.
   *  · the `unreadable` arm — "this install's key does not open it". That sentence sends somebody
   *    to re-enter a password into whichever of the two servers the install happens to be pointing
   *    at, which is the exact failure mode the credential-state seam exists to end. Note the
   *    engine does not claim the row IS readable: it compares the servers before decrypting, so
   *    `foreign-host` takes precedence over `unreadable` rather than excluding it.
   */
  it("says the SERVER changed, not that the password needs re-entering", async () => {
    await mount({ ...SERVING, credentialState: "foreign-host" });
    const text = hostEl.textContent ?? "";

    expect(text).toContain("Server changed");
    expect(text).toContain("different mail server");
    /* It says what was NOT done with the password, SCOPED to the only server that claim is true
       about. Reaching this state by the ordinary route means the password was already proved
       against the server the credential records — a real login — so "not sent to either" was a
       false reassurance about credential handling and is asserted against below. */
    expect(text).toContain("has not been sent to the server it is set to");
    expect(text).not.toContain("not been sent to either");

    // Not the neighbour it would most plausibly be folded into…
    expect(text).not.toContain("Needs re-entering");
    expect(text).not.toContain("does not open it");
    // …and not the "newer engine, carry on" default, which is the one a missing case produces.
    expect(text).not.toContain("Nothing is wrong");
    expect(text).not.toContain("Unknown");
  });

  /**
   * THE GUARD THIS FILE EXISTS FOR. "Sign out" asks first, and then calls the command — not a
   * toast, not local state, not a reload.
   */
  it("asks once, then actually calls engine_logout", async () => {
    const shell = shellAnswering(({ command }) =>
      command === "engine_logout" ? { state: "not_configured", mode: null, missing: ["config.json"] } : undefined,
    );
    let landed: EngineStatus | null = null;
    await mount(SERVING, (s) => { landed = s; });

    await click("Sign out");
    /* The first press is the question, and nothing about signing out has been asked of the shell.
       Written as the exact list of what DID cross rather than as "nothing crossed", because this
       pane also reads two things about the install when it opens — the Ohbox bar
       (`DesktopScreeningWords`) and what model is configured (`DesktopAiSettings`) — on different
       rows and different routes, neither of which has any business being counted as a sign-out. A
       bare length check would have made this test go red for a pane that was behaving correctly,
       and the way out of that is to name the traffic, not to stop looking at it.

       TWO → ONE when the bar editor moved to Settings → Screener, where the rest of the screening
       controls are. What is left is the model read, which is this pane's own. The claim the list
       carries is unchanged and is the reason it is spelled out rather than counted: NOTHING here
       is a write, so the pane opening cannot change anything, and the sign-out below is still the
       only command that crosses. */
    expect(shell.asked.map((a) => `${String(a.payload?.method ?? a.command)} ${String(a.payload?.url ?? "")}`))
      .toEqual(["GET /local/ai"]);
    expect(hostEl.textContent).toContain("Sign out of this mailbox?");
    // …and it says what stays, which is the thing somebody is actually asking.
    expect(hostEl.textContent).toContain(`copy of your mail already on this ${MACHINE_WORD} stays`);
    expect(hostEl.textContent).toMatch(/Nothing is removed from your mail server/);

    await click("Sign out");
    expect(shell.asked.map((a) => a.command).filter((c) => c !== "engine_request"))
      .toEqual(["engine_logout"]);
    expect(landed).toEqual({ state: "not_configured", mode: null, missing: ["config.json"] });
  });

  it("keeps the mailbox when the question is declined", async () => {
    const shell = shellAnswering();
    await mount(SERVING);
    await click("Sign out");
    await click("Cancel");
    // Same shape as above: the pane's own settings read is named, so declining is still proved to
    // have asked the shell for nothing else.
    expect(shell.asked.map((a) => `${String(a.payload?.method ?? a.command)} ${String(a.payload?.url ?? "")}`))
      .toEqual(["GET /local/ai"]);
    expect(hostEl.textContent).not.toContain("Sign out of this mailbox?");
  });

  it("says what a door switch costs before it is taken", async () => {
    await mount(SERVING);
    expect(hostEl.textContent).toMatch(/frozen where it is rather than deleted/);
  });
});

/**
 * THE MENU'S COMMANDS — the second channel, and why it is a second one.
 *
 * A view id and a command id name different kinds of thing, and the two unions are closed
 * separately so a shell one version ahead cannot turn a command this bundle has never heard of
 * into a navigation to a route it does not have. The two channels therefore have to stay apart at
 * the wire as well as in the parser, which is what the first test here is about.
 */
describe("the menu's commands", () => {
  it("listens on its own event and delivers only the names it knows", async () => {
    const shell = shellAnswering();
    const ran: string[] = [];
    await onMenuCommand((command) => ran.push(command));

    const listen = shell.asked.find((a) => a.command === "plugin:event|listen")!;
    expect(listen.payload!.event).toBe(MENU_COMMAND_EVENT);
    expect(listen.payload!.target).toEqual({ kind: "Any" });

    shell.emit(MENU_COMMAND_EVENT, "compose");
    shell.emit(MENU_COMMAND_EVENT, "palette");
    // Not a command, whatever else it is. `ohbox` is a VIEW, and that is the case worth pinning:
    // the two channels carry different vocabularies and neither may accept the other's.
    shell.emit(MENU_COMMAND_EVENT, "ohbox");
    shell.emit(MENU_COMMAND_EVENT, "");
    shell.emit(MENU_COMMAND_EVENT, null);
    expect(ran).toEqual(["compose", "palette"]);
  });

  it("knows the five commands the bar offers and no more", () => {
    expect([...MENU_COMMANDS]).toEqual([
      "compose", "settings", "search", "palette", "shortcuts",
    ]);
    // Both payload shapes the runtime delivers, read directly rather than through the envelope.
    expect(commandOfMenuPayload("settings")).toBe("settings");
    expect(commandOfMenuPayload({ payload: "settings" })).toBe("settings");
    expect(commandOfMenuPayload({ payload: "nope" })).toBeNull();
    for (const view of MENU_VIEWS) expect(commandOfMenuPayload(view)).toBeNull();
    for (const command of MENU_COMMANDS) expect(viewOfMenuPayload(command)).toBeNull();
  });

  it("is silent when there is no shell to listen to", async () => {
    await expect(onMenuCommand(() => undefined)).resolves.toBeUndefined();
  });
});

/**
 * ═══ THE SIGN-IN COMMITMENT GOING OUT, AND THE HANDOFF CODE COMING BACK ═════════════════════
 *
 * Signing a hosted install in used to end with somebody reading a code off a browser page and
 * retyping it. It now ends with a press in the browser, and two things cross this boundary for
 * that to be safe:
 *
 *  · OUT — a 43-character commitment the mail engine invented, passed BESIDE a place key. The
 *    window still names no address: the shell owns the scheme, the host, the path and the
 *    parameter's spelling, and refuses a value that is not challenge-shaped rather than opening
 *    the page without it.
 *  · IN — the handoff code a scheme activation carried, on its own event, which the window sends
 *    down the same bridge the retyped code has always gone down. The shell claims nothing.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop `challenge` from `openWeb`'s payload           → the first case goes red, and that is the
 *    one that matters most: the page would mint an UNBOUND code while the engine went on holding a
 *    verifier, and every party would believe the binding was on;
 *  · send `{ key, challenge: undefined }` unconditionally → the second case goes red;
 *  · accept an empty or non-string payload as a code      → the refusal case goes red;
 *  · register a listener per call instead of swapping the handler → the "one listener" case goes
 *    red, which is the shape that answers one activation from several stale mounts at once.
 */
describe("the browser handoff, at the window's edge", () => {
  /** Challenge-shaped: 43 characters of base64url, which is what a SHA-256 digest encodes to. */
  const CHALLENGE = "0123456789abcdefghijklmnopqrstuvwxyzABCDEF_";

  it("passes the commitment beside the place, never an address", async () => {
    const shell = shellAnswering();
    expect(CHALLENGE).toHaveLength(43);
    await openWeb("link-desktop", CHALLENGE);
    expect(shell.asked).toEqual([
      { command: "open_link", payload: { key: "link-desktop", challenge: CHALLENGE } },
    ]);
  });

  it("omits the field entirely when there is no commitment to pass", async () => {
    const shell = shellAnswering();
    await openWeb("link-desktop");
    await openWeb("account");
    /* Absent, not `undefined`. The shell's `Option<String>` and "no such parameter" are the same
       fact, and a caller that always sent the key would make the one page that takes one look like
       every page — which is what `desktop-mailboxes.test.ts` also pins from the other side. */
    expect(shell.asked).toEqual([
      { command: "open_link", payload: { key: "link-desktop" } },
      { command: "open_link", payload: { key: "account" } },
    ]);
  });

  it("reads a code out of both payload shapes and refuses everything that is not one", () => {
    expect(codeOfLinkPayload("abc123")).toBe("abc123");
    expect(codeOfLinkPayload({ payload: "abc123" })).toBe("abc123");
    // Trimmed rather than refused: a value the runtime wrapped in whitespace is still the code.
    expect(codeOfLinkPayload("  abc123  ")).toBe("abc123");
    for (const nothing of ["", "   ", null, undefined, 3, {}, { payload: 3 }, { payload: "" }]) {
      expect(codeOfLinkPayload(nothing), String(JSON.stringify(nothing))).toBeNull();
    }
  });

  /**
   * ONE SHELL-SIDE LISTENER FOR THE LIFE OF THE WINDOW, and the latest handler wins.
   *
   * The sign-in screen mounts every time somebody picks the hosted door, and there is no way to
   * take a listener off — that would cost `core:event:allow-unlisten`, a SECOND core permission
   * this window is deliberately not granted. So a registration per mount would stack listeners in
   * the shell, and one activation would be answered by every stale mount at once, each holding an
   * old mount's props.
   */
  it("keeps one listener and swaps the handler behind it", async () => {
    vi.resetModules();
    const native = await import("../src/native.js");
    const shell = shellAnswering();

    const first: string[] = [];
    const second: string[] = [];
    await native.onLinkCode((c) => first.push(c));
    const live = (c: string): void => { second.push(c); };
    await native.onLinkCode(live);

    const listens = shell.asked.filter((a) => a.command === "plugin:event|listen");
    expect(listens, "a second registration reached the shell").toHaveLength(1);
    expect(listens[0]!.payload!.event).toBe(native.LINK_CODE_EVENT);
    expect(listens[0]!.payload!.target).toEqual({ kind: "Any" });

    shell.emit(native.LINK_CODE_EVENT, "code-1");
    expect(first, "a superseded handler still answered").toEqual([]);
    expect(second).toEqual(["code-1"]);

    // Clearing a handler that is NOT the live one changes nothing — the screen that registered it
    // is long gone, and taking the live screen off the air would be the bug.
    native.offLinkCode((c: string) => first.push(c));
    shell.emit(native.LINK_CODE_EVENT, "code-2");
    expect(second).toEqual(["code-1", "code-2"]);

    // Clearing the live one stops answering, and the shell is untouched either way.
    native.offLinkCode(live);
    shell.emit(native.LINK_CODE_EVENT, "code-3");
    expect(second).toEqual(["code-1", "code-2"]);
    expect(shell.asked.filter((a) => a.command === "plugin:event|listen")).toHaveLength(1);
  });

  it("delivers nothing for a payload that is not a code", async () => {
    vi.resetModules();
    const native = await import("../src/native.js");
    const shell = shellAnswering();
    const got: string[] = [];
    await native.onLinkCode((c) => got.push(c));

    shell.emit(native.LINK_CODE_EVENT, "");
    shell.emit(native.LINK_CODE_EVENT, null);
    shell.emit(native.LINK_CODE_EVENT, 7);
    expect(got).toEqual([]);
  });

  it("is silent when there is no shell", async () => {
    vi.resetModules();
    const native = await import("../src/native.js");
    await expect(native.onLinkCode(() => undefined)).resolves.toBeUndefined();
    await expect(native.openWeb("link-desktop", CHALLENGE)).resolves.toBeUndefined();
    // The statically imported copy names the same channel as the freshly loaded one.
    expect(native.LINK_CODE_EVENT).toBe(LINK_CODE_EVENT);
  });
});
