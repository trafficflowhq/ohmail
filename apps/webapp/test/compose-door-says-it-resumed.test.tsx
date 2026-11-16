/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "../app/shell/compose";
import { sendLocksKey, SEND_LOCK_FORMAT } from "../app/shell/send-lock";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE PLAIN COMPOSE DOOR SAYS IT RESUMED A MESSAGE. `#/compose` opens the message left unfinished
 * — decided, and right — but said nothing, so a person who meant to start a new one found the old
 * one and edited it. The composer now says so, and not when a door put a message there on purpose
 * (a draft opened from Drafts) nor over a held message, whose own sentence says more.
 * Mutation: the note's condition made false → cases 1 and 4 red; the seeded mark ignored → case 2 red.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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
  const { AppShell } = await import("./_todays-shell.js");
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

const notes = (): string[] =>
  Array.from(host!.querySelectorAll<HTMLElement>(".view-compose .send-note")).map((n) => n.textContent ?? "");
const compose = messages.compose as unknown as Record<string, string>;

beforeEach(() => {
  window.location.hash = "";
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

describe("the plain compose door, over a message left unfinished", () => {
  it("1 — says it resumed that message", async () => {
    await mountShell();
    await makeADraft();
    await goto("#/ohbox");
    await goto("#/compose");
    expect(notes(), "the composer resumed a message without saying so").toContain(compose.resumedNote);
  }, 30_000);

  it("2 — says nothing over a draft a person opened from Drafts", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    const open = q<HTMLElement>(`.draft-row[data-id="${id}"] .draft-open`);
    expect(open, "the draft is not listed").not.toBeNull();
    await act(async () => { open!.click(); });
    await settle(6);
    await settleFirstPaint();
    expect(window.location.hash).toBe("#/compose");
    expect(notes(), "a draft opened on purpose was announced as resumed").not.toContain(compose.resumedNote);
  }, 30_000);

  it("3 — gives way to a held message's own sentence", async () => {
    await mountShell();
    const id = await makeADraft();
    parkTheRow(id);
    await goto("#/ohbox");
    await goto("#/compose");
    expect(notes(), "the resumed line stood over a held message").not.toContain(compose.resumedNote);
  }, 30_000);

  it("4 — a reload that brings the message back on the compose door says it too", async () => {
    await mountShell();
    await makeADraft();
    await act(async () => { root!.unmount(); });
    host?.remove();
    window.location.hash = "#/compose";
    await mountShell();
    await settle(10);
    await settleFirstPaint();
    expect(q<HTMLInputElement>("#compose-subject")?.value, "the reload did not restore the message").toBe("Bis Montag");
    expect(notes(), "the restored message was not said as resumed").toContain(compose.resumedNote);
  }, 30_000);

  it("CONTROL: an empty composer says nothing about resuming", async () => {
    await mountShell();
    await goto("#/compose");
    expect(notes()).not.toContain(compose.resumedNote);
  }, 30_000);
});
