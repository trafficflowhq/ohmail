/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import base from "./fixtures/keys-at-the-ohbox.base.json";
import compactSelection from "./fixtures/keys-at-the-ohbox-compact-selection.base.json";
import { act, stubDom, unmountAll } from "../_draft-shell.js";
import {
  ISO, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, syncPage, teardownConfirmEnv, tick,
} from "../fixtures/cloud-confirm-shell.js";

import {
  NOW, engineOver, msg, setup as setupView, shell, storeWith, teardown as teardownView, waitFor,
} from "../_view-shell.js";
import en from "../../messages/en.json";

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

const pickedRows = (): number => rows().filter((r) => r.hasAttribute("data-picked")).length;
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

function expectShortcuts(original: readonly string[], open: boolean): void {
  for (const chord of ["f", "shift+Backspace"]) {
    const rowsFor = (rows: readonly string[]) => rows.filter((row) => row.startsWith(`${chord}|`));
    expect.soft(rowsFor(table.rows)).toEqual(rowsFor(original));
  }
  expect.soft(table.rows.includes("Escape|Close what is open|on")).toBe(open);
}

describe("Reply Run, Restore and Escape in the mounted mail frame", () => {
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
    { width: 1440, state: "with a letter open", original: base.letterOpen, open: true, pick: false },
    { width: 1440, state: "with a letter and two rows picked", original: base.letterOpenRowsPicked, open: true, pick: true },
    { width: 390, state: "with nothing open", original: base.nothingOpenNarrow, open: false, pick: false },
    { width: 390, state: "with a letter over the list", original: base.letterOpenNarrow, open: true, pick: false },
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

    expectShortcuts(original, open);

    if (pick) {
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
    expectShortcuts(compactSelection, true);

    await key("Escape");
    await tick(100);
    expect(letter()).toBeNull();
    expect(pickedRows()).toBe(2);
    await key("Escape");
    await tick(100);
    expect(pickedRows()).toBe(0);
  }, 60_000);

});

it.each(["ohbox", "history"])("opens a waiting reply with f from %s", async (place) => {
  setupView();
  try {
    const waiting = msg("waiting", {
      triage: {
        messageId: "waiting", state: "reply_later", bubbleUpAt: null,
        setAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    });
    const store = await storeWith([waiting]);
    const host = await shell(store, engineOver(store), "#/" + place);
    await waitFor(() => host.textContent?.includes("Answer Later") ?? false, "the mail rail");
    await key("f");
    expect(window.location.hash).toMatch(/^#\/(later|triage)/);
    const run = () => within(host).queryByRole("toolbar", { name: en.later.run.label });
    await waitFor(() => run() !== null, "the Reply Run toolbar");
    expect(within(host).getByRole("heading", { name: waiting.subject! })).toBeTruthy();
    expect(within(run()!).getByRole("button", { name: en.later.run.skip })).toBeTruthy();
  } finally {
    await teardownView();
  }
});
