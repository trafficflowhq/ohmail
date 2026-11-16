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
 * THE DRAFTS LIST'S ENDINGS RELEASE THE RECORD IN EVERY WINDOW (a high verifier finding, the
 * verifier's probe tracked). An unverified record naming a row is what a browser holds after a lost
 * answer; written AFTER this shell's outbox view it stands for another window's press. "Send again"
 * (the server's "not arrived"), "It was sent — dismiss" and Delete are endings the SERVER answered
 * for that row, which is knowledge, so the record goes whichever window pressed the send, and Send
 * is live on the message that opens. A record from an earlier session is the control.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

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

/** The whole client on the fixture world. */
async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("./_todays-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-08T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  await settle(10);
}

/** Type into a controlled input the way React sees it. */
async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Write a message on `#/compose` and let the autosave give it a row. Returns the row's id. */
async function makeADraft(): Promise<string> {
  await goto("#/compose");
  await typeInto("#compose-to", "lena@atelier.example");
  await typeInto("#compose-subject", "Bis Montag");
  // The debounce is real time, deliberately: faking it here would put a second async machine
  // between the press and the write, which is how a green harness comes to measure nothing.
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey());
  expect(id, "the compose never wrote a row, so there is nothing to press Delete on").not.toBeNull();
  return id!;
}

const rowOf = (id: string): HTMLElement | null => q<HTMLElement>(`.draft-row[data-id="${id}"]`);
const toastText = (): string => q<HTMLElement>(".toast[role='status']")?.textContent ?? "";

/** Press a row's Delete and then the confirm behind it. */
async function pressDelete(id: string): Promise<void> {
  await press(q<HTMLButtonElement>(`.draft-row[data-id="${id}"] .draft-discard`)!);
  await settle(4);
  // By its LABEL: Keep comes first in the confirm on purpose, so "the first button" is the wrong one.
  const confirm = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
    .find((b) => (b.textContent ?? "").trim() === messages.drafts.discardConfirm) ?? null;
  expect(confirm, "the confirm behind Delete did not open, or lost its destructive button").not.toBeNull();
  await press(confirm!);
  await settle(10);
}

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* blocked storage; the in-memory half still runs */ }
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
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

function parkAt(draftId: string, at: number): void {
  window.localStorage.setItem(sendLocksKey(), JSON.stringify([{
    v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-HELD", at,
    draftId, fp: "fp-held", subject: `draft:${draftId}`, unverified: true,
  }]));
}
const verbBtn = (id: string, label: string): HTMLButtonElement | null =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>(`.draft-row[data-id="${id}"] button`))
    .find((b) => (b.textContent ?? "").trim() === label) ?? null;
const composeSend = (): HTMLButtonElement | null =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => !b.closest(".draft-row") && /^Send(\b|Ctrl)/.test((b.textContent ?? "").trim()) && !/later/i.test(b.textContent ?? "")) ?? null;

describe("a row's server-answered ending releases its record, whichever window pressed the send", () => {
  for (const [label, when] of [["another window, after this view", "now"], ["an earlier session (the control)", "hour"]] as const) {
    for (const verb of ["Send again", "It was sent — dismiss", "Delete"] as const) {
      it(`${verb} over a record from ${label}`, async () => {
        await mountShell();
        const id = await makeADraft();
        await goto("#/drafts");
        parkAt(id, when === "now" ? Date.now() : Date.now() - 60 * 60 * 1000);
        await goto("#/"); await goto("#/drafts");
        if (verb === "Delete") await pressDelete(id);
        else {
          const b = verbBtn(id, verb);
          expect(b, `the row offers no "${verb}"`).not.toBeNull();
          await press(b!); await settle(20);
        }
        const jar = JSON.parse(window.localStorage.getItem(sendLocksKey()) ?? "[]") as Array<{ draftId?: string }>;
        expect({ jarNamesRow: jar.filter((r) => r.draftId === id).length, rowStill: rowOf(id) !== null },
          "the server answered for the row and this window kept its record").toEqual({ jarNamesRow: 0, rowStill: false });
        if (verb === "Send again") {
          expect(window.location.hash, "Send again did not open the message").toBe("#/compose");
          expect(composeSend()?.disabled, "the reopened message is parked with Send disabled").toBe(false);
          expect(host!.textContent ?? "", "the reopened message says it may already have gone")
            .not.toContain("We're not sure this was sent");
        }
      }, 30_000);
    }
  }
});
