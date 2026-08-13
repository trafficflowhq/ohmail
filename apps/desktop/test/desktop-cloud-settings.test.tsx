/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost, useToast } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { AutoSuggestRow } from "../../webapp/app/shell/AutoSuggestRow";
import { useConsentState } from "../../webapp/app/shell/consent-state";
import { useScreenerSuggestions } from "../../webapp/app/shell/screener-suggest";
import { accountDoorFor } from "../src/doors.js";
import { CONSENT_PATH, CONSENT_SETTINGS_PATH, consentOverBridge } from "../src/local-consent.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import { DesktopWebSection } from "../src/DesktopWebSection.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * ═══ THE ACCOUNT'S OWN SETTINGS, IN THE APP THAT IS MIRRORING IT ════════════════════════════
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * "Suggest for new senders automatically" is the one setting in this product that authorises
 * SPENDING without a press: while it is on, the account buys a suggestion for each new sender as
 * their mail arrives. It shipped in the browser and was absent here — on the hosted door, where
 * the install is mirroring the very account being charged. Somebody could turn it on in a tab and
 * then have no way to see it, price it or revoke it in the app.
 *
 * The cause was not the transport. `apiConfigured()` is false in every desktop build (the Cloud
 * client is aliased to a refusing stub), so the shared shell's `GET /consent` never ran, `known`
 * stayed false for the life of the process, and `autoOptIn.supported` — which is
 * `wire.configured()` — was false with it. Three more controls went the same way: the dormancy
 * dial, auto-unsubscribe, and the account's own choice of interface language.
 *
 * ── WHAT MUST BE TRUE ───────────────────────────────────────────────────────────────────────
 *
 *  1. THE ROW EXISTS on the hosted door and its wires reach the engine. This window cannot open a
 *     socket, so the proof is the requests that leave: `GET /consent`, `POST /screener/suggest`
 *     with `dryRun`, and `PATCH /consent/settings`, all addressed root-relative to the engine,
 *     which serves none of them locally and forwards each to the account with the bearer.
 *  2. NO PRICE, NO CONSENT. The confirm stays unpressable until the SERVER has quoted the batch —
 *     the whole reason the opt-in needs a suggest wire as well as a consent wire.
 *  3. THE SWITCH SHOWS WHAT WAS STORED. The flag is set from the write's echo, never from the
 *     click, so a refused write cannot leave the app believing the account is authorised.
 *  4. THE STANDALONE DOOR GETS NONE OF IT, structurally. No transport ⇒ nothing is asked, `known`
 *     stays false and `standalone` stays true — there is no account row to hold any of this.
 *  5. THE LINK-OUTS NAME A PLACE, NEVER A URL, and reach the shell's own table.
 *  6. NOTHING REACHES THE CLOUD CLIENT. `fetch` is booby-trapped: a control that fell back to the
 *     hosted client would throw rather than pass quietly.
 *
 * ── MUTATION WATCH ──────────────────────────────────────────────────────────────────────────
 *
 *  · make `useConsentState` ignore its `transport` (back to `apiConfigured()` alone) → the row's
 *    read case and the standalone case invert;
 *  · have `consentOverBridge.setAutoSuggest` return the ARGUMENT instead of the account's echo →
 *    the disagreement case goes red. **It did not, at first, and the reason is worth keeping:**
 *    the scripted account stored whatever it was told, so the echo and the argument were the same
 *    value and an argument-echoing client satisfied every assertion. `declineWrite` is what makes
 *    them differ — a guard for an echo needs a server that answers something else.
 *  · remove the `!priced` clause from the confirm's `disabled` → the no-price case goes red;
 *  · pass a URL rather than a key to `openWeb` → the link case goes red.
 *
 * All five were run against the implementation and restored.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: (cb: unknown) => number };
};

/** One answer, framed exactly as the shell frames one for the bridge. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked { command: string; method: string; url: string; body: Record<string, unknown> | null; payload: unknown }
let asked: Asked[];
/** The account's stored consent row, as the hosted API answers it through the engine's forward. */
let autoSuggestAt: string | null;
/** What the scripted account quotes for a dry run — `null` stands for a server that quoted none. */
let quotedCredits: number | null;
/** The account ACCEPTS the request and leaves the row as it was — a policy refusal, answered 200. */
let declineWrite: boolean;

const STORED_AT = "2026-08-13T09:00:00.000Z";

/** Anything that looks like an address. Nothing this page hands the shell may match it. */
const URLISH = /https?:\/\//;

function engineAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      const p = (payload ?? {}) as { method?: string; url?: string; body?: number[]; key?: string };
      const raw = p.body && p.body.length > 0 ? new TextDecoder().decode(Uint8Array.from(p.body)) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      asked.push({ command, method: p.method ?? "GET", url: p.url ?? "", body, payload });

      /* The link-out command. Not a bridge request at all — it carries a KEY, and the shell's own
         table is what turns that into an address. */
      if (command !== "engine_request") return undefined;

      const url = p.url ?? "";
      if (url === CONSENT_PATH) {
        return encode(200, JSON.stringify({
          seedConfirmedAt: STORED_AT,
          screeningResetAt: null,
          dormancyDays: 90,
          screeningBaselineAt: null,
          autoSuggestAt,
          blockRemoteImagesAt: null,
          blockAutoUnsubscribeAt: null,
          locale: null,
          counts: { decidedSenders: 4, activeUndecidedSenders: 3, dormantUndecidedSenders: 0 },
        }));
      }
      if (url === CONSENT_SETTINGS_PATH) {
        /* THE ROUTE ANSWERS WHAT IS STORED, NEVER WHAT WAS ASKED FOR, and `declineWrite` is what
           makes those two DIFFERENT — the only configuration in which the echo discipline can be
           observed at all. A server that always stores what it is told is satisfied identically by
           a client that echoes the argument, which is why a first version of this file went green
           against exactly that mutation. */
        if (body && "autoSuggest" in body && !declineWrite) {
          autoSuggestAt = body.autoSuggest === true ? STORED_AT : null;
        }
        return encode(200, JSON.stringify({ autoSuggestAt }));
      }
      if (url === "/screener/suggest") {
        return encode(200, JSON.stringify({
          dryRun: true,
          requested: 3,
          quoted: 3,
          ...(quotedCredits === null ? {} : { quotedCredits }),
          charged: 0,
          suggestions: [],
          skipped: [],
        }));
      }
      return encode(404, JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    },
  };
}

/** The requests that left, as `METHOD path` — the only evidence a window with no socket has. */
const wire = (): string[] =>
  asked.filter((a) => a.command !== "open_link").map((a) => `${a.method.toUpperCase()} ${a.url}`);

/**
 * `AppShell`'s own wiring of this row, and nothing else of it.
 *
 * The two hooks and the one component, joined exactly as the shell joins them: the flag is read
 * and written through `useConsentState`, the quote comes from `useScreenerSuggestions`, and the
 * row is handed both. Mounting the whole shell would take an engine, a mirror and a router to
 * observe one settings row — and the thing under test is the pair of wires, which is right here.
 *
 * `active: false` on the suggestions hook is what the shell passes while the user is in Settings
 * rather than the Screener (`route.view === "screener"`), so this is the real configuration.
 */
function OptInHarness({ transport }: { transport: boolean }) {
  const toast = useToast();
  const consent = useConsentState(true, transport ? consentOverBridge : undefined);
  const suggestions = useScreenerSuggestions({
    active: false,
    autoSuggest: consent.autoSuggest,
    toast,
    ...(transport ? { wire: cloudSuggestWire } : {}),
  });
  const autoOptIn = suggestions.autoOptIn(["a@example.com", "b@example.com", "c@example.com"]);
  return h(
    "div",
    null,
    h("span", { className: "probe-known" }, String(consent.known)),
    h("span", { className: "probe-standalone" }, String(consent.standalone)),
    h("span", { className: "probe-supported" }, String(autoOptIn.supported)),
    autoOptIn.supported
      ? h(AutoSuggestRow, {
          on: consent.autoSuggest,
          since: consent.autoSuggestAt,
          control: autoOptIn,
          setAutoSuggest: consent.setAutoSuggest,
        })
      : null,
  );
}

let el: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactElement): Promise<void> {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
  });
  await settle();
}

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const click = async (node: Element): Promise<void> => {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};

const text = (sel: string): string => el.querySelector(sel)?.textContent?.trim() ?? "";
const button = (label: string): Element => {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled "${label}" — on screen: ${el.textContent}`);
  return found;
};

beforeEach(() => {
  asked = [];
  autoSuggestAt = null;
  quotedCredits = 3;
  declineWrite = false;
  engineAnswering();
  /* BOOBY TRAP — nothing on this path may reach the hosted client. This window has
     `connect-src 'none'` and the packaged bundle has no API client at all, so a fallback to it
     lands here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the desktop window opened a socket — nothing here may reach the network");
  }) as typeof fetch;
});

describe("the hosted door's auto-suggest opt-in, over the bridge", () => {
  it("reads the account's consent row down the pipe and offers the row", async () => {
    await mount(h(OptInHarness, { transport: true }));

    expect(wire(), "GET /consent never left — the shell is not reading the account's row")
      .toContain(`GET ${CONSENT_PATH}`);
    expect(text(".probe-known")).toBe("true");
    // The account IS reachable, so this install is not standalone — the fact
    // `autoUnsubscribeDiscloses` reads before it promises an unsubscribe on screen-out.
    expect(text(".probe-standalone")).toBe("false");
    expect(text(".probe-supported")).toBe("true");
    expect(el.textContent).toContain("Suggest for new senders automatically");
  });

  it("prices the batch against the ACCOUNT before it will take a yes", async () => {
    await mount(h(OptInHarness, { transport: true }));
    await click(el.querySelector('[role="switch"], .sw')!);

    expect(wire(), "the quote did not go to the account — the confirm has no price to show")
      .toContain("POST /screener/suggest");
    const dryRun = asked.find((a) => a.url === "/screener/suggest");
    expect(dryRun?.body, "a dry run must not charge").toMatchObject({ dryRun: true });
    // The server's figure, not one computed here: the sentence names both halves of its quote.
    expect(el.textContent).toContain("3");
    expect((button("Turn on") as HTMLButtonElement).disabled).toBe(false);
  });

  it("NO PRICE, NO CONSENT — a server that quotes nothing leaves the confirm unpressable", async () => {
    quotedCredits = null;
    await mount(h(OptInHarness, { transport: true }));
    await click(el.querySelector('[role="switch"], .sw')!);

    expect((button("Turn on") as HTMLButtonElement).disabled).toBe(true);
    // And nothing was written: an unknown cost cannot be consented to.
    expect(wire()).not.toContain(`PATCH ${CONSENT_SETTINGS_PATH}`);
  });

  it("writes the flag to the account and shows what the account STORED", async () => {
    await mount(h(OptInHarness, { transport: true }));
    await click(el.querySelector('[role="switch"], .sw')!);
    await click(button("Turn on"));

    const write = asked.find((a) => a.url === CONSENT_SETTINGS_PATH);
    expect(write?.method.toUpperCase()).toBe("PATCH");
    /* ONE AXIS ONLY. The route tests presence with `in`, so a body carrying the other three
       fields would overwrite settings this control does not own with whatever it happened to
       hold — including the dormancy window and the remote-image opt-out. */
    expect(write?.body).toEqual({ autoSuggest: true });

    // The switch now reads the account's own timestamp, taken from the write's echo.
    expect(el.textContent).toContain("On since");
    expect(autoSuggestAt).toBe(STORED_AT);
  });

  it("…and shows the ACCOUNT's answer even when it disagrees with the click", async () => {
    /**
     * THE DIRECTION THAT COSTS MONEY. The account accepts the request and leaves the row off —
     * a plan whose entitlement forbids it, a policy the client cannot see. Answered `200`, so
     * there is no error for the row to catch and the ONLY thing separating "authorised" from
     * "not" is whether the client reads the echo or the argument it sent.
     *
     * A client that trusted its own argument would draw the switch ON, tell the person their
     * account is suggesting automatically, and be wrong about what is being spent. This case
     * exists because a weaker version of it — a server that always stores what it is told —
     * passed against exactly that implementation.
     */
    declineWrite = true;
    await mount(h(OptInHarness, { transport: true }));
    await click(el.querySelector('[role="switch"], .sw')!);
    await click(button("Turn on"));

    expect(asked.some((a) => a.url === CONSENT_SETTINGS_PATH), "the write never left").toBe(true);
    expect(autoSuggestAt, "the scripted account was supposed to decline").toBeNull();
    expect(el.textContent, "the row claims the account is authorised when it is not")
      .not.toContain("On since");
    expect(el.textContent).toContain("New senders wait in the Screener");
  });

  it("turning it OFF writes straight through — no confirm in front of the brake", async () => {
    autoSuggestAt = STORED_AT;
    await mount(h(OptInHarness, { transport: true }));
    expect(el.textContent).toContain("On since");

    await click(el.querySelector('[role="switch"], .sw')!);
    expect(asked.find((a) => a.url === CONSENT_SETTINGS_PATH)?.body).toEqual({ autoSuggest: false });
    // Nothing was priced: revoking an authorisation costs nothing and asks nothing.
    expect(wire()).not.toContain("POST /screener/suggest");
  });
});

describe("the standalone door gets none of it, structurally", () => {
  it("asks nothing, knows nothing, and offers no row", async () => {
    await mount(h(OptInHarness, { transport: false }));

    expect(wire(), "a standalone install asked an account it does not have").toEqual([]);
    expect(text(".probe-known")).toBe("false");
    expect(text(".probe-standalone")).toBe("true");
    expect(text(".probe-supported")).toBe("false");
    expect(el.textContent).not.toContain("Suggest for new senders automatically");
  });
});

describe("accountDoorFor — which installs have an account to administer", () => {
  const status = (over: Partial<EngineStatus>): EngineStatus =>
    ({ state: "serving", mode: "cloud", credentialState: "ready", ...over }) as EngineStatus;

  it("the hosted door with a session", () => {
    expect(accountDoorFor(status({}))).toBe("cloud");
  });

  it("…and nothing else", () => {
    expect(accountDoorFor(null)).toBeNull();
    expect(accountDoorFor(status({ mode: "local" }))).toBeNull();
    // Signed out, or unreadable: every read would be refused, and a settings pane whose only
    // state is an error about something it cannot fix from inside itself is worse than no pane.
    expect(accountDoorFor(status({ credentialState: "absent" }))).toBeNull();
    expect(accountDoorFor(status({ credentialState: "unreadable" }))).toBeNull();
  });
});

describe("the panes whose ceremony is a browser's — a door, not a form", () => {
  it("opens the place the shell knows by name, and passes no address", async () => {
    await mount(h(DesktopWebSection, {
      place: "security",
      copy: { title: "webSecurityTitle", why: "webSecurityWhy" },
    }));

    expect(el.textContent).toContain("Your password and second factor");
    // The copy says where the button goes BEFORE it is pressed.
    expect(el.textContent).toContain("open in your browser");

    await click(button("Open in browser"));
    const opened = asked.find((a) => a.command === "open_link");
    expect(opened, "the button did not reach the shell's link command").toBeTruthy();

    /* A KEY, NEVER A URL — the whole safety argument, and the claim the preview artifact rests
       on. If a URL could travel from this page, anything that ever got a string into it could
       open an arbitrary address in the user's real browser, signed in to everything. */
    expect(opened!.payload).toEqual({ key: "security" });
    expect(JSON.stringify(opened!.payload)).not.toMatch(URLISH);
  });

  it("says so plainly when the computer would not open one", async () => {
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command) => {
        if (command === "open_link") throw new Error("no browser");
        return encode(404, "{}");
      },
    };
    await mount(h(DesktopWebSection, {
      place: "account",
      copy: { title: "webAccountTitle", why: "webAccountWhy", note: "webAccountNote" },
    }));
    await click(button("Open in browser"));
    expect(el.textContent).toContain("would not open a browser");
  });
});
