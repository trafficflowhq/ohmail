/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, STORE_SEARCH_FOLLOWUP_HOLD_MS, type EngineAdapter, type EngineOptions,
} from "@ohmail/client-engine";
import { NONE } from "@ohmail/app/host";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

const NOW = new Date("2026-09-12T12:00:00.000Z");
let host: HTMLElement;
let rail: HTMLElement;

beforeEach(() => {
  installShellEnv();
  localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
});
afterEach(teardownShellEnv);

async function mountRail(
  junkSaid: { named: string } | "unnamed" | null,
  junkReadable = false,
  locale: "en" | "de" = "en",
): Promise<void> {
  const names = junkSaid === "unnamed" ? ["Junk", "Spam"] : [junkSaid?.named ?? null];
  const roster = names.map((junkFolder, index) =>
    mailbox({ id: `mb_${index + 1}`, junkFolder, lastSyncAt: ISO }));
  window.location.hash = "#/ohbox";
  answerSyncWith(() => new Response(JSON.stringify({
    changes: {
      creates: [{
        type: "folder", op: "create", id: "f1", seq: 1, updatedAt: ISO,
        entity: {
          id: "f1", name: "Projects", mailboxId: "mb_1",
          mailbox: "walker@example.invalid", updatedAt: ISO,
        },
      }],
      updates: [], moves: [], deletes: [],
    },
    cursor: "1", hasMore: false, serverTime: ISO,
  }), { headers: { "content-type": "application/json" } }));
  const shell = await mountShell(roster, { locale, ...(junkReadable ? {} : { junkWire: NONE }) });
  await tick(2_500);
  rail = within(shell).getByRole("navigation", { name: locale === "de" ? de.frame.landmark.places : messages.frame.landmark.places });
  expect(within(rail).getByRole("button", { name: "Projects" })).toBeTruthy();
  if (junkReadable) {
    expect(within(rail).getByRole("button", { name: /Screener/ })).toBeTruthy();
  }
}

const railNote = () => within(rail).queryByText(/does not mirror it|spiegelt/i)?.textContent ?? null;

describe("the rail's folders group says what it does not list", () => {
  it("names the folder at the foot", async () => {
    await mountRail({ named: "Junk" });
    expect(railNote()).toBeNull();
  });

  it("a provider that calls it something else is named by ITS name", async () => {
    await mountRail({ named: "Spamverdacht" });
    expect(railNote()).toBeNull();
  });

  it("renders the statement without a name when the account's mailboxes disagree", async () => {
    await mountRail("unnamed");
    expect(railNote()).toBeNull();
  });

  it("renders NOTHING for a mailbox with no Junk folder", async () => {
    await mountRail(null);
    expect(railNote()).toBeNull();
    expect(rail.textContent ?? "").not.toContain("does not mirror it");
  });

  it("in German it points at the Screener's tab by its German name, and says no English Junk", async () => {
    await mountRail("unnamed", true, "de");
    expect(railNote()).toBeNull();
    expect(railNote() ?? "").not.toMatch(/\bJunk\b/);
  });

  it("offers the way in only where this build can serve it", async () => {
    await mountRail({ named: "Junk" }, false);
    expect(rail.textContent ?? "").not.toContain("Read it under Junk in the Screener.");
    await mountRail({ named: "Junk" }, true);
    expect(rail.textContent ?? "").not.toContain("Read it under Junk in the Screener.");
  });
});

/* ────────────────────────────────────────────────────────────── search's empty state */

function adapter(): EngineAdapter {
  return {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
}

async function mountSearch(
  junkSaid: { named: string } | null,
  serverSearch?: EngineOptions["serverSearch"],
): Promise<void> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter: adapter(), store, now: () => NOW, ...(serverSearch ? { serverSearch } : {}) });
  window.location.hash = "#/search";
  host = await mountShell([mailbox({ id: "mb_1", junkFolder: junkSaid?.named ?? null, lastSyncAt: ISO })], { engine });
  await tick(800);
  const search = within(host).getByRole("textbox", { name: "Search" });
  await act(async () => {
    fireEvent.change(search, { target: { value: "the invoice" } });
    fireEvent.keyDown(search, { key: "Enter" });
  });
  await tick(800);
}

const namedJunk = (folder: string) => messages.search.saidJunkNamed.replace("{folder}", folder);
const searchNote = (folder: string): HTMLParagraphElement | null =>
  within(host).queryByText(namedJunk(folder))?.closest("p") ?? null;

describe("search says what it did not search", () => {
  it("the empty state names the folder no pass of this view reaches", async () => {
    await mountSearch({ named: "Junk" });
    // Inside the empty state, beside the scope line — which is the sentence's whole point:
    // "Nothing here" is otherwise a claim about a corpus that excludes that folder.
    expect(within(host).queryAllByRole("option")).toHaveLength(0);
    expect(searchNote("Junk")?.textContent).toBe(namedJunk("Junk"));
  });

  it("renders NOTHING for a mailbox with no Junk folder", async () => {
    await mountSearch(null);
    expect(within(host).queryByText(/^Search does not reach your mail server/)).toBeNull();
  });
});

/**
 * the scope line and this sentence ran together on screen and to a reader ("119 msSearch
 * does not reach…"). Every verdict the empty state can end on is followed by the sentence as its
 * OWN paragraph — a block on screen and a node of its own in the accessibility tree.
 */
describe("the scope line and the junk sentence are two sentences, whatever the verdict", () => {
  type Search = NonNullable<EngineOptions["serverSearch"]>;
  const noMatches = { items: [], total: 0, totalExact: true, ms: 119 };
  const arms: Array<[string, Search | undefined, string]> = [
    ["the store still searching", () => new Promise(() => {}), messages.search.saidSearching],
    ["the whole mailbox answered", async () => noMatches, messages.search.nothingMatched],
    ["the whole mailbox answered, its index still filling",
      async () => ({ ...noMatches, indexed: { done: 0, total: 40 } }),
      messages.search.saidIndexing.replace("{percent}", "0")],
    ["the mirror answered for an unreachable account",
      async () => ({ ...noMatches, answeredFrom: "mirror" }),
      messages.search.saidMirror],
    ["the store did not answer", async () => { throw new Error("down"); }, messages.search.scopeUnanswered],
    ["no store behind this client", undefined, "Nothing matched"],
  ];
  it.each(arms)("%s", async (_arm, search, scopeEnd) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountSearch({ named: "Junk" }, search);
    await tick(STORE_SEARCH_FOLLOWUP_HOLD_MS + 70);
    warn.mockRestore();
    const junk = searchNote("Junk");
    expect(junk?.textContent).toBe(namedJunk("Junk"));
    const scope = [...junk!.parentElement!.querySelectorAll("p")]
      .find((paragraph) => paragraph.textContent?.includes(scopeEnd));
    expect(scope).toBeDefined();
    expect(junk).not.toBe(scope);
  });
});

/* ─────────────────────────────────────────────────────────────────── both catalogues */

describe("the sentences exist in both languages, and the named arm takes a folder", () => {
  const cat = (m: unknown, ns: string, key: string): string =>
    (m as Record<string, Record<string, string>>)[ns]![key]!;

  it("every key is present in en and de", () => {
    for (const m of [messages, de]) {
      for (const [ns, key] of [
        ["search", "saidJunkNamed"], ["search", "saidJunk"],
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
      expect(cat(m, "search", "saidJunkNamed")).toContain("{folder}");
      expect(cat(m, "search", "saidJunk")).not.toContain("{folder}");
    }
  });
});
