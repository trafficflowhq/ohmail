/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { OhmailEngine, MemoryMirrorStore, senderKey, type SyncChange } from "@ohmail/client-engine";
import { useScreenerState } from "@ohmail/app-logic/screener/screener-state";
import type { SenderSuggestion } from "@ohmail/app-logic/screener/screener-suggest";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { inWords, mountPlace } from "../../../packages/app/test/screener/screener-world.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

/**
 * ONE SENDER PER SUGGESTION SHAPE, so every chip has something to count.
 *
 * Two News on purpose: a chip whose count is always 1 cannot tell a count from a presence.
 */
const WORLD: Array<{ address: string; dest: SenderSuggestion["dest"] | null; noAnswer?: SenderSuggestion["noAnswer"] }> = [
  { address: "box@example.test", dest: "ohbox" },
  { address: "read1@example.test", dest: "reads" },
  { address: "read2@example.test", dest: "reads" },
  { address: "bill@example.test", dest: "receipts" },
  { address: "out@example.test", dest: "screened" },
  { address: "junk@example.test", dest: "spam" },
  { address: "hold@example.test", dest: "screener" },
  { address: "unasked@example.test", dest: "screener", noAnswer: "out_of_credits" },
  { address: "never@example.test", dest: null },
];

function overlay(): ReadonlyMap<string, SenderSuggestion> {
  const m = new Map<string, SenderSuggestion>();
  for (const w of WORLD) {
    if (!w.dest) continue;
    m.set(senderKey(w.address), {
      dest: w.dest, confidence: 0.9, rationale: "because",
      ...(w.noAnswer ? { noAnswer: w.noAnswer } : {}),
    });
  }
  return m;
}

afterEach(cleanup);

async function mount(only?: string[]) {
  const world = only ? WORLD.filter((w) => only.includes(w.address)) : WORLD;
  const engine = await engineWith(world.map((w, i) => held(`m${i}`, w.address, 9 + i)));
  const mutations = vi.spyOn(engine, "mutate");
  const suggestions = overlay();
  const { result } = renderHook(
    () => useScreenerState(engine, null, 0, () => {}, useScreenerWords(), suggestions),
    { wrapper: ({ children }: { children: ReactNode }) => inWords(children) },
  );
  await waitFor(() => expect(result.current.queueSettled).toBe(true));
  mountPlace(result.current, { engine });
  return { latest: () => result.current, mutations };
}

const filterName = "Show only senders suggested for one pile";
const rows = () => within(screen.getByRole("listbox", { name: "Screener" })).getAllByRole("option");
const apply = () => screen.getByRole("button", { name: "Apply 6 — Ohbox, News, Receipts, Screened out & Spam" });

function menu(current: string) {
  fireEvent.click(screen.getByRole("button", { name: current }));
  return within(screen.getByRole("menu", { name: filterName }));
}

function filter(current: string, choice: string) {
  fireEvent.click(menu(current).getByRole("menuitemradio", { name: choice }));
}

describe("the Screener's filter chips", () => {
  it("counts every group, and the apply-able five add up to the number on the apply button", async () => {
    const { latest } = await mount();
    const state = latest();
    expect(state.waitingCount).toBe(9);
    const choices = menu("All 9");
    const names = ["All 9", "Ohbox 1", "News 2", "Receipts 1", "Screened out 1", "Spam 1", "No suggestion 3"];
    expect(choices.getAllByRole("menuitemradio")).toEqual(
      names.map((name) => choices.getByRole("menuitemradio", { name })),
    );
    const applyable = 1 + 2 + 1 + 1 + 1;
    expect(applyable).toBe(state.suggestedCount);
    expect(applyable + 3).toBe(state.waitingCount);
    expect(state.suggestedDests).toEqual(["ohbox", "reads", "receipts", "screened", "spam"]);
    expect(apply()).toBeTruthy();
  });

  it("a chip narrows the list and decides nothing", async () => {
    const { latest, mutations } = await mount();
    expect(rows()).toHaveLength(9);
    filter("All 9", "News 2");
    expect(rows()).toHaveLength(2);
    for (const row of rows()) expect(row.getAttribute("aria-label")).toMatch(/read[12]@example\.test/);
    expect(latest().waitingCount).toBe(9);
    expect(latest().waiting.filter((w) => latest().isExiting(w.id))).toHaveLength(0);
    expect(mutations).not.toHaveBeenCalled();
    expect(apply()).toBeTruthy();

    filter("News 2", "All 9");
    expect(rows()).toHaveLength(9);
    expect(mutations).not.toHaveBeenCalled();
  });

  it("the group nobody can act on is still visible and still selectable", async () => {
    await mount();
    filter("All 9", "No suggestion 3");
    expect(rows()).toHaveLength(3);
    filter("No suggestion 3", "Spam 1");
    expect(rows()).toHaveLength(1);
  });

  it("offers no chips at all when there is no partition to make", async () => {
    await mount(["never@example.test", "hold@example.test"]);
    expect(screen.queryByRole("button", { name: "All 2" })).toBeNull();
    expect(screen.queryByRole("menu", { name: filterName })).toBeNull();
    expect(rows()).toHaveLength(2);
  });
});
