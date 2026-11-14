/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { type EngineMutation } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "../app/shell/compose";
import { sendLocksKey, SEND_LOCK_FORMAT } from "../app/shell/send-lock";
import { AUTOSAVE_DELAY_MS, discardKeepsRow } from "../app/shell/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE COMPOSER'S DISCARD OF A HELD MESSAGE SAYS WHAT IT DID. A message whose send is not confirmed
 * is never deleted from the composer — its row is kept — and the confirmation said "This deletes
 * what you've written", then the composer closed without a word. The question now says the row
 * stays, and the press says why it was not deleted. Driven through the shipped shell.
 * Mutation: the question's held branch removed → case 1 red; the toast removed → case 1 red.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
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

/** A send record naming the row, its outcome unknown — what a browser holds after a lost answer. */
function parkTheRow(draftId: string): void {
  window.localStorage.setItem(sendLocksKey(), JSON.stringify([{
    v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-HELD", at: Date.now(),
    draftId, fp: "fp-held", subject: `draft:${draftId}`, unverified: true,
  }]));
}

const btnIn = (sel: string, label: string): HTMLButtonElement | null =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>(`${sel} button`))
    .find((b) => (b.textContent ?? "").trim() === label) ?? null;
const toastText = (): string => q<HTMLElement>(".toast[role='status']")?.textContent ?? "";
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
  it("1 — the question says the draft stays, and the press says why it was not deleted", async () => {
    await mountShell();
    const id = await makeADraft();
    parkTheRow(id);
    await goto("#/");
    await goto("#/compose");

    await press(q<HTMLButtonElement>(".compose-foot .compose-cancel")!);
    const what = q<HTMLElement>("#compose-cancel-what")?.textContent ?? "";
    expect(what, "the question still promises a delete the press will not make").toBe(compose.cancelWhatHeld);

    await press(btnIn(".compose-confirm", compose.cancelConfirm!)!);
    await settle(10);
    expect(toastText(), "the composer closed over a kept draft without a word").toContain(compose.discardHeld);
    expect(sent.filter((m) => m.kind === "draft_discard"), "a held draft was deleted").toEqual([]);
    await goto("#/drafts");
    expect(q(`.draft-row[data-id="${id}"]`), "the held draft is gone from Drafts").not.toBeNull();
  }, 30_000);

  it("CONTROL: a draft nothing is waiting on is still deleted, and the question says so", async () => {
    await mountShell();
    const id = await makeADraft();

    await press(q<HTMLButtonElement>(".compose-foot .compose-cancel")!);
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent).toBe(compose.cancelWhat);
    await press(btnIn(".compose-confirm", compose.cancelConfirm!)!);
    await settle(10);
    expect(toastText()).not.toContain(compose.discardHeld);
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
