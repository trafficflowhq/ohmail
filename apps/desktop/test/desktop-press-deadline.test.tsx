/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import { BRIDGE_DEADLINE_MS } from "../src/bridge-fetch.js";
import { DesktopDevices } from "../src/DesktopDevices.js";

/**
 * A PRESS AGAINST A WEDGED ENGINE ENDS IN A SENTENCE (the transport deadline). The engine process is alive and the
 * bridge request never comes back — before the transport deadline this press stayed "pending"
 * for ever with nothing rendered. Driven through a REAL pane (the Devices mint press), not a
 * bridge unit: the property under test is that the deadline's named rejection reaches a press
 * site's own catch and renders as the person's sentence, which no transport-level assertion
 * can prove.
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

const ORIGIN = "https://sonoma.tail1234.ts.net";
const RUNNING = { state: "running", dnsName: "sonoma.tail1234.ts.net", version: "1.66.0" };
const SERVING = { enabled: true, port: 47800, origin: ORIGIN, state: "serving", problem: null, autostart: true };

const LISTS: Record<string, { status: number; body: unknown }> = {
  "GET /pair": { status: 200, body: { items: [] } },
  "GET /devices": {
    status: 200,
    body: {
      items: [
        { id: "sess-self", kind: "web", label: "", createdAt: "2026-08-19T09:00:00Z", lastSeenAt: "2026-08-19T12:00:00Z", ip: "", current: true, pushToken: null },
      ],
    },
  },
};

/** The stand-in shell: every route answers except the PRESS's own, which never comes back. */
function shellWithWedgedPress(): void {
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      switch (command) {
        case "host_state":
          return Promise.resolve(SERVING);
        case "tailscale_status":
          return Promise.resolve(RUNNING);
        case "engine_request": {
          const p = payload as { method: string; url: string };
          if (`${p.method} ${p.url}` === "POST /pair") return new Promise(() => {});
          const hit = LISTS[`${p.method} ${p.url}`];
          return Promise.resolve(framed(hit?.status ?? 404, hit?.body ?? { error: { code: "not_found" } }));
        }
        default:
          return Promise.resolve(undefined);
      }
    },
  };
}

const hostCopy = (en as { host: Record<string, string> }).host;

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root.unmount());
  hostEl?.remove();
  delete globe.__TAURI_INTERNALS__;
});

describe("a press against a wedged-but-alive engine", () => {
  it("ends in the deadline's sentence on the pane, never a forever-pending state", async () => {
    shellWithWedgedPress();
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
    await act(async () => {
      root.render(
        /* `as never` for the positional-children overload — the shape the sibling harness
           (`desktop-mailboxes.test.ts`) carries for the same providers. */
        h(NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" } as never,
          h(ThemeProvider, null as never, h(ToastHost, null, h(DesktopDevices)))),
      );
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    });

    const press = [...hostEl.querySelectorAll("button")]
      .find((b) => b.textContent === hostCopy.addAction);
    expect(press, `no "${hostCopy.addAction}" button — the world below did not reach the pane`)
      .toBeDefined();

    // The press, then the whole deadline on a virtual clock. Fake timers go on only now: the
    // mount above settles on real ones, and the press's own request is the one that hangs.
    vi.useFakeTimers();
    await act(async () => {
      press!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(hostEl.querySelector('[role="alert"]')).toBeNull(); // pending, not yet a sentence
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
    });
    vi.useRealTimers();
    await act(async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    });

    const alert = hostEl.querySelector('[role="alert"]');
    expect(alert, "the deadline rejection never reached the pane").not.toBeNull();
    expect(alert!.textContent).toContain(
      "the local engine did not answer within a minute, so this request was given up.",
    );
  });
});
