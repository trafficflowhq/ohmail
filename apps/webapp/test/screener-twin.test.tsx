/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { screenerKeys, type ScreenerKeyWords } from "@ohmail/app-logic/screener";
import { modelOf, mountPlace, sender, type Asked } from "../../../packages/app/test/screener/screener-world.js";

afterEach(cleanup);

const advice = (dest: "reads" | "ohbox") => ({ ai: { dest, confidence: 0.9, rationale: "Suggestion" } });
const queue = [
  sender("ada", "Ada", advice("reads")),
  sender("ben", "Ben"),
  sender("cleo", "Cleo", advice("reads")),
  sender("dan", "Dan", advice("ohbox")),
  sender("eve", "Eve"),
];

function mount() {
  const asked: Asked = { flushes: 0, decided: [] };
  mountPlace(modelOf(asked, {
    waiting: queue, waitingCount: 5, suggestedCount: 3, suggestedDests: ["ohbox", "reads"],
  }));
  return asked.decided;
}

const selected = () => within(screen.getByRole("region", { name: "Reading" })).getByRole("heading", { name: /goes to/ });
function key(name: string) {
  act(() => { fireEvent.keyDown(document.body, { key: name }); });
}

const destinationWords = { ohbox: "Ohbox", reads: "News", receipts: "Receipts", screened: "Screen out", spam: "Spam" };
const words: ScreenerKeyWords = {
  next: "Next", prev: "Previous", accept: "Accept", applyAll: "Apply",
  card: "Sender card", segPrev: "Previous section", segNext: "Next section", undo: "Undo",
  close: "Close", file: destinationWords, fileRead: destinationWords,
};

const idle = () => {};
const bindings = (suggested: "reads" | null) => screenerKeys({
  words, segment: "waiting", step: { down: idle, up: idle }, decidable: true,
  decide: idle, suggested, applyAll: idle, card: idle, go: idle, undo: idle, escape: null,
});

describe("the old Screener and the new screen", () => {
  it("open the same sender after a decision: the one below, never the top", () => {
    const decided = mount();
    key("j");
    key("j");
    expect(selected().textContent).toMatch(/^Cleo goes to/);
    key("n");
    expect(decided).toEqual([{ id: "cleo", dest: "screened", read: false, scope: "sender" }]);
    expect(selected().textContent).toMatch(/^Dan goes to/);
  });

  it("bind the same Screener keys, with Shift only on the three that let a sender in", () => {
    const chords = bindings(null).filter((binding) => binding.group === "screener").map((binding) => binding.chord);
    expect([...new Set(chords)].sort()).toEqual(
      ["Escape", "Enter", "a", "s", "[", "]", "o", "r", "c", "n", "x", "shift+o", "shift+r", "shift+c", "z"].sort(),
    );
    expect(chords.filter((chord) => chord.startsWith("shift+")).sort()).toEqual(["shift+c", "shift+o", "shift+r"]);
  });

  it("group the queue the same way, with the same counts", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "All 5" }));
    const filter = within(screen.getByRole("menu", { name: "Show only senders suggested for one pile" }));
    expect(filter.getAllByRole("menuitemradio")).toEqual(
      ["All 5", "Ohbox 1", "News 2", "No suggestion 2"].map((name) => filter.getByRole("menuitemradio", { name })),
    );
  });

  it("let Enter file a sender with a real suggestion where it says, and nothing else", () => {
    const decided = mount();
    key("j");
    expect(selected().textContent).toMatch(/^Ben goes to/);
    expect(bindings(null).find((binding) => binding.chord === "Enter")?.disabled).toBe(true);
    key("Enter");
    expect(decided).toEqual([]);
    key("j");
    expect(selected().textContent).toMatch(/^Cleo goes to News/);
    expect(bindings("reads").find((binding) => binding.chord === "Enter")?.disabled).toBe(false);
    key("Enter");
    expect(decided).toEqual([{ id: "cleo", dest: "reads", read: false, scope: "sender" }]);
  });
});
