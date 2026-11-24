/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * ESCAPE CLOSES THE INNERMOST THING THAT IS OPEN, AND ONLY THAT.
 *
 * With the address suggestions open under To, one Escape closed the whole compose view. The
 * field stopped the key, but the App Router hydrates the DOCUMENT, so React and the keymap are
 * sibling listeners on one node and `stopPropagation` does not reach a sibling. The rule: the
 * keymap leaves alone a key a field already handled (prevented or stopped). The shell cases
 * mount React on `document` itself, as the App Router does — in a `<div>` the bug cannot show.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const { useKeyBindings } = await import("@ohmail/app-logic/keys/keymap");
const { KeymapProvider } = await import("../../../test/support/keymap-provider");

let roots: Root[] = [];
let foreign: Array<() => void> = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the shell still boots */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null, dispatchEvent: () => false,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  for (const off of foreign) off();
  foreign = [];
  // A document-level root takes `<html>` with it on unmount; the next case needs one back.
  if (!document.documentElement) {
    const html = document.createElement("html");
    html.append(document.createElement("head"), document.createElement("body"));
    document.appendChild(html);
  }
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** The shipped shell, rendered the way the App Router renders it: React's root IS `document`. */
async function shellOnDocument(): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const root = createRoot(document as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(
      h("html", null, h("head"), h("body", null,
        h(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
          now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(ThemeProvider, {
            storageKey: null,
            children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
          }),
        }))),
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  await waitFor(() => within(document.body).queryByRole("main") !== null, "the mail frame never opened");
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    if (cond()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(cond(), what).toBe(true);
}

/** Leaving Compose saves first and navigates after, so a close lands a few tasks later. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A keydown aimed at `target`, bubbling and cancelable as a typed one is. */
async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(e); });
  return e;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const compose = () => within(document.body).queryByRole("region", { name: "New message" });
const suggestions = () => compose() ? within(compose()!).queryAllByRole("option").length : 0;
const toField = () => within(compose()!).getByRole<HTMLInputElement>("combobox", { name: "To" });
const editor = () => within(compose()!).queryByRole("textbox", { name: messages.write.text });
const linkCard = () => within(document.body).queryByRole("dialog", { name: "Link" });

/** Open Compose, type into To until the address suggestions show, and hand back the field. */
async function suggestionsOpen(): Promise<HTMLInputElement> {
  await press(document, "c");
  await waitFor(() => compose() != null, "`c` did not open Compose");
  const to = toField();
  for (const prefix of ["a", "e", "m", "s"]) {
    await typeInto(to, prefix);
    if (suggestions() > 0) return to;
  }
  expect(suggestions(), "no address suggestion opened — the case has nothing to close").toBeGreaterThan(0);
  return to;
}

/** Open Compose and wait for the message body's editor. */
async function openBody(): Promise<void> {
  await press(document, "c");
  await waitFor(() => compose() != null, "`c` did not open Compose");
  await waitFor(
    () => editor() != null,
    "the editor never mounted",
  );
}

describe("Escape in the address suggestions closes the suggestions, not the message", () => {
  it("one Escape closes the list and Compose stays; the next closes Compose and keeps the draft", async () => {
    await shellOnDocument();
    const to = await suggestionsOpen();
    const typed = to.value;

    await press(to, "Escape");
    await settle();
    expect(suggestions(), "Escape left the address suggestions open").toBe(0);
    expect(compose(), "one Escape in the suggestions closed the whole compose view").not.toBeNull();

    await press(toField(), "Escape");
    await waitFor(() => compose() == null, "the second Escape did not close Compose");

    await press(document, "c");
    await waitFor(() => compose() != null, "`c` did not reopen Compose");
    expect(toField().value, "closing lost the draft")
      .toBe(typed);
  });

  it("the link popover in the message body: Escape closes the popover, Compose stays", async () => {
    // The same field shape one row down: LinkPopover prevents and stops Escape and nothing else.
    await shellOnDocument();
    await openBody();
    const letter = within(compose()!);
    if (!letter.queryByRole("button", { name: messages.write.marks.link })) {
      await act(async () => { letter.getByRole("button", { name: messages.write.marks.show }).click(); });
    }
    const link = letter.getByRole("button", { name: messages.write.marks.link });
    await act(async () => { link.click(); });
    await waitFor(() => linkCard() != null, "Link did not open the popover");

    await press(within(linkCard()!).getByRole("textbox", { name: "Address" }), "Escape");
    await settle();
    expect(linkCard(), "Escape left the link popover open").toBeNull();
    expect(compose(), "Escape in the link popover closed the whole compose view").not.toBeNull();
  });

  it("⌘K in the message body is the editor's: the link popover opens and the palette does not", async () => {
    await shellOnDocument();
    await openBody();
    await press(editor()!, "k", { metaKey: true });
    await settle();
    expect(within(document.body).queryByRole("dialog", { name: "Command palette" }), "⌘K in the body also opened the command palette").toBeNull();
    expect(linkCard(), "⌘K in the body did not open the link popover").not.toBeNull();
  });
});

/*
 * THE RULE, IN THE DISPATCHER. `field` stands where React stands under the App Router: a
 * document listener attached BEFORE the keymap's. A key it prevented or stopped is its own;
 * one it leaves alone still reaches the binding (the positive control).
 */
describe("the keymap leaves alone a key a field has handled", () => {
  function Bound({ ran }: { ran: string[] }) {
    useKeyBindings([
      { chord: "Escape", group: "app", label: "Close", inInput: true, run: () => ran.push("escape") },
      { chord: "mod+Enter", group: "message", label: "Send", inInput: true, run: () => ran.push("send") },
    ], "view");
    return h("input", { "aria-label": "field" });
  }

  async function mountBehind(field: (e: KeyboardEvent) => void): Promise<string[]> {
    const ran: string[] = [];
    document.addEventListener("keydown", field);
    foreign.push(() => document.removeEventListener("keydown", field));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(h(KeymapProvider, null, h(Bound, { ran }))); });
    return ran;
  }

  it("a key the field PREVENTED runs no binding", async () => {
    const ran = await mountBehind((e) => { if (e.key === "Escape") e.preventDefault(); });
    await press(document.querySelector("input")!, "Escape");
    expect(ran, "the keymap acted on a key a field had already handled").toEqual([]);
  });

  it("a key the field STOPPED runs no binding", async () => {
    const ran = await mountBehind((e) => { if (e.key === "Escape") e.stopPropagation(); });
    await press(document.querySelector("input")!, "Escape");
    expect(ran, "a field's stopPropagation did not reach the sibling keymap").toEqual([]);
  });

  it("a key the field left alone still runs its binding — Escape and ⌘↵ both", async () => {
    const ran = await mountBehind(() => {});
    const input = document.querySelector("input")!;
    const esc = await press(input, "Escape");
    const send = await press(input, "Enter", { metaKey: true });
    expect(ran).toEqual(["escape", "send"]);
    expect(esc.defaultPrevented && send.defaultPrevented, "a binding that ran did not claim its key").toBe(true);
  });
});

/*
 * THE RULE'S ONE CASUALTY, CLOSED. TipTap's HardBreak binds Mod-Enter, so ProseMirror prevented
 * ⌘↵ (Ctrl+↵ off a Mac) in the message body and, under the rule, Send would never hear it. The
 * editor leaves the chord alone instead: Send runs and no line break is written. jsdom is not a
 * Mac, so Ctrl is ProseMirror's Mod here; both spellings are pressed.
 */
describe("⌘↵ in the message body stays Send's", () => {
  it("the editor claims neither spelling, the binding runs, and no line break is written", async () => {
    const { MailRichEditor } = await import("@ohmail/app/mail");
    const ran: string[] = [];
    let html = "";
    function Body() {
      useKeyBindings([
        { chord: "mod+Enter", group: "message", label: "Send", inInput: true, run: () => ran.push("send") },
      ], "view");
      const [v, setV] = React.useState({ text: "hi", html: "<p>hi</p>" });
      html = v.html ?? "";
      return h(MailRichEditor, { value: v, onChange: setV, label: "Message", placeholder: "", editable: true, focusAtMount: false, onHandle: () => {} });
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", children: h(KeymapProvider, null, h(Body)),
      }));
    });
    await waitFor(() => within(host).queryByRole("textbox", { name: "Message" }) != null, "the editor never mounted");
    const surface = within(host).getByRole("textbox", { name: "Message" });
    const ctrl = await press(surface, "Enter", { ctrlKey: true });
    const meta = await press(surface, "Enter", { metaKey: true });
    expect(ran, "⌘↵ in the message body no longer reached Send").toEqual(["send", "send"]);
    expect(html, "⌘↵ wrote a line break into the message it sends").not.toContain("<br");
    expect(ctrl.defaultPrevented && meta.defaultPrevented, "Send ran and left the key unclaimed").toBe(true);
  });
});
