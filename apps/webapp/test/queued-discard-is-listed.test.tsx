/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "@ohmail/app-logic/writing/compose";
import { AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { settleFirstPaint } from "./_first-paint.js";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * A QUEUED DISCARD IS LISTED, NOT ONLY TOASTED. A Delete that cannot reach the account is kept on
 * the outbox and retried; the toast said so once, and the strip listed the entry only once it was
 * abandoned. Driven through the shipped shell on the demo world: the network answer is the
 * retryable one the adapter raises for a dropped connection.
 * Mutation: `UnsavedChanges` passing no queued rows → case 1 red on the missing row.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** While true, every `draft_discard` answers as a dropped connection. */
let offline = false;
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
  const { DemoShell } = await import("../app/(product)/demo/DemoShell");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-27T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(DemoShell, { serverDemo: true, says: { service: "managed", sendCeiling: "strict" } }) }),
      }),
    }));
  });
  await settle(10);
}

/** A row made through compose — the demo world seeds no drafts. */
async function makeADraft(): Promise<string> {
  await goto("#/compose");
  const to = await screen.findByRole("combobox", { name: "To" });
  fireEvent.change(to, { target: { value: "lena@atelier.example" } });
  fireEvent.keyDown(to, { key: "Enter" });
  const subject = screen.getByRole("textbox", { name: "Subject" });
  fireEvent.change(subject, { target: { value: "Bis Montag" } });
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey(storageOwner()));
  expect(id, "the compose never wrote a row").not.toBeNull();
  return id!;
}

const rowOf = (id: string): HTMLElement | null => {
  const list = screen.queryByRole("listbox", { name: "Drafts" });
  return list ? within(list).queryAllByRole("option", { name: /Bis Montag/ }).find((row) => row.dataset.id === id) ?? null : null;
};

async function pressDelete(id: string): Promise<void> {
  const row = rowOf(id);
  expect(row, "the draft is visible before Discard").not.toBeNull();
  vi.useFakeTimers();
  try {
    await press(within(row!.parentElement!).getByRole("button", { name: messages.drafts.discard }));
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
  } finally {
    vi.useRealTimers();
  }
  await settle(10);
}

async function stripRows(): Promise<HTMLElement[]> {
  const show = () => screen.queryByRole("button", { name: messages.sync.unsavedShow })
    ?? screen.queryByRole("menuitem", { name: new RegExp(messages.sync.unsavedShow) });
  if (!screen.queryByRole("dialog")) {
    const more = screen.queryByRole("button", { name: /more notices?/i });
    if (!show() && more) await press(more);
    const disclosure = show();
    if (!disclosure) return [];
    await press(disclosure);
  }
  const dialog = screen.queryByRole("dialog");
  return dialog ? within(dialog).queryAllByRole("listitem") : [];
}

const button = (row: HTMLElement, label: string) => within(row).queryByRole("button", { name: label });

const discards = (): number => sent.filter((m) => m.kind === "draft_discard").length;

beforeEach(() => {
  window.location.hash = "";
  offline = false;
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
    const m = args[0] as EngineMutation;
    sent.push(m);
    if (offline && m.kind === "draft_discard") {
      throw new MutationRejectedError("Failed to fetch", { code: "network", retryable: true });
    }
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

describe("a discard that could not reach the account", () => {

  it("1 — is one row in the strip, with Try again and Discard", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    offline = true;
    await pressDelete(id);
    expect(discards(), "the Delete never reached the adapter").toBe(1);

    const rows = await stripRows();
    const copy = messages.sync as unknown as Record<string, string>;
    const mine = rows.filter((r) => (r.textContent ?? "").includes(copy.unsavedKindDraftDiscard!));
    expect(mine.length, "the queued discard is on the outbox and listed nowhere").toBe(1);
    expect(mine[0]!.textContent).toContain(copy.unsavedQueuedWhy);
    expect(button(mine[0]!, copy.unsavedRetry!), "the row offers no Try again").not.toBeNull();
    expect(button(mine[0]!, copy.unsavedDiscard!), "the row offers no Discard").not.toBeNull();
  }, 30_000);

  it("2 — Discard withdraws it: the draft is back and nothing more is sent", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    offline = true;
    await pressDelete(id);
    expect(rowOf(id), "the optimistic delete did not hide the row").toBeNull();

    const [row] = await stripRows();
    const copy = messages.sync as unknown as Record<string, string>;
    await press(button(row!, copy.unsavedDiscard!)!);
    await settle(10);
    offline = false;
    await goto("#/");
    await goto("#/drafts");

    expect(rowOf(id), "the withdrawn discard still hides the draft").not.toBeNull();
    expect(await stripRows(), "the withdrawn discard is still listed").toEqual([]);
    expect(discards(), "a withdrawn discard reached the adapter again").toBe(1);
  }, 30_000);

  it("3 — Try again sends it now, and the row leaves when it lands", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    offline = true;
    await pressDelete(id);

    offline = false;
    const [row] = await stripRows();
    const copy = messages.sync as unknown as Record<string, string>;
    await press(button(row!, copy.unsavedRetry!)!);
    await settle(20);

    expect(discards(), "Try again did not send the queued discard").toBe(2);
    expect(await stripRows(), "a discard that landed is still listed").toEqual([]);
    await goto("#/");
    await goto("#/drafts");
    expect(rowOf(id), "the draft survived a discard that landed").toBeNull();
  }, 30_000);

  it("CONTROL: a discard that lands on the first press lists nothing", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    await pressDelete(id);
    expect(discards()).toBe(1);
    expect(await stripRows()).toEqual([]);
  }, 30_000);
});
