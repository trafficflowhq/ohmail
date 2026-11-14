/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "@ohmail/app-logic/writing/compose";
import { sendLocksKey, SEND_LOCK_FORMAT } from "@ohmail/app-logic/writing/send-lock";
import { AUTOSAVE_DELAY_MS, discardKeepsRow } from "@ohmail/app-logic/writing/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * Discard keeps a draft whose send is unconfirmed and tells the person why.
 * A free draft is discarded on the first press and can be brought back with Undo.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };
const settle = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
};

async function goto(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle(6);
  await settleFirstPaint();
}

async function mountShell(): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-27T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
      }),
    }));
  });
  await settle(10);
}

const letter = () => within(within(host!).getByRole("region", { name: "New message" }));

async function makeADraft(): Promise<string> {
  await goto("#/compose");
  await act(async () => {
    fireEvent.change(letter().getByRole("combobox", { name: "To" }), { target: { value: "lena@atelier.example, " } });
    fireEvent.change(letter().getByRole("textbox", { name: "Subject" }), { target: { value: "Bis Montag" } });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey(storageOwner()));
  expect(id, "the compose never wrote a row").not.toBeNull();
  return id!;
}

/** A send record naming the row, its outcome unknown — what a browser holds after a lost answer. */
function parkTheRow(draftId: string): void {
  window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([{
    v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-HELD", at: Date.now(),
    draftId, fp: "fp-held", subject: `draft:${draftId}`, unverified: true,
  }]));
}

const notices = (): string[] =>
  within(host!).queryAllByRole("status").map((status) => status.textContent ?? "");
const compose = messages.compose as unknown as Record<string, string>;

beforeEach(() => {
  window.location.hash = "";
  sent = [];
  try { window.localStorage.clear(); } catch { /* blocked storage */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter, ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("Discard, pressed in the composer on a message whose send is not confirmed", () => {
  it("Discard keeps an unconfirmed draft and says why", async () => {
    await mountShell();
    const id = await makeADraft();
    parkTheRow(id);
    await goto("#/");
    await goto("#/compose");

    await press(letter().getByRole("button", { name: "Discard" }));
    await settle(10);
    expect(notices(), "the composer closed over a kept draft without a word").toContain(compose.discardHeld);
    expect(sent.filter((m) => m.kind === "draft_discard"), "a held draft was deleted").toEqual([]);
    await goto("#/drafts");
    const kept = within(host!).getByRole("option", { name: /Bis Montag/ });
    expect(kept.getAttribute("data-id"), "the original held draft is gone from Drafts").toBe(id);
  }, 30_000);

  it("CONTROL: one press discards a free draft and offers Undo", async () => {
    await mountShell();
    const id = await makeADraft();

    await press(letter().getByRole("button", { name: "Discard" }));
    await settle(10);
    expect(notices()).not.toContain(compose.discardHeld);
    expect(within(host!).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId?: string }).draftId)).toEqual([id]);
  }, 30_000);
});

describe("which kept row the press names", () => {
  it("a parked row is held, an unreadable one unknown, and no row or a free one is deleted as before", () => {
    const parked = { kind: "parked", by: "record", status: null, draftId: "d1", session: null } as const;
    expect(discardKeepsRow(parked, "d1")).toBe("held");
    expect(discardKeepsRow({ kind: "unknown" }, "d1")).toBe("unknown");
    expect(discardKeepsRow({ kind: "free" }, "d1")).toBeNull();
    expect(discardKeepsRow(parked, null), "a message with no row has nothing to keep").toBeNull();
  });
});
