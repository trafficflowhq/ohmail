/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type MutationOutcome,
  type SyncResponse,
  STORE_SEARCH_FOLLOWUP_HOLD_MS,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { FoldersRailGroup } from "../app/shell/FoldersRailGroup";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";
import { junkFolderSaid } from "@ohmail/app-logic/lists/folders";
import { fillFrom } from "../app/shell/locale";

/**
 * ═══ JUNK-INVISIBLE — ohmail SAYS where the provider put the mail it will not show ═════════
 *
 * The provider's own `\Junk` is excluded from the folder inventory whole, so mail the mail
 * server filed as junk is in no list, no folder and no search here — measured three times
 * against an iCloud mailbox, where the message being looked for was on the
 * server the whole time. The exclusion is correct; the silence was not, because the only
 * evidence a person has is that their message is gone.
 *
 * Two surfaces carry the sentence — the rail's folders group at its foot, and search's empty
 * state, where "Nothing here" is a claim about a corpus that excludes exactly that folder —
 * and it NAMES the folder the roster resolved, because every provider calls it something
 * else. The three properties under test:
 *
 *  · it renders, and NAMES the folder, when the roster resolved one;
 *  · it renders WITHOUT a name when an account's mailboxes disagree (Gmail's `Spam` beside
 *    iCloud's `Junk`), where one name would be wrong for somebody;
 *  · it does NOT render for a mailbox with no Junk folder — a sentence about a folder that
 *    may not exist is worse than silence, and that arm is what stops this becoming copy that
 *    lies to everybody whose server has no such folder.
 *
 * The pointer at the Screener's Junk window is a fourth, separate condition: it rides the same
 * gate that decides whether that segment exists at all, so neither surface can send somebody
 * to a place this build withholds.
 */

// See `folders-rail.test.tsx` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-12T12:00:00.000Z");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/* ───────────────────────────────────────────────────── the derivation, on its own terms */

describe("junkFolderSaid — which sentence the two surfaces are owed", () => {
  it("names the folder the roster resolved", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: "Junk" }])).toEqual({ named: "Junk" });
  });

  it("names the LEAF, so a nested path reads as the folder a person sees", () => {
    expect(junkFolderSaid([{ status: "connected", junkFolder: "INBOX/Spamverdacht" }]))
      .toEqual({ named: "Spamverdacht" });
  });

  it("two mailboxes whose paths differ but whose leaf agrees still get the name", () => {
    expect(junkFolderSaid([
      { status: "connected", junkFolder: "Junk" },
      { status: "connected", junkFolder: "INBOX/Junk" },
    ])).toEqual({ named: "Junk" });
  });

  it("two mailboxes that call it different things get the sentence WITHOUT a name", () => {
    // Gmail beside iCloud. One name here would be wrong for one of the two mailboxes, and a
    // list of names is not a sentence — so the statement stays and the name goes.
    expect(junkFolderSaid([
      { status: "connected", junkFolder: "Junk" },
      { status: "connected", junkFolder: "[Gmail]/Spam" },
    ])).toBe("unnamed");
  });

  it("says NOTHING when no Junk folder was resolved — all three absences alike", () => {
    // No folder, nothing attached yet, and a server older than the field. Every one of them
    // means there is nothing to assert about somebody's mailbox.
    expect(junkFolderSaid([{ status: "connected", junkFolder: null }])).toBeNull();
    expect(junkFolderSaid([{ status: "connected" }])).toBeNull();
    expect(junkFolderSaid([{ status: "connected", junkFolder: "" }])).toBeNull();
    expect(junkFolderSaid([])).toBeNull();
  });

  it("does not speak for a stood-down mailbox — another install's, and the window skips it too", () => {
    expect(junkFolderSaid([{ status: "disabled", junkFolder: "Junk" }])).toBeNull();
    // …and it is the STATUS doing that, not the absence of a second row.
    expect(junkFolderSaid([
      { status: "disabled", junkFolder: "Spam" },
      { status: "connected", junkFolder: "Junk" },
    ])).toEqual({ named: "Junk" });
  });
});

/* ─────────────────────────────────────────────────────────── the rail's folders group */

async function mountRail(
  junkSaid: { named: string } | "unnamed" | null,
  junkReadable = false,
  locale: "en" | "de" = "en",
): Promise<void> {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale, messages: (locale === "de" ? fillFrom(messages as never, de as never) : messages) as never,
        timeZone: "UTC", now: NOW,
        children: h(FoldersRailGroup, {
          folders: [{ id: "f1", name: "Projects", mailboxId: "mb1", mailbox: "a@x.test" }],
          unread: new Map<string, number>(),
          onNavigate: () => {},
          junkSaid,
          junkReadable,
        }),
      }),
    );
  });
}

const railNote = (): string | null =>
  host.querySelector('[data-testid="rail-junk-note"]')?.textContent ?? null;

describe("the rail's folders group says what it does not list", () => {
  it("names the folder at the foot", async () => {
    await mountRail({ named: "Junk" });
    expect(railNote()).toBe(
      "Your mail server's own Junk folder is not listed here — ohmail does not mirror it.",
    );
  });

  it("a provider that calls it something else is named by ITS name", async () => {
    await mountRail({ named: "Spamverdacht" });
    expect(railNote()).toContain("Spamverdacht");
  });

  it("renders the statement without a name when the account's mailboxes disagree", async () => {
    await mountRail("unnamed");
    expect(railNote()).toBe(
      "Your mail server's own junk folder is not listed here — ohmail does not mirror it.",
    );
  });

  it("renders NOTHING for a mailbox with no Junk folder", async () => {
    await mountRail(null);
    expect(host.querySelector('[data-testid="rail-junk-note"]')).toBeNull();
    expect(host.textContent ?? "").not.toContain("does not mirror it");
  });

  it("in German it points at the Screener's tab by its German name, and says no English Junk", async () => {
    await mountRail("unnamed", true, "de");
    expect(railNote()).toContain(`„${de.screener.segJunk}“`);
    expect(railNote()).not.toMatch(/\bJunk\b/);
  });

  it("offers the way in only where this build can serve it", async () => {
    await mountRail({ named: "Junk" }, false);
    expect(railNote()).not.toContain("Read it under Junk in the Screener.");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mountRail({ named: "Junk" }, true);
    expect(railNote()).toContain("Read it under Junk in the Screener.");
  });
});

/* ────────────────────────────────────────────────────────────── search's empty state */

function adapter(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
}

async function mountSearch(
  junkSaid: { named: string } | "unnamed" | null,
  over: Partial<EngineAdapter> = {},
): Promise<void> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: { ...adapter(), ...over }, store, now: () => NOW });
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, {
          children: h(SearchView, {
            engine, version: 1, now: NOW, query: "the invoice",
            onQuery: () => {}, onOpen: () => {},
            junkSaid,
          }),
        }),
      }),
    );
  });
}

const searchNote = (): string | null =>
  host.querySelector('[data-testid="search-junk-scope"]')?.textContent ?? null;

describe("search says what it did not search", () => {
  it("the empty state names the folder no pass of this view reaches", async () => {
    await mountSearch({ named: "Junk" });
    // Inside the empty state, beside the scope line — which is the sentence's whole point:
    // "Nothing here" is otherwise a claim about a corpus that excludes that folder.
    expect(host.querySelector(".empty")).not.toBeNull();
    expect(searchNote()).toBe(
      "Search does not reach your mail server's own Junk folder — ohmail does not mirror it.",
    );
  });

  it("renders NOTHING for a mailbox with no Junk folder", async () => {
    await mountSearch(null);
    expect(host.querySelector('[data-testid="search-junk-scope"]')).toBeNull();
    expect(host.textContent ?? "").not.toContain("does not mirror it");
  });
});

/**
 * the scope line and this sentence ran together on screen and to a reader ("119 msSearch
 * does not reach…"). Every verdict the empty state can end on is followed by the sentence as its
 * OWN paragraph — a block on screen and a node of its own in the accessibility tree.
 */
describe("the scope line and the junk sentence are two sentences, whatever the verdict", () => {
  const JUNK = "Search does not reach your mail server's own Junk folder — ohmail does not mirror it.";
  /** The store's answer by part, as the engine's adapter sees it. */
  const store = (parts: Record<string, unknown>): Partial<EngineAdapter> => ({
    searchServer: async (_q: string, o: { parts?: string }) => parts[o.parts ?? "both"] ?? parts.page,
  }) as unknown as Partial<EngineAdapter>;
  // Past a typed question's hold: the index progress comes with its count.
  const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, STORE_SEARCH_FOLLOWUP_HOLD_MS + 70)); });
  const arms: Array<[string, Partial<EngineAdapter>, string]> = [
    ["the store still searching", { searchServer: () => new Promise(() => {}) } as unknown as Partial<EngineAdapter>,
      "Searching your whole mailbox…"],
    ["the whole mailbox answered", store({ page: { items: [], total: 0, ms: 119 } }),
      "Searched your whole mailbox — nothing matched · "],
    ["the whole mailbox answered, its index still filling", store({
      page: { items: [], total: 0, ms: 64 },
      estimate: { items: [], total: 0, totalExact: true, ms: 5, indexed: { done: 0, total: 40 } },
    }), "Searched your whole mailbox — nothing matched · "],
    ["the mirror answered for an unreachable account", store({
      page: { items: [], total: 0, ms: 9, answeredFrom: "mirror" },
      estimate: { items: [], total: 0, totalExact: true, ms: 4, answeredFrom: "mirror" },
    }), "Search your whole mailbox again"],
    ["the store did not answer", { searchServer: async () => { throw new Error("down"); } } as unknown as Partial<EngineAdapter>,
      "Search your whole mailbox again"],
    ["no store behind this client", {}, "Search covers the sample mailbox."],
  ];
  it.each(arms)("%s", async (_arm, over, scopeEnd) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountSearch({ named: "Junk" }, over);
    await settle();
    warn.mockRestore();
    const empty = host.querySelector(".empty");
    const junk = host.querySelector('[data-testid="search-junk-scope"]');
    expect(empty?.textContent ?? "").toContain(scopeEnd);
    expect(junk?.tagName, "the junk sentence is not its own paragraph").toBe("P");
    expect(junk?.parentElement).toBe(empty);
    expect(junk?.textContent).toBe(JUNK);
  });
});

/* ─────────────────────────────────────────────────────────────────── both catalogues */

describe("the sentences exist in both languages, and the named arm takes a folder", () => {
  const cat = (m: unknown, ns: string, key: string): string =>
    (m as Record<string, Record<string, string>>)[ns]![key]!;

  it("every key is present in en and de", () => {
    for (const m of [messages, de]) {
      for (const [ns, key] of [
        ["rail", "junkNote"], ["rail", "junkNoteUnnamed"],
        ["search", "junkScope"], ["search", "junkScopeUnnamed"],
        ["screener", "junkElsewhere"],
      ] as const) {
        expect(cat(m, ns, key), `${ns}.${key}`).toBeTypeOf("string");
        expect(cat(m, ns, key).length, `${ns}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the NAMED arm interpolates the folder in both languages, and the unnamed arm does not", () => {
    // A named sentence that dropped its placeholder would render a true statement about a
    // folder nobody can find, which is the sentence this row exists to stop.
    for (const m of [messages, de]) {
      expect(cat(m, "rail", "junkNote")).toContain("{folder}");
      expect(cat(m, "search", "junkScope")).toContain("{folder}");
      expect(cat(m, "rail", "junkNoteUnnamed")).not.toContain("{folder}");
      expect(cat(m, "search", "junkScopeUnnamed")).not.toContain("{folder}");
    }
  });
});
