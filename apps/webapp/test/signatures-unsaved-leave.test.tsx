/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";

import { SettingsView } from "../app/views/SettingsView";
import { SignaturesRow } from "../app/shell/SignaturesRow";
import { go, goSettings, useHashRoute } from "../app/shell/routing";

/**
 * SETTINGS-SIGNATURE-DRAFT-DROPPED-ON-LEAVE. An edited signature is a draft until its Save, and
 * leaving the pane unmounted the editor: the words were dropped without a question. Through the
 * real settings view, the real row and the shell's hash routing: a leave with an edit asks
 * (Keep editing stays, Discard leaves without a write), a Back press is held too, the tab close
 * asks, and with nothing edited nothing asks.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
const S = messages.settings.signatures;

let host: HTMLDivElement;
let root: Root;
let writes: Array<[string, string | null, string | null | undefined]>;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

function Shell() {
  const route = useHashRoute();
  if (route.view !== "settings") return h("p", { className: "elsewhere" }, route.view);
  return h(SettingsView, {
    notifications: null, tags: [], tagCounts: {},
    pane: route.settingsPane ?? undefined,
    onSelectPane: goSettings,
    screeningSection: h("p", null, "posture"),
    signaturesSection: h(SignaturesRow, {
      mailboxes: [{ id: "mb-one", address: "one@example.test" }],
      signatures: { "mb-one": "Anna" }, signaturesHtml: {}, signatureSources: {},
      setMailboxSignature: async (id, text, html) => { writes.push([id, text, html]); return {}; },
    }),
  });
}

async function mount(): Promise<void> {
  writes = [];
  window.history.replaceState(null, "", "/mailbox#/settings/signatures");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, null, h(ToastHost, null, h(Shell))),
    }));
  });
  await settle();
  await settleEditor();
}

/** Types through the editor's own command (jsdom gives ProseMirror no input events). */
const type = async (words: string): Promise<void> => {
  const dom = host.querySelector(".sig-settings-editor .ProseMirror") as unknown as {
    editor?: { commands: { focus: (at: string) => void; insertContent: (s: string) => void } };
  } | null;
  if (!dom?.editor) throw new Error("the signature editor did not mount");
  await act(async () => { dom.editor!.commands.focus("end"); dom.editor!.commands.insertContent(words); });
  await settle();
};
const buttons = (label: string): HTMLButtonElement[] =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
const press = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
};
const question = (): Element | null => host.querySelector("[role=alertdialog]");
const onSettings = (): boolean => host.querySelector(".elsewhere") === null;

beforeEach(() => { window.history.replaceState(null, "", "/mailbox"); });
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

describe("leaving Signatures with an edited signature asks", () => {
  it("the rail's verb is held: Keep editing stays with the words, Discard leaves unsaved", async () => {
    await mount();
    await type(" — on leave");
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings(), "the pane was left and the draft dropped").toBe(true);
    expect(window.location.hash).toBe("#/settings/signatures");
    expect(question()?.getAttribute("aria-label")).toBe(S.leaveAsk);

    await press(buttons(S.leaveKeep)[0]!);
    expect(question()).toBeNull();
    expect(host.querySelector(".sig-settings-editor")?.textContent).toContain("on leave");

    await act(async () => { go("ohbox"); });
    await settle();
    await press(question()!.querySelector("button")!);
    expect(onSettings()).toBe(false);
    expect(window.location.hash).toBe("#/ohbox");
    expect(writes).toHaveLength(0);
  });

  it("a Back press or a link is held too, and the address goes back to the pane", async () => {
    await mount();
    await type(" — on leave");
    await act(async () => { window.location.hash = "#/screener"; });
    await settle();
    expect(onSettings()).toBe(true);
    expect(window.location.hash).toBe("#/settings/signatures");
    expect(question()).not.toBeNull();
  });

  it("closing the tab asks while edited, and not after the Save", async () => {
    await mount();
    const unload = (): boolean => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await type(" — on leave");
    expect(unload()).toBe(true);
    await press(buttons(S.save)[0]!);
    expect(writes).toHaveLength(1);
    expect(unload()).toBe(false);
  });

  it("CONTROL: with nothing edited, leaving goes without a question", async () => {
    await mount();
    await act(async () => { go("ohbox"); });
    await settle();
    expect(onSettings()).toBe(false);
    expect(question()).toBeNull();
  });
});
