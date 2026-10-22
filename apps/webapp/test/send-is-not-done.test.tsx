/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * SEND IS NOT DONE — through the whole shell (the desktop mounts this same AppShell).
 *
 * Reported 2026-10-22: "I had a resurfaced message and clicked only send on it and not send and
 * done and it marked as done!" A plain Send leaves a pinned row under Resurfaced and a booked
 * message in the Resurface pile. Only Send + Done (or Done) files it, and its Undo restores it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];
let hadScrollIntoView: unknown;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  const { preloadRichEditor } = await import("../app/shell/RichEditorLazy.js");
  await act(async () => { await preloadRichEditor(); });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await key("j");
}

const barButton = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}
const editors = (): HTMLElement[] =>
  [...host!.querySelectorAll<HTMLElement>(".reader .msg, .read-col .msg")]
    .flatMap((m) => [...m.querySelectorAll<HTMLElement>(".rte-surface")]);
const doneButton = (): HTMLButtonElement | null =>
  host!.querySelector<HTMLButtonElement>(".reply-actions .reply-send-done");
const sendButton = (): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(".reply-actions .btn.primary")!;
const replyFor = (): string =>
  host!.querySelector<HTMLElement>(".reply[data-reply-for]")?.dataset.replyFor ?? "";

async function pinSelected(): Promise<string> {
  const id = host!.querySelector<HTMLElement>(".row.sel")?.dataset.id;
  expect(id, "no row under the cursor").toBeTruthy();
  await key("Enter");
  await click(barButton("Resurface"));
  await click(barButton("Now"));
  expect(idsInGroup("Resurfaced")).toContain(id!);
  return id!;
}

beforeEach(() => {
  vi.useFakeTimers();
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  sent = [];
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  hadScrollIntoView = proto.scrollIntoView;
  proto.scrollIntoView = function noop() { /* jsdom runs no layout */ };
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = hadScrollIntoView;
});

async function type(text: string): Promise<void> {
  await act(async () => { typeInto(editors()[0]!, text); });
}
/** Let the send confirm and the sent beat pass. */
async function confirm(): Promise<void> {
  await settle();
  await act(async () => { vi.advanceTimersByTime(2000); });
  await settle();
}
const chord = async (shiftKey: boolean): Promise<void> => {
  const editor = editors()[0]!;
  editor.focus();
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", metaKey: true, shiftKey, bubbles: true, cancelable: true,
    }));
  });
};
const kinds = (): string[] => sent.map((m) => m.kind);

async function openBookedFromThePile(): Promise<string> {
  const id = host!.querySelector<HTMLElement>(".row.sel")?.dataset.id;
  expect(id, "no row under the cursor").toBeTruthy();
  await key("Enter");
  await click(barButton("Resurface"));
  await click(barButton("Tomorrow"));
  await act(async () => {
    window.location.hash = "#/triage/resurface";
    window.dispatchEvent(new Event("hashchange"));
  });
  await settle();
  await click(host!.querySelector<HTMLElement>(`.view-triage .row[data-id="${id}"]`));
  await key("Enter");
  await key("r");
  await drain();
  expect(replyFor()).toBe(id);
  return id!;
}
const pile = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".view-triage .row[data-id]")].map((r) => r.dataset.id!);

describe("a plain Send files nothing", () => {
  it("Send on a pinned row puts only the mail on the wire, and the row stays under Resurfaced", async () => {
    await mountShell();
    const id = await pinSelected();
    await key("r");
    await drain();
    expect(replyFor()).toBe(id);
    expect(doneButton(), "Send + Done is offered beside Send here").not.toBeNull();
    await type("Danke, erledigt.");
    sent = [];
    await act(async () => { sendButton().click(); });
    await confirm();
    expect(kinds(), "a plain Send spent the pin").toEqual(["mail_send"]);
    expect(idsInGroup("Resurfaced"), "a plain Send filed the resurfaced row").toContain(id);
    expect(host!.textContent).not.toContain("Sent · marked done");
  });

  it("⌘↩ on a pinned row is the same plain Send", async () => {
    await mountShell();
    const id = await pinSelected();
    await key("r");
    await drain();
    await type("Danke.");
    sent = [];
    await chord(false);
    await confirm();
    expect(kinds()).toEqual(["mail_send"]);
    expect(idsInGroup("Resurfaced")).toContain(id);
  });

  it("Send from the Resurface pile keeps the booking", async () => {
    await mountShell();
    const id = await openBookedFromThePile();
    await type("Danke.");
    sent = [];
    await act(async () => { sendButton().click(); });
    await confirm();
    expect(kinds(), "a plain Send cancelled the booking").toEqual(["mail_send"]);
    await act(async () => {
      window.location.hash = "#/triage/resurface";
      window.dispatchEvent(new Event("hashchange"));
    });
    await settle();
    expect(pile(), "the booked message left the Resurface pile").toContain(id);
  });
});

describe("CONTROL: Send + Done still files, and Undo restores", () => {
  it("Send + Done on a pinned row files it with one deliberate read, and Undo re-pins it", async () => {
    await mountShell();
    const id = await pinSelected();
    await key("r");
    await drain();
    await type("Danke, erledigt.");
    sent = [];
    await act(async () => { doneButton()!.click(); });
    await confirm();
    const seen = sent.filter((m) => m.kind === "mark_seen") as Array<{ messageIds: string[]; via?: string }>;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messageIds).toEqual([id]);
    expect(seen[0]!.via).toBeUndefined();
    expect(idsInGroup("Resurfaced")).not.toContain(id);
    expect(host!.textContent).toContain("Sent · marked done");
    const undo = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Undo");
    expect(undo, "no Undo on the Send + Done pill").toBeTruthy();
    await act(async () => { undo!.click(); });
    await confirm();
    expect(idsInGroup("Resurfaced"), "Undo did not re-pin the row").toContain(id);
  });

  it("⌘⇧↩ on a pinned row is Send + Done", async () => {
    await mountShell();
    const id = await pinSelected();
    await key("r");
    await drain();
    await type("Danke.");
    sent = [];
    await chord(true);
    await confirm();
    expect(kinds()).toContain("mark_seen");
    expect(idsInGroup("Resurfaced")).not.toContain(id);
    expect(host!.textContent).toContain("Sent · marked done");
  });
});
