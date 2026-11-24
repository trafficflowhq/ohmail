/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { ThemeProvider, ToastHost, useToast } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import german from "../../webapp/messages/de.json";
import { TextFromIntl } from "../../webapp/app/shell/LocaleContext";
import { useConsentState } from "@ohmail/app-logic/consent/consent-state";
import { useScreenerSuggestions } from "@ohmail/app-logic/screener/screener-suggest";
import { ScreenerOptInFixture, type ScreenerSuggest } from "../../../test/support/screener-opt-in.js";
import { accountDoorFor } from "../src/doors.js";
import {
  CONSENT_PATH, CONSENT_SETTINGS_PATH, consentOverBridge, consentOverBridgeStandalone,
} from "../src/local-consent.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DOORS, plantShell, type Pipe } from "./_doors-harness.js";

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
let localDoor: boolean;
let localOutcome: "advice" | "empty";
let waitForLocalAnswer: Promise<void> | undefined;
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

      if (command === "engine_status") return DOORS[localDoor ? "D-l" : "D-m"](mailbox);

      /* The link-out command. Not a bridge request at all — it carries a KEY, and the shell's own
         table is what turns that into an address. */
      if (command !== "engine_request") return undefined;

      const url = p.url ?? "";
      if (url === "/health") return encode(200, JSON.stringify({ signedIn: true }));
      if (url === "/mailboxes") return encode(200, JSON.stringify({ items: [{
        ...mailbox, status: "connected", organizerRole: "organizer",
        initialImportCompletedAt: STORED_AT, organizeConsentedAt: STORED_AT,
      }] }));
      if (url.startsWith("/sync/snapshot")) return encode(200, JSON.stringify({
        asOfSeq: 3, changes: heldChanges, nextCursor: null, window: { days: 90, minRows: 500 },
      }));
      if (url.startsWith("/sync")) return encode(200, JSON.stringify({
        changes: { creates: heldChanges, updates: [], moves: [], deletes: [] },
        cursor: "3", hasMore: false, serverTime: new Date().toISOString(),
      }));
      if (url === "/account/screening") {
        return encode(200, JSON.stringify({
          ohboxPolicy: "people_only",
          ohboxBar: null,
          defaultBar: "Keep mail you act on in the Ohbox.",
        }));
      }
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
      if (url === "/local/ai") return encode(200, JSON.stringify({
        provider: "ollama", available: true, unavailableReason: null, contentGoesTo: "this_machine",
      }));
      if (url === "/screener" || url.startsWith("/screener?")) return encode(200, JSON.stringify({
        items: heldChanges.map(({ entity }) => ({
          messageId: entity.id, sender: entity.from, receivedAt: entity.date,
          subject: entity.subject, snippet: entity.snippet, mailboxId: entity.mailboxId,
        })),
        total: heldChanges.length, nextCursor: null, inFlight: [],
      }));
      if (url === "/screener/suggest") {
        if (localDoor) {
          await waitForLocalAnswer;
          return encode(200, JSON.stringify({
            suggestions: localOutcome === "empty" ? [] : heldChanges.map(({ entity }) => ({
              sender: entity.from.address, decision: "yes", confidence: 0.9, rationale: "Fixture suggestion",
            })),
            skipped: [],
          }));
        }
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
 * The paid account control's bridge contract.
 *
 * The two hooks and the one component, joined exactly as the shell joins them: the flag is read
 * and written through `useConsentState`, the quote comes from `useScreenerSuggestions`, and the
 * row is handed both. Mounting the whole shell would take an engine, a mirror and a router to
 * observe one settings row — and the thing under test is the pair of wires, which is right here.
 *
 * The fixture probes the consent model with a standalone transport or with no transport.
 * The paid account controls below are pressed through the registered desktop Settings pane.
 */
function OptInHarness({ transport, standaloneDoor = false }: {
  transport: boolean; standaloneDoor?: boolean;
}) {
  const toast = useToast();
  const t = useTranslations("screener");
  const consent = useConsentState(
    true,
    null,
    transport ? (standaloneDoor ? consentOverBridgeStandalone : consentOverBridge) : "none",
  );
  const suggestions = useScreenerSuggestions({
    text: { screener: t as never, aiRefusal: useTranslations("aiRefusal") as never },
    active: false,
    autoSuggest: consent.autoSuggest,
    toast,
    wire: transport ? cloudSuggestWire : "none",
  });
  const autoOptIn = suggestions.autoOptIn(["a@example.com", "b@example.com", "c@example.com"]);
  const { quote } = autoOptIn;
  const suggest: ScreenerSuggest | null = autoOptIn.supported ? {
    on: consent.autoSuggest,
    phase: autoOptIn.phase,
    priced: quote !== null,
    open: autoOptIn.open,
    cancel: autoOptIn.cancel,
    set: consent.setAutoSuggest,
    said: {
      title: t("suggest.autoTitle"),
      state: consent.autoSuggestAt
        ? t("suggest.autoOn", { when: consent.autoSuggestAt })
        : t("suggest.autoOff"),
      what: t("suggest.autoWhat", { count: autoOptIn.batchSize }),
      cost: t("suggest.autoCost"),
      decides: t("suggest.autoDecides"),
      quote: quote ? t("suggest.price", { senders: quote.senders, credits: quote.credits }) : null,
      notice: autoOptIn.notice,
      turnOn: t("suggest.autoTurnOn"),
      cancel: t("suggest.cancel"),
      failed: t("suggest.autoFailed"),
    },
  } : null;
  return h(
    "div",
    null,
    h("span", { className: "probe-known" }, String(consent.known)),
    h("span", { className: "probe-standalone" }, String(consent.standalone)),
    h("span", { className: "probe-supported" }, String(autoOptIn.supported)),
    h(ScreenerOptInFixture, { suggest }),
  );
}

let el: HTMLDivElement;
let root: Root | undefined;
let pipe: Pipe | undefined;
const fetchFromWindow = vi.fn(async () => {
  throw new Error("the desktop window opened a socket — nothing here may reach the network");
});

async function mount(node: React.ReactElement, locale: "en" | "de" = "en"): Promise<void> {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? german : messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(TextFromIntl, { children: node }))),
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
  localDoor = false;
  localOutcome = "advice";
  waitForLocalAnswer = undefined;
  autoSuggestAt = null;
  quotedCredits = 3;
  declineWrite = false;
  engineAnswering();
  /* BOOBY TRAP — nothing on this path may reach the hosted client. This window's `connect-src`
     admits no address off this machine and the packaged bundle has no API client at all, so a fallback to it
     lands here rather than passing quietly. */
  fetchFromWindow.mockClear();
  vi.stubGlobal("fetch", fetchFromWindow);
});

async function unmount() {
  if (root) await act(async () => { root!.unmount(); });
  el?.remove();
  root = undefined;
}

afterEach(async () => {
  await unmount();
  pipe?.unplant();
  pipe = undefined;
  delete host.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  window.location.hash = "";
  localStorage.clear();
});

const mailbox = { id: "desktop-settings-fixture", address: ["settings", "example.invalid"].join("@") };

/** The registered window, with only the engine's answers and the native link-out supplied. */
async function mountBrowserSection(
  section: "account" | "security",
  status = DOORS["D-m"](mailbox),
) {
  window.location.hash = `#/settings/${section}`;
  pipe = plantShell(status, async (request) => {
    switch (new URL(request.url).pathname) {
      case "/health":
        return Response.json({ signedIn: true });
      case "/mailboxes":
        return Response.json({ items: [mailbox] });
      case "/sync/snapshot":
        return Response.json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
      case "/sync":
        return Response.json({
          changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
          serverTime: STORED_AT,
        });
      default:
        return Response.json({}, { status: 404 });
    }
  }, "fixture");
  const { invoke } = host.__TAURI_INTERNALS__!;
  const nativeOpen = vi.fn(async (_payload: Record<string, unknown> | undefined) => undefined);
  host.__TAURI_INTERNALS__!.invoke = (command, payload) =>
    command === "open_link" ? nativeOpen(payload) : invoke(command, payload);
  const { DesktopGate } = await import("../src/DesktopGate.js");
  await mount(h(DesktopGate));
  await within(el).findByRole("navigation", { name: "Places" });
  return nativeOpen;
}

const heldChanges = Array.from({ length: 3 }, (_, index) => {
  const id = `held-${index}`;
  const date = new Date().toISOString();
  return { type: "message", op: "create", seq: index + 1, id, updatedAt: date, entity: {
    id, accountId: "fixture-account", mailboxId: mailbox.id, threadId: null, messageIdHeader: null,
    from: { name: null, address: [id, "example.invalid"].join("@") }, to: [], cc: [], date,
    subject: id, snippet: id, folder: "ohmail/Screener", unread: true, hasAttachments: false,
    attachmentCount: 0, triage: null, labels: [], remoteContent: "none", updatedAt: date,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  } };
});

async function mountHostedOptIn() {
  window.location.hash = "#/settings/screener";
  const { DesktopGate } = await import("../src/DesktopGate.js");
  await mount(h(DesktopGate));
  await waitFor(() => expect(optInSwitch().disabled).toBe(false));
}

function optInSwitch() {
  const pane = within(el).getByRole("region", { name: messages.settings.screener });
  return within(pane).getByRole<HTMLButtonElement>("switch", { name: messages.screener.suggest.autoTitle });
}

async function approveQuote() {
  await click(optInSwitch());
  expect(wire()).not.toContain("POST /screener/suggest");
  expect(wire()).not.toContain(`PATCH ${CONSENT_SETTINGS_PATH}`);
  await click(button("Get a quote"));
}

describe("SET-P — the two surfaces offer the same panes", () => {
  it("the Screener pane on the desktop carries the three controls it used to be short of", async () => {
    await mountHostedOptIn();
    const pane = within(within(el).getByRole("region", { name: messages.settings.screener }));
    expect(await pane.findByRole("switch", { name: messages.desktopScreener.postureLabel })).toBeTruthy();
    expect(pane.getByRole("group", { name: messages.settings.dormancy.ariaLabel })).toBeTruthy();
    expect(pane.getByRole("switch", { name: messages.screener.suggest.autoTitle })).toBeTruthy();
    expect(pane.getByRole("switch", { name: messages.settings.autoUnsub.title })).toBeTruthy();
  });
});

describe("the hosted door's auto-suggest opt-in, over the bridge", () => {
  it("reads the account's consent row down the pipe and offers the row", async () => {
    await mountHostedOptIn();

    expect(wire(), "GET /consent never left — the shell is not reading the account's row")
      .toContain(`GET ${CONSENT_PATH}`);
    expect(optInSwitch().disabled).toBe(false);
    expect(within(el).getByRole("switch", { name: messages.settings.autoUnsub.title })).toBeTruthy();
    expect(el.textContent).toContain("Suggest for new senders automatically");
  });

  /**
   * THE STANDALONE DOOR HAS A CONSENT ROW TOO, and that is the fact the unsubscribe promise
   * hangs on. `consent.standalone` means "nothing to reach", not "no account": this door hands in
   * its own wire (`consentOverBridgeStandalone`, the same ten calls one capability short), so the
   * sheet may state the unsubscribe before a screen-out and Settings may offer the switch that
   * turns it off — which the engine on this machine now honours. Watched fail by handing the
   * harness no transport: `standalone` reads true and both halves withdraw.
   */
  it("the STANDALONE door is not `standalone` — it has a row to ask and to write", async () => {
    await mount(h(OptInHarness, { transport: true, standaloneDoor: true }));

    expect(wire(), "GET /consent never left the standalone door").toContain(`GET ${CONSENT_PATH}`);
    expect(text(".probe-known")).toBe("true");
    expect(text(".probe-standalone")).toBe("false");

    await unmount();
    await standaloneSuggestions();
    await unmount();
    await germanStandaloneSuggestions();
  });

  it("prices the batch against the ACCOUNT before it will take a yes", async () => {
    await mountHostedOptIn();
    await approveQuote();

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
    await mountHostedOptIn();
    await approveQuote();

    expect((button("Turn on") as HTMLButtonElement).disabled).toBe(true);
    // And nothing was written: an unknown cost cannot be consented to.
    expect(wire()).not.toContain(`PATCH ${CONSENT_SETTINGS_PATH}`);
  });

  it("writes the flag to the account and shows what the account STORED", async () => {
    await mountHostedOptIn();
    await approveQuote();
    await click(button("Turn on"));

    const write = asked.find((a) => a.url === CONSENT_SETTINGS_PATH);
    expect(write?.method.toUpperCase()).toBe("PATCH");
    /* ONE AXIS ONLY. The route tests presence with `in`, so a body carrying the other three
       fields would overwrite settings this control does not own with whatever it happened to
       hold — including the dormancy window and the remote-image opt-out. */
    expect(write?.body).toEqual({ autoSuggest: true });

    // The switch now reflects the account’s stored answer from the write.
    expect(optInSwitch().getAttribute("aria-checked")).toBe("true");
    expect(autoSuggestAt).toBe(STORED_AT);
    expect(asked.filter((a) => a.url === "/screener/suggest").map((a) => a.body?.dryRun)).toEqual([true]);
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
    await mountHostedOptIn();
    await approveQuote();
    await click(button("Turn on"));

    expect(asked.some((a) => a.url === CONSENT_SETTINGS_PATH), "the write never left").toBe(true);
    expect(autoSuggestAt, "the scripted account was supposed to decline").toBeNull();
    expect(optInSwitch().getAttribute("aria-checked"), "the row claims the account is authorised when it is not")
      .toBe("false");
  });

  it("turning it OFF writes straight through — no confirm in front of the brake", async () => {
    autoSuggestAt = STORED_AT;
    await mountHostedOptIn();
    expect(optInSwitch().getAttribute("aria-checked")).toBe("true");

    await click(optInSwitch());
    expect(optInSwitch().getAttribute("aria-checked")).toBe("false");
    expect(within(el).queryByRole("button", { name: "Get a quote" })).toBeNull();
    expect(asked.find((a) => a.url === CONSENT_SETTINGS_PATH)?.body).toEqual({ autoSuggest: false });
    // Nothing was priced: revoking an authorisation costs nothing and asks nothing.
    expect(wire()).not.toContain("POST /screener/suggest");
  });
});

async function standaloneSuggestions() {
  localDoor = true;
  window.location.hash = "#/screener";
  const { DesktopGate } = await import("../src/DesktopGate.js");
  await mount(h(DesktopGate));
  const suggest = await within(el).findByRole("button", { name: "Suggest for 3 senders" });
  expect(wire()).not.toContain("POST /screener/suggest");
  expect(within(el).queryByRole("button", { name: /^Apply 3/ })).toBeNull();

  await click(suggest);
  const requests = asked.filter((a) => a.method === "POST" && a.url === "/screener/suggest");
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]!.body ?? {})).toEqual(["senders"]);
  expect((requests[0]!.body!.senders as string[]).slice().sort())
    .toEqual(heldChanges.map(({ entity }) => entity.from.address).sort());
  expect(await within(el).findByRole("button", { name: /^Apply 3/ })).toBeTruthy();
  expect(fetchFromWindow).not.toHaveBeenCalled();
}

async function germanStandaloneSuggestions() {
  localDoor = true;
  localOutcome = "empty";
  let complete!: () => void;
  waitForLocalAnswer = new Promise<void>((resolve) => { complete = resolve; });
  window.location.hash = "#/screener";
  const { DesktopGate } = await import("../src/DesktopGate.js");
  await mount(h(DesktopGate), "de");
  const suggest = await within(el).findByRole("button", { name: "Für 3 Absender vorschlagen" });
  try {
    await click(suggest);
    expect(el.textContent).toContain("0 von 3 vorgeschlagen");
  } finally {
    await act(async () => { complete(); });
  }
  expect(await within(el).findByText("Für diese Absender gibt es keine neuen Vorschläge.")).toBeTruthy();
}

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

  it("the hosted door with a session", async () => {
    expect(accountDoorFor(status({}), "live")).toBe("cloud");
    const nativeOpen = await mountBrowserSection("account");
    expect(within(el).getByRole("button", { name: "Open in browser" })).toBeTruthy();
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  /**
   * AND THE SESSION IS THE ENGINE'S LIVE ANSWER, NOT THE LAUNCH FRAME'S.
   *
   * This rule used to read `status.credentialState`, which the shell copies out of the engine's
   * one-shot `ready` frame and never rewrites. On the cloud door a sign-in happens IN PLACE
   * against the running engine, so an install that started pre-auth reported `absent` for the life
   * of the process — and Subscription, Security, Account, the consent row and the spend wire were
   * all withheld from a window whose mail was arriving, until it was relaunched.
   */
  it("…on an install that signed in AFTER launch, where the frame still says otherwise", async () => {
    for (const credentialState of ["absent", "unreadable", "unknown", undefined] as const) {
      expect(
        accountDoorFor(status({ credentialState }), "live"),
        `a live session with credentialState=${String(credentialState)} lost the account panes`,
      ).toBe("cloud");
    }
    const nativeOpen = await mountBrowserSection("account", {
      ...DOORS["D-m"](mailbox), credentialState: "absent",
    });
    expect(within(el).getByRole("button", { name: "Open in browser" })).toBeTruthy();
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it("…and nothing else", async () => {
    expect(accountDoorFor(null, "live")).toBeNull();
    expect(accountDoorFor(status({ mode: "local" }), "live")).toBeNull();
    // Signed out, or not yet asked: every read would be refused, and a settings pane whose only
    // state is an error about something it cannot fix from inside itself is worse than no pane.
    expect(accountDoorFor(status({}), "out")).toBeNull();
    expect(accountDoorFor(status({}), "unknown")).toBeNull();
    const nativeOpen = await mountBrowserSection("account", DOORS["D-l"](mailbox));
    expect(within(el).queryByRole("button", { name: "Open in browser" })).toBeNull();
    expect(nativeOpen).not.toHaveBeenCalled();
  });
});

describe("the panes whose ceremony is a browser's — a door, not a form", () => {
  it("opens the place the shell knows by name, and passes no address", async () => {
    const nativeOpen = await mountBrowserSection("security");
    const pane = within(el).getByRole("region", { name: "Security" });

    expect(pane.textContent).toContain("Your second factor");
    // The password change is the Account door's: the web keeps it in Settings → Account.
    expect(pane.textContent).not.toMatch(/password/i);
    // The copy says where the button goes BEFORE it is pressed.
    expect(pane.textContent).toContain("open in your browser");

    expect(nativeOpen).not.toHaveBeenCalled();
    await click(within(pane).getByRole("button", { name: "Open in browser" }));
    const [opened] = nativeOpen.mock.calls;
    expect(opened, "the button did not reach the shell's link command").toBeTruthy();

    /* A KEY, NEVER A URL — the whole safety argument, and the claim the preview artifact rests
       on. If a URL could travel from this page, anything that ever got a string into it could
       open an arbitrary address in the user's real browser, signed in to everything. */
    expect(opened![0]).toEqual({ key: "security" });
    expect(JSON.stringify(opened![0])).not.toMatch(URLISH);
    expect(fetchFromWindow).not.toHaveBeenCalled();
  });

  it("says so plainly when the computer would not open one", async () => {
    const nativeOpen = await mountBrowserSection("account");
    nativeOpen.mockRejectedValueOnce(new Error("no browser"));
    expect(el.textContent).toContain("changing your password");
    await click(button("Open in browser"));
    await waitFor(() => expect(el.textContent).toContain("would not open a browser"));
    expect(nativeOpen.mock.calls).toEqual([[{ key: "account" }]]);
    expect(fetchFromWindow).not.toHaveBeenCalled();
  });
});
