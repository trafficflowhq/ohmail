/** @vitest-environment jsdom */
/**
 * THE KEY TABLE AT THE SEATED OHBOX IS THE SHIPPED SHELL'S, ROW FOR ROW. Read out of the registry (what the `?` sheet
 * is drawn from) over the real shell, with nothing open and with a letter open, against the table the shell held at
 * today's Ohbox before the seat (`fixtures/keys-at-the-ohbox.base.json`, read on the lane's base). The rows that
 * differ are the declared ones, each named here with why. No chord runs twice in one state, and none is lost.
 *
 * WITH ROWS PICKED the sorted rows cannot say which of two bindings of one chord runs: that state is also read chord
 * by chord, the first enabled binding in the registry's own order, which is the order a key press walks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import base from "./fixtures/keys-at-the-ohbox.base.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const table = vi.hoisted(() => ({ rows: [] as string[], sheetOpen: false }));

/* The `?` sheet's place in the shell, standing in as the reader of the registry it is drawn from. */
vi.mock("../../app/shell/ShortcutSheet", async () => {
  const { useKeymap } = await import("@ohmail/app-logic/keys/keymap");
  return {
    ShortcutSheet: ({ open }: { open: boolean }) => {
      table.sheetOpen = open;
      table.rows = useKeymap().bindings.map(
        (b) => `${b.chord}|${b.label}|${b.disabled ? `off${b.disabledReason ? `:${b.disabledReason}` : ""}` : "on"}`,
      );
      return null;
    },
  };
});

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const letter = (): Element | null => document.querySelector('[role="region"][aria-label="Open message"] article');

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  table.rows = [];
});
afterEach(async () => {
  await unmountAll();
});

const enabled = (table_: readonly string[]): string[] => table_.filter((r) => r.endsWith("|on")).map((r) => r.split("|")[0]!);
const twice = (chords: readonly string[]): string[] => [...new Set(chords.filter((c, i) => chords.indexOf(c) !== i))];
/** Chord by chord, the binding a press runs: the first enabled one, in the order the table was read. */
const runs = (table_: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of table_) {
    const [chord, label, state] = r.split("|") as [string, string, string];
    if (state === "on" && !(chord in out)) out[chord] = label;
  }
  return out;
};
const pickedRows = (): number => rows().filter((r) => r.hasAttribute("data-picked")).length;
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

describe("the keys at the seated Ohbox", () => {
  it("the table is the shipped shell's row for row, with nothing open and with a letter open, and no chord runs twice", async () => {
    await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => rows().length === 3, "the seated list");
    const nothingOpen = [...table.rows];
    await act(async () => { rows()[0]!.click(); });
    await waitFor(() => letter() !== null, "the open letter");
    const letterOpen = [...table.rows];

    expect([...nothingOpen].sort(), "with nothing open").toEqual([...base.nothingOpen].sort());
    expect([...letterOpen].sort(), "with a letter open").toEqual([...base.letterOpen].sort());
    /* The shipped table binds some chords twice by design, live in turn (Escape's cascade, the arrows by zone): no
       chord may be live more often here than there. */
    expect(twice(enabled(nothingOpen)).sort(), "chords live twice with nothing open").toEqual(twice(enabled(base.nothingOpen)).sort());
    expect(twice(enabled(letterOpen)).sort(), "chords live twice with a letter open").toEqual(twice(enabled(base.letterOpen)).sort());
  }, 60_000);

  it("a letter open with two rows picked: the table is the shipped shell's, and chord by chord the binding that runs is the selection's", async () => {
    await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3"), message("m4")]);
    await waitFor(() => rows().length === 4, "the seated list");
    await act(async () => { rows()[1]!.click(); });
    await waitFor(() => letter() !== null, "the open letter");
    await act(async () => { rows()[1]!.focus(); });
    await key("x");
    await waitFor(() => pickedRows() === 1, "x picked the open row");
    const opened = window.location.hash;
    await key("j");
    await waitFor(() => window.location.hash !== opened, "j showed the next row's letter");
    await key("x");
    await waitFor(() => pickedRows() === 2, "x picked it too");
    const rowsPicked = [...table.rows];

    expect([...rowsPicked].sort(), "with a letter open and rows picked").toEqual([...base.letterOpenRowsPicked].sort());
    expect(runs(rowsPicked), "chord by chord, the binding that runs").toEqual(runs(base.letterOpenRowsPicked));
    expect(twice(enabled(rowsPicked)).sort(), "chords live twice").toEqual(twice(enabled(base.letterOpenRowsPicked)).sort());
  }, 60_000);

  it("the app's keys stand at the seated Ohbox: c, /, g and a place's letter, ?, z", async () => {
    await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await waitFor(() => rows().length === 2, "the seated list");
    table.sheetOpen = false;
    await key("?");
    await waitFor(() => table.sheetOpen, "? opens the key sheet");
    await key("?");
    await waitFor(() => !table.sheetOpen, "? closes it again");

    await key("z");
    await waitFor(() => (document.querySelector('[role="status"]')?.textContent ?? "") !== "" || document.body.textContent!.includes(en.shortcuts.nothingToUndo), "z answers");
    expect(document.body.textContent, "z with nothing armed says so").toContain(en.shortcuts.nothingToUndo);

    await key("g");
    await key("h");
    await waitFor(() => window.location.hash === "#/history", "g h goes to History");
    await key("g");
    await key("o");
    await waitFor(() => window.location.hash === "#/ohbox" && rows().length === 2, "g o comes back to the seated Ohbox");
    await key("/");
    await waitFor(() => window.location.hash === "#/search", "/ goes to Search");
    await key("Escape");
    await key("Escape");
    await waitFor(() => window.location.hash === "#/ohbox", "Escape leaves Search for where it was entered from");
    await key("c");
    await waitFor(() => window.location.hash.startsWith("#/compose"), "c reaches the composer");
  }, 60_000);
});
