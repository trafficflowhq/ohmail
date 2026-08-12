/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { DesktopGate } from "../src/DesktopGate.js";
import { bootSentence } from "../src/BootStatus.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * ═══ THE BOOT'S WORDS SIT WHERE THE APP'S OWN SYNC LINE SITS — AND THEY ARE THE ENGINE'S ═══
 *
 * The launch used to be one centred card — a wordmark and one sentence — over an empty window,
 * for anything from half a second to the minute a write-ahead-log recovery takes. Two things
 * were wrong with that, and each half of this file pins the repair for one of them:
 *
 *  · WHERE. The app already has a corner where it reports work that is not the reader's job —
 *    the sync line at the foot of the rail. The boot now borrows that surface (`BootStatus`
 *    renders the sync line's own classes over the skeleton's rail), so the wait and the work
 *    that follows it read as one continuous thing in one place. The centred card is gone from
 *    the opening state; `GateNotice` keeps it for apologies, which are a different thing.
 *
 *  · WHAT. The sentence is the engine's own account of the wait: the engine writes `phase`
 *    frames while it starts, the shell surfaces the latest as `status.bootPhase`, and
 *    {@link bootSentence} maps that closed set to words. A recovery launch says "Replaying
 *    recent changes…" instead of one sentence for every wait — and a phase this build does not
 *    know must fall back to the generic sentence rather than surface as a wire token.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: unknown, once?: boolean) => number };
}
const host = globalThis as unknown as Host;

const STARTING: EngineStatus = {
  state: "starting",
  mode: "local",
  address: "someone@example.test",
  credentialState: "ready",
};

function shell(status: EngineStatus): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command) => {
      if (command === "engine_status") return status;
      if (command === "plugin:event|listen") return null;
      return null;
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<void> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("where the boot line stands", () => {
  it("the opening state has no centred card — the words are the sync line's shape, over the rail", async () => {
    shell(STARTING);
    await render();

    expect(mountPoint!.querySelector(".gate-card"), "the centred boot card is back").toBeNull();

    const line = mountPoint!.querySelector<HTMLElement>(".gate-boot .rail-sync.busy");
    expect(line, "no sync-line-shaped boot status in the opening state").not.toBeNull();
    // Its pieces are the sync line's pieces — the spinner and the travelling track — so the boot
    // reads as the same affordance the rail will carry once the engine serves.
    expect(line!.querySelector(".mbx-spin")).not.toBeNull();
    expect(line!.querySelector(".rs-track")).not.toBeNull();

    // Anchored at the rail's foot: bottom-left of the window, not centred over the canvas.
    const anchor = line!.parentElement as HTMLElement;
    expect(anchor.style.position).toBe("absolute");
    expect(Number.parseInt(anchor.style.bottom, 10)).toBeGreaterThan(0);
    expect(Number.parseInt(anchor.style.left, 10)).toBeGreaterThan(0);
    // A live region, exactly like the sync line it stands in for.
    expect(anchor.getAttribute("role")).toBe("status");
  });

  it("is gone once the engine serves — the real rail takes the corner over", async () => {
    shell({ ...STARTING, state: "serving", mailboxId: "mbx-1" });
    // The serving path mounts the real client over the bridge; the two reads it makes at mount
    // (the snapshot and the mailbox list) need answers or the mount throws instead of rendering.
    const encode = (body: string): Uint8Array => {
      const meta = new TextEncoder().encode(JSON.stringify({ status: 200, statusText: "OK", h: [] }));
      const payload = new TextEncoder().encode(body);
      const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
      new DataView(out.buffer).setUint32(0, meta.byteLength, false);
      out.set(meta, 4);
      out.set(payload, 4 + meta.byteLength);
      return out;
    };
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, payload) => {
        if (command === "engine_status") return { ...STARTING, state: "serving", mailboxId: "mbx-1" };
        if (command === "plugin:event|listen") return null;
        if (command === "engine_request") {
          const url = String(payload?.url ?? "");
          if (url.startsWith("/sync/snapshot")) {
            return encode(JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } }));
          }
          if (url.startsWith("/mailboxes")) return encode(JSON.stringify({ items: [] }));
          return encode(JSON.stringify({
            changes: { creates: [], updates: [], moves: [], deletes: [] },
            cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z",
          }));
        }
        return null;
      },
    };
    await render();

    expect(mountPoint!.querySelector(".gate-boot .rail-sync"), "the boot line outlived the boot").toBeNull();
  });
});

describe("what the boot line says — the engine's phase, mapped, never echoed", () => {
  it("a replaying engine says so", async () => {
    shell({ ...STARTING, bootPhase: "replaying_wal" });
    await render();
    expect(mountPoint!.textContent).toContain("Replaying recent changes…");
  });

  it("with no phase yet, the generic sentence — the one true in every case", async () => {
    shell(STARTING);
    await render();
    expect(mountPoint!.textContent).toContain("Opening your mailbox…");
  });

  it("a phase this build does not know falls back rather than surfacing as a wire token", async () => {
    shell({ ...STARTING, bootPhase: "defragmenting_flux_capacitor" });
    await render();
    expect(mountPoint!.textContent).not.toContain("defragmenting_flux_capacitor");
    expect(mountPoint!.textContent).toContain("Opening your mailbox…");
  });

  it("the whole table, driven — every announced phase has words and every stranger has the fallback", () => {
    expect(bootSentence("creating_store")).toBe("Setting up your local mail store…");
    expect(bootSentence("opening_store")).toBe("Opening your local mail store…");
    expect(bootSentence("replaying_wal")).toBe("Replaying recent changes…");
    expect(bootSentence("migrating")).toBe("Updating your local mail store…");
    for (const stranger of [undefined, null, "", "preparing", "nonsense", "REPLAYING_WAL"]) {
      expect(bootSentence(stranger), `phase ${String(stranger)}`).toBe("Opening your mailbox…");
    }
  });
});
