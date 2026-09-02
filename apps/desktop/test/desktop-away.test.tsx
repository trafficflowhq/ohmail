/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { AwayResponderRow } from "../../webapp/app/shell/AwayResponderRow";
import { awayDoorFor } from "../src/doors.js";
import { AWAY_PATH, awayOverBridge } from "../src/local-away.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * THE AWAY RESPONDER IN THE APP — available on the hosted door, absent on the standalone one.
 *
 * The control shipped in the browser and was missing here on BOTH doors, and only one of those two
 * absences was intended. The shared shell offers it when `apiConfigured()` says there is a server;
 * that is false in every desktop build, both doors, because `vite.config.ts` aliases the Cloud
 * client to a stub whose value exports refuse. So a hosted install — mirroring a real account, with
 * a hosted worker standing by to send — was told it had no away responder.
 *
 * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────────
 *
 *  1. THE HOSTED DOOR GETS IT, over the pipe. The window cannot open a socket, so the proof is in
 *     the request that leaves: `GET`/`PUT /away-responder`, addressed root-relative, to the engine.
 *     The engine serves no such route locally in cloud mode and forwards it to the account with the
 *     bearer, which is what makes the row that is written the HOSTED account's own.
 *  2. IT IS THE SHARED CONTROL, not a copy. One `PUT /away-responder` whose `updatedAt` is the
 *     enablement episode the worker's at-most-once record is filed under; two implementations would
 *     be two definitions of when an episode begins, and the visible failure — one correspondent
 *     answered twice — would show up in somebody's mailbox rather than in a suite.
 *  3. THE STANDALONE DOOR GETS NOTHING, and that is structural rather than a refusal on press. The
 *     local engine would answer these routes perfectly well out of its own database; nothing on
 *     that door SENDS the reply, so a control there would store a configuration that answers
 *     nobody. `awayDoorFor` is where that rule lives.
 *  4. NOTHING REACHES THE CLOUD CLIENT. `fetch` is booby-trapped below: a control that fell back to
 *     the hosted client would throw rather than pass.
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

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke };
}
const host = globalThis as unknown as Host;

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

interface Asked { method: string; url: string; body: Record<string, unknown> | null }

/** The account's stored row, as the hosted API would answer it through the engine's forward. */
let stored: Record<string, unknown>;
let asked: Asked[];

function engineAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const p = (payload ?? {}) as { method?: string; url?: string; body?: number[] };
      const raw = p.body && p.body.length > 0 ? new TextDecoder().decode(Uint8Array.from(p.body)) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      asked.push({ method: p.method ?? "GET", url: p.url ?? "", body });
      if ((p.url ?? "") !== AWAY_PATH) {
        return encode(404, JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
      }
      // The FULL REPLACE the hosted route performs, with a fresh `updatedAt` — the enablement
      // episode. Answered from what was stored, never from what was asked for.
      if ((p.method ?? "GET").toUpperCase() === "PUT") {
        stored = { ...(body ?? {}), updatedAt: "2026-08-07T12:00:00.000Z" };
      }
      return encode(200, JSON.stringify(stored));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

async function mountRow(): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(
          ThemeProvider,
          null,
          h(ToastHost, null, h(AwayResponderRow, { transport: awayOverBridge })),
        ),
      }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** React's controlled inputs ignore a plain `.value=`; go through the native setter. */
function setNative(el: HTMLInputElement | HTMLTextAreaElement, v: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  asked = [];
  stored = {
    enabled: false, body: null, startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", updatedAt: null,
  };
  engineAnswering();
  /* BOOBY TRAP. Nothing on this path may reach the hosted client: this window has
     `connect-src 'none'` and the packaged bundle has no API client at all. A fallback to it would
     land here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the desktop window opened a socket — nothing here may reach the network");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the away responder on the hosted door", () => {
  /**
   * THE ROUTE, AS A LITERAL. Everything below addresses `AWAY_PATH`, which makes every one of those
   * assertions true of whatever string this module happens to hold — a wrong path passes them all.
   * (Checked: renaming it to `/account/away` left all nine green.) It is the hosted API's own
   * endpoint, and it is load-bearing twice over: the engine's cloud-mode read table deliberately
   * does NOT list it, which is the whole reason a hosted install's request is FORWARDED to the
   * account rather than answered from the local mirror — and a locally-answered PUT would store
   * an away responder no worker anywhere reads.
   */
  it("is the hosted API's own endpoint, spelled exactly", () => {
    expect(AWAY_PATH).toBe("/away-responder");
  });

  it("reads the account's row over the pipe, and draws the stored state", async () => {
    stored = { ...stored, enabled: true, body: "Back Monday.", audience: "everyone", throttle: "per_week" };
    await mountRow();
    expect(asked).toEqual([{ method: "GET", url: AWAY_PATH, body: null }]);
    expect((hostEl.querySelector("#away-body") as HTMLTextAreaElement).value).toBe("Back Monday.");
    expect((hostEl.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked")).toBe("true");
    // There is no subject to draw: the responder replies in the correspondent's own thread.
    expect(hostEl.querySelector("#away-subject")).toBeNull();
  });

  it("saves the whole row in ONE explicit PUT — one press, one enablement episode", async () => {
    await mountRow();
    await click(hostEl.querySelector('[role="switch"]')!);
    setNative(hostEl.querySelector("#away-body") as HTMLTextAreaElement, "Back Monday.");
    const save = [...hostEl.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    await click(save);

    const puts = asked.filter((a) => a.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(AWAY_PATH);
    // A FULL REPLACE, every field named — the route stores what it is handed. A partial body would
    // blank the fields it omitted on a row somebody had already filled in.
    expect(puts[0]!.body).toEqual({
      enabled: true, body: "Back Monday.",
      startsAt: null, endsAt: null, audience: "screened_in", throttle: "per_day",
    });
    expect(hostEl.textContent).toContain("Saved.");
    // …and no second read: the control renders the PUT's own echo.
    expect(asked.filter((a) => a.method === "GET")).toHaveLength(1);
  });

  it("says so when the account cannot be reached, rather than leaving its pane blank", async () => {
    // `503 offline_read_only` — what the engine answers before it forwards anything while the
    // hosted account is out of reach. As the Screener pane's last row this could draw nothing; as
    // a pane of its own, nothing is a nav entry onto an empty rectangle.
    host.__TAURI_INTERNALS__ = {
      invoke: async () => encode(503, JSON.stringify({
        error: { code: "offline_read_only", message: "this install is offline" },
      })),
    };
    await mountRow();
    expect(hostEl.textContent).toContain("could not be read");
    // Still no controls: a resting OFF switch shown to somebody whose responder is ON would be a
    // lie about mail going out.
    expect(hostEl.querySelector('[role="switch"]')).toBeNull();
  });
});

/** WHICH DOOR MAY CONFIGURE ONE — the decision on its own, without a window around it. */
describe("the door that may configure an away responder", () => {
  const serving = (over: Partial<EngineStatus>): EngineStatus => ({
    state: "serving", mailboxId: "mbx-1", credentialState: "ready", ...over,
  });

  it("is the hosted door, signed in", () => {
    expect(awayDoorFor(serving({ mode: "cloud" }))).toBe("cloud");
  });

  /**
   * THE STANDALONE ARM, which this block used to assert was permanently `null`.
   *
   * It said: *"is NEVER the standalone door — the sender lives in the hosted worker… Nothing on
   * this door sends the reply, so a control here would store a configuration that answers
   * nobody."* True when written, and false since the pass moved into `@trafficflow/services` —
   * which the desktop engine bundles — and began running in the sidecar's drain with this
   * machine's own SMTP dial.
   *
   * The promise on that door is genuinely smaller (replies go out while the app is open) and the
   * pane says so; that is a sentence, not a reason to withhold the control. It is asserted for
   * BOTH credential states because the credential is not what gates it: the responder is
   * configuration, and hiding the setting on the launch where somebody is mid-setup is the
   * failure `profileImportDoorFor` already argues against.
   */
  it("is ALSO the standalone door — the engine on this machine sends while the window is open", () => {
    expect(awayDoorFor(serving({ mode: "local" }))).toBe("local");
    expect(awayDoorFor(serving({ mode: "local", credentialState: "ready" }))).toBe("local");
    expect(awayDoorFor(serving({ mode: "local", credentialState: "absent" }))).toBe("local");
  });

  it("distinguishes the two live doors rather than answering a boolean", () => {
    // The caller needs WHICH door: `"local"` also selects the "while ohmail is open on this
    // computer" note, and a boolean would put that sentence on the hosted pane where it is false.
    expect(awayDoorFor(serving({ mode: "local" }))).not.toBe(awayDoorFor(serving({ mode: "cloud" })));
  });

  it("is nothing while there is no hosted session, no door, or no answer from the shell", () => {
    expect(awayDoorFor(serving({ mode: "cloud", credentialState: "absent" }))).toBeNull();
    expect(awayDoorFor(serving({ mode: "cloud", credentialState: "unreadable" }))).toBeNull();
    expect(awayDoorFor(serving({ mode: "cloud", credentialState: "unknown" }))).toBeNull();
    expect(awayDoorFor(serving({ mode: null }))).toBeNull();
    expect(awayDoorFor(null)).toBeNull();
  });
});

/**
 * THE WIRING BETWEEN TWO APPLICATIONS, PINNED BY SOURCE.
 *
 * Same argument as the suggest control's in `desktop-shell.test.ts`: the behaviour is driven where
 * it can be driven — above, and in the shared client's own suite over the pane — but the edge
 * between `DesktopGate` and the shared shell has no single place to render, and deleting it leaves
 * every suite in both applications green.
 */
describe("the wiring, pinned by source", () => {
  const gate = read("src/DesktopGate.tsx");
  const shell = fs.readFileSync(
    path.resolve(APP, "../webapp/app/shell/AppShell.tsx"),
    "utf8",
  );

  it("the window hands its transport in on EITHER live door, and says which one", () => {
    // One wire, both doors — the engine decides what to do with the request (forward it to the
    // account, or answer it out of the store on this machine). `awayIsLocal` carries the only
    // difference the window is responsible for: the sentence about replies going out while the
    // app is open, which is true on one door and false on the other.
    expect(gate).toMatch(/awayDoorFor\(status\) !== null/);
    expect(gate).toMatch(/awayTransport: awayOverBridge, awayIsLocal: awayDoorFor\(status\) === "local"/);
  });

  it("the shared shell admits a host transport as a second way to be supported", () => {
    // Without this the desktop's node is wired and the shell still withholds the control, because
    // `apiConfigured()` is false in this build whatever door it came in by.
    expect(shell).toMatch(/const awaySupported = autoOptIn\.supported \|\| awayTransport !== undefined;/);
    expect(shell).toMatch(/awaySection=\{demo \|\| !awaySupported \? undefined : \(/);
    expect(shell).toMatch(
      /<AwayResponderRow onChanged=\{awayNotice\.update\} transport=\{awayTransport\} local=\{awayIsLocal \?\? false\} \/>/,
    );
  });

  it("the shared files name none of the transport — no bridge, no Tauri, no engine", () => {
    const row = fs.readFileSync(
      path.resolve(APP, "../webapp/app/shell/AwayResponderRow.tsx"),
      "utf8",
    );
    for (const shared of [shell, row]) {
      expect(shared).not.toMatch(/bridgeFetch|__TAURI/);
    }
    // …and the control is genuinely the shared one, imported rather than reimplemented here.
    expect(fs.existsSync(path.join(APP, "src", "DesktopAway.tsx"))).toBe(false);
    expect(read("src/local-away.ts")).toMatch(/from "\.\/bridge-fetch\.js"/);
  });
});
