/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import { hostLabelOf } from "../src/doors.js";
import messages from "../../webapp/messages/en.json";

/**
 * THE FIRST-RUN CHOOSER HOLDS ITS PAIRING CARD UNTIL THE PAIRING ANSWERS, and the answer is the
 * mail or the same card with the reason. The gate's lifecycle poll read the door the pairing had
 * just written and drew the boot frame over the card; a refused pairing then fell to the pre-auth
 * arm and drew the ohmail Cloud sign-in form. A fake shell and engine, fake timers, every DOM
 * change classified, and the gate's own status asks told apart from the pairing's by call site.
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
const HOST = hostLabelOf(ORIGIN)!;

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

/** What the other computer answers the redeem with — the engine's own codes and statuses. */
const ANSWERS = {
  paired: { status: 200, body: { status: "paired", mailboxId: "mbx-1" } },
  invalid_pair_code: { status: 401, body: { error: { code: "invalid_pair_code", message: "that pairing code was not accepted" } } },
  host_unreachable: { status: 502, body: { error: { code: "host_unreachable", message: "that computer could not be reached" } } },
  host_refused: { status: 502, body: { error: { code: "host_refused", message: "that computer answered HTTP 403 to the code" } } },
  rate_limited: { status: 429, body: { error: { code: "rate_limited", message: "too many attempts from this connection; give it a few minutes and try again" } } },
  pair_account_mismatch: { status: 409, body: { error: { code: "pair_account_mismatch", message: "a different account" } } },
  started_over: { status: 200, body: { status: "paired", restartRequired: true } },
} as const;
type Answer = keyof typeof ANSWERS;

/**
 * The Rust shell's rules over a fake engine: a configure writes the door and restarts the engine
 * (`starting` for `startMs`), a logout forgets the door, and the redeem answers after `redeemMs`.
 */
function fakeShell(opts: {
  startMs: number; redeemMs: number; answer: Answer; door?: Record<string, unknown>;
  /** The engine the configure starts fails instead of serving. */ fails?: boolean;
  /** The redeem's answers in order, the last repeated; `answer` when absent. */ answers?: Answer[];
}) {
  let door: Record<string, unknown> | null = opts.door ?? null;
  let startedAt = 0;
  let paired = false;
  let restartRequired = false;
  let redeems = 0;
  const log: string[] = [];
  let t0 = 0;
  let answeredAt: number | null = null;
  const at = (): number => Date.now() - t0;
  const status = (): Record<string, unknown> => {
    if (!door) return { state: "not_configured", mode: null };
    const shape = { mode: door.mode, flavor: door.flavor, cloudUrl: door.cloudUrl };
    if (Date.now() - startedAt < opts.startMs) return { state: "starting", attempt: 1, of: 4, ...shape };
    if (opts.fails) return { state: "failed", reason: "The mail engine stopped and did not come back.", ...shape };
    return {
      state: "serving", baseUrl: "http://sidecar", mailboxId: paired ? "mbx-1" : "",
      credentialState: paired ? "ready" : "absent", ...shape,
    };
  };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        const s = status();
        /* THE GATE'S OWN ASK, told from the pairing's `settle` by where it was made. */
        if ((new Error().stack ?? "").includes("DesktopGate")) log.push(`${at()}ms gate-asked ${String(s.state)}/${String(s.mode)}`);
        return s;
      }
      if (command === "engine_configure") {
        door = payload!.config as Record<string, unknown>;
        startedAt = Date.now();
        log.push(`${at()}ms configure ${String(door.flavor)}`);
        return status();
      }
      if (command === "engine_logout") {
        door = null;
        paired = false;
        log.push(`${at()}ms logout`);
        return status();
      }
      if (command === "host_candidate_probe") return { status: 200, body: { ok: true, flavor: "desktop-host", base: ORIGIN } };
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        if (status().state !== "serving") throw new Error("the engine is not serving");
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify({ signedIn: paired, sessionExpired: false, restartRequired }));
        if (url === "/cloud/pair-redeem") {
          await new Promise((r) => setTimeout(r, opts.redeemMs));
          const which = opts.answers ? opts.answers[Math.min(redeems, opts.answers.length - 1)]! : opts.answer;
          redeems += 1;
          const a = ANSWERS[which];
          if (which === "paired") paired = true;
          if (which === "started_over") restartRequired = true;
          answeredAt = at();
          log.push(`${answeredAt}ms redeem ${a.status}`);
          return encode(a.status, JSON.stringify(a.body));
        }
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return {
    log,
    pressed(): void { t0 = Date.now(); },
    answeredAt: (): number | null => answeredAt,
    door: (): Record<string, unknown> | null => door,
  };
}

let root: Root | null = null;
let el: HTMLElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const text = (): string => el?.textContent ?? "";
async function until(what: string, test: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; waited <= ms; waited += 50) {
    if (test()) return;
    await advance(50);
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

/** What the window is showing, as one word — the shapes the invariant names. */
function shape(): string {
  if (text().includes(DOOR_COPY.cloudTitle)) return "cloud-sign-in-form";
  if (el!.querySelector(".gate-boot")) return "boot";
  if (text().includes("Ohbox")) return "mail";
  if (el!.querySelector("#host-link")) {
    const error = el!.querySelector(".join-error")?.textContent ?? "";
    if (error) return `card-refused:${error.slice(0, 40)}`;
    return buttons(DOOR_COPY.hostPairing).length === 1 ? "card-pairing" : "card";
  }
  if (text().includes(DOOR_COPY.gateRestartTitle)) return "restart-card";
  if (text().includes(DOOR_COPY.credHostOutValue)) return "not-paired";
  if (text().includes(DOOR_COPY.chooserTitle)) return "doors";
  return `other:${text().slice(0, 40)}`;
}

/** The first-run chooser → Another computer → the link → Check → Pair; the shapes from then on. */
async function pairFromFirstRun(shell: ReturnType<typeof fakeShell>): Promise<string[]> {
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
  await until("the first-run chooser", () => text().includes(DOOR_COPY.chooserTitle), 5_000);
  const tile = [...el.querySelectorAll(".door-tile")]
    .find((b) => b.querySelector(".door-name")?.textContent === DOOR_COPY.doorHostName)!;
  await act(async () => { tile.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const field = el.querySelector<HTMLInputElement>("#host-link")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(field, LINK); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await press(DOOR_COPY.hostCheck);
  await until("the proved link", () => buttons(DOOR_COPY.hostPair).length === 1, 5_000);
  shell.pressed();
  const shown: string[] = [];
  const pressedAt = Date.now();
  const note = (): void => {
    const now = shape();
    if (!shown[shown.length - 1]?.endsWith(` ${now}`)) shown.push(`${Date.now() - pressedAt}ms ${now}`);
  };
  new MutationObserver(note).observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
  await press(DOOR_COPY.hostPair);
  note();
  return shown;
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

describe("the first-run chooser holds its pairing card until the pairing answers", () => {
  it("a pairing still in flight when the gate's poll reads the new door keeps the card, then the mail", async () => {
    /* The engine the configure starts takes 7 s, so the gate's five-second poll reads the door the
       pairing wrote while the pairing is still settling — the packaged app's 4.8 s. */
    const shell = fakeShell({ startMs: 7_000, redeemMs: 500, answer: "paired" });
    const shown = await pairFromFirstRun(shell);
    try {
      await until("the mail", () => shape() === "mail", 30_000);
      await advance(6_000);
    } finally {
      console.info(`HELD shown ${shown.join(", ")} || shell ${shell.log.join(", ")}`);
    }
    const answered = shell.answeredAt();

    const beforeAnswer = shown.filter((s) => Number(s.split("ms")[0]) < (answered ?? Infinity));
    expect(
      shell.log.some((l) => /gate-asked (starting|serving)\/cloud/.test(l) && Number(l.split("ms")[0]) < (answered ?? 0)),
      "the gate's poll never read the new door mid-pairing, so nothing here measures the hold",
    ).toBe(true);
    expect(beforeAnswer.every((s) => s.endsWith(" card-pairing")), `the card left the screen before the pairing answered: ${shown.join(", ")}`).toBe(true);
    expect(shown.filter((s) => /^\d+ms (boot|cloud-sign-in-form|doors|other:)/.test(s)), "a frame other than the card or the mail").toEqual([]);
    expect(shown[shown.length - 1]).toMatch(/ mail$/);
  });
});

describe("a refused pairing says why on the same card, and never shows a sign-in form", () => {
  it.each([
    ["invalid_pair_code", (): string => DOOR_COPY.hostRefuseSpent],
    ["host_unreachable", (): string => DOOR_COPY.hostRefuseUnreachable(HOST)],
    ["host_refused", (): string => DOOR_COPY.hostRefuseRefused(HOST)],
    ["rate_limited", (): string => DOOR_COPY.hostRefuseRateLimited(HOST)],
  ] as const)("the other computer answers %s", async (answer, sentence) => {
    const shell = fakeShell({ startMs: 1_000, redeemMs: 300, answer });
    const shown = await pairFromFirstRun(shell);
    await until("the pairing's answer", () => shell.answeredAt() !== null, 30_000);
    const answered = shell.answeredAt()!;
    /* Sixty seconds after the answer: the gate's probes, polls and held questions all had their turn. */
    for (let i = 0; i < 60; i += 1) await advance(1_000);
    console.info(`REFUSED ${answer} shown ${shown.join(", ")} || shell ${shell.log.join(", ")}`);

    expect(shown.filter((s) => /^\d+ms (boot|cloud-sign-in-form|mail|doors|other:)/.test(s)), `a frame other than the card: ${shown.join(", ")}`).toEqual([]);
    const refusedAt = shown.find((s) => s.includes(" card-refused:"));
    expect(refusedAt, "the card never carried the refusal").toBeDefined();
    expect(Number(refusedAt!.split("ms")[0]) - answered, "the refusal came later than 5 s after the answer").toBeLessThanOrEqual(5_000);
    expect(el!.querySelector(".join-error")?.textContent).toBe(sentence());
    expect(buttons(DOOR_COPY.gateTryAgain)).toHaveLength(1);
    expect(buttons(DOOR_COPY.hostChooseAnother)).toHaveLength(1);
    /* AS IT WAS BEFORE THE PRESS: no door, so a relaunch lands on this chooser and not on a sign-in. */
    expect(shell.door(), "the refused pairing left its door on disk").toBeNull();

    /* Try again is the card's first step with the link kept; Choose another way is the door grid. */
    await press(DOOR_COPY.gateTryAgain);
    await advance(50);
    expect(el!.querySelector<HTMLInputElement>("#host-link")!.readOnly).toBe(false);
    expect(el!.querySelector<HTMLInputElement>("#host-link")!.value).toBe(LINK);
    expect(buttons(DOOR_COPY.hostCheck)).toHaveLength(1);
    await press(DOOR_COPY.back);
    await advance(50);
    expect(shape()).toBe("doors");
  });
});

describe("the pairing's other two answers hold the card too", () => {
  it("an engine that fails to start under the pairing is a sentence on the card, not the notice", async () => {
    const shell = fakeShell({ startMs: 7_000, redeemMs: 0, answer: "paired", fails: true });
    const shown = await pairFromFirstRun(shell);
    for (let i = 0; i < 20; i += 1) await advance(1_000);
    console.info(`FAILED shown ${shown.join(", ")} || shell ${shell.log.join(", ")}`);
    expect(shown.filter((s) => /^\d+ms (boot|cloud-sign-in-form|mail|doors|not-paired|other:)/.test(s)), `a frame other than the card: ${shown.join(", ")}`).toEqual([]);
    expect(shape()).toMatch(/^card-refused:/);
    expect(text()).not.toContain(DOOR_COPY.gateCannotOpen);
    expect(buttons(DOOR_COPY.gateTryAgain)).toHaveLength(1);
    expect(shell.door(), "the failed pairing left its door on disk").toBeNull();
  });

  it("a start over on the first run lands on the Pairing finished card, never Not paired", async () => {
    /* The one refusal with a way out keeps its door, because Start over is a redeem on it. */
    const shell = fakeShell({ startMs: 1_000, redeemMs: 200, answer: "paired", answers: ["pair_account_mismatch", "started_over"] });
    const shown = await pairFromFirstRun(shell);
    await until("the mismatch on the card", () => buttons(DOOR_COPY.hostStartOver).length === 1, 10_000);
    expect(shell.door(), "the refusal Start over answers forgot the door Start over needs").not.toBeNull();
    /* Read for a while first: the gate's poll reads the door and its probe earns a pre-auth answer,
       which the start-over's answer (no status of its own) must not be released on. */
    for (let i = 0; i < 7; i += 1) await advance(1_000);
    await press(DOOR_COPY.hostStartOver);
    for (let i = 0; i < 10; i += 1) await advance(500);
    console.info(`STARTOVER shown ${shown.join(", ")} || shell ${shell.log.join(", ")}`);
    expect(text()).toContain(DOOR_COPY.gateRestartTitle);
    expect(shown.filter((s) => /^\d+ms (boot|cloud-sign-in-form|mail|doors|not-paired|other:)/.test(s)), `a frame other than the card: ${shown.join(", ")}`).toEqual([]);
  });
});

describe("a paired door with no session is never offered the ohmail Cloud sign-in", () => {
  it("a pairing that never finished opens on the Not-paired card, and Pair again opens the pairing card", async () => {
    /* The door a pairing writes before it redeems, found at launch with no session behind it. */
    const shell = fakeShell({
      startMs: 0, redeemMs: 0, answer: "paired",
      door: { mode: "cloud", flavor: "desktop-host", cloudUrl: ORIGIN, hostPin: "a".repeat(43) },
    });
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
    await until("the gate's first auth answer", () => shape() !== "boot" && !shape().startsWith("other:"), 10_000);
    for (let i = 0; i < 10; i += 1) await advance(1_000);
    console.info(`UNFINISHED shell ${shell.log.join(", ")} || ${text().slice(0, 200)}`);
    expect(shape(), "the paired door drew the ohmail Cloud sign-in form").not.toBe("cloud-sign-in-form");
    expect(text()).toContain(DOOR_COPY.credHostOutValue);
    expect(text()).toContain(DOOR_COPY.gateUnpaired(machineWord(), HOST));
    await press(DOOR_COPY.gatePairAgain);
    await advance(200);
    expect(el!.querySelector("#host-link"), "Pair again did not open the pairing card").not.toBeNull();
    expect(shape()).not.toBe("cloud-sign-in-form");
  });
});

describe("the refused card's words are in both catalogues", () => {
  const raw = (locale: string): string => fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), `../../webapp/messages/${locale}.json`), "utf8");
  afterEach(() => setActiveCatalog(DEFAULT_LOCALE, null));

  it("English and German carry the refusal and the way out, as written and as rendered", () => {
    expect(raw("en")).toContain('"hostRefuseRefused": "{host} refused this pairing. Make a new link from Settings → Devices there and try again."');
    expect(raw("en")).toContain('"hostChooseAnother": "Choose another way"');
    expect(raw("de")).toContain('"hostRefuseRefused": "{host} hat diese Kopplung abgelehnt. Erstelle dort unter Einstellungen → Geräte einen neuen Link und versuche es erneut."');
    expect(raw("de")).toContain('"hostChooseAnother": "Anderen Weg wählen"');
    expect(DOOR_COPY.hostRefuseRefused("kestrel")).toBe("kestrel refused this pairing. Make a new link from Settings → Devices there and try again.");
    const en = JSON.parse(raw("en")) as never;
    setActiveCatalog("de", fillFrom(en, JSON.parse(raw("de")) as never) as never);
    expect(DOOR_COPY.hostRefuseRefused("kestrel")).toBe("kestrel hat diese Kopplung abgelehnt. Erstelle dort unter Einstellungen → Geräte einen neuen Link und versuche es erneut.");
    expect(DOOR_COPY.hostChooseAnother).toBe("Anderen Weg wählen");
    expect(DOOR_COPY.gateTryAgain).toBe("Erneut versuchen");
  });
});
