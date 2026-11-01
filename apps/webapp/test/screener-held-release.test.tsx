/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type EngineMessage, type EngineMutation, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * "N HELD MESSAGES FROM SENDERS YOU ALREADY DECIDED" — THE ROW A PERSON PRESSES.
 *
 * Mail an install adopted at the screening gate is recorded as a hand file, so no pass revisits it
 * and it sits at the gate behind a rule its owner already wrote. The fix is not a repair that runs
 * on its own: it is a row in this header that states what is stuck, names the rule that would file
 * each group and where it would go, and does nothing until somebody presses it.
 *
 * Four claims, and each is a way the row could lie:
 *
 *  1. IT STATES THE SERVER'S DISTINCT NUMBER. A message can sit in two groups (a domain rule and a
 *     sender rule inside it both claim it), so summing the groups overstates what is held.
 *  2. IT IS ONE SENTENCE AND TWO VERBS. The per-rule list is gone — it named addresses and piles
 *     for a press that acts on the whole set anyway, and reading it was the work the offer exists
 *     to save (FIX-021; it returned every session on a live account and read as noise).
 *  3. IT IS PRESSED, NEVER AUTOMATIC. Nothing is released until the button is clicked, and what
 *     reaches the door is the press the person made.
 *  4. "NOT NOW" HOLDS. A dismissal names the exact set's fingerprint, the server remembers it per
 *     account, and the row stays away — on this device, the next session and every other device —
 *     until the set changes. A server that keeps no fingerprint gets no "Not now" at all, because
 *     a press that forgets by tomorrow is worse than no button.
 *
 * The fifth is the absence: a door with nothing to offer draws no row at all.
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

const NOW = new Date("2026-09-12T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-09-12T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-12T09:00:00.000Z",
  };
}

interface Door {
  groups: Array<{ ruleId: string; kind: "sender" | "domain"; match: string; destination: string; count: number }>;
  total: number;
  /** This set's identity. Absent models an OLDER server, which keeps no dismissal. */
  fingerprint?: string;
  /** The account already said "not now" to exactly this set, on some device. */
  dismissed?: boolean;
  /** Contacts nobody wrote a rule for. Absent models a server before row 138. */
  senders?: Array<{ sender: string; count: number }>;
}

let presses: Array<readonly string[] | undefined> = [];
let senderPresses: Array<readonly string[] | undefined> = [];
let dismissals: string[] = [];

async function engineWith(door: Door | null): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([held("m0", "stranger@example.test", 9)].map((m): SyncChange => ({
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
          heldReleases: async () => ({
            groups: door.groups, total: door.total, max: 200, ...(door.senders ? { senders: door.senders } : {}),
            fingerprint: door.fingerprint ?? "",
            // A dismissal recorded on ANY device answers `dismissed` on every later read.
            dismissed: (door.dismissed ?? false) || dismissals.includes(door.fingerprint ?? "§never"),
          }),
          releaseHeld: async (ruleIds?: readonly string[], senders?: readonly string[]) => {
            presses.push(ruleIds);
            senderPresses.push(senders);
            return { released: door.groups, total: door.total };
          },
          dismissHeldRelease: async (fingerprint: string) => { dismissals.push(fingerprint); },
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
  senderPresses = [];
  dismissals = [];
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

const row = (): HTMLElement | null => host!.querySelector(".scn-held");
const rowButtons = (): HTMLElement[] => [...(row()?.querySelectorAll<HTMLElement>("button") ?? [])];
/** The named verb, by its whole text — two buttons share the row, so "first button" is a guess. */
const buttonNamed = (text: string): HTMLElement => {
  const hits = rowButtons().filter((b) => (b.textContent ?? "").trim().startsWith(text));
  if (hits.length !== 1) throw new Error(`${hits.length} buttons read "${text}"`);
  return hits[0]!;
};
const pressButton = (): HTMLElement => buttonNamed("Release");

const DOOR: Door = {
  groups: [
    { ruleId: "r-news", kind: "domain", match: "paper.test", destination: "ohmail/News", count: 9 },
    { ruleId: "r-bills", kind: "sender", match: "bills@paper.test", destination: "ohmail/Receipts", count: 3 },
  ],
  // DISTINCT: the three bills are inside the nine, so the sum (12) is not what is held.
  total: 9,
  fingerprint: "v1-feedfacecafebeef",
};

/**
 * ── THE REAL-PATH TWIN ────────────────────────────────────────────────────────────────────
 *
 * Everything above hands a hand-built adapter to `OhmailEngine`, which is why all of it was green
 * through 0.19.0 and 0.19.1 while this row could not render on the web at all: `createEngine`
 * wraps the transport in `createSyncGate(...).guard(...)`, an explicit object literal, and that
 * literal named neither `heldReleases` nor `releaseHeld`. Both are optional on `EngineAdapter`, so
 * `satisfies` accepted the omission and no `held_release_group` row ever reached a web mirror.
 * This one builds the engine THE WAY THE PRODUCT DOES and stubs the wire underneath it.
 */
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
      if (url.endsWith("/api/screener/held-releases")) {
        return Promise.resolve(method === "POST"
          ? json(200, { released: DOOR.groups, total: DOOR.total })
          : json(200, { groups: DOOR.groups, total: DOOR.total, max: 200 }));
      }
      return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it("THE REGRESSION: the live engine's adapter carries both held-release capabilities", () => {
    const engine = createEngine(false, ARMED);
    const adapter = (engine as unknown as { adapter: Record<string, unknown> }).adapter;
    expect(typeof adapter.heldReleases, "the gate drops `heldReleases`").toBe("function");
    expect(typeof adapter.releaseHeld, "the gate drops `releaseHeld`").toBe("function");
  });

  it("draws the row from the wire and presses back through it", async () => {
    const engine = createEngine(false, ARMED);
    await mount(null, engine);
    expect(calls, "the panel never asked the door").toContain("GET /api/screener/held-releases");
    const text = row()?.querySelector(".scn-held-lead")?.textContent ?? "";
    expect(text, "the held-release row did not render on the live path").toContain("9");
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(calls, "the press never reached the door").toContain("POST /api/screener/held-releases");
  });
});

describe("the held-release row in the Screener header", () => {
  it("states the server's distinct number, not the sum of the groups", async () => {
    await mount(DOOR);
    const text = row()?.querySelector(".scn-held-lead")?.textContent ?? "";
    expect(text).toContain("9");
    expect(text).not.toContain("12");
    expect(text.toLowerCase()).toContain("already decided");
  });

  it("is one sentence and two verbs — the per-rule list is gone", async () => {
    await mount(DOOR);
    expect(host!.querySelector(".scn-held-groups"), "the per-rule list came back").toBeNull();
    expect((row()?.textContent ?? "")).not.toContain("paper.test");
    expect(buttonNamed("Release 9")).toBeTruthy();
    expect(buttonNamed("Not now")).toBeTruthy();
  });

  it("'Not now' names this exact set to the door, and the row leaves on the re-read", async () => {
    await mount(DOOR);
    await act(async () => {
      buttonNamed("Not now").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(dismissals).toEqual([DOOR.fingerprint]);
    expect(row(), "the dismissed offer is still on screen").toBeNull();
    // …and nothing was RELEASED: "not now" is not a quiet yes.
    expect(presses).toEqual([]);
  });

  it("a set dismissed on another device never renders here", async () => {
    await mount({ ...DOOR, dismissed: true });
    expect(row()).toBeNull();
  });

  it("a server that keeps no dismissal gets no 'Not now' — the release verb stays", async () => {
    await mount({ ...DOOR, fingerprint: "" });
    expect(buttonNamed("Release 9")).toBeTruthy();
    expect(rowButtons().filter((b) => (b.textContent ?? "").includes("Not now"))).toEqual([]);
  });

  it("releases nothing until the press, and then presses for every group", async () => {
    await mount(DOOR);
    expect(presses).toEqual([]);
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(presses).toEqual([undefined]);
  });

  it("presses a rule-only set without naming a sender (the control for row 138)", async () => {
    await mount(DOOR);
    await act(async () => { pressButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(senderPresses).toEqual([undefined]);
  });

  /* ROW 138: a contact nobody wrote a rule for has held mail and no group. The row names each such
     sender on its own line — the press is a decision about a named person — and "Release all"
     names every line it showed. */
  it("one line per contact nobody wrote a rule for, and the press names each one", async () => {
    await mount({ groups: [], total: 0, fingerprint: "v1-0000000000000138", senders: [{ sender: "ana@friends.test", count: 2 }] });
    const lines = [...(row()?.querySelectorAll(".scn-held-lead") ?? [])].map((p) => p.textContent ?? "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ana@friends.test");
    expect(lines[0]).toContain("2 messages");
    expect(lines[0]!.toLowerCase(), "a contact is not a sender you already decided about").not.toContain("already decided");
    await act(async () => { buttonNamed("Release 2").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(presses).toEqual([undefined]);
    expect(senderPresses).toEqual([["ana@friends.test"]]);
  });

  it("rule groups and contact lines share one press, and the rules' sentence keeps its number", async () => {
    await mount({ ...DOOR, senders: [{ sender: "ana@friends.test", count: 2 }] });
    const lines = [...(row()?.querySelectorAll(".scn-held-lead") ?? [])].map((p) => p.textContent ?? "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("9");
    expect(lines[1]).toContain("ana@friends.test");
    expect(buttonNamed("Release 11")).toBeTruthy();
  });

  /** A door with nothing to offer draws NO ROW — never a row stating zero. */
  it("draws no row when the door offers nothing", async () => {
    await mount(null);
    expect(row()).toBeNull();
  });
});

/**
 * A HELD LETTER ITS PROVIDER FAILED, WITH NO WAITING ROW: one claiming the account's own address, or a
 * contact's the store does not list. It is said with the check that failed, and each letter is decided
 * alone — one `move` out of the gate, never a rule, a decision or a contact.
 */
describe("a held letter its provider failed, in the Screener header", () => {
  const ME = "me@example.test";
  let sent: EngineMutation[] = [];
  afterEach(() => { sent = []; });

  async function engineWithForgery(stranger = true): Promise<OhmailEngine> {
    const store = new MemoryMirrorStore();
    await store.load();
    const letters = [{ ...held("forged", ME, 10), authVerdict: "fail" as const }, ...(stranger ? [held("m0", "stranger@example.test", 9)] : [])];
    await store.applyChanges([
      ...letters.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
      { type: "mailbox", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: { id: "mb", address: ME } },
    ] as SyncChange[]);
    return new OhmailEngine({
      store, now: () => NOW,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async (m: EngineMutation) => { sent.push(m); return { changes: [], seq: null }; },
        fetchBody: async () => null,
      } as never,
    });
  }
  const block = (): HTMLElement | null => host!.querySelector(".scn-failed");
  const verb = (text: string): HTMLElement => [...block()!.querySelectorAll<HTMLElement>("button")]
    .find((b) => (b.textContent ?? "").trim() === text)!;

  it("says the check that failed and offers the two verbs", async () => {
    await mount(null, await engineWithForgery());
    expect(block()?.textContent).toContain(`Your mail provider checked whether this message is from ${ME}, and the check failed.`);
    expect([...block()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Not from you", "It's from you"]);
  });

  for (const [press, folder] of [["Not from you", "ohmail/Quarantine"], ["It's from you", "INBOX"]] as const) {
    it(`"${press}" is one move out of the gate and nothing else`, async () => {
      await mount(null, await engineWithForgery());
      await act(async () => { verb(press).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await flush();
      expect(sent).toEqual([{ kind: "move", messageId: "forged", folder, from: "ohmail/Screener" }]);
    });
  }

  it("is said with nobody waiting", async () => {
    await mount(null, await engineWithForgery(false));
    expect(block()?.textContent).toContain(`Your mail provider checked whether this message is from ${ME}, and the check failed.`);
  });

  it("CONTROL: a mirror with no failed letter draws no such block", async () => {
    await mount(DOOR);
    expect(block()).toBeNull();
  });
});
