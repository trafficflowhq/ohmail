/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate, LIFECYCLE_POLL_MS } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * ═══ THE LIFECYCLE STAYS OWNED PAST "SERVING" ════════════════════════════════════════════════
 *
 * The window asked the shell what the engine was doing while it was STARTING and stopped asking
 * the moment it served. Rust goes on changing its mind — an engine can die, be restarted, come
 * back — and every one of those was written to the log and delivered to nobody, so the screen
 * kept describing a run that had ended until somebody reloaded the window. A window showing a
 * mailbox nothing is behind is the failure this product keeps meeting: healthy-looking, false.
 *
 * So the ask continues at a slow steady cadence, and what it learns is rendered. The cadence is
 * a floor, not a poll for its own sake: pinned here so nobody shortens it into an idle cost.
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

/** A paired install whose session was revoked — the surface that can open a door overlay. */
const PAIRED_REVOKED: EngineStatus = {
  state: "serving",
  mode: "cloud",
  flavor: "desktop-host",
  address: "someone@example.com",
  mailboxId: "mbx-1",
  baseUrl: "https://kestrel.tail1234.ts.net",
  credentialState: "ready",
};

const LOCAL_SERVING: EngineStatus = {
  state: "serving",
  mode: "local",
  address: "someone@example.com",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

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
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});

/** The shell behind the bridge, with a status this test moves and a count of the asks. */
function fakeShell(initial: EngineStatus): {
  set(next: EngineStatus): void;
  health(next: Record<string, unknown>): void;
  asks(): number;
} {
  let status = initial;
  let asks = 0;
  let health: Record<string, unknown> = { signedIn: true };
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        asks++;
        return status;
      }
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify(health));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return {
    set: (n) => { status = n; },
    health: (n) => { health = n; },
    asks: () => asks,
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      <IntlProvider locale="en" messages={messages as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme">
          <ToastHost>
            <DesktopGate />
          </ToastHost>
        </ThemeProvider>
      </IntlProvider>,
    );
  });
  await advance(0);
  return mountPoint;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = (): string => mountPoint?.textContent ?? "";
/** The mail app's unmistakable text — the rail entry only `AppShell` renders. */
const mounted = (): boolean => text().includes("Ohbox");

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = "";
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  window.location.hash = "";
  localStorage.clear();
});

describe("the gate owns the engine lifecycle past serving", () => {
  it("an engine that DIES after serving reaches the screen within one cadence", async () => {
    const shell = fakeShell(LOCAL_SERVING);
    await render();
    expect(mounted(), "the mail app never mounted, so nothing here measures a death").toBe(true);

    /* The engine died. Rust knows; nothing has told the window. */
    shell.set({ ...LOCAL_SERVING, state: "failed", reason: "the engine stopped and did not come back" });
    await advance(LIFECYCLE_POLL_MS + 50);

    expect(text(), "the window still describes the run that ended")
      .toContain("the engine stopped and did not come back");
    expect(mounted(), "the mail app is still on screen over a dead engine").toBe(false);
  });

  it("an engine that stays serving renders no change at all", async () => {
    /* The positive control: a live owner that redrew the window on every tick would pass the
       case above and be a worse product than the defect. */
    fakeShell(LOCAL_SERVING);
    await render();
    const before = text();
    await advance(LIFECYCLE_POLL_MS * 3);
    expect(mounted()).toBe(true);
    expect(text()).toBe(before);
  });

  it("a run that moves while a door is open leaves the door on screen", async () => {
    /* ── WHAT A LIVE OWNER MUST NOT COST ────────────────────────────────────────────────────
     * A delivered lifecycle move re-keys the door's auth answer, and a pending auth answer is
     * one of this component's early returns — above the element that renders the overlay. So a
     * steady owner that delivers a move while somebody is standing in a door would take the
     * door off the screen mid-attempt, with whatever they had typed. The door is rendered by
     * the branch that is on screen, which is the same rule the revoked notice keeps.
     */
    const shell = fakeShell(PAIRED_REVOKED);
    shell.health({ signedIn: false, sessionExpired: true });
    const el = await render();
    await advance(500);
    expect(text(), "the revoked notice never rendered, so nothing here opens a door")
      .toContain("no longer paired");

    const pairAgain = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Pair again"));
    await act(async () => {
      pairAgain!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await advance(200);
    expect(text(), "the pairing door did not open").toContain("Paste the pairing link");

    /* Somebody is standing in it, with something typed. This is what a remount costs, and a
       sentence still on screen does not prove the element behind it survived. */
    const field = el.querySelector<HTMLInputElement>("#host-link")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, "https://kestrel.tail1234.ts.net/pair#code");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelector<HTMLInputElement>("#host-link")!.value).not.toBe("");

    /* The engine is replaced under the open door — a restart, exactly what a door attempt
       causes — and the steady owner delivers it. */
    shell.set({ ...PAIRED_REVOKED, state: "restarting" });
    await advance(LIFECYCLE_POLL_MS + 500);

    expect(text(), "the delivered move took the open door off the screen")
      .toContain("Paste the pairing link");
    expect(
      el.querySelector<HTMLInputElement>("#host-link")!.value,
      "the door was remounted under the person: what they had typed is gone",
    ).toBe("https://kestrel.tail1234.ts.net/pair#code");
  });

  it("asks on the steady cadence and never faster — the floor, pinned", async () => {
    /* DT-R8-05 is the idle-wake row: this window may not buy its liveness with a fast poll. The
       floor is five seconds and the ask must not happen before it. */
    expect(LIFECYCLE_POLL_MS).toBeGreaterThanOrEqual(5_000);
    const shell = fakeShell(LOCAL_SERVING);
    await render();
    const settled = shell.asks();
    await advance(LIFECYCLE_POLL_MS - 100);
    expect(shell.asks(), "the steady owner asked before its own cadence").toBe(settled);
    await advance(200);
    expect(shell.asks(), "the steady owner stopped asking").toBe(settled + 1);
  });
});
