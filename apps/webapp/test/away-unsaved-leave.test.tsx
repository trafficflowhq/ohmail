/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

import { SettingsView } from "../app/views/SettingsView";
import { AwayResponderRow, type AwayTransport } from "../app/shell/AwayResponderRow";
import type { AwayResponderSaveWire, AwayResponderWire } from "../app/api-client";
import { go, goSettings, useHashRoute } from "../app/shell/routing";

/**
 * THE AWAY SWITCH SAYS WHAT IS SAVED.
 *
 * Pressing the switch drew "On. Replies to new mail, …" while nothing was stored, Save sat below
 * the fold, and leaving the pane dropped the change without a word: somebody who flipped it on
 * before a holiday was told replies would go out and none did. Measured here through the real
 * settings view, the real row and the shell's own hash routing:
 *  · the status line states the SAVED row; an unsaved change has its own sentence and its own Save;
 *  · leaving with one asks — through the rail's verb, a settings pane switch, and Back/a link —
 *    and Discard leaves without a write, Keep editing stays with the edit;
 *  · controls: a save still writes the message unchanged, and switching off says off once saved.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;
let puts: Array<Omit<AwayResponderWire, "updatedAt">>;

const A = messages.away;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/** The shell's shape: the route decides whether the settings view is on screen at all. */
function Shell({ transport }: { transport: AwayTransport }) {
  const route = useHashRoute();
  if (route.view !== "settings") return h("p", { className: "elsewhere" }, route.view);
  return h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    pane: route.settingsPane ?? undefined,
    onSelectPane: goSettings,
    screeningSection: h("p", null, "posture"),
    awaySection: h(AwayResponderRow as React.FunctionComponent<{ transport: AwayTransport }>, { transport }),
  });
}

async function mount(row: Partial<AwayResponderSaveWire> = {}, url = "/mailbox#/settings/away"): Promise<void> {
  const stored: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "t0",
    ...row,
  };
  puts = [];
  const transport: AwayTransport = {
    state: async () => stored,
    save: async (next) => { puts.push(next); Object.assign(stored, next, { updatedAt: "t1" }); return { ...stored }; },
  };
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, null, h(ToastHost, null, h(Shell, { transport }))),
    }));
  });
  await settle();
}

const awaySwitch = (): Element => {
  const found = [...host.querySelectorAll("[role=switch], input[type=checkbox]")]
    .filter((el) => el.getAttribute("aria-label") === A.title);
  if (found.length !== 1) throw new Error(`away switch: expected 1, found ${found.length}`);
  return found[0]!;
};
const flip = async (): Promise<void> => {
  await act(async () => { awaySwitch().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};
const buttons = (label: string): HTMLButtonElement[] =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
const press = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};
const text = (): string => host.textContent ?? "";
const question = (): Element | null => host.querySelector("[role=alertdialog]");
const onSettings = (): boolean => host.querySelector(".elsewhere") === null;

beforeEach(() => { window.history.replaceState(null, "", "/mailbox"); });
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

describe("the status line states the saved responder", () => {
  it("switching on draws the unsaved sentence and its Save, never 'On.'", async () => {
    await mount();
    expect(text()).toContain(A.off);
    await flip();
    expect(text(), "the line read the draft").not.toContain(A.on);
    expect(text()).toContain(A.off);
    expect(text()).toContain(A.unsavedStillOff);
    /* The Save beside the sentence, in the block under the switch. */
    const block = host.querySelector(".away-unsaved");
    expect(block?.textContent).toContain(A.save);
    expect(puts).toHaveLength(0);
  });

  it("the end-date note follows the saved row too: no 'On until' over a responder still off", async () => {
    await mount({ endsAt: "2036-09-14T23:59:59.000Z" });
    /* At rest: a saved OFF row that keeps a stored end date reads Off, and nothing else. */
    expect(text()).toContain(A.off);
    expect(text()).not.toContain("On until");
    await flip();
    expect(text()).not.toContain("On until");
    await press(host.querySelector(".away-unsaved button")!);
    expect(text()).toContain("On until ");
  });

  it("CONTROL: the Save beside it writes the row, the message unchanged, and the line says On", async () => {
    await mount();
    await flip();
    await press(host.querySelector(".away-unsaved button")!);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.enabled).toBe(true);
    expect(puts[0]!.body).toBe("Back Monday");
    expect(text()).toContain(A.on);
    expect(text()).not.toContain(A.unsavedStillOff);
    expect(text()).toContain(A.saved);
    /* Nothing unsaved, nothing to ask: leaving goes. */
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings()).toBe(false);
  });

  it("CONTROL: switching off says off once saved, and 'stays on' until then", async () => {
    await mount({ enabled: true });
    expect(text()).toContain(A.on);
    await flip();
    expect(text()).toContain(A.on);
    expect(text()).toContain(A.unsavedStillOn);
    await press(buttons(A.save)[0]!);
    expect(puts.at(-1)!.enabled).toBe(false);
    expect(text()).toContain(A.off);
    expect(text()).not.toContain(A.on);
  });
});

describe("leaving with an unsaved change asks", () => {
  it("the rail's verb is held: asked, Keep editing stays with the edit, Discard leaves unsaved", async () => {
    await mount();
    await flip();
    const depth = window.history.length;
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings(), "the pane was left without a question").toBe(true);
    /* Asked BEFORE the hash is written: no history entry for a leave that did not happen. */
    expect(window.history.length).toBe(depth);
    expect(window.location.hash).toBe("#/settings/away");
    expect(question()?.getAttribute("aria-label")).toBe(A.leaveAsk);
    await press(buttons(A.leaveKeep)[0]!);
    expect(question()).toBeNull();
    expect(onSettings()).toBe(true);
    expect(awaySwitch().getAttribute("aria-checked") ?? String((awaySwitch() as HTMLInputElement).checked)).toBe("true");

    await act(async () => { go("ohbox"); });
    await settle();
    await press(buttons(A.leaveDiscard)[0]!);
    expect(onSettings()).toBe(false);
    expect(window.location.hash).toBe("#/ohbox");
    expect(puts).toHaveLength(0);
  });

  it("a Back press or a link is held too, and the address goes back to the pane", async () => {
    await mount();
    await flip();
    await act(async () => { window.location.hash = "#/screener"; });
    await settle();
    expect(onSettings()).toBe(true);
    expect(window.location.hash).toBe("#/settings/away");
    expect(question()).not.toBeNull();
    await press(buttons(A.leaveDiscard)[0]!);
    expect(window.location.hash).toBe("#/screener");
    expect(onSettings()).toBe(false);
    expect(puts).toHaveLength(0);
  });

  it("another settings pane is a leave as well", async () => {
    await mount();
    await flip();
    const entry = [...host.querySelectorAll(".set-nav button")].find((b) => b.textContent?.trim() === "Screener");
    const depth = window.history.length;
    await press(entry!);
    expect(window.location.hash).toBe("#/settings/away");
    expect(window.history.length).toBe(depth);
    expect(question()).not.toBeNull();
  });

  it("closing the tab asks the browser's question while unsaved, and not after a save", async () => {
    await mount();
    const unload = (): boolean => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await flip();
    expect(unload()).toBe(true);
    await press(host.querySelector(".away-unsaved button")!);
    expect(unload()).toBe(false);
  });

  it("CONTROL: a message typed and deleted over an empty one is no change", async () => {
    await mount({ body: null });
    const field = host.querySelector("#away-body") as HTMLTextAreaElement;
    const type = async (v: string): Promise<void> => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => { set.call(field, v); field.dispatchEvent(new Event("input", { bubbles: true })); });
      await settle();
    };
    await type("x");
    expect(text()).toContain(A.unsavedStillOff);
    await type("");
    expect(text()).not.toContain(A.unsavedStillOff);
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings()).toBe(false);
  });

  it("the pane's own nav entry under a bare #/settings is no leave; another pane still asks", async () => {
    await mount({}, "/mailbox?settings=away#/settings");
    await flip();
    const entry = (label: string) => [...host.querySelectorAll(".set-nav button")].find((b) => b.textContent?.trim() === label)!;
    await press(entry(A.title));
    expect(question()).toBeNull();
    expect(text()).toContain(A.unsavedStillOff);
    await press(entry("Screener"));
    expect(question()).not.toBeNull();
  });

  it("CONTROL: a pile ticked and unticked over an old spelling or an inert Screener pile is no change", async () => {
    await mount({ piles: ["INBOX", "ohmail/Reads", "ohmail/Screener"] as never });
    const box = (v: string) => host.querySelector(`input[name="away-piles"][value="${v}"]`) as HTMLInputElement;
    await press(box("ohmail/Receipts"));
    expect(text()).toContain(A.unsavedStillOff);
    await press(box("ohmail/Receipts"));
    expect(text()).not.toContain(A.unsavedStillOff);
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings()).toBe(false);
  });

  it("every verb that writes the hash asks the hold first", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/shell/routing.ts"), "utf8");
    for (const verb of ["go", "goTag", "goFolder", "goAddress", "goScreener", "goTriage", "goSettings", "goFirstRun"]) {
      const body = src.slice(src.indexOf(`export function ${verb}(`));
      const end = body.indexOf("\n}\n");
      const decl = body.slice(0, end);
      // The write is the hash itself, or `navigate`, which writes it and tells the route at once.
      expect(decl, verb).toMatch(/if \(heldBefore\(next, \(\) => \w+\([^)]*\)\)\) return;\n[\s\S]*(?:window\.location\.hash = next|navigate\(next\));/);
    }
    const navigate = src.slice(src.indexOf("function navigate("));
    expect(navigate.slice(0, navigate.indexOf("\n}\n")), "navigate no longer writes the hash first")
      .toMatch(/^function navigate\(next: string\): void \{\n\s*window\.location\.hash = next;/);
  });

  it("CONTROL: an edit put back by hand is no change — nothing asks", async () => {
    await mount();
    await flip();
    await flip();
    expect(text()).not.toContain(A.unsavedStillOff);
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings()).toBe(false);
  });
});
