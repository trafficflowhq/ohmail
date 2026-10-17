/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * "N MESSAGES FROM SENDERS YOU HAVE NOT DECIDED ABOUT ARE STILL IN THE INBOX ON YOUR MAIL SERVER"
 * — THE ROW A PERSON PRESSES.
 *
 * Mail that arrived before the screening gate existed sits in the server's Inbox from senders
 * nobody ever decided about. The answer is not a repair that runs on its own: it is a row in this
 * header that states how much there is and does nothing until somebody presses it.
 *
 * Four claims, each a way the row could lie:
 *
 *  1. IT STATES THE SERVER'S NUMBER, AND WHERE THAT MAIL IS. The set is the arrival gate's own
 *     answer, which no client can work out, so the figure is the door's. The Ohbox never lists
 *     that mail (unruled INBOX mail presents at the gate or in History), so the row names the
 *     server's Inbox — measured on a self-hosted install: 299 said "in your Ohbox", 0 drawn there.
 *  2. IT MOVES NOTHING UNTIL THE PRESS. The Ohbox is arrival-ordered and a READ never moves a row
 *     (owner ruling 2026-09-18); this is a press, and what reaches the door is the press made.
 *  3. IT GOES THROUGH THE ENGINE THE PRODUCT BUILDS. `createEngine` wraps the transport in an
 *     explicit object literal and both capabilities are optional, so `satisfies` would accept the
 *     omission — the shape that left the held-release row unrenderable on the web for two releases.
 *  4. A DOOR WITH NOTHING TO OFFER DRAWS NO ROW — never a row stating zero.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-09-22T09:00:00.000Z");
let seq = 0;

function waiting(id: string, from: string, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-22T08:00:00.000Z",
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-22T08:00:00.000Z",
  };
}

interface Door {
  groups: Array<{ address: string; count: number; newestAt: string }>;
  total: number;
}

let presses: Array<readonly string[] | undefined> = [];

async function engineWith(door: Door | null): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([waiting("m0", "stranger@example.test")].map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      // A door with nothing to say implements NEITHER call — an older server, exactly.
      ...(door
        ? {
          unscreened: async () => ({ groups: door.groups, total: door.total, max: 200 }),
          screenUnscreened: async (addresses?: readonly string[]) => {
            presses.push(addresses);
            return { screened: door.groups, total: door.total };
          },
        }
        : {}),
    } as never,
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  presses = [];
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function mount(door: Door | null, engineOverride?: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = engineOverride ?? await engineWith(door);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
}

const row = (): HTMLElement | null => host!.querySelector(".scn-unscreened");
const pressButton = (): HTMLElement => {
  const hits = [...(row()?.querySelectorAll<HTMLElement>("button") ?? [])]
    .filter((b) => (b.textContent ?? "").trim().startsWith("Screen"));
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "Screen"`);
  return hits[0]!;
};

const DOOR: Door = {
  groups: [
    { address: "paper@paper.test", count: 9, newestAt: "2024-03-01T08:00:00.000Z" },
    { address: "bills@paper.test", count: 3, newestAt: "2024-02-01T08:00:00.000Z" },
  ],
  total: 12,
};

describe("the row renders through the engine the product actually builds", () => {
  const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
  let calls: string[] = [];
  const originalFetch = globalThis.fetch;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    calls = [];
    // Stubbed BEFORE `createEngine`: `HttpAdapter` binds the global at construction.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.endsWith("/api/screener/unscreened")) {
        return Promise.resolve(method === "POST"
          ? json(200, { screened: DOOR.groups, total: DOOR.total })
          : json(200, { groups: DOOR.groups, total: DOOR.total, max: 200 }));
      }
      return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("the live engine's adapter carries both undecided-sender capabilities", () => {
    const engine = createEngine(false, ARMED);
    const adapter = (engine as unknown as { adapter: Record<string, unknown> }).adapter;
    expect(typeof adapter.unscreened, "the gate drops `unscreened`").toBe("function");
    expect(typeof adapter.screenUnscreened, "the gate drops `screenUnscreened`").toBe("function");
  });

  it("draws the row from the wire and presses back through it", async () => {
    const engine = createEngine(false, ARMED);
    await mount(null, engine);
    expect(calls, "the row never asked the door").toContain("GET /api/screener/unscreened");
    const text = row()?.querySelector(".scn-held-lead")?.textContent ?? "";
    expect(text, "the undecided-sender row did not render on the live path").toContain("12");
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(calls, "the press never reached the door").toContain("POST /api/screener/unscreened");
  });
});

describe("the undecided-sender row in the Screener header", () => {
  it("states the server's number and says what it is about", async () => {
    await mount(DOOR);
    const text = row()?.querySelector(".scn-held-lead")?.textContent ?? "";
    expect(text).toContain("12");
    expect(text.toLowerCase()).toContain("not decided about");
    expect(text.toLowerCase()).toContain("inbox on your mail server");
    expect(text.toLowerCase(), "the Ohbox never lists this mail").not.toContain("ohbox");
  });

  it("both catalogues name the server's Inbox and never the Ohbox", () => {
    const en = messages.screener.unscreenedLead;
    const german = de.screener.unscreenedLead;
    expect(en).toContain("Inbox on your mail server");
    expect(german).toContain("Inbox auf deinem Mailserver");
    for (const lead of [en, german]) expect(lead).not.toMatch(/Ohbox/);
  });

  it("is one sentence and one verb — no per-sender list to read", async () => {
    await mount(DOOR);
    expect((row()?.textContent ?? "")).not.toContain("paper.test");
    expect(pressButton().textContent).toContain("Screen 12");
  });

  it("moves nothing until the press, and then presses for every group shown", async () => {
    await mount(DOOR);
    expect(presses, "a READ moved somebody's mail").toEqual([]);
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(presses).toEqual([undefined]);
  });

  /** A door with nothing to offer draws NO ROW — never a row stating zero. */
  it("draws no row when the door offers nothing", async () => {
    await mount(null);
    expect(row()).toBeNull();
  });

  it("draws no row when the door answers an empty set", async () => {
    await mount({ groups: [], total: 0 });
    expect(row()).toBeNull();
  });
});
