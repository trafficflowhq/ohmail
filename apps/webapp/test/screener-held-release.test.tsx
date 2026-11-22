/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder, RuleEntity } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/dom";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, heldReleaseTotalOf,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { createEngine } from "../app/shell/engine-config.js";
import { ROSTER } from "./_draft-shell.js";

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

const OWN_ADDRESS = "me@example.test";
const roster = async () => [{ ...ROSTER[0]!, id: "mb", address: OWN_ADDRESS }];
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
let delivered: EngineMessage[] = [];
let senderPresses: Array<readonly string[] | undefined> = [];
let dismissals: string[] = [];

async function engineWith(door: Door | null, letters: EngineMessage[] = [], arrivals: SyncChange[] = []): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([held("m0", "stranger@example.test", 9), ...letters].map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: arrivals.splice(0), moves: [], deletes: [] },
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
            const groups = door.groups.filter((group) => ruleIds === undefined || ruleIds.includes(group.ruleId));
            for (const message of letters) {
              const rule = groups.find((group) => group.kind === "sender" ? group.match === message.from.address
                : message.from.address.endsWith("@" + group.match));
              if (!rule) continue;
              const entity = { ...message, folder: rule.destination as Folder };
              delivered.push(entity);
              await store.applyChanges([{ type: "message", op: "update", id: message.id,
                seq: ++seq, updatedAt: message.updatedAt, entity }]);
            }
            return { released: groups, total: door.total };
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
  delivered = [];
  senderPresses = [];
  dismissals = [];
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

async function mount(door: Door | null, engineOverride?: OhmailEngine): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  const engine = engineOverride ?? await engineWith(door);
  window.location.hash = "#/screener";

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(MailShell, {
            engine, mailboxFacts: roster, consentTransport: "none", suggestWire: "none", junkWire: "none",
          }),
        }),
      }),
    );
  });
  await flush();
}

const row = (): HTMLElement | null =>
  within(host!).queryAllByRole("status").find((notice) =>
    notice.textContent?.includes("held, already decided") ||
    within(notice).queryByRole("button", { name: /^Release \d+$/ }),
  ) ?? null;
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
    expect(calls).toContain("GET /api/screener/held-releases");
    expect(calls.filter((call) => call === "POST /api/screener/held-releases")).toHaveLength(1);
    expect(row()).toBeNull();
  });
});

async function expectHeldArrivalFiled(when: "before" | "after") {
  const door: Door = { groups: [], total: 0 };
  const letters: EngineMessage[] = [];
  const arrivals: SyncChange[] = [];
  const engine = await engineWith(door, letters, arrivals);
  await mount(door, engine);
  expect(presses).toEqual([]);
  const letter = held("new-letter", "newspaper@paper.test", 11);
  const rule: RuleEntity = {
    id: "r-news", kind: "domain", match: "paper.test", destination: "ohmail/News",
    priority: 0, provenance: "manual", enabled: true, createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(), stats: { hits: 0, lastHitAt: null, demotions: 0 },
  };
  const arrive = async (kind: "rule" | "message") => {
    const entity = kind === "rule" ? rule : letter;
    arrivals.push({ type: kind, op: "create", id: entity.id, seq: ++seq, updatedAt: entity.updatedAt, entity });
    await act(async () => { await engine.syncOnce(); });
    await flush();
  };
  letters.push(letter);
  await arrive(when === "before" ? "rule" : "message");
  expect(presses).toEqual([]);
  door.groups = [DOOR.groups[0]!];
  door.total = 1;
  await arrive(when === "before" ? "message" : "rule");
  expect(delivered.map((mail) => [mail.id, mail.folder])).toEqual([["new-letter", "ohmail/News"]]);
  expect(presses).toHaveLength(1);
}

// The case titles remain stable for the regression checklist. The retired controls are absent.
describe("the held-release row in the Screener header", () => {
  it("states the server's distinct number, not the sum of the groups", async () => {
    const engine = await engineWith(DOOR);
    await mount(DOOR, engine);
    expect(heldReleaseTotalOf(engine.read())).toBe(9);
    expect(row()).toBeNull();
  });

  it("is one sentence and two verbs — the per-rule list is gone", async () => {
    await mount(DOOR);
    expect(row()).toBeNull();
    expect(host!.textContent).not.toContain("paper.test");
    expect(within(host!).queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("'Not now' names this exact set to the door, and the row leaves on the re-read", async () => {
    await expectHeldArrivalFiled("before");
    expect(dismissals).toEqual([]);
    expect(row()).toBeNull();
  });

  it("a set dismissed on another device never renders here", async () => {
    await mount({ ...DOOR, dismissed: true });
    expect(row()).toBeNull();
    expect(presses).toHaveLength(1);
  });

  it("a server that keeps no dismissal gets no 'Not now' — the release verb stays", async () => {
    await mount({ ...DOOR, fingerprint: "" });
    expect(row()).toBeNull();
    expect(within(host!).queryByRole("button", { name: "Not now" })).toBeNull();
    expect(presses).toHaveLength(1);
  });

  it("releases nothing until the press, and then presses for every group", async () => {
    const decided = held("decided", "newspaper@paper.test", 10);
    const engine = await engineWith(DOOR, [decided]);
    await mount(DOOR, engine);
    expect(delivered.map((mail) => [mail.id, mail.folder])).toEqual([["decided", "ohmail/News"]]);
    expect(engine.read().get<EngineMessage>("message", "m0")?.folder).toBe("ohmail/Screener");
    expect(presses).toHaveLength(1);
  });

  it("presses a rule-only set without naming a sender (the control for row 138)", async () => {
    await expectHeldArrivalFiled("after");
    expect(senderPresses).toEqual([undefined]);
  });

  it("one line per contact nobody wrote a rule for, and the press names each one", async () => {
    await mount({ groups: [], total: 0, senders: [{ sender: "ana@friends.test", count: 2 }] });
    expect(presses).toEqual([]);
    expect(row()).toBeNull();
  });

  it("rule groups and contact lines share one press, and the rules' sentence keeps its number", async () => {
    await mount({ ...DOOR, senders: [{ sender: "ana@friends.test", count: 2 }] });
    expect(presses).toEqual([DOOR.groups.map((group) => group.ruleId)]);
    expect(senderPresses).toEqual([undefined]);
    expect(dismissals).toEqual([]);
  });

  it("draws no row when the door offers nothing", async () => {
    await mount(null);
    expect(presses).toEqual([]);
    expect(row()).toBeNull();
  });
});

/**
 * A HELD LETTER ITS PROVIDER FAILED, WITH NO WAITING ROW: one claiming the account's own address, or a
 * contact's the store does not list. It is said with the check that failed, and each letter is decided
 * alone — one `move` out of the gate, never a rule, a decision or a contact.
 */
describe("a held letter its provider failed, in the Screener header", () => {
  let sent: EngineMutation[] = [];
  afterEach(() => { sent = []; });

  async function engineWithForgery(stranger = true): Promise<OhmailEngine> {
    const store = new MemoryMirrorStore();
    await store.load();
    const letters = [{ ...held("forged", OWN_ADDRESS, 10), authVerdict: "fail" as const }, ...(stranger ? [held("m0", "stranger@example.test", 9)] : [])];
    await store.applyChanges([
      ...letters.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
      { type: "mailbox", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(), entity: { id: "mb", address: OWN_ADDRESS } },
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
  const failedList = () => within(host!).queryByRole("listbox", { name: "Messages that failed the sender check" });
  const block = () => within(host!).queryByRole("toolbar", { name: "Messages that failed the sender check" });
  const verb = (name: string) => within(block()!).getByRole("button", { name });

  async function openFailed(): Promise<void> {
    await act(async () => { fireEvent.click(within(failedList()!).getByRole("option")); });
    await flush();
  }

  it("says the check that failed and offers the two verbs", async () => {
    await mount(null, await engineWithForgery());
    await openFailed();
    expect(within(host!).queryByRole("region", { name: "The sender check failed" })?.textContent).toContain(`Your mail provider checked whether this message is from ${OWN_ADDRESS}, and the check failed.`);
    expect([...block()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Not from you", "It's from you"]);
  });

  for (const [press, folder] of [["Not from you", "ohmail/Quarantine"], ["It's from you", "INBOX"]] as const) {
    it(`"${press}" is one move out of the gate and nothing else`, async () => {
      await mount(null, await engineWithForgery());
      await openFailed();
      await act(async () => { verb(press).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await flush();
      expect(sent).toEqual([{ kind: "move", messageId: "forged", folder, from: "ohmail/Screener" }]);
    });
  }

  it("is said with nobody waiting", async () => {
    await mount(null, await engineWithForgery(false));
    await openFailed();
    expect(within(host!).queryByRole("region", { name: "The sender check failed" })?.textContent).toContain(`Your mail provider checked whether this message is from ${OWN_ADDRESS}, and the check failed.`);
  });

  it("CONTROL: a mirror with no failed letter draws no such block", async () => {
    await mount(DOOR);
    expect(failedList()).toBeNull();
    expect(block()).toBeNull();
  });
});
