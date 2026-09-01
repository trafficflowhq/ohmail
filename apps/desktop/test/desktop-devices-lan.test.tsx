/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import { DesktopDevices } from "../src/DesktopDevices.js";

/**
 * ═══ THE SAME-NETWORK OPTION IN THE PANE — the ceremony, the states, the honest copy ═════════
 *
 * What is pinned here, beyond rendering:
 *
 *  · **The copy matches the shipped capability.** The LAN door is API-only (the secure-context
 *    audit — `apps/sidecar/src/host-lan.ts`), so every serving sentence promises the mail API
 *    for APPS, carries the awake qualifier, and the browser note says plainly why a phone
 *    browser needs the Tailscale address. A pane that showed a QR or promised "read your mail
 *    at this address" would be claiming what the LAN door deliberately does not ship.
 *  · **The address is chosen, never typed.** The toggle loads the engine's own enumeration and
 *    offers it; arming with the option on and nothing offerable refuses locally, before any
 *    shell command.
 *  · **The no-Tailscale path exists.** With the probe guiding (no CLI), the pane still offers
 *    same-network access, and its enable arms with the chosen address — on the screen where a
 *    person without Tailscale actually lands.
 *  · **Two truths render at once.** A LAN-only install is degraded (the tailnet half) AND
 *    serving (the same-network half); the pane says both instead of picking the flattering one.
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
const globe = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

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

let asked: Array<{ command: string; payload?: Record<string, unknown> }> = [];

function shell(world: {
  hostState: unknown;
  tailscale: unknown;
  armAnswer?: unknown;
  routes?: Record<string, { status: number; body: unknown }>;
}): void {
  asked = [];
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      asked.push(payload === undefined ? { command } : { command, payload });
      switch (command) {
        case "host_state":
          return Promise.resolve(world.hostState);
        case "tailscale_status":
          return Promise.resolve(world.tailscale);
        case "tailscale_serve_arm":
          return Promise.resolve(world.armAnswer ?? world.hostState);
        case "open_tailscale_download":
          return Promise.resolve(undefined);
        case "engine_request": {
          const p = payload as { method: string; url: string };
          const route = world.routes?.[`${p.method} ${p.url}`];
          if (!route) return Promise.resolve(framed(404, { error: { code: "not_found" } }));
          return Promise.resolve(framed(route.status, route.body));
        }
        default:
          return Promise.reject(new Error(`unstubbed command ${command}`));
      }
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  hostEl?.remove();
  delete globe.__TAURI_INTERNALS__;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, null, h(ToastHost, null, h(DesktopDevices)))),
    );
  });
  await flush();
}

const text = (): string => hostEl.textContent ?? "";
const button = (label: string): HTMLButtonElement => {
  const found = [...hostEl.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
};
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
};

const enHost = (en as { host: Record<string, string> }).host;

const ORIGIN = "https://sonoma.tail1234.ts.net";
const RUNNING = { state: "running", dnsName: "sonoma.tail1234.ts.net", version: "1.66.0" };
const OFF = {
  enabled: false, port: null, origin: null, lan: null, lanState: null,
  state: "off", problem: null, autostart: null,
};
const EMPTY_LISTS = {
  "GET /pair": { status: 200, body: { items: [] } },
  "GET /devices": { status: 200, body: { items: [] } },
};
const CANDIDATES = {
  "GET /local/lan/candidates": {
    status: 200,
    body: { items: [{ address: "192.168.1.23", name: "en0" }, { address: "10.0.0.7", name: "en5" }] },
  },
};
/** Tailnet serving with the LAN half also on. */
const BOTH = {
  enabled: true, port: 47800, origin: ORIGIN, lan: "192.168.1.23", lanState: "serving",
  state: "serving", problem: null, autostart: true,
};
/** The no-Tailscale install: tailnet degraded, same-network serving — two truths at once. */
const LAN_ONLY = {
  enabled: true, port: 47800, origin: null, lan: "192.168.1.23", lanState: "serving",
  state: "degraded", problem: "no-cli", autostart: true,
};

describe("the serving LAN row and its honest copy", () => {
  it("shows the address, the apps-only promise, the awake qualifier and the browser note", async () => {
    shell({ hostState: BOTH, tailscale: RUNNING, routes: EMPTY_LISTS });
    await mount();
    expect(text()).toContain(enHost.lanTitle!);
    expect(text()).toContain("The mail API is served at http://192.168.1.23:47800");
    expect(text()).toContain("while this computer is awake");
    // The honesty line, verbatim from the catalog: the capability is the API, not a browser.
    expect(text()).toContain(enHost.lanBrowserNote!);
    expect(button(enHost.lanCopy!)).toBeTruthy();
    // And no QR is offered for the LAN address — the QR is the Tailscale pairing's alone.
  });

  it("a LAN-only install renders BOTH truths: the tailnet guidance and the serving LAN half", async () => {
    shell({ hostState: LAN_ONLY, tailscale: RUNNING, routes: EMPTY_LISTS });
    await mount();
    expect(text()).toContain(enHost.guideNoCli!);
    expect(text()).toContain("The mail API is served at http://192.168.1.23:47800");
    expect(text()).toContain(enHost.lanBrowserNote!);
  });

  /**
   * ── THE HONESTY GUARD ────────────────────────────────────────────────────────────────────
   *
   * The shipped defect: on a default-deny distribution (Omarchy/Arch with ufw — the platform
   * this feature is aimed at) arming same-network access binds the port and does not open the
   * firewall. The pane said "The mail API is served at … for apps on your network" while nothing
   * on the network could reach it, with nothing on screen saying why.
   *
   * `blocked` is the state the engine reaches by READING the firewall's own files. It cannot
   * reach it by probing itself: a connection to an address this machine holds is routed over
   * `lo`, which ufw accepts unconditionally, so the probe answers happily through a closed
   * firewall. Measured, not reasoned — see `apps/sidecar/src/host-firewall.ts`.
   *
   * The three claims below are what "honest" means here, and each has a mutation that reddens it:
   * the serving sentence must NOT appear, the reason must, and the exact command must.
   */
  it("a firewalled LAN door never claims it is serving — it says why and gives the command", async () => {
    shell({
      hostState: { ...BOTH, lanState: "blocked" },
      tailscale: RUNNING,
      routes: EMPTY_LISTS,
    });
    await mount();
    // 1. THE CLAIM IS GONE. This is the assertion the defect would fail.
    expect(text()).not.toContain("The mail API is served at");
    // 2. The truth, naming the firewall and the port, in the operator's language.
    expect(text()).toContain("this computer's firewall is not letting anything through to port 47800");
    // 3. The remedy, verbatim and runnable — the command that made it work when measured.
    expect(text()).toContain("sudo ufw allow 47800/tcp");
    expect(button(enHost.checkAgain!)).toBeTruthy();
    // The address is still shown and still copyable: it is the right address, and the operator
    // is one command from it working. A blocked door must not become a dead end.
    expect(text()).toContain("http://192.168.1.23:47800");
    expect(button(enHost.lanCopy!)).toBeTruthy();
  });

  it("the serving sentence no longer promises reachability it has not checked", async () => {
    // The other half of the same repair. `serving` is reported on every machine whose firewall
    // this code cannot read — macOS, Windows, nftables, no firewall at all — so the sentence has
    // to be true there too. It points at the firewall instead of guaranteeing past it.
    shell({ hostState: BOTH, tailscale: RUNNING, routes: EMPTY_LISTS });
    await mount();
    expect(text()).toContain("check that this computer's firewall allows port 47800");
  });

  it("a failed LAN door says so instead of showing an address nobody can dial", async () => {
    shell({
      hostState: { ...BOTH, lanState: "failed" },
      tailscale: RUNNING,
      routes: EMPTY_LISTS,
    });
    await mount();
    expect(text()).toContain(enHost.lanFailed!);
    expect(text()).not.toContain("http://192.168.1.23");
  });
});

describe("the ceremony's LAN option", () => {
  it("opening the toggle loads the engine's enumeration and arming carries the chosen address", async () => {
    shell({
      hostState: OFF, tailscale: RUNNING, armAnswer: BOTH,
      routes: { ...EMPTY_LISTS, ...CANDIDATES },
    });
    await mount();
    // Two switches in the ready ceremony: start-at-login first, the LAN option second.
    const switches = [...hostEl.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(2);
    await click(switches[1] as HTMLElement);
    const select = hostEl.querySelector("select")!;
    expect(select).toBeTruthy();
    expect(select.options[0]!.value).toBe("192.168.1.23");
    await click(button(enHost.enable!));
    const arm = asked.find((a) => a.command === "tailscale_serve_arm");
    expect(arm?.payload).toMatchObject({ autostart: true, lan: "192.168.1.23" });
  });

  it("the option on with nothing offerable refuses locally — no shell command, one sentence", async () => {
    shell({
      hostState: OFF, tailscale: RUNNING,
      routes: { ...EMPTY_LISTS, "GET /local/lan/candidates": { status: 200, body: { items: [] } } },
    });
    await mount();
    const switches = [...hostEl.querySelectorAll('[role="switch"]')];
    await click(switches[1] as HTMLElement);
    expect(text()).toContain(enHost.lanNone!);
    await click(button(enHost.enable!));
    expect(asked.some((a) => a.command === "tailscale_serve_arm")).toBe(false);
  });

  it("the no-Tailscale path: the guiding screen still offers same-network access and arms with it", async () => {
    shell({
      hostState: OFF, tailscale: { state: "no-cli" }, armAnswer: LAN_ONLY,
      routes: { ...EMPTY_LISTS, ...CANDIDATES },
    });
    await mount();
    expect(text()).toContain(enHost.guideNoCli!);
    expect(text()).toContain(enHost.lanAlone!);
    expect(text()).toContain(enHost.lanAloneWhy!);
    const lanSwitch = hostEl.querySelector('[role="switch"]')!;
    await click(lanSwitch as HTMLElement);
    await click(button(enHost.lanEnable!));
    const arm = asked.find((a) => a.command === "tailscale_serve_arm");
    expect(arm?.payload).toMatchObject({ lan: "192.168.1.23" });
    // The answer is the LAN-only state: degraded tailnet, serving LAN — both rendered.
    expect(text()).toContain("The mail API is served at http://192.168.1.23:47800");
  });

  it("the no-Tailscale ceremony shows the start-at-login choice, visible and honoured", async () => {
    // The ruled ceremony line: start-at-login is "a visible default-checked line of the enable
    // ceremony" — EVERY enable ceremony. Without it here, arming the fallback would register
    // the app at login off an invisible default.
    shell({
      hostState: OFF, tailscale: { state: "no-cli" }, armAnswer: LAN_ONLY,
      routes: { ...EMPTY_LISTS, ...CANDIDATES },
    });
    await mount();
    await click(hostEl.querySelector('[role="switch"]') as HTMLElement);
    const autostart = [...hostEl.querySelectorAll('[role="switch"]')]
      .find((s) => s.getAttribute("aria-label") === enHost.autostart);
    expect(autostart, "the start-at-login switch must be visible in this ceremony").toBeTruthy();
    expect(autostart!.getAttribute("aria-checked")).toBe("true");
    await click(autostart as HTMLElement);
    await click(button(enHost.lanEnable!));
    const arm = asked.find((a) => a.command === "tailscale_serve_arm");
    expect(arm?.payload).toMatchObject({ lan: "192.168.1.23", autostart: false });
  });
});

describe("pairing in LAN-only mode — the door must be enterable, not just addressed", () => {
  const MINT = {
    "POST /pair": {
      status: 200,
      body: { id: "pm_1", grant: "device-pair", token: "dpt_lanonly4be6f0a92d3c41e7", label: "" },
    },
  };

  it("a LAN-only serving install offers the add-a-device mint, and the minted link targets the LAN address — copy only, no QR", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } },
    });
    shell({ hostState: LAN_ONLY, tailscale: RUNNING, routes: { ...EMPTY_LISTS, ...MINT } });
    await mount();
    // The bearer-only door's ONLY public bootstrap is /pair/redeem; without a mint here the
    // pane would advertise an address nothing can ever authenticate against.
    expect(text()).toContain(enHost.lanAddHint!);
    await click(button(enHost.addAction!));
    expect(text()).toContain(enHost.lanMintedLead!);
    expect(text()).toContain(enHost.mintedOnce!);
    // No QR in LAN-only: a camera scan would open a phone BROWSER, which this door refuses by
    // design — the copy button is the whole hand-over.
    expect(hostEl.querySelector("svg")).toBeNull();
    await click(button(enHost.copyLink!));
    expect(written).toEqual(["http://192.168.1.23:47800/pair#dpt_lanonly4be6f0a92d3c41e7"]);
  });

  it("with the tailnet serving, the mint keeps its QR and the tailnet origin — the LAN row changes nothing there", async () => {
    shell({ hostState: BOTH, tailscale: RUNNING, routes: { ...EMPTY_LISTS, ...MINT } });
    await mount();
    await click(button(enHost.addAction!));
    // The browser flow's lead and the QR stand exactly as the Devices pane first shipped them.
    expect(text()).toContain(enHost.mintedLead!);
    expect(hostEl.querySelector("svg")).not.toBeNull();
  });
});
