/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * THE SEATED OHBOX'S KEYS AND ITS KEYBOARD (the Ohbox's own rows of the key table, and the list's part of where the
 * keyboard stands). The Ohbox seated in the frame, `TodaysOhboxAbove` above its two columns, fed by the composition's one feed:
 *
 * 1. Its key table, read out of the registry (what the `?` sheet is drawn from), with nothing open, with a letter open,
 *    and with a row picked, is the base's row for row, for every row the Ohbox's model and its zone walk bind (the
 *    base: the shipped shell's table at the Ohbox, read on the lane's base). No row is bound twice.
 * 2. Nothing of today's Ohbox view is in the document: the list is the frame's list section.
 * 3. The open letter is the address's, and `j` moves both.
 * 4. Focus follows the cursor while it stands on a row; a verb that takes the focused row leaves the keyboard on the
 *    row the cursor went to, never on the page.
 *
 * The reading column is empty here (the host hands no reader): what the reader binds and where it takes the keyboard
 * is the reader's own case at the join.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A wide window: no width query matches, so the frame draws both columns. */
function wide(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
function msg(id: string, hour: number): EngineMessage {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subj-${id}`, from: { name: `sender-${id}`, address: `${id}@ex.example` }, to: [], cc: [],
    date: at(hour), folder: "INBOX", snippet: `snip-${id}`,
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at(hour),
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let table: string[] = [];
const bulk: Array<{ action: string; ids: string[] }> = [];

async function mount(rows: EngineMessage[]): Promise<void> {
  const Seated = await (await import("./_today.js")).prepareSeated();
  const { useKeymap } = await import("@ohmail/app-logic/keys/keymap");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  let shown = rows;
  function Probe(): null {
    table = useKeymap().bindings.map(
      (b) => `${b.chord}|${b.label}|${b.disabled ? `off${b.disabledReason ? `:${b.disabledReason}` : ""}` : "on"}`,
    );
    return null;
  }
  function Wrapper(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(null);
    const [, redraw] = React.useState(0);
    return h(Seated as never, {
      owed: false, demo: false, settled: true,
      newForYou: shown, previouslySeen: [],
      tags: [], now: new Date(at(12)),
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: {
        run: (action: string, ids: string[]) => {
          bulk.push({ action, ids });
          shown = shown.filter((m) => !ids.includes(m.id));
          redraw((n) => n + 1);
          return true;
        },
        tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {},
      },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      selectedId: sel,
      onSelect: (id: string | null) => setSel(id),
    } as never);
  }
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date(at(12)),
    children: h(KeymapProvider as never, { children: [h(Probe, { key: "probe" }), h(Wrapper, { key: "view" })] } as never),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  table = [];
  bulk.length = 0;
});

const key = async (k: string, target: EventTarget = document.activeElement ?? document): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};
const cursor = (): string | null =>
  host!.querySelector<HTMLElement>('[role="option"][data-id][data-open]')?.dataset.id ?? null;
const row = (id: string): HTMLElement => host!.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)!;

/** The labels the Ohbox's model and its zone walk bind: the Ohbox's rows of the key table (PARITY K1 to K7, K24). */
const OHBOX_LABELS = new Set([
  "Next message", "Previous message", "Open the message", "Extend the selection down", "Extend the selection up",
  "Tag the message", "Select the message", "Mark unread", "Mark read", "Mark the selection read", "Cancel the open row",
  "Clear the selection", "Queue the selection for the Reply Run", "Park the selection", "Resurface the selection later",
  "Tag the selection", "Screen the selection's senders", "Move the selection", "Mark the selection unread",
  "Delete the selection — asks first", "Move the selection to Trash", "Back to the list", "Focus the menu",
  "Focus the open message", "Up the menu", "Down the menu", "Scroll the open message",
]);
const ours = (): string[] => table.filter((r) => OHBOX_LABELS.has(r.split("|")[1]!)).sort();

/* The base's table at today's Ohbox (the shipped shell, read before the seat: `wide.1-list-nothing-open`,
   `wide.2-after-j`, `wide.8-a-row-picked`), the Ohbox's rows of it. The base holds `←`/`h` "Back to the list" twice:
   once from the zone walk (here) and once from the shell's own binding for today's reader sheet, which is the shell's
   (on only under the narrow cut with the sheet up) and not a row of the Ohbox's. */
const ZONE_REST = [
  "ArrowLeft|Back to the list|off", "h|Back to the list|off",
  "ArrowRight|Back to the list|off", "l|Back to the list|off", "ArrowUp|Up the menu|off", "ArrowDown|Down the menu|off",
  "Escape|Back to the list|off", "Escape|Focus the menu|on", "ArrowUp|Scroll the open message|off",
  "ArrowDown|Scroll the open message|off", "ArrowLeft|Focus the menu|on", "h|Focus the menu|on",
];
const EXTEND = [
  "shift+ArrowDown|Extend the selection down|on", "shift+j|Extend the selection down|on",
  "shift+ArrowUp|Extend the selection up|on", "shift+k|Extend the selection up|on",
];
const BASE_NOTHING_OPEN = [
  "j|Next message|on", "k|Previous message|on", "Enter|Open the message|off:no_cursor", ...EXTEND,
  "t|Tag the message|off:no_cursor", "x|Select the message|off:no_cursor", "u|Mark unread|off:no_cursor",
  "shift+i|Mark read|off:no_cursor", "shift+u|Mark the selection read|off", "Escape|Cancel the open row|off",
  "Escape|Clear the selection|off", ...ZONE_REST,
  "ArrowRight|Focus the open message|off", "l|Focus the open message|off",
  "ArrowUp|Previous message|on", "ArrowDown|Next message|on",
].sort();
const BASE_FIRST_ROW_OPEN = [
  "j|Next message|on", "k|Previous message|off", "Enter|Open the message|on", ...EXTEND,
  "t|Tag the message|on", "x|Select the message|on", "u|Mark unread|on", "shift+i|Mark read|on",
  "shift+u|Mark the selection read|off", "Escape|Cancel the open row|off", "Escape|Clear the selection|off", ...ZONE_REST,
  "ArrowRight|Focus the open message|on", "l|Focus the open message|on",
  "ArrowUp|Previous message|off", "ArrowDown|Next message|on",
].sort();
const BASE_A_ROW_PICKED = [
  "j|Next message|on", "k|Previous message|on", "Enter|Open the message|on", ...EXTEND,
  "a|Queue the selection for the Reply Run|on", "e|Park the selection|on", "b|Resurface the selection later|on",
  "t|Tag the selection|on", "s|Screen the selection's senders|on", "m|Move the selection|on",
  "u|Mark the selection unread|on", "d|Delete the selection — asks first|on", "Backspace|Move the selection to Trash|on",
  "Delete|Move the selection to Trash|on",
  "t|Tag the message|on", "x|Select the message|on", "u|Mark unread|on", "shift+i|Mark read|on",
  "shift+u|Mark the selection read|on", "Escape|Cancel the open row|off", "Escape|Clear the selection|on", ...ZONE_REST,
  "ArrowRight|Focus the open message|on", "l|Focus the open message|on",
  "ArrowUp|Previous message|on", "ArrowDown|Next message|on",
].sort();

describe("the seated Ohbox's own keys read as the base's", () => {
  it("with nothing open, with the first row open, and with a row picked", async () => {
    wide();
    await mount([msg("a", 11), msg("b", 10), msg("c", 9)]);
    expect(host!.querySelector(".view-ohbox"), "today's Ohbox view is drawn at the seated place").toBeNull();
    expect(ours(), "nothing open").toEqual(BASE_NOTHING_OPEN);

    await key("j", document);
    expect(cursor()).toBe("a");
    expect(window.location.hash, "the open letter is the address's").toBe("#/ohbox/m/a");
    expect(ours(), "the first row open").toEqual(BASE_FIRST_ROW_OPEN);

    await key("j", document);
    await key("x", document);
    expect(ours(), "a row picked").toEqual(BASE_A_ROW_PICKED);
  });

  it("binds no chord twice under one label", async () => {
    wide();
    await mount([msg("a", 11), msg("b", 10)]);
    await key("j", document);
    await key("x", document);
    const shown = table.filter((r) => OHBOX_LABELS.has(r.split("|")[1]!) && r.endsWith("|on"));
    expect(shown.length, "the probe read the table").toBeGreaterThan(10);
    expect(new Set(shown).size, "an enabled row bound twice").toBe(shown.length);
  });
});

describe("the seated Ohbox keeps the keyboard in its list", () => {
  it("focus follows `j` while it stands on a row, and the address follows the cursor", async () => {
    wide();
    await mount([msg("a", 11), msg("b", 10), msg("c", 9)]);
    await key("j", document);
    row("a").focus();
    expect(document.activeElement).toBe(row("a"));
    await key("j");
    expect(cursor()).toBe("b");
    expect(document.activeElement, "the keyboard stayed on the row the cursor left").toBe(row("b"));
    expect(window.location.hash).toBe("#/ohbox/m/b");
  });

  it("a verb that takes the focused row leaves the keyboard on the row the cursor went to, never on the page", async () => {
    wide();
    await mount([msg("a", 11), msg("b", 10), msg("c", 9)]);
    await key("j", document);
    row("a").focus();
    await key("x");
    await key("e");
    expect(bulk.map((b) => b.action), "the pick's Park ran").toEqual(["aside"]);
    expect(host!.querySelector('[role="option"][data-id="a"]'), "the parked row left the list").toBeNull();
    const now = document.activeElement as HTMLElement | null;
    expect(now === null || now === document.body, "the keyboard fell to the page").toBe(false);
    expect(now!.closest("section")?.contains(row("b")), "the keyboard is in the list's section").toBe(true);
  });
});
