/** @vitest-environment jsdom */
/**
 * AT ONE COLUMN THE LETTER OVER THE LIST IS THE ZONE WALK's SHEET (the switch's point 65, by RULING-JOIN J-1: today's
 * reader sheet was): while it stands, ↑ and ↓ scroll it from wherever the keyboard was left, and never move the list
 * hidden under it; a field under the letter does not silence it; a dialog over it owns its own arrows. Over the shell
 * the hosts mount (the tests' door), the letter opened by its address.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READER_SCROLL_STEP } from "@ohmail/app-logic/keys";
import { fireEvent, within } from "@testing-library/react";
import { act, message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import { key, letter as composer, letterSubject, letterText } from "../_writing-shell";
import { navigate } from "../_handoff-steps";
import { typeInto } from "../fixtures/rich-editor-driver";

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

/** The open letter's region and its scroller, as a person meets them. */
const letter = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const scroller = (): HTMLElement | null => letter()?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;
const list = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="listbox"]');
const marked = (): string =>
  [...(list()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    .map((r) => `${r.getAttribute("aria-selected")}|${r.hasAttribute("data-open")}|${r.hasAttribute("data-cursor")}`)
    .join(",");
const down = async (from: Element): Promise<void> => {
  await act(async () => {
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  sized(390, 844);
});
afterEach(async () => {
  await unmountAll();
  document.querySelectorAll("[data-case-made]").forEach((n) => n.remove());
});

async function letterOver(): Promise<HTMLElement> {
  await mountShell("#/ohbox/m/m2", [message("m1"), message("m2"), message("m3")]);
  await waitFor(() => scroller() !== null, "the letter over the list");
  const el = scroller()!;
  el.scrollTop = 0;
  return el;
}

describe("the letter over the list at 390 wide is the sheet the keys scroll", () => {
  it("↓ with the keyboard on the page scrolls the letter and moves nothing in the list under it", async () => {
    const el = await letterOver();
    (document.activeElement as HTMLElement | null)?.blur();
    const before = marked();
    await down(document.body);
    expect(el.scrollTop, "the letter scrolled").toBe(READER_SCROLL_STEP);
    expect(marked(), "the list under it did not move").toBe(before);
    expect(window.location.hash).toBe("#/ohbox/m/m2");
  }, 30_000);

  it("a field under the letter does not silence it: ↓ there scrolls the letter", async () => {
    const el = await letterOver();
    const field = document.createElement("input");
    field.setAttribute("data-case-made", "");
    document.querySelector(".fr-list")!.prepend(field);
    field.focus();
    await down(field);
    expect(el.scrollTop).toBe(READER_SCROLL_STEP);
  }, 30_000);

  it("a dialog over the letter owns its own arrows: the letter does not scroll and the list does not move", async () => {
    const el = await letterOver();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-case-made", "");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    const before = marked();
    await down(button);
    expect(el.scrollTop).toBe(0);
    expect(marked()).toBe(before);
  }, 30_000);
});

it.each([
  { width: 390, exit: "Back" },
  { width: 1024, exit: "Escape" },
])("keeps the final words in Drafts when $exit closes Write during a save", async ({ width, exit }) => {
  sized(width, 844);
  const shell = await mountShell("#/compose", []);
  const saves = () => shell.sent.filter((mutation) => mutation.kind === "draft_save");
  const subject = "The letter I was writing";
  const body = "The first words. The last words too.";
  await waitFor(() => letterText(shell.el) !== null, "the editor");
  let answer!: () => void;
  let finish!: () => void;
  shell.saveGate.wait = new Promise<void>((resolve) => { answer = resolve; });
  const finalAnswer = new Promise<void>((resolve) => { finish = resolve; });
  try {
    fireEvent.change(letterSubject(shell.el)!, { target: { value: subject } });
    await act(async () => { typeInto(letterText(shell.el)!, "The first words."); });
    if (exit === "Back") {
      await waitFor(() => saves().length === 1, "the autosave");
      await press(within(composer(shell.el)!).getByRole("button", { name: "Ohbox" }), "Back");
    } else {
      await key("Escape");
    }
    await waitFor(() => saves().length === 1, "the first save");
    await act(async () => { typeInto(letterText(shell.el)!, body); });
    shell.saveGate.wait = finalAnswer;
    await act(async () => { answer(); });
    await waitFor(() => saves().length === 2, "the last words to start saving");
    expect(composer(shell.el), "the composer closed before the last words were kept").not.toBeNull();
  } finally {
    await act(async () => { answer(); finish(); });
  }
  await waitFor(() => composer(shell.el) === null, "the closed composer");
  expect(saves()[1]).toMatchObject({ subject, body });
  expect(saves()[1]).not.toMatchObject({ draftId: null });

  await navigate("#/drafts");
  const list = within(await within(shell.el).findByRole("listbox", { name: "Drafts" }));
  await press(list.getByRole("option", { name: new RegExp(subject) }), "the saved draft");
  await waitFor(() => letterText(shell.el)?.textContent === body, "all the saved words");
}, 15_000);

it.each([
  { width: 390, exit: "navigation" },
  { width: 1024, exit: "navigation" },
  { width: 390, exit: "navigation after Escape" },
])("keeps the final words in one draft after $exit during an autosave at $width wide", async ({ width, exit }) => {
  sized(width, 844);
  const shell = await mountShell("#/compose", []);
  const saves = () => shell.sent.filter((mutation) => mutation.kind === "draft_save");
  const subject = "An unfinished letter";
  const body = "First words. And the last words.";
  await waitFor(() => letterText(shell.el) !== null, "the editor");
  let answer!: () => void;
  shell.saveGate.wait = new Promise<void>((resolve) => { answer = resolve; });
  try {
    fireEvent.change(letterSubject(shell.el)!, { target: { value: subject } });
    await act(async () => { typeInto(letterText(shell.el)!, "First words."); });
    await waitFor(() => saves().length === 1, "the autosave");
    await act(async () => { typeInto(letterText(shell.el)!, body); });
    if (exit === "navigation after Escape") await key("Escape");
    await navigate("#/drafts");
    expect(composer(shell.el)).toBeNull();
  } finally {
    await act(async () => { answer(); });
  }
  await waitFor(() => saves().some((save) => save.body === body), "the final words to be saved");
  expect(window.location.hash).toBe("#/drafts");
  expect(saves()).toEqual([
    expect.objectContaining({ draftId: null, body: "First words." }),
    expect.objectContaining({ draftId: expect.any(String), body }),
  ]);
  const list = within(await within(shell.el).findByRole("listbox", { name: "Drafts" }));
  expect(list.getAllByRole("option")).toHaveLength(1);
  await press(list.getByRole("option", { name: new RegExp(subject) }), "the saved draft");
  await waitFor(() => letterText(shell.el)?.textContent === body, "all the saved words");
}, 15_000);

it("leaving Write while the first save is queued keeps later edits on the same draft", async () => {
  const shell = await mountShell("#/compose", [], [], { startOffline: true });
  const subject = "A letter written offline";
  const body = "First words. More before leaving.";
  await waitFor(() => letterText(shell.el) !== null, "the editor");
  fireEvent.change(letterSubject(shell.el)!, { target: { value: subject } });
  await act(async () => { typeInto(letterText(shell.el)!, "First words."); });
  const pending = () => shell.engine.pendingMutations().filter(({ mutation }) => mutation.kind === "draft_save");
  await waitFor(() => pending().length === 1, "the first queued save");
  await act(async () => { typeInto(letterText(shell.el)!, body); });
  await navigate("#/drafts");
  expect(pending()).toHaveLength(1);
  shell.offline.on = false;
  await act(async () => { await shell.engine.flushPending(); });
  await waitFor(() => shell.sent.some((save) => save.kind === "draft_save" && save.body === body), "the later edits to save");
  const list = within(await within(shell.el).findByRole("listbox", { name: "Drafts" }));
  expect(list.getAllByRole("option")).toHaveLength(1);
  await press(list.getByRole("option", { name: new RegExp(subject) }), "the saved draft");
  await waitFor(() => letterText(shell.el)?.textContent === body, "all the saved words");
}, 15_000);

it("the narrow reader's Back returns to Drafts and keeps the saved reply", async () => {
  const parent = "parent-letter";
  const text = "Thursday works, I will bring the samples.";
  const shell = await mountShell("#/drafts", [message(parent)], [replyDraft("saved-reply", parent, text)]);
  const open = async () => {
    const list = within(await within(shell.el).findByRole("listbox", { name: "Drafts" }));
    await press(list.getByRole("option"), "the saved reply");
    await waitFor(() => replySurface(shell.el) !== null, "the opened reply");
  };
  await open();
  const reader = within(within(shell.el).getByRole("region", { name: "Open message" }));
  await press(reader.getByRole("button", { name: /Drafts|Ohbox/ }), "the reader's Back");
  expect(window.location.hash).toBe("#/drafts");
  await open();
  expect(replySurface(shell.el)!.textContent).toBe(text);
}, 15_000);
