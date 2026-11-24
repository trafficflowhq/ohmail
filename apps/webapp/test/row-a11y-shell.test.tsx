/** @vitest-environment jsdom */
/**
 * ═══ THE LIST ROW, THROUGH THE SHIPPED SHELL ══════════════════════════════════════════════
 *
 * `packages/ui/test/message-row-a11y.test.tsx` holds the row's own contract. This file drives it
 * through the real Ohbox, because three of the four facts only exist once the view supplies them:
 * the stamp comes from `rowStamp`, the words from the catalogue through `useRowBadgeCopy`, and the
 * selection from the cursor the shell owns.
 *
 * THE PRESS IS PROVEN BY AN EFFECT ONLY A REAL SELECTION PRODUCES. The accessibility tree cannot
 * tell "nothing is selected" from "the selection is not published" — which is how the defect stood
 * — so a press is never judged by the tree: it is judged by the reading pane naming that message.
 * The press itself goes by ROLE with a count-refusing match, the rule the drivers use.
 *
 * MUTATION-PROVEN AT AUTHORING TIME (applied, watched red, restored, `cmp`-verified):
 *   · `MessageRow`'s `chosen` → `false` — "the cursor is the selection" goes red, naming green.
 *   · `pickState` → `picked.has(m.id)` (the pre-fix constant shape) — the same case goes red,
 *     because the Ohbox's empty pick set then publishes `false` on every row.
 *   · `rowStamp`'s `timeSpoken: abs` → `""` — the stamp case goes red alone.
 *   · `useRowBadgeCopy`'s `spoken` dropped from the row — the read-state case goes red alone.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): the shell is the one there is (`_mail-shell.tsx`: the frame
 * over the mail ground, the seated Ohbox and the reader); the Ohbox's rows are the options of the frame's list
 * section ("Messages"), and the reading column is the frame's reading section ("Reading"). Expectations as they stood.
 * The case that read `useRowBadgeCopy` alone (one spoken object across renders) moved word for word to
 * `row-copy-one-spoken-object.test.tsx`: the list places that draw their rows' words with it are not mounted yet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import { readingColumn, seatedList } from "./ohbox/_finders.js";

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

/* jsdom has no layout, so the shell's locate-and-flash would throw inside a frame callback. */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The demo shell — `selection-pill.test.tsx`'s harness, without its cursor-priming keystroke. */
async function mountShell(): Promise<void> {
  await unmount();
  const { MailShell: AppShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/**
 * A ROLE QUERY WITH A COUNT REFUSAL, written here because this app is not a `@testing-library`
 * consumer (the note in `rich-editor.test.tsx`). Two candidates for one name is a list that cannot
 * be driven, so it refuses rather than pressing the first.
 */
function option(name: string): HTMLElement {
  const hits = rows().filter(
    (el) => el.getAttribute("aria-label") === name,
  );
  expect(hits.length, `options named ${JSON.stringify(name)}`).toBe(1);
  return hits[0]!;
}

const rows = (): HTMLElement[] => [...(seatedList(host!)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const chosen = (): HTMLElement[] => rows().filter((r) => r.getAttribute("aria-selected") === "true");
/** What the reading column is showing — the effect a real selection has and nothing else does. */
const readerText = (): string => readingColumn(host!)?.textContent ?? "";

beforeEach(mountShell);
afterEach(unmount);

describe("every Ohbox row is an option in a named listbox", () => {
  it("puts every row in a labelled listbox and none of them outside one", () => {
    expect(rows().length).toBeGreaterThan(3);
    for (const r of rows()) {
      const box = r.closest('[role="listbox"]');
      expect(box, `${r.getAttribute("data-id")} stands outside a listbox`).toBeTruthy();
      expect((box as HTMLElement).getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("describes each row with its arrival stamp written out and its read state in a word", () => {
    for (const r of rows()) {
      const said = r.getAttribute("aria-description") ?? "";
      expect(said, `${r.getAttribute("data-id")} says nothing`).not.toBe("");
      // The shown stamp is relative ("Sat", "09:12"); the spoken one names the day and the year.
      expect(said, said).toMatch(/\d{4}/);
      expect(said, said).toMatch(/ · (Unread|Read)(?: · |$)/);
    }
  });
});

describe("a press by role publishes the selection it makes", () => {
  it("flips aria-selected onto the pressed row, and the reading pane names that message", async () => {
    expect(chosen(), "nothing is selected before the press").toHaveLength(0);

    const target = rows()[2]!;
    expect(readerText(), "the reading column already names it").not.toContain(
      target.getAttribute("aria-label")!.slice(target.getAttribute("aria-label")!.indexOf(": ") + 2),
    );
    const name = target.getAttribute("aria-label")!;
    const subject = name.slice(name.indexOf(": ") + 2);
    await click(option(name));

    // THE EFFECT ONLY A REAL SELECTION PRODUCES.
    expect(readerText(), "the reading column does not name the pressed message").toContain(subject);
    // …and now the tree says so too, on exactly one row.
    const picked = chosen();
    expect(picked).toHaveLength(1);
    expect(picked[0]!.getAttribute("aria-label")).toBe(name);
  });

  it("moves the selection rather than adding one, which is what a cursor is", async () => {
    await click(option(rows()[1]!.getAttribute("aria-label")!));
    const second = rows()[4]!.getAttribute("aria-label")!;
    await click(option(second));
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]!.getAttribute("aria-label")).toBe(second);
  });

  it("keeps one tab stop in the list, on the row the cursor is on", async () => {
    const name = rows()[3]!.getAttribute("aria-label")!;
    await click(option(name));
    const stops = rows().filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("aria-label")).toBe(name);
  });
});
