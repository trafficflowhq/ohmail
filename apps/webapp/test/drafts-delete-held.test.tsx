/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { composeRowKey, composeSessionKey } from "../app/shell/compose";
import { sendLocksKey, SEND_LOCK_FORMAT } from "../app/shell/send-lock";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
/* The pinned conditional below is read as source, anchored on the DECLARED NAME. Both of this
   file's old bounds named a hook and both had gone stale — see the case for what that cost. */
import { sliceOfDeclaration } from "./source-anchor.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE DRAFTS LIST'S DELETE, DRIVEN THROUGH THE SHIPPED SHELL. `send-hold-census.test.ts` pins the
 * SOURCE — that `discardDraft` asks the predicate; it cannot say whether the answer reaches a
 * person. So the whole client is mounted on the demo world and the buttons are pressed. The row is
 * MADE through compose (the demo world seeds no drafts, and `demo` wins over an injected engine), so
 * the id, the mirror entry and the held-row key are the real ones. The hold is a RECORD in the jar
 * — what a browser holds after a lost answer, the arm `parkedComposeRecord` reads. Since the discard
 * of a held row was admitted, a record no longer refuses the press: the server decides and the
 * record is RELEASED on confirm, which is what this file measures. The `sending` refusal is driven
 * in `discard-decision.test.ts`, its rendering in the verbs test.
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

/** An unresolved send record naming this row — what a browser holds after a lost answer. */
function parkTheRow(draftId: string): void {
  window.localStorage.setItem(sendLocksKey(), JSON.stringify([{
    v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-HELD", at: Date.now(),
    draftId, fp: "fp-held", subject: `draft:${draftId}`, unverified: true,
  }]));
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

describe("Deleting a draft this browser holds a send record for", () => {
  /**
   * THE RECORD GOES WITH THE ROW. A row held by an unresolved record used to refuse the press with a
   * toast; the discard goes to the server now, and on confirm the jar entry naming the row is
   * released by the one door, so the next mount reads no record about a row that is gone. The two
   * acts are on screen while the row is held, and the confirm still asks before it acts.
   * Mutation: drop `releaseSendLockForRow` from `discardDraft`'s confirmed branch →
   *   AssertionError: the jar still names the discarded row …: expected 1 to be 0
   */
  it("the discard goes through, the row leaves, and the record that held it is released", async () => {
    await mountShell();
    const id = await makeADraft();

    await goto("#/drafts");
    expect(rowOf(id), "the draft that was just written is not in the list").not.toBeNull();

    parkTheRow(id);
    // Leave and come back: the record is read at RENDER (`unresolvedSendRows` in `AppShell`), and
    // a `goto` to the hash already shown re-renders nothing.
    await goto("#/");
    await goto("#/drafts");
    expect(
      q(`.draft-row[data-id="${id}"] .draft-send-again`),
      "a row this browser holds by a record offers no way to send it again",
    ).not.toBeNull();
    await pressDelete(id);

    expect(rowOf(id), "the discard of a held row was refused — the row a person pressed for weeks").toBeNull();
    expect(toastText(), "a discard that went through was narrated as a refusal").not.toContain("Not discarded");
    const jar = JSON.parse(window.localStorage.getItem(sendLocksKey()) ?? "[]") as Array<{ draftId?: string }>;
    expect(
      jar.filter((r) => r.draftId === id).length,
      "the jar still names the discarded row — the next mount would park a message that is gone",
    ).toBe(0);
  }, 30_000);

  /**
   * The compose session is asked about only for the row this compose is HOLDING — `openDraft`'s
   * rule, and the reason is that the session names whichever message the composer has open. Asked
   * unconditionally, ONE unresolved send would refuse Delete for every draft in the account.
   *
   * Mutation: pass `composeSessionId()` unconditionally in `discardDraft`.
   */
  /**
   * ── THE BLAST RADIUS OF THE GUARD, AND WHY IT IS PINNED RATHER THAN DRIVEN ────────────────
   *
   * `discardDraft` asks about the compose SESSION only for the row this compose is HOLDING —
   * `openDraft`'s rule, and the reason is that the session names whichever message the composer
   * has open. Asked unconditionally, ONE unresolved send would refuse Delete for every draft in
   * the account, which is a worse outcome than the silent Delete this slice closed.
   *
   * Driving it needs TWO rows in the list with the composer holding one of them, and the demo
   * world cannot supply them: `FixturesAdapter` mints `demo-1` for the first `draft_save` and the
   * counter lives with the engine, so a reload — the only door reachable from a mounted shell that
   * starts a second message — hands back the same id. Measured rather than assumed: the two-row
   * fixture failed on `expected 'demo-1' not to be 'demo-1'`.
   *
   * So the conditional is pinned as source, beside the case that drives the guard itself, and the
   * pairing is stated: the case above proves the guard refuses and admits; this proves it is asked
   * about the right message. `holdOf`'s own answer for a row a record does not name is driven in
   * the census's truth table against a literal mirror.
   *
   * Mutation: pass `composeSessionId()` unconditionally in `discardDraft`.
   */
  it("asks about the compose session only for the row the composer is holding", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    /* BOTH BOUNDS USED TO NAME A HOOK, and both were wrong by the time this ran: the codemod
       spells that declaration `useStableCallback`, so `indexOf` returned -1, `slice(-1, …)` handed
       back the EMPTY string, and the two judgements below had nothing to read. `toContain` on ""
       fails, so this case was red — but with the sentence for "the pinned conditional is gone"
       rather than for a stale anchor, which is the diagnosis a reader actually needs.
       `sliceOfDeclaration` throws `anchor not found: discardDraft` instead, and its end is the
       next sibling — `plan`, which the old bound named by hand — less `plan`'s own docblock. */
    const body = sliceOfDeclaration(shell, "discardDraft");
    expect(
      body,
      "the Drafts list's Delete asks about the compose session unconditionally — one unresolved "
      + "send then refuses Delete for every draft in the account",
    ).toContain("session: heldRow !== null && heldRow === draftId ? composeSessionId() : null,");
    /* AND THE 409 ARM, which the demo world cannot answer with: `FixturesAdapter` never refuses,
       so the race the server settles under its row lock has no fixture here. The server half is
       driven in `packages/api/test/drafts.test.ts` — 409 `send_recorded`, the row still present. */
    expect(
      body,
      "the race the server refuses by name says nothing to the person it happened to",
    ).toMatch(/res\.status === "rolled_back" && res\.error\?\.code === "send_recorded"/);
    expect(
      body,
      "the server's refusal is not rendered in the row — a toast pointing at nothing, or silence",
    ).toMatch(/setDiscardRefusal\(\{ draftId, why: "still-sending", at: Date\.now\(\) \}\)/);
  });
});
