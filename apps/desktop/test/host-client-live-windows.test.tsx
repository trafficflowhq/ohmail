/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import messages from "../../webapp/messages/en.json";
import type { JunkWire } from "../../webapp/app/shell/junk-window";
import type { TrashWire } from "../../webapp/app/shell/trash-window";
import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";

/**
 * ═══ THE PAIRED PHONE'S TWO LIVE WINDOWS — the wires the host door was not handing in ════════
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────────────
 *
 * `HostGate` mounts the SAME shell the desktop window mounts, and this artifact aliases
 * `app/api-client` to a refusing stub exactly as the window's does — so both live windows (the
 * Screener's Junk segment and the Trash view's second section) decide `supported` from a wire
 * that is not there and report "no server". The gate handed in `olderBodyWire` and nothing else,
 * so on a paired phone or host client both sections were absent with no state naming why, while
 * `desktopHostRoutes` spreads `localRoutes` and serves all four reads one hop away.
 *
 * ── WHY IT IS ONE FIX AND NOT TWO ───────────────────────────────────────────────────────────
 *
 * The two windows are one absence with one cause: neither folder is ever mirrored, so neither can
 * be answered locally, and both hooks read the same refusing stub. Wiring one would leave the
 * other silently missing on the same door for the same reason, so the pair is asserted as a pair.
 *
 * ── WHAT IS MEASURED HERE ───────────────────────────────────────────────────────────────────
 *
 * The composition, driven: `HostGate` renders with a bearer whose transport RECORDS, and the
 * wires it hands the shell are taken from the render and used. Everything above the seam — the
 * states, the session body caches, the rescue verbs — is the shared shell's and is measured in
 * `apps/webapp/test`. What only this file can get wrong is which wires reach the shell and what
 * leaves the page when they are used.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/** One render's worth of the props `HostGate` hands the shared shell. */
let shellProps: Record<string, unknown> | null = null;

vi.mock("../../webapp/app/shell/AppShell", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/AppShell")>(
    "../../webapp/app/shell/AppShell",
  );
  return {
    ...real,
    /* A capture rather than the shell: the shell's own behaviour is not this file's subject, and
       mounting 8000 lines of it would measure the wires only through whatever it happens to ask. */
    AppShell: (props: Record<string, unknown>) => {
      shellProps = props;
      return null;
    },
  };
});

/**
 * THE CLOUD CLIENT AS THIS ARTIFACT HAS IT — refusing, because `vite.config.ts` aliases it to
 * `no-api-client.ts` in the host-client bundle too. Without this the no-wire arm below would
 * measure a browser's client that this build does not carry.
 */
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>(
    "../../webapp/app/api-client",
  );
  const refuse = (): never => {
    throw new Error("the ohmail Cloud API is not part of this build");
  };
  return {
    ...real,
    apiConfigured: () => false,
    trashWindow: { list: refuse, body: refuse },
    screener: { junkList: refuse, junkBody: refuse },
  };
});

interface Sent { url: string; init: { method?: string; headers?: Record<string, string> } | undefined }
let sent: Sent[];
/** The page's ONE door. Anything reaching the platform `fetch` instead is a second one. */
let platformFetchCalls: number;

beforeEach(() => {
  sent = [];
  platformFetchCalls = 0;
  shellProps = null;
  window.localStorage.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    platformFetchCalls += 1;
    throw new Error("the page opened a socket of its own");
  }) as typeof fetch;
});

let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  window.history.replaceState(null, "", "/");
});

const PAGE = { mailboxes: [], items: [], nextCursor: null };

/** A bearer holding a live pairing, over a transport that records and answers an empty page. */
function pairedBearer(): BearerManager {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string, init?: unknown) => {
      sent.push({ url, init: init as Sent["init"] });
      const body = String(url).includes("/body")
        ? { subject: "s", text: "t" }
        : PAGE;
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  // An access token, so `headers()` answers with the Authorization the door reads.
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  return bearer;
}

/** Render the gate on a live pairing and return the props it handed the shell. */
async function mountGate(): Promise<Record<string, unknown>> {
  const bearer = pairedBearer();
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(HostGate, { bearer }),
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(shellProps, "the gate did not mount the shared shell on a live pairing").not.toBeNull();
  return shellProps!;
}

describe("the wires a paired device's gate hands the shared shell", () => {
  it("BOTH live windows arrive, beside the reach-past body wire that was already there", async () => {
    const props = await mountGate();

    // As a PAIR, in one assertion: a composition that hands in one of these and not the other
    // leaves the other section absent on this door for exactly the reason this lane fixed.
    const junk = props.junkWire as JunkWire | undefined;
    const trash = props.trashWire as TrashWire | undefined;
    expect(typeof junk?.list, "no junkWire: the Screener's Junk segment stays absent").toBe("function");
    expect(typeof junk?.body).toBe("function");
    expect(typeof trash?.list, "no trashWire: the Trash view's live section stays absent").toBe("function");
    expect(typeof trash?.body).toBe("function");
    // The wire this door already had, unchanged — the fix adds beside it and replaces nothing.
    expect(props.olderBodyWire, "the reach-past body wire was disturbed").toBeDefined();
  });

  it("every read is a GET carrying the manager's Authorization, down the ONE bearer door", async () => {
    const props = await mountGate();
    const junk = props.junkWire as JunkWire;
    const trash = props.trashWire as TrashWire;

    await junk.list();
    await junk.body("mbx/1", 42, "7");
    await trash.list();
    await trash.body("mbx/1", 42, "7");

    expect(sent.map((s) => s.url)).toEqual([
      "/screener/junk",
      "/screener/junk/body?mailboxId=mbx%2F1&uid=42&uidValidity=7",
      "/trash/window",
      "/trash/window/body?mailboxId=mbx%2F1&uid=42&uidValidity=7",
    ]);
    for (const s of sent) {
      // No `method` key AT ALL, not "method: GET": the transports pass no init and the manager
      // only ever adds headers, so there is no field for a later edit to flip to a verb.
      expect(s.init?.method, `${s.url} carried a method`).toBeUndefined();
      expect(s.init?.headers?.authorization, `${s.url} carried no bearer`).toBe("Bearer a1");
    }
    // ONE DOOR. Both wires ride the manager's fetch; nothing on this page opens a socket, and
    // the refusing Cloud client is never reached either (it would have thrown).
    expect(platformFetchCalls, "a second fetch door was opened").toBe(0);
  });

  it("the paths these wires ask for are GETs the paired-device route table serves", () => {
    /* A cross-package read rather than an import: `apps/desktop` does not depend on the api
       package. The GET patterns are collected from the two route modules and the two spreads
       that carry them onto the door, so a renamed route or a dropped spread reddens this. */
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    const local = read("packages/api/src/routes/local.ts");
    expect(local).toContain("...screenerRoutes,");
    expect(local).toContain("...trashRoutes,");

    const gets = new Set<string>();
    for (const rel of ["packages/api/src/routes/screener.ts", "packages/api/src/routes/trash.ts"]) {
      for (const m of read(rel).matchAll(/method:\s*"GET",\s*pattern:\s*"([^"]+)"/g)) {
        gets.add(m[1]!);
      }
    }
    for (const p of [
      "/screener/junk", "/screener/junk/body", "/screener/junk/sweep",
      "/trash/window", "/trash/window/body",
    ]) {
      expect(gets, `${p} is not a GET on the mounted tables`).toContain(p);
    }
    // The positive control: the collection really parsed route objects, and a path nobody serves
    // is refused rather than passed by a permissive match.
    expect(gets.size).toBeGreaterThanOrEqual(5);
    expect(gets.has("/trash/windows")).toBe(false);
  });
});

describe("what the wires DO to the two windows, through the shared hooks", () => {
  /** Both real hooks, active, over whatever wires are handed in. */
  async function mountHooks(junk?: JunkWire, trash?: TrashWire): Promise<{
    junk: { supported: boolean }; trash: { supported: boolean };
  }> {
    const { useJunkWindow } = await import("../../webapp/app/shell/junk-window");
    const { useTrashWindow } = await import("../../webapp/app/shell/trash-window");
    const out: { junk?: { supported: boolean }; trash?: { supported: boolean } } = {};
    function Probe(): null {
      out.junk = useJunkWindow(true, (() => undefined) as never, junk);
      out.trash = useTrashWindow(true, trash);
      return null;
    }
    const el = document.createElement("div");
    document.body.append(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", children: h(Probe),
      }));
    });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => r.unmount());
    el.remove();
    return { junk: out.junk!, trash: out.trash! };
  }

  it("THE DEFECT: with no wires handed in, this build supports neither window and asks nothing", async () => {
    const got = await mountHooks(undefined, undefined);

    // The state before this lane: the Cloud client is the refusing stub, so both hooks answer
    // "no server" and `AppShell` passes neither control to its view. Nothing on screen says why.
    expect(got.junk.supported).toBe(false);
    expect(got.trash.supported).toBe(false);
    expect(sent, "a wireless build asked something anyway").toEqual([]);
  });

  it("with the gate's OWN wires, both windows are supported and both ask down the bearer", async () => {
    const props = await mountGate();
    sent.length = 0;

    const got = await mountHooks(props.junkWire as JunkWire, props.trashWire as TrashWire);

    expect(got.junk.supported).toBe(true);
    expect(got.trash.supported).toBe(true);
    // The lazy first page of each, on the paths the door serves — read off the wires the gate
    // built, so this is the composition being exercised and not a hand-made pair. The Junk
    // segment's third ask is its one-time sweep OFFER, a GET preview on the same door.
    expect(sent.map((s) => s.url).sort()).toEqual([
      "/screener/junk", "/screener/junk/sweep", "/trash/window",
    ]);
    for (const s of sent) expect(s.init?.method, `${s.url} carried a method`).toBeUndefined();
    expect(platformFetchCalls).toBe(0);
  });
});

describe("the host client's transports add no door of their own", () => {
  const src = read("apps/desktop/src/host-client/transports.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("spells no request: no fetch call, no method, no path — every wire is the window's factory", () => {
    // The rule this file's header states, as a census. The narrowing, the paths and the status
    // contracts live once in the window's modules; a request built here would be a second door
    // past the manager's Authorization stamp and its one 401 recovery.
    for (const forbidden of ["fetch(", "method:", "headers:", '"/'] as const) {
      expect(code, `the host client's transports spell ${forbidden}`).not.toContain(forbidden);
    }
    // The positive control: the census reads this file's real code, so the absences are measured.
    expect(code).toContain("junkVia(bearer.fetch)");
    expect(code).toContain("trashVia(bearer.fetch)");
    expect(code).toContain("olderBodyVia(bearer.fetch)");
  });

  it("both live-window wires are exported, and neither is reachable without the other", () => {
    // A pair in the source too: the gate spreads them together, and a lane that deletes one
    // export leaves the other window absent for the reason this file's header gives.
    expect(code).toContain("export function junkOverBearer");
    expect(code).toContain("export function trashOverBearer");
    const gate = read("apps/desktop/src/host-client/HostGate.tsx");
    expect(gate).toContain("junkWire={junk}");
    expect(gate).toContain("trashWire={trash}");
  });
});
