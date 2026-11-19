/** @vitest-environment jsdom */
/**
 * THE KEY TABLE AT THE SEATED OHBOX IS THE SHIPPED SHELL'S, ROW FOR ROW. Read out of the registry (what the `?` sheet
 * is drawn from) over the real shell, with nothing open and with a letter open, against the table the shell held at
 * today's Ohbox before the seat (`fixtures/keys-at-the-ohbox.base.json`, read on the lane's base). The rows that
 * differ are the declared ones, each named here with why. No chord runs twice in one state, and none is lost.
 *
 * WITH ROWS PICKED the sorted rows cannot say which of two bindings of one chord runs: that state is also read chord
 * by chord, the first enabled binding in the registry's own order, which is the order a key press walks.
 *
 * AT 390 WIDE the same, against the two states the shipped shell's table was read in there (nothing open; a letter
 * opened by a press, which stood in its sheet over the list).
 */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import en from "../../messages/en.json";
import base from "./fixtures/keys-at-the-ohbox.base.json";
import compactSelection from "./fixtures/keys-at-the-ohbox-compact-selection.base.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import {
  ISO, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, syncPage, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell.js";

const table = vi.hoisted(() => ({ rows: [] as string[] }));

/* What the new shell BINDS: the frame's own key registry, read where the frame mounts it (its zone cursor stands in
   the registry the frame provides), every binding with its chord, label and state, as the `?` sheet is drawn from it. */
vi.mock("@ohmail/app-logic/keys", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/keys")>();
  return {
    ...real,
    ZoneCursor: () => {
      table.rows = real.useKeymap().bindings.map(
        (b) => `${b.chord}|${b.label}|${b.disabled ? `off${b.disabledReason ? `:${b.disabledReason}` : ""}` : "on"}`,
      );
      return real.ZoneCursor();
    },
  };
});
const keySheet = () => screen.queryByRole("dialog", { name: en.shortcuts.title });

/** The window at a width, as today's own narrow rule and the frame's plan both read it. */
function sized(w: number, hgt: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: hgt });
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/.exec(query);
      const min = /min-width:\s*([\d.]+)px/.exec(query);
      const matches = (max === null || w <= Number(max[1])) && (min === null || w >= Number(min[1])) && (max !== null || min !== null);
      return {
        matches, media: query, onchange: null, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      };
    },
  });
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const letter = (): Element | null => document.querySelector('[role="region"][aria-label="Open message"] article');

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  sized(1440, 900);
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
/**
 * THE ONE ROW THE NARROW STATES DIFFER BY, and why. The shipped shell's narrow table was read with every max-width
 * query answering yes, which its layout switch reads as a width where its two layouts differ (392 to 1023): there
 * `w` is live. At a true 390 the two layouts are one and the switch rests by the shell's own rule (`layout_same`).
 */
const at390 = (was: readonly string[]): string[] =>
  was.map((r) => (r === "w|Switch layout (Zero / classic)|on" ? "w|Switch layout (Zero / classic)|off:layout_same" : r));
/**
 * THE ROW A RULING CHANGED, and why: Escape closes the open letter beside a list too (FOR-S3-TO-S8 point 64, the
 * dispatcher, 18 November 01:25: by J-1 the act stays as over one column), where the shipped shell's table read it
 * resting with rows picked. Read into the shipped table wherever a letter is open beside the list.
 */
const escapeBeside = (was: readonly string[]): string[] =>
  was.map((r) => (r === "Escape|Close what is open|off" ? "Escape|Close what is open|on" : r));
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
    expect([...letterOpen].sort(), "with a letter open").toEqual([...escapeBeside(base.letterOpen)].sort());
    /* The shipped table binds some chords twice by design, live in turn (Escape's cascade, the arrows by zone): no
       chord may be live more often here than there. */
    expect(twice(enabled(nothingOpen)).sort(), "chords live twice with nothing open").toEqual(twice(enabled(base.nothingOpen)).sort());
    expect(twice(enabled(letterOpen)).sort(), "chords live twice with a letter open").toEqual(twice(enabled(escapeBeside(base.letterOpen))).sort());
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

    expect([...rowsPicked].sort(), "with a letter open and rows picked").toEqual([...escapeBeside(base.letterOpenRowsPicked)].sort());
    expect(runs(rowsPicked), "chord by chord, the binding that runs").toEqual(runs(escapeBeside(base.letterOpenRowsPicked)));
    expect(twice(enabled(rowsPicked)).sort(), "chords live twice").toEqual(twice(enabled(escapeBeside(base.letterOpenRowsPicked))).sort());
  }, 60_000);

  it("at 390 wide the table is the shipped shell's row for row, with nothing open and with a letter over the list, and no chord runs twice", async () => {
    sized(390, 844);
    await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => rows().length === 3, "the seated list");
    const nothingOpen = [...table.rows];
    /* A press enters the row: its letter stands over the list, as the shipped shell's sheet did. */
    await act(async () => { rows()[0]!.click(); });
    await waitFor(() => letter() !== null, "the letter over the list");
    const letterOpen = [...table.rows];

    const wasNothingOpen = at390(base.nothingOpenNarrow);
    const wasLetterOpen = at390(base.letterOpenNarrow);
    expect([...nothingOpen].sort(), "with nothing open").toEqual([...wasNothingOpen].sort());
    expect(runs(nothingOpen), "chord by chord, the binding that runs with nothing open").toEqual(runs(wasNothingOpen));
    expect([...letterOpen].sort(), "with a letter open").toEqual([...wasLetterOpen].sort());
    expect(runs(letterOpen), "chord by chord, the binding that runs with a letter open").toEqual(runs(wasLetterOpen));
    expect(twice(enabled(nothingOpen)).sort(), "chords live twice with nothing open").toEqual(twice(enabled(wasNothingOpen)).sort());
    expect(twice(enabled(letterOpen)).sort(), "chords live twice with a letter open").toEqual(twice(enabled(wasLetterOpen)).sort());
  }, 60_000);

  it("the app's keys stand at the seated Ohbox: c, /, g and a place's letter, ?, z", async () => {
    await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await waitFor(() => rows().length === 2, "the seated list");
    await key("?");
    await waitFor(() => keySheet() !== null, "? opens the key sheet");
    await key("?");
    await waitFor(() => keySheet() === null, "? closes it again");

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

/** Return each planted letter and its authentic screening rule in the same sync page. */
async function seatLetters() {
  const seeded = await Promise.all(["One", "Two", "Three", "Four"].map((subject) => syncPage(subject).json()));
  const creates = seeded
    .flatMap((page) => page.changes.creates)
    .map((create, i) => ({ ...create, updatedAt: ISO, seq: i + 1 }));
  scriptSync(() => Response.json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: "c1", hasMore: false, serverTime: ISO,
  }));
  window.location.hash = "#/ohbox";
  await mountCloudShell();
  await tick(2500);
  expect(rows()).toHaveLength(4);
}

/* The original tables above also cover keys whose destinations have no switch registration. */
const laterDestinationChords = new Set([
  "/", "mod+k", // Search and palette
  "2", "3", "g r", "g e", // News and Receipts
  "4", "g s", // Screener
  "5", "6", "7", "g l", "g p", "g b", "f", // piles and Reply Run
  "g d", "g h", // Drafts and History
  "g t", "shift+Backspace", // Trash and Restore
]);

function switchTable(original: readonly string[], narrowOpen: boolean, picked: boolean): string[] {
  const expected = original.filter((row) =>
    !laterDestinationChords.has(row.split("|")[0]!) &&
    !row.startsWith("s|Change this sender's screening|") &&
    row !== "w|Switch layout (Zero / classic)|off:layout_same" &&
    // Write registers Mod+Enter where its reply editor stands.
    row !== "mod+Enter|Send the reply|off",
  ).map((row) =>
    // This Cloud host offers Pull; the frozen table used a mirror with no pull door.
    row === "p|Pull new mail now|off" ? "p|Pull new mail now|on" : row,
  );
  /* The old shell also declared these lateral keys for its Zero sheet. The zone registry owns the pair here. */
  for (const retired of ["ArrowLeft|Back to the list|off", "h|Back to the list|off"]) {
    const duplicate = expected.indexOf(retired);
    if (duplicate >= 0) expected.splice(duplicate, 1);
  }
  if (narrowOpen) expected.push("Escape|Close what is open|off"); // The beside-the-list fallback rests under the sheet.
  if (picked && !narrowOpen) {
    // The selected rows clear before the frame can close the letter beside them.
    const close = expected.indexOf("Escape|Close what is open|on");
    expected.push(...expected.splice(close, 1));
  }
  return expected;
}

function expectSwitchTable(original: readonly string[], narrowOpen: boolean, picked: boolean) {
  const expected = switchTable(original, narrowOpen, picked);
  expect([...table.rows].sort()).toEqual([...expected].sort());
  expect(runs(table.rows)).toEqual(runs(expected));
  expect(twice(enabled(table.rows)).sort()).toEqual(twice(enabled(expected)).sort());
}

describe("keys available in the mounted mail frame", () => {
  beforeEach(() => {
    resetSessionTruthForTests();
    installConfirmEnv();
    resetStorageOwnerForTest();
    scriptRefresh(refresh204);
    scriptSession(() => sessionFull());
    rememberOwner();
  });
  afterEach(async () => {
    window.history.replaceState(null, "", "/");
    resetStorageOwnerForTest();
    await teardownConfirmEnv();
  });

  it.each([
    { width: 1440, state: "with nothing open", original: base.nothingOpen, open: false, pick: false },
    { width: 1440, state: "with a letter open", original: escapeBeside(base.letterOpen), open: true, pick: false },
    { width: 1440, state: "with a letter and two rows picked", original: escapeBeside(base.letterOpenRowsPicked), open: true, pick: true },
    { width: 390, state: "with nothing open", original: at390(base.nothingOpenNarrow), open: false, pick: false },
    { width: 390, state: "with a letter over the list", original: at390(base.letterOpenNarrow), open: true, pick: false },
  ])("binds the switch keys at $width $state", async ({ width, original, open, pick }) => {
    sized(width, 900);
    await seatLetters();
    if (open) {
      await act(async () => { rows()[pick ? 1 : 0]!.click(); });
      await tick(200);
      expect(letter()).not.toBeNull();
    }
    if (pick) {
      await act(async () => { rows()[1]!.focus(); });
      await key("x");
      await tick(100);
      expect(pickedRows()).toBe(1);
      const selected = window.location.hash;
      await key("j");
      await tick(100);
      expect(window.location.hash).not.toBe(selected);
      await key("x");
      await tick(100);
      expect(pickedRows()).toBe(2);
    }

    expectSwitchTable(original, width === 390 && open, pick);

    if (pick) {
      await key("s");
      await tick(50);
      expect(screen.getByRole("dialog", { name: /screen to/i })).toBeTruthy();
      await key("Escape");
      await tick(50);
      expect(pickedRows()).toBe(2);
      await key("Escape");
      await tick(50);
      expect(pickedRows()).toBe(0);
      expect(letter()).not.toBeNull();
    }
    if (open) {
      await key("Escape");
      await tick(50);
      expect(letter()).toBeNull();
    }
  }, 60_000);

  it("binds the switch keys at 390 with a letter over two picked rows", async () => {
    sized(390, 844);
    await seatLetters();
    await key("j");
    await tick(50);
    await key("x");
    await tick(50);
    expect(pickedRows()).toBe(1);
    await key("j");
    await key("x");
    await tick(100);
    expect(pickedRows()).toBe(2);
    await key("Enter");
    await tick(150);
    expect(letter()).not.toBeNull();
    expect(pickedRows()).toBe(2);

    // The old shell snapshot took the same path: pick from the list, then enter the current letter.
    expectSwitchTable(at390(compactSelection), true, true);

    await key("Escape");
    await tick(100);
    expect(letter()).toBeNull();
    expect(pickedRows()).toBe(2);
    await key("Escape");
    await tick(100);
    expect(pickedRows()).toBe(0);
  }, 60_000);

  it.each([1440, 390])("opens, reads and closes keyboard help at %i", async (width) => {
    sized(width, 900);
    await seatLetters();

    await key("?");
    await tick(50);
    const sheet = keySheet();
    expect(sheet).not.toBeNull();
    expect(within(sheet!).getByText(en.shortcuts.compose)).toBeTruthy();
    expect(within(sheet!).getByText(en.shortcuts.undo)).toBeTruthy();
    expect(within(sheet!).getByText(en.shortcuts.goOhbox)).toBeTruthy();
    expect(within(sheet!).queryByText(en.shortcuts.search)).toBeNull();
    expect(sheet!.contains(document.activeElement)).toBe(true);

    await key("?");
    await tick(50);
    expect(keySheet()).toBeNull();
    expect(window.location.hash).toBe("#/ohbox");

    await key("z");
    await tick(50);
    expect(document.body.textContent).toContain(en.shortcuts.nothingToUndo);
    await key("p");
    await tick(50);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([input, request]) =>
      String(input).endsWith("/sync/pull") && request?.method === "POST",
    )).toHaveLength(1);
    await key("g");
    await key(",");
    await tick(100);
    expect(window.location.hash).toBe("#/settings");
    await key("g");
    await key("o");
    await tick(100);
    expect(window.location.hash).toBe("#/ohbox");
    expect(rows()).toHaveLength(4);
    await key("c");
    await tick(100);
    expect(window.location.hash).toMatch(/^#\/compose/);
  }, 60_000);
});
