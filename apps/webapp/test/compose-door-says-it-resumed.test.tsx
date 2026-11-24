/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey } from "@ohmail/app-logic/writing/compose";
import { sendLocksKey, SEND_LOCK_FORMAT } from "@ohmail/app-logic/writing/send-lock";
import { AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

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

const RECIPIENT = "lena@atelier.example";
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const composer = () => within(host!).getByRole("region", { name: messages.write.letter });
const subjectField = () => within(composer()).getByRole<HTMLTextAreaElement>("textbox", { name: "Subject" });
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

async function makeADraft(): Promise<string> {
  await goto("#/compose");
  const to = within(composer()).getByRole("combobox", { name: "To" });
  await act(async () => {
    fireEvent.change(to, { target: { value: `${RECIPIENT}, ` } });
    fireEvent.change(subjectField(), { target: { value: "Bis Montag" } });
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

const notes = (): string[] =>
  within(composer()).queryAllByRole("status").map((n) => n.textContent ?? "");
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
    const drafts = within(host!).getByRole("listbox", { name: messages.drafts.title });
    const open = within(drafts).getByRole("option", { name: `${RECIPIENT}: Bis Montag` });
    expect(open.dataset.id).toBe(id);
    await press(open);
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
    expect(notes().some((line) => line.startsWith(messages.write.status.unverified))).toBe(true);
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
    expect(subjectField().value, "the reload did not restore the message").toBe("Bis Montag");
    expect(notes(), "the restored message was not said as resumed").toContain(compose.resumedNote);
  }, 30_000);

  it("CONTROL: an empty composer says nothing about resuming", async () => {
    await mountShell();
    await goto("#/compose");
    expect(notes()).not.toContain(compose.resumedNote);
  }, 30_000);
});
