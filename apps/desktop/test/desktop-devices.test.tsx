/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DesktopDevices, DEFAULT_HOST_PORT, guideKey, type GuideKey } from "../src/DesktopDevices.js";
import { HOST_PROBLEMS, type HostProblem } from "../src/host.js";
import { hostDoorFor } from "../src/doors.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { decodeQr, matrixFromSvg } from "./fixtures/qr-decode.js";

/**
 * ═══ SETTINGS → DEVICES — host mode's face, held behaviourally ═════════════════════════════════
 *
 * The claims that carry the pane, each proven against the real component over a stubbed shell
 * (`__TAURI_INTERNALS__.invoke` is the ONE seam — the same commands the Rust side registers, the
 * same framed bytes the bridge decodes):
 *
 *  · the pane exists on the STANDALONE door only — `hostDoorFor` is the rule and the gate is
 *    pinned to it;
 *  · the guided ladder is a CLOSED vocabulary: every problem the shell can name renders its one
 *    designed sentence, an unknown name degrades to the generic guidance, and no state ever
 *    prints a raw problem code;
 *  · the QR encodes exactly `${origin}/pair#<token>` — decoded by the spec-derived decoder, not
 *    trusted from the encoder — and the raw token appears NOWHERE in the pane's text, before or
 *    after dismissal;
 *  · mint/list/revoke and the device take-back ride the exact stdio wire (`POST/GET/DELETE
 *    /pair`, `GET/DELETE /devices`), and the window's own launch session never renders as a
 *    removable device;
 *  · the enable ceremony arms with the visible, default-checked start-at-login choice and the
 *    (advanced-only) port; a nonsense port is refused beside the field, never sent;
 *  · the copy bar: serving is qualified "while this computer is awake" in BOTH languages —
 *    never an unqualified always-on.
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

// ── The shell, stubbed at the one global the window reaches it by ─────────────────────────────

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const globe = globalThis as unknown as Host;

/** One engine answer, framed exactly as the shell frames one (meta length · meta JSON · body). */
function framed(status: number, body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(
    JSON.stringify({ status, statusText: "", h: [["content-type", "application/json"]] }),
  );
  const bytes = body === null ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.length + bytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, false);
  out.set(meta, 4);
  out.set(bytes, 4 + meta.length);
  return out;
}

interface EngineAnswer { status: number; body: unknown }
interface World {
  /** `host_state` answers — shifted per call so an arm can change the world. */
  hostState: unknown;
  tailscale: unknown;
  /** Routed engine answers by `"METHOD /url"`. */
  routes: Record<string, EngineAnswer | ((body: unknown) => EngineAnswer)>;
  /** `tailscale_serve_arm` — records the payload, answers `armAnswer`. */
  armAnswer?: unknown;
  disarmAnswer?: unknown;
  /** The real disarm can REJECT after the runtime already stood down (a settings-write
   *  failure) — set this to drive that arm of the contract. */
  disarmRejects?: string;
  autostartAnswer?: boolean;
}

interface Asked { command: string; payload?: Record<string, unknown> }
interface EngineAsked { method: string; url: string; body: unknown }

let world: World;
let asked: Asked[];
let engineAsked: EngineAsked[];

function installShell(w: World): void {
  world = w;
  asked = [];
  engineAsked = [];
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      asked.push(payload === undefined ? { command } : { command, payload });
      switch (command) {
        case "host_state":
          return Promise.resolve(typeof world.hostState === "function" ? (world.hostState as () => unknown)() : world.hostState);
        case "tailscale_status":
          return Promise.resolve(typeof world.tailscale === "function" ? (world.tailscale as () => unknown)() : world.tailscale);
        case "tailscale_serve_arm":
          return Promise.resolve(world.armAnswer);
        case "tailscale_serve_disarm":
          if (world.disarmRejects) return Promise.reject(new Error(world.disarmRejects));
          return Promise.resolve(world.disarmAnswer);
        case "autostart_set":
          return Promise.resolve(world.autostartAnswer ?? (payload as { enabled: boolean }).enabled);
        case "open_tailscale_download":
          return Promise.resolve(undefined);
        case "engine_request": {
          const p = payload as { method: string; url: string; body: number[] };
          const bodyText = new TextDecoder().decode(Uint8Array.from(p.body));
          const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;
          engineAsked.push({ method: p.method, url: p.url, body });
          const route = world.routes[`${p.method} ${p.url}`];
          if (!route) return Promise.resolve(framed(404, { error: { code: "not_found" } }));
          const answer = typeof route === "function" ? route(body) : route;
          return Promise.resolve(framed(answer.status, answer.body));
        }
        default:
          return Promise.reject(new Error(`unstubbed command ${command}`));
      }
    },
  };
}

// ── Mounting ───────────────────────────────────────────────────────────────────────────────────

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  hostEl?.remove();
  delete globe.__TAURI_INTERNALS__;
});

async function flush(): Promise<void> {
  // The mount effect chains up to three awaits (host_state → probe/lists → json) — settle them.
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(messages: Record<string, unknown> = en as never): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: messages === (de as never) ? "de" : "en",
        messages: messages as never,
        timeZone: "Europe/Zurich",
      },
        h(ThemeProvider, null, h(ToastHost, null, h(DesktopDevices)))),
    );
  });
  await flush();
}

const text = (): string => hostEl.textContent ?? "";
const button = (label: string): HTMLButtonElement => {
  const found = [...hostEl.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}" — buttons: ${[...hostEl.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return found;
};
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
};
const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const ORIGIN = "https://sonoma.tail1234.ts.net";
const TOKEN = "dpt_4be6f0a92d3c41e78a51c07b9e2d8f13";

const OFF = { enabled: false, port: null, origin: null, state: "off", problem: null, autostart: null };
const RUNNING = { state: "running", dnsName: "sonoma.tail1234.ts.net", version: "1.66.0" };
const SERVING = { enabled: true, port: 47800, origin: ORIGIN, state: "serving", problem: null, autostart: true };
const EMPTY_LISTS = {
  "GET /pair": { status: 200, body: { items: [] } },
  "GET /devices": { status: 200, body: { items: [] } },
};

const enHost = (en as { host: Record<string, string> }).host;
const deHost = (de as { host: Record<string, string> }).host;

// ── The door rule ──────────────────────────────────────────────────────────────────────────────

describe("the pane exists on the standalone door only", () => {
  const status = (mode: EngineStatus["mode"]): EngineStatus =>
    ({ state: "serving", mode, credentialState: "ready" }) as EngineStatus;

  it("hostDoorFor: local ⇒ local; cloud, no door, no answer ⇒ withheld", () => {
    expect(hostDoorFor(status("local"))).toBe("local");
    expect(hostDoorFor(status("cloud"))).toBe(null);
    expect(hostDoorFor(status(null))).toBe(null);
    expect(hostDoorFor(null)).toBe(null);
  });

  it("the gate injects devicesSection through hostDoorFor and nowhere else", () => {
    // The render decision is the pure function above; this pins the gate TO it, so a rewrite
    // that injects the pane unconditionally (or on another condition) goes red here while the
    // pure test above still passes.
    const gate = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/DesktopGate.tsx"),
      "utf8",
    );
    const injections = gate.match(/devicesSection/g) ?? [];
    expect(injections.length).toBe(1);
    expect(gate).toMatch(/hostDoorFor\(status\) === "local"\s*\?\s*\{ devicesSection: <DesktopDevices \/> \}/);
  });
});

// ── The guided ladder ──────────────────────────────────────────────────────────────────────────

describe("the guided ladder is a closed vocabulary", () => {
  const DESIGNED: Record<HostProblem, GuideKey> = {
    "no-cli": "guideNoCli",
    "not-running": "guideNotRunning",
    "not-logged-in": "guideNotLoggedIn",
    "no-dns-name": "guideNoDnsName",
    "serve-refused": "guideServeRefused",
    "local-door-required": "guideLocalDoorRequired",
    "engine-not-serving": "guideEngineNotServing",
    "listener-pending": "guideListenerPending",
    "listener-skipped": "guideListenerSkipped",
    "listener-failed": "guideListenerFailed",
    "host-config-invalid": "guideConfigInvalid",
  };

  it("every problem the shell can name maps to its own designed sentence, in both languages", () => {
    for (const problem of HOST_PROBLEMS) {
      const key = guideKey(problem);
      expect(key, problem).toBe(DESIGNED[problem]);
      expect(typeof enHost[key], `en host.${key}`).toBe("string");
      expect(typeof deHost[key], `de host.${key}`).toBe("string");
    }
    // Injective over the closed set: no two problems share a sentence, so a state can never
    // masquerade as another. (`null` alone falls to the generic arm, asserted below.)
    expect(new Set(HOST_PROBLEMS.map(guideKey)).size).toBe(HOST_PROBLEMS.length);
    expect(guideKey(null)).toBe("guideGeneric");
  });

  it("an armed, degraded state renders the designed sentence and NEVER the raw code", async () => {
    for (const problem of HOST_PROBLEMS) {
      installShell({
        hostState: { ...SERVING, state: "degraded", problem },
        tailscale: RUNNING,
        routes: EMPTY_LISTS,
      });
      await mount();
      expect(text(), problem).toContain(enHost[guideKey(problem)]!);
      expect(text(), problem).not.toContain(problem);
      await act(async () => root.unmount());
      hostEl.remove();
    }
  });

  it("a problem this bundle has never heard of degrades to the generic guidance", async () => {
    installShell({
      hostState: { ...SERVING, state: "degraded", problem: "quantum-flux-inverted" },
      tailscale: RUNNING,
      routes: EMPTY_LISTS,
    });
    await mount();
    expect(text()).toContain(enHost.guideGeneric!);
    expect(text()).not.toContain("quantum-flux-inverted");
  });

  it("the OFF state detects and guides: no-cli gets the install step and the download deep-link", async () => {
    installShell({ hostState: OFF, tailscale: { state: "no-cli" }, routes: {} });
    await mount();
    expect(text()).toContain(enHost.lead!);
    expect(text()).toContain(enHost.story!);
    expect(text()).toContain(enHost.guideNoCli!);
    await click(button(enHost.getTailscale!));
    expect(asked.some((a) => a.command === "open_tailscale_download")).toBe(true);
    // No enable button while the one prerequisite is missing — guide, don't dare.
    expect([...hostEl.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(enHost.enable);
  });

  it("Check again re-probes, and a healed tailnet reveals the ceremony", async () => {
    const probes = [{ state: "not-running" }, RUNNING];
    installShell({ hostState: OFF, tailscale: () => probes.shift() ?? RUNNING, routes: {} });
    await mount();
    expect(text()).toContain(enHost.guideNotRunning!);
    await click(button(enHost.checkAgain!));
    expect(text()).toContain(enHost.ready!.replace("{name}", "sonoma.tail1234.ts.net"));
    expect(button(enHost.enable!)).toBeTruthy();
  });
});

// ── The enable ceremony ────────────────────────────────────────────────────────────────────────

describe("the enable ceremony", () => {
  it("arms with the default port and the visible, default-checked start-at-login choice", async () => {
    installShell({
      hostState: OFF,
      tailscale: RUNNING,
      armAnswer: SERVING,
      routes: EMPTY_LISTS,
    });
    await mount();
    const autostart = hostEl.querySelector('[role="switch"]')!;
    expect(autostart.getAttribute("aria-checked")).toBe("true");
    await click(button(enHost.enable!));
    const arm = asked.find((a) => a.command === "tailscale_serve_arm");
    expect(arm?.payload).toEqual({ port: DEFAULT_HOST_PORT, autostart: true, lan: null });
    expect(text()).toContain("while this computer is awake");
  });

  it("the start-at-login choice is honoured when unchecked", async () => {
    installShell({ hostState: OFF, tailscale: RUNNING, armAnswer: SERVING, routes: EMPTY_LISTS });
    await mount();
    await click(hostEl.querySelector('[role="switch"]') as HTMLElement);
    await click(button(enHost.enable!));
    expect(asked.find((a) => a.command === "tailscale_serve_arm")?.payload).toEqual({
      port: DEFAULT_HOST_PORT,
      autostart: false,
      lan: null,
    });
  });

  it("the port hides behind Advanced, and a nonsense port is refused beside the field, never sent", async () => {
    installShell({ hostState: OFF, tailscale: RUNNING, armAnswer: SERVING, routes: EMPTY_LISTS });
    await mount();
    expect(hostEl.querySelector(`input[aria-label="${enHost.port}"]`)).toBeNull();
    await click(button(enHost.advanced!));
    const port = hostEl.querySelector(`input[aria-label="${enHost.port}"]`) as HTMLInputElement;
    expect(port.value).toBe(String(DEFAULT_HOST_PORT));
    await type(port, "99999");
    await click(button(enHost.enable!));
    expect(asked.some((a) => a.command === "tailscale_serve_arm")).toBe(false);
    expect(text()).toContain(enHost.portInvalid!);
  });

  it("an arm the tailnet refuses comes back as the guided state, not a success and not a code", async () => {
    installShell({
      hostState: OFF,
      tailscale: RUNNING,
      armAnswer: { ...SERVING, state: "degraded", problem: "serve-refused" },
      routes: EMPTY_LISTS,
    });
    await mount();
    await click(button(enHost.enable!));
    expect(text()).toContain(enHost.guideServeRefused!);
    expect(text()).not.toContain("serve-refused");
  });
});

// ── The pairing flow ───────────────────────────────────────────────────────────────────────────

describe("add a device — the QR moment", () => {
  function servingWorld(): World {
    return {
      hostState: SERVING,
      tailscale: RUNNING,
      routes: {
        ...EMPTY_LISTS,
        "POST /pair": (body) => ({
          status: 200,
          body: {
            id: "pt-1",
            token: TOKEN,
            grant: "device-pair",
            label: (body as { label?: string }).label ?? "",
            expiresAt: "2026-08-19T12:05:00.000Z",
          },
        }),
      },
    };
  }

  it("mints device-pair with the label, and the QR decodes to exactly `${origin}/pair#${token}`", async () => {
    installShell(servingWorld());
    await mount();
    await type(hostEl.querySelector(`input[aria-label="${enHost.addFor}"]`) as HTMLInputElement, "Mara");
    await click(button(enHost.addAction!));

    const mint = engineAsked.find((r) => r.method === "POST" && r.url === "/pair");
    expect(mint?.body).toEqual({ grant: "device-pair", label: "Mara" });

    const svg = hostEl.querySelector("svg")!;
    expect(decodeQr(matrixFromSvg(svg as unknown as SVGSVGElement))).toBe(`${ORIGIN}/pair#${TOKEN}`);
  });

  it("the raw token appears NOWHERE in the pane's text — during the QR moment or after Done", async () => {
    installShell(servingWorld());
    await mount();
    await click(button(enHost.addAction!));
    expect(text()).not.toContain(TOKEN);

    // The copy button carries the link to the clipboard — the accessible path to the value.
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (v: string) => { written.push(v); return Promise.resolve(); } },
      configurable: true,
    });
    await click(button(enHost.copyLink!));
    expect(written).toEqual([`${ORIGIN}/pair#${TOKEN}`]);

    await click(button(enHost.mintedDone!));
    expect(text()).not.toContain(TOKEN);
    expect(hostEl.querySelector("svg")).toBeNull();
  });

  it("a rejected clipboard is said, with the scan as the way that still works — never a false `copied`", async () => {
    installShell(servingWorld());
    await mount();
    await click(button(enHost.addAction!));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    await click(button(enHost.copyLink!));
    expect(text()).toContain(enHost.copyFailed!);
  });
});

describe("the lists and the take-backs", () => {
  it("lists only LIVE device-pair codes; revoke hits the row's id and refreshes", async () => {
    let revoked = false;
    installShell({
      hostState: SERVING,
      tailscale: RUNNING,
      routes: {
        "GET /pair": () => ({
          status: 200,
          body: {
            items: revoked
              ? []
              : [
                  { id: "pt-live", grant: "device-pair", status: "live", label: "Mara", createdAt: "2026-08-19T12:00:00Z", expiresAt: "2026-08-19T12:05:00Z", consumedAt: null, revokedAt: null },
                  { id: "pt-spent", grant: "device-pair", status: "consumed", label: "spent", createdAt: "2026-08-19T11:00:00Z", expiresAt: "2026-08-19T11:05:00Z", consumedAt: "2026-08-19T11:01:00Z", revokedAt: null },
                ],
          },
        }),
        "GET /devices": { status: 200, body: { items: [] } },
        "DELETE /pair/pt-live": () => {
          revoked = true;
          return { status: 204, body: null };
        },
      },
    });
    await mount();
    expect(text()).toContain("Mara");
    expect(text()).not.toContain("spent");
    await click(button(enHost.revoke!));
    expect(engineAsked.some((r) => r.method === "DELETE" && r.url === "/pair/pt-live")).toBe(true);
    expect(text()).not.toContain("Mara");
  });

  it("the window's own session never renders as a device; a paired phone does, with a plain confirm on Remove", async () => {
    let removed = false;
    installShell({
      hostState: SERVING,
      tailscale: RUNNING,
      routes: {
        "GET /pair": { status: 200, body: { items: [] } },
        "GET /devices": () => ({
          status: 200,
          body: {
            items: [
              { id: "sess-self", kind: "web", label: "", createdAt: "2026-08-19T09:00:00Z", lastSeenAt: "2026-08-19T12:00:00Z", ip: "", current: true, pushToken: null },
              ...(removed
                ? []
                : [{ id: "dev-phone", kind: "web", label: "Mara's phone", createdAt: "2026-08-18T09:00:00Z", lastSeenAt: "2026-08-19T11:00:00Z", ip: "", current: false, pushToken: null }]),
            ],
          },
        }),
        "DELETE /devices/dev-phone": () => {
          removed = true;
          return { status: 204, body: null };
        },
      },
    });
    await mount();
    // Exactly one device row — the paired phone. The current session is not offered a Remove.
    expect(text()).toContain("Mara's phone");
    const removes = [...hostEl.querySelectorAll("button")].filter((b) => b.textContent === enHost.remove);
    expect(removes.length).toBe(1);

    // Remove asks before it acts, names the device, and the confirm carries the truthful cost.
    await click(removes[0]!);
    expect(engineAsked.some((r) => r.method === "DELETE")).toBe(false);
    expect(text()).toContain(enHost.removeWhat!);
    await click(button(enHost.remove!));
    expect(engineAsked.some((r) => r.method === "DELETE" && r.url === "/devices/dev-phone")).toBe(true);
    expect(text()).not.toContain("Mara's phone");
  });

  it("disarmed, the pane asks the engine for NOTHING — the routes only exist while armed", async () => {
    installShell({ hostState: OFF, tailscale: RUNNING, routes: {} });
    await mount();
    expect(engineAsked).toEqual([]);
  });
});

// ── The review battery: the shell states the first cut mishandled ──────────────────────────────

describe("off-state problems are honored — the ladder is not only the probe's", () => {
  it("off with a stored problem says it, even while the probe reads ready", async () => {
    // The real shape: a disarm whose tailnet withdrawal was refused stands down anyway and
    // `host_state` answers OFF with `problem: "serve-refused"` — the old registration may
    // still exist. A pane that read only the probe would offer a clean ceremony over it.
    installShell({
      hostState: { ...OFF, problem: "serve-refused" },
      tailscale: RUNNING,
      routes: {},
    });
    await mount();
    expect(text()).toContain(enHost.guideServeRefused!);
    expect(text()).not.toContain("serve-refused");
    // The ceremony is still offered — arming again re-publishes, which is a real way out —
    // but never silently, and never as if nothing stood.
    expect(button(enHost.enable!)).toBeTruthy();
  });

  it("an arm the shell refuses pre-serve lands its problem on screen, not a silent loop", async () => {
    // The shell re-probes inside the arm; a race (Tailscale quit between probe and arm)
    // answers the CURRENT state — still off — plus this attempt's problem.
    installShell({
      hostState: OFF,
      tailscale: RUNNING,
      armAnswer: { ...OFF, problem: "not-running" },
      routes: {},
    });
    await mount();
    await click(button(enHost.enable!));
    expect(text()).toContain(enHost.guideNotRunning!);
  });

  it("and that problem SURVIVES — no background read may wipe the only explanation on screen", async () => {
    /**
     * The regression this exists to stop, caught by review of the change that caused it. A poll
     * was added so an ARMED pane follows the engine's LAN door; written unconditionally, it also
     * ran while host mode was OFF, where a plain `host_state` does NOT carry the problem an
     * arm-refusal answered with. Five seconds after the refusal the sentence vanished, leaving a
     * stale "Tailscale is ready" beside an Enable button that silently did nothing.
     *
     * So the wait here is longer than the poll interval, and the assertion is that nothing moved.
     */
    installShell({
      hostState: OFF,
      tailscale: RUNNING,
      armAnswer: { ...OFF, problem: "not-running" },
      routes: {},
    });
    await mount();
    await click(button(enHost.enable!));
    expect(text()).toContain(enHost.guideNotRunning!);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 6000));
    });
    expect(text()).toContain(enHost.guideNotRunning!);
  }, 20_000);

  it("a first read that fails is retried — 'Checking…' is not a dead end", async () => {
    /**
     * Older than this screen's polling and found while reviewing it: the mount read has no catch,
     * so a shell call that rejects leaves the pane on "Checking…" with no control to try again
     * until it is remounted. Gating the background read on "host mode is on" would have kept it
     * that way, because a window that never got an answer does not know that it is off.
     *
     * The boundary is a CONFIRMED off state — the one place a background read destroys
     * information. "We have never heard back" is not that, so it retries.
     */
    let attempts = 0;
    globe.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "host_state") {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("bridge not ready"));
          return Promise.resolve(OFF);
        }
        if (command === "tailscale_status") return Promise.resolve(RUNNING);
        return Promise.resolve(undefined);
      },
    };
    await mount();
    expect(text()).toContain(enHost.checking!);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 6000));
    });
    expect(attempts).toBeGreaterThan(1);
    expect(text()).not.toContain(enHost.checking!);
    expect(button(enHost.enable!)).toBeTruthy();
  }, 20_000);

  it("a first read whose PROBE half fails is retried too — both halves, not one", async () => {
    /**
     * The mirror image of the case above, and the reason the retry condition is not simply
     * "we have no host state": the opening read has two halves. If `host_state` answers off and
     * `tailscale_status` then rejects, host state is set — so a retry gated on that alone stops —
     * while the probe stays unresolved and the off ladder renders "Checking…" for ever.
     */
    let probes = 0;
    globe.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "host_state") return Promise.resolve(OFF);
        if (command === "tailscale_status") {
          probes += 1;
          if (probes === 1) return Promise.reject(new Error("probe blew up"));
          return Promise.resolve(RUNNING);
        }
        return Promise.resolve(undefined);
      },
    };
    await mount();
    expect(text()).toContain(enHost.checking!);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 6000));
    });
    expect(probes).toBeGreaterThan(1);
    expect(text()).not.toContain(enHost.checking!);
  }, 20_000);

  it("a HANGING probe is not retried on top of itself — one attempt at a time", async () => {
    /**
     * `tailscale_status` shells out with NO timeout, so a tailnet daemon that hangs rather than
     * refusing never settles. A retry that fired on a timer regardless would start a new
     * `tailscale` subprocess every five seconds for as long as the window stayed open. A stuck
     * attempt is still an attempt.
     */
    let probes = 0;
    globe.__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "host_state") return Promise.resolve(OFF);
        if (command === "tailscale_status") {
          probes += 1;
          return new Promise(() => undefined); // never settles
        }
        return Promise.resolve(undefined);
      },
    };
    await mount();
    await act(async () => {
      await new Promise((done) => setTimeout(done, 12_000));
    });
    // Two full poll intervals have passed and the mount's own probe is still out there.
    expect(probes).toBe(1);
  }, 30_000);

});

describe("a live code stays revocable in every armed state", () => {
  it("degraded, the unused-codes list still renders with its revoke", async () => {
    // Disarming does not revoke pairing tokens, and the stdio routes stay mounted while
    // armed — so a code minted before the degradation MUST keep its take-back, or it comes
    // back to life when serving recovers.
    installShell({
      hostState: { ...SERVING, state: "degraded", problem: "serve-refused" },
      tailscale: RUNNING,
      routes: {
        "GET /pair": {
          status: 200,
          body: { items: [{ id: "pt-1", grant: "device-pair", status: "live", label: "Mara", createdAt: "2026-08-19T12:00:00Z", expiresAt: "2026-08-19T12:05:00Z", consumedAt: null, revokedAt: null }] },
        },
        "GET /devices": { status: 200, body: { items: [] } },
      },
    });
    await mount();
    expect(text()).toContain("Mara");
    expect(button(enHost.revoke!)).toBeTruthy();
  });
});

describe("a rejected disarm re-reads the world instead of keeping the serving snapshot", () => {
  it("the pane lands on what host_state now says, plus the failure sentence — never stale serving", async () => {
    // The real command can reject AFTER the runtime stood down (the settings write failed).
    // The ground truth is whatever host_state answers now: off.
    let disarmed = false;
    installShell({
      hostState: () => (disarmed ? OFF : SERVING),
      tailscale: RUNNING,
      disarmRejects: "the settings file could not be written",
      routes: EMPTY_LISTS,
    });
    await mount();
    disarmed = true; // the runtime stands down before the rejection reaches the window
    await click(button(enHost.off!));
    await click(button(enHost.off!));
    expect(text()).toContain(enHost.lead!); // the OFF face
    expect(text()).not.toContain("Serving your devices at");
    expect(text()).toContain("the settings file could not be written");
  });

  it("and that sentence SURVIVES — the retry belongs to the opening read, not to this", async () => {
    /**
     * The trap in inferring "the opening read has not finished" from `host` and `probe`: a disarm
     * that fails ALSO lands with host off and — if the follow-up probe fails too — an unresolved
     * probe. By those two alone it is indistinguishable from a cold mount, so a state-inferred
     * retry starts, and its `refresh()` clears `problem`. Five seconds after the user pressed the
     * button, the only explanation for what went wrong disappears.
     *
     * That is the same erasure the off-state gate exists to prevent, arriving through the gate's
     * own escape hatch — which is why "the opening read finished" is a recorded fact and not a
     * deduction from shared state.
     */
    let disarmed = false;
    installShell({
      hostState: () => (disarmed ? OFF : SERVING),
      tailscale: () => {
        if (disarmed) throw new Error("the tailnet probe is gone too");
        return RUNNING;
      },
      disarmRejects: "the settings file could not be written",
      routes: EMPTY_LISTS,
    });
    await mount();
    disarmed = true;
    await click(button(enHost.off!));
    await click(button(enHost.off!));
    expect(text()).toContain("the settings file could not be written");
    await act(async () => {
      await new Promise((done) => setTimeout(done, 6000));
    });
    expect(text()).toContain("the settings file could not be written");
  }, 20_000);
});

describe("Done refreshes the lists — a scanned code does not linger as unused", () => {
  it("dismissing the QR re-asks /pair and /devices", async () => {
    installShell({
      hostState: SERVING,
      tailscale: RUNNING,
      routes: {
        ...EMPTY_LISTS,
        "POST /pair": { status: 200, body: { id: "pt-1", token: TOKEN, grant: "device-pair", label: "", expiresAt: "2026-08-19T12:05:00.000Z" } },
      },
    });
    await mount();
    await click(button(enHost.addAction!));
    const before = engineAsked.filter((r) => r.method === "GET").length;
    await click(button(enHost.mintedDone!));
    const after = engineAsked.filter((r) => r.method === "GET").length;
    expect(after).toBe(before + 2); // one /pair, one /devices — the scan just consumed a code
  });
});

describe("an unknown start-at-login state is said, not rendered as off", () => {
  it("autostart null gets the unknown sentence instead of the ordinary hint", async () => {
    installShell({
      hostState: { ...SERVING, autostart: null },
      tailscale: RUNNING,
      routes: EMPTY_LISTS,
    });
    await mount();
    expect(text()).toContain(enHost.autostartUnknown!);
    expect(text()).not.toContain(enHost.autostartWhy!);
  });
});

describe("the port field refuses a numeric prefix — the whole string or nothing", () => {
  it("'47800x' is refused beside the field, never parsed down and sent", async () => {
    installShell({ hostState: OFF, tailscale: RUNNING, armAnswer: SERVING, routes: EMPTY_LISTS });
    await mount();
    await click(button(enHost.advanced!));
    const port = hostEl.querySelector(`input[aria-label="${enHost.port}"]`) as HTMLInputElement;
    await type(port, "47800x");
    await click(button(enHost.enable!));
    expect(asked.some((a) => a.command === "tailscale_serve_arm")).toBe(false);
    expect(text()).toContain(enHost.portInvalid!);
  });
});

describe("the default port dodges every supported platform's ephemeral range", () => {
  it("sits above 1023 and below Linux's 32768 floor (macOS/Windows start at 49152)", () => {
    // A default inside an ephemeral range can be transiently held by any outbound socket at
    // the moment of arming, which reports as listener-failed for no reason the user caused.
    expect(DEFAULT_HOST_PORT).toBeGreaterThan(1023);
    expect(DEFAULT_HOST_PORT).toBeLessThan(32768);
  });
});

// ── Turning it off ─────────────────────────────────────────────────────────────────────────────

describe("turn off — the truthful sentence, then the disarm", () => {
  it("asks first, says what stops, and disarms on the confirm", async () => {
    installShell({
      hostState: SERVING,
      tailscale: RUNNING,
      disarmAnswer: OFF,
      routes: EMPTY_LISTS,
    });
    await mount();
    await click(button(enHost.off!));
    expect(asked.some((a) => a.command === "tailscale_serve_disarm")).toBe(false);
    expect(text()).toContain(enHost.offWhat!);
    await click(button(enHost.off!)); // the confirm's primary carries the same verb
    expect(asked.some((a) => a.command === "tailscale_serve_disarm")).toBe(true);
    // Back to the OFF face: the explainer, not the serving line. (The ceremony's start-at-login
    // hint carries the awake qualifier too, so the pin is on the serving sentence itself.)
    expect(text()).toContain(enHost.lead!);
    expect(text()).not.toContain("Serving your devices at");
  });
});

// ── The copy bar ───────────────────────────────────────────────────────────────────────────────

describe("the copy bar: awake-qualified, never unqualified always-on", () => {
  it("the serving line carries the qualifier in both catalogues", () => {
    expect(enHost.serving).toContain("while this computer is awake");
    expect(deHost.serving).toContain("solange dieser Computer wach ist");
    for (const [key, value] of Object.entries(enHost)) {
      expect(value.toLowerCase(), `en host.${key}`).not.toContain("always-on");
      expect(value.toLowerCase(), `en host.${key}`).not.toContain("always on");
    }
  });

  it("the German pane serves with the qualifier rendered", async () => {
    installShell({ hostState: SERVING, tailscale: RUNNING, routes: EMPTY_LISTS });
    await mount(de as never);
    expect(text()).toContain("solange dieser Computer wach ist");
    expect(text()).toContain(ORIGIN);
  });
});

// ── Outside the app ────────────────────────────────────────────────────────────────────────────

describe("without a shell", () => {
  it("says so in one sentence and offers nothing", async () => {
    delete globe.__TAURI_INTERNALS__;
    world = { hostState: null, tailscale: null, routes: {} };
    asked = [];
    engineAsked = [];
    await mount();
    expect(text()).toContain(enHost.notAvailable!);
    expect(hostEl.querySelectorAll("button").length).toBe(0);
  });
});
