/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";

/**
 * A PAIRING STARTED FROM A DOOR IS PROVISIONAL UNTIL THE OTHER COMPUTER ACCEPTS. Settings →
 * Switch → Another computer on a desktop that already reads mail: a refusal, a timeout or an
 * abandoned pairing hands back the door it replaced, and only an acceptance retires it. A fake
 * shell with the Rust shell's rules — a provisional switch keeps the replaced door until it is
 * committed or restored — fake timers, and the door on disk read after every answer.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const ORIGIN = "https://192.168.1.24:8443";
const LINK = `${ORIGIN}/pair#k1.${"a".repeat(43)}.tok_xyz`;

type Door = Record<string, unknown>;
const LOCAL_DOOR: Door = {
  mode: "local", imapHost: "imap.example.test", imapUser: "reader", imapPort: 993, imapSecure: true,
  address: "reader@example.test",
};
const HOSTED_DOOR: Door = { mode: "cloud", cloudUrl: "https://api.ohmail.app", address: "reader@example.test" };

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}
const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
/** `GET /consent` as the engine answers it for a mailbox that never decided anything
 * (`packages/api/src/routes/consent.ts`: the default window, every stamp null, empty maps). */
const CONSENT = JSON.stringify({
  seedConfirmedAt: null, screeningResetAt: null, dormancyDays: 60, screeningBaselineAt: null,
  autoSuggestAt: null, blockRemoteImagesAt: null, loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null,
  foldersEnabledAt: null, folderMailboxesOff: {}, signatures: {}, signaturesHtml: {}, signatureSources: {},
  locale: null, themeFace: null, resurfaceTime: null, onboardingCompletedAt: null, screeningScope: "window",
  counts: { activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
});
/** The local door's model settings, as `/local/ai` answers them with nothing configured. */
const NO_MODEL = JSON.stringify({
  provider: "none", available: false, unavailableReason: "not_configured", contentGoesTo: "nowhere",
  settings: {
    provider: "none",
    anthropic: { classifyModel: "claude-haiku-4-5", draftModel: "claude-sonnet-5", hasKey: false },
    openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: false },
    ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "", draftModel: "" },
  },
  probe: null, canStoreKey: true,
});

const ANSWERS = {
  paired: { status: 200, body: { status: "paired", mailboxId: "mbx-paired" } },
  invalid_pair_code: { status: 401, body: { error: { code: "invalid_pair_code", message: "that pairing code was not accepted" } } },
  host_refused: { status: 502, body: { error: { code: "host_refused", message: "that computer answered HTTP 403 to the code" } } },
  pair_account_mismatch: { status: 409, body: { error: { code: "pair_account_mismatch", message: "a different account" } } },
} as const;
type Answer = keyof typeof ANSWERS | "never";

/**
 * The Rust shell's rules over a fake engine. A configure writes the door and restarts the engine;
 * `provisional: true` over a door keeps that door as the REPLACED one until `engine_switch_commit`
 * drops it or `engine_switch_restore` puts it back; a sign-out is refused while one is kept.
 * `probeOnLocal: false` is the real local engine, which serves no `/cloud/probe` (measured: 404).
 */
function fakeShell(opts: {
  door: Door; answer: Answer; redeemMs?: number; pairStartMs?: number; probeOnLocal?: boolean;
  /** The shell refuses this many restores first (a gesture in flight, a directory held). */
  restoreRefusals?: number;
}) {
  let restoreRefusals = opts.restoreRefusals ?? 0;
  let door: Door | null = opts.door;
  let replaced: Door | null = null;
  let startedAt = -Infinity;
  let paired = false;
  const log: string[] = [];
  /** Every request that WRITES, with the door it reached: a restored door must be sent none. */
  const writes: string[] = [];
  const isPairing = (d: Door): boolean => d.flavor === "desktop-host";
  const startMs = (): number => (door && isPairing(door) ? opts.pairStartMs ?? 800 : 400);
  const mailboxOf = (d: Door): string =>
    d.mode === "local" ? "mbx-local" : isPairing(d) ? (paired ? "mbx-paired" : "") : "mbx-hosted";
  const status = (): Record<string, unknown> => {
    if (!door) return { state: "not_configured", mode: null };
    const shape = {
      mode: door.mode, flavor: door.flavor, cloudUrl: door.cloudUrl, address: door.address,
      ...(replaced ? { switchPending: true } : {}),
    };
    if (Date.now() - startedAt < startMs()) return { state: "starting", attempt: 1, of: 4, ...shape };
    const id = mailboxOf(door);
    return { state: "serving", baseUrl: "http://sidecar", mailboxId: id, credentialState: id ? "ready" : "absent", ...shape };
  };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status();
      if (command === "engine_configure") {
        const next = payload!.config as Door;
        const provisional = payload!.provisional === true;
        if (provisional && door) replaced ??= door;
        if (!provisional) replaced = null;
        door = next;
        startedAt = Date.now();
        paired = false;
        log.push(`configure ${String(next.flavor ?? next.mode)}${provisional ? " provisional" : ""}`);
        return status();
      }
      if (command === "engine_switch_commit") {
        log.push(`commit${replaced ? "" : " (nothing kept)"}`);
        replaced = null;
        return status();
      }
      if (command === "engine_switch_restore") {
        if (replaced && restoreRefusals > 0) {
          restoreRefusals -= 1;
          log.push("restore refused");
          throw new Error("the replaced door could not be put back yet");
        }
        log.push(`restore${replaced ? "" : " (nothing kept)"}`);
        if (replaced) {
          door = replaced;
          replaced = null;
          startedAt = Date.now();
          paired = false;
        }
        return status();
      }
      if (command === "engine_logout") {
        if (replaced) throw new Error("a pairing is still being set up");
        log.push("logout");
        door = null;
        return status();
      }
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        if (status().state !== "serving") throw new Error("the engine is not serving");
        const url = String(payload?.url ?? "");
        const method = String(payload?.method ?? "GET").toUpperCase();
        if (method !== "GET" && url !== "/cloud/probe" && url !== "/cloud/pair-redeem") {
          writes.push(`${method} ${url} on ${String(door!.flavor ?? door!.mode)}`);
        }
        if (url === "/health") {
          return encode(200, JSON.stringify({ signedIn: door!.mode === "cloud" && (!isPairing(door!) || paired), sessionExpired: false }));
        }
        if (url === "/cloud/probe") {
          if (door!.mode === "local" && opts.probeOnLocal === false) {
            return encode(404, JSON.stringify({ error: { code: "not_found", message: "not found" } }));
          }
          return encode(200, JSON.stringify({ ok: true, flavor: "desktop-host", base: ORIGIN }));
        }
        if (url === "/cloud/pair-redeem") {
          log.push("redeem asked");
          if (opts.answer === "never") return new Promise(() => undefined);
          await new Promise((r) => setTimeout(r, opts.redeemMs ?? 300));
          const a = ANSWERS[opts.answer];
          if (opts.answer === "paired") paired = true;
          log.push(`redeem ${a.status}`);
          return encode(a.status, JSON.stringify(a.body));
        }
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        if (url === "/local/ai") return encode(200, NO_MODEL);
        // The window reads consent on every door; a page without a window is a failed read it reports.
        if (url === "/consent") return encode(200, CONSENT);
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return {
    log,
    writes,
    door: (): Door | null => door,
    replaced: (): Door | null => replaced,
  };
}

let root: Root | null = null;
let el: HTMLElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const text = (): string => el?.textContent ?? "";
async function until(what: string, test: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; waited <= ms; waited += 100) {
    if (test()) return;
    await advance(100);
  }
  throw new Error(`timed out waiting for ${what}; the window said: ${text().slice(0, 300)}`);
}
const buttons = (label: string): HTMLButtonElement[] =>
  [...el!.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
async function press(label: string): Promise<void> {
  const found = buttons(label);
  if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
  await act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

/** The false state the row names: this install drawn as a pairing that never finished. */
const readsNotPaired = (): boolean =>
  text().includes(DOOR_COPY.credHostOutValue) || buttons(DOOR_COPY.gatePairAgain).length > 0;

async function mount(): Promise<void> {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <IntlProvider locale="en" messages={messages as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme"><ToastHost><DesktopGate /></ToastHost></ThemeProvider>
      </IntlProvider>,
    );
  });
}

/** Settings → Switch… → Another computer → the link → Check the link. Answers whether Pair came up. */
async function openPairingFromSettings(): Promise<boolean> {
  window.location.hash = "#/settings/desktop";
  await mount();
  await until("the Settings pane of the working door", () => buttons(DOOR_COPY.installSwitchAction).length === 1, 15_000);
  await press(DOOR_COPY.installSwitchAction);
  await until("the door grid", () => el!.querySelectorAll(".door-tile").length > 0, 5_000);
  const tile = [...el!.querySelectorAll(".door-tile")]
    .find((b) => b.querySelector(".door-name")?.textContent === DOOR_COPY.doorHostName)!;
  await act(async () => { tile.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const field = el!.querySelector<HTMLInputElement>("#host-link")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(field, LINK); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await press(DOOR_COPY.hostCheck);
  for (let i = 0; i < 20 && buttons(DOOR_COPY.hostPair).length === 0 && !el!.querySelector(".join-error"); i += 1) await advance(100);
  return buttons(DOOR_COPY.hostPair).length === 1;
}

/** After the pairing card is left: the pane of the door the window now stands on. */
async function leaveTheCard(): Promise<void> {
  await press(DOOR_COPY.cancel);
  for (let i = 0; i < 30; i += 1) await advance(500);
}

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = "";
  localStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  el?.remove();
  root = null;
  el = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  window.location.hash = "";
  localStorage.clear();
});

describe("a pairing the other computer refuses hands back the door it replaced", () => {
  it.each([
    ["the local door", "invalid_pair_code", LOCAL_DOOR],
    ["the local door", "host_refused", LOCAL_DOOR],
    ["the ohmail Cloud door", "invalid_pair_code", HOSTED_DOOR],
  ] as const)("from %s, answered %s", async (_name, answer, start) => {
    const shell = fakeShell({ door: start, answer });
    expect(await openPairingFromSettings(), "Check the link never offered Pair").toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the refusal on the card", () => el!.querySelector(".join-error") !== null, 20_000);
    const onDisk = shell.door();
    await leaveTheCard();
    console.info(`REFUSED from ${String(start.mode)} (${answer}): door on disk ${String(onDisk?.flavor ?? onDisk?.mode)}, `
      + `window ${readsNotPaired() ? "Not paired" : "the door it had"} || ${shell.log.join(", ")}`);

    expect(shell.log, "the pairing was not started as a provisional switch").toContain("configure desktop-host provisional");
    expect(onDisk, "after the refusal the door on disk is the paired one").toEqual(start);
    expect(shell.replaced(), "a restored switch still keeps a replaced door").toBeNull();
    expect(readsNotPaired(), `the window reads Not paired over the door it had: ${text().slice(0, 200)}`).toBe(false);
    expect(buttons(DOOR_COPY.installSwitchAction), "the window is not back on its own Settings pane").toHaveLength(1);
    expect(shell.log.filter((l) => l === "logout"), "the refusal signed the replaced door out").toEqual([]);
    /* THE LEASE IS THE ENGINE'S TO READ: the restored door is sent no write — no organize press,
       no consent — and no guided setup is opened over it, which is where a press would come from. */
    expect(shell.writes, "the window wrote to the restored door").toEqual([]);
    expect(window.location.hash, "the restore opened the guided setup").not.toContain("first-run");
  });

  it("a pairing whose engine outlives the walk's clock restores the door too", async () => {
    /* The pairing's engine serves at 70 s, past the 60 s walk: the redeem is never entered. */
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "paired", pairStartMs: 70_000 });
    expect(await openPairingFromSettings()).toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the walk's refusal on the card", () => el!.querySelector(".join-error") !== null, 120_000);
    const onDisk = shell.door();
    await leaveTheCard();
    console.info(`TIMEOUT door on disk ${String(onDisk?.flavor ?? onDisk?.mode)} || ${shell.log.join(", ")}`);
    expect(shell.log).not.toContain("redeem asked");
    expect(onDisk).toEqual(LOCAL_DOOR);
    expect(readsNotPaired()).toBe(false);
  });

  it("a pairing abandoned by its window is restored by the next window that finds it", async () => {
    /* The window goes away while the redeem is out (a reload): the next mount finds the switch
       still provisional, with nobody left to answer it, and hands the replaced door back. */
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "never" });
    expect(await openPairingFromSettings()).toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the redeem", () => shell.log.includes("redeem asked"), 20_000);
    await act(async () => { root!.unmount(); });
    el!.remove();
    window.location.hash = "#/settings/desktop";
    await mount();
    for (let i = 0; i < 30; i += 1) await advance(500);
    console.info(`ABANDONED door on disk ${String(shell.door()?.flavor ?? shell.door()?.mode)} || ${shell.log.join(", ")}`);
    expect(shell.door()).toEqual(LOCAL_DOOR);
    expect(shell.replaced()).toBeNull();
    expect(readsNotPaired()).toBe(false);
    expect(buttons(DOOR_COPY.installSwitchAction)).toHaveLength(1);
  });
});

describe("every way off the pairing card puts the replaced door back", () => {
  it("a restore the shell refused is asked again when the card is left", async () => {
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "invalid_pair_code", restoreRefusals: 1 });
    expect(await openPairingFromSettings()).toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the card's sentence", () => el!.querySelector(".join-error") !== null, 20_000);
    expect(shell.replaced(), "the refused restore left nothing to put back").not.toBeNull();
    await leaveTheCard();
    console.info(`RESTORE REFUSED door on disk ${String(shell.door()?.flavor ?? shell.door()?.mode)} || ${shell.log.join(", ")}`);
    expect(shell.door()).toEqual(LOCAL_DOOR);
    expect(shell.replaced()).toBeNull();
    expect(readsNotPaired()).toBe(false);
  });

  it("an account mismatch on a provisional pairing is undone, and offers no Start over", async () => {
    /* The pairing opened a fresh directory, so there is no other account's mail to start over from. */
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "pair_account_mismatch" });
    expect(await openPairingFromSettings()).toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the card's sentence", () => el!.querySelector(".join-error") !== null, 20_000);
    expect(buttons(DOOR_COPY.hostStartOver), "Start over offered over a door already put back").toHaveLength(0);
    expect(shell.door()).toEqual(LOCAL_DOOR);
  });
});

describe("only an accepted pairing retires the door it replaced", () => {
  it("the other computer accepts: the paired door stays and the replaced one is let go", async () => {
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "paired" });
    expect(await openPairingFromSettings()).toBe(true);
    await press(DOOR_COPY.hostPair);
    await until("the paired door serving", () => shell.log.includes("redeem 200"), 20_000);
    for (let i = 0; i < 20; i += 1) await advance(500);
    console.info(`ACCEPTED door on disk ${String(shell.door()?.flavor)} || ${shell.log.join(", ")}`);
    expect(shell.door()?.flavor).toBe("desktop-host");
    expect(shell.replaced(), "an accepted pairing still keeps the door it replaced").toBeNull();
    expect(shell.log.filter((l) => l.startsWith("restore") && !l.endsWith("(nothing kept)"))).toEqual([]);
    expect(readsNotPaired()).toBe(false);
  });
});

describe("what the local engine answers the pairing's first step", () => {
  it("the real local engine serves no probe, so Check the link says so and nothing is switched", async () => {
    /* Measured on the engine itself: POST /cloud/probe on the local door answers 404 not_found. */
    const shell = fakeShell({ door: LOCAL_DOOR, answer: "paired", probeOnLocal: false });
    const offered = await openPairingFromSettings();
    console.info(`LOCAL PROBE offered Pair ${offered}; card ${el!.querySelector(".join-error")?.textContent ?? "-"} || ${shell.log.join(", ")}`);
    expect(offered).toBe(false);
    expect(shell.log.filter((l) => l.startsWith("configure"))).toEqual([]);
    expect(shell.door()).toEqual(LOCAL_DOOR);
    expect(machineWord()).toBeTruthy();
  });
});
