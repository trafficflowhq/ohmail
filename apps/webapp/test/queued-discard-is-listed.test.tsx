/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError, type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "../app/shell/compose";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";

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

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
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
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-27T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
      }),
    }));
  });
  await settle(10);
}

async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A row made through compose — the demo world seeds no drafts. */
async function makeADraft(): Promise<string> {
  await goto("#/compose");
  await typeInto("#compose-to", "lena@atelier.example");
  await typeInto("#compose-subject", "Bis Montag");
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey());
  expect(id, "the compose never wrote a row").not.toBeNull();
  return id!;
}

const rowOf = (id: string): HTMLElement | null => q<HTMLElement>(`.draft-row[data-id="${id}"]`);

async function pressDelete(id: string): Promise<void> {
  await press(q<HTMLButtonElement>(`.draft-row[data-id="${id}"] .draft-discard`)!);
  await settle(4);
  const confirm = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
    .find((b) => (b.textContent ?? "").trim() === messages.drafts.discardConfirm) ?? null;
  expect(confirm, "the confirm behind Delete did not open").not.toBeNull();
  await press(confirm!);
  await settle(10);
}

/** The strip the shell mounts above the views, opened. */
async function stripRows(): Promise<HTMLElement[]> {
  const strip = q<HTMLElement>(".unsaved-shell");
  if (strip === null) return [];
  const toggle = strip.querySelector<HTMLButtonElement>(".unsaved-toggle");
  if (toggle !== null && toggle.getAttribute("aria-expanded") === "false") await press(toggle);
  return Array.from(q<HTMLElement>(".unsaved-shell")?.querySelectorAll<HTMLElement>(".unsaved-row") ?? []);
}

const button = (row: HTMLElement, label: string): HTMLButtonElement | null =>
  Array.from(row.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => (b.textContent ?? "").trim() === label) ?? null;

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
