/** @vitest-environment jsdom */
/**
 * THE COMPOSER NAMES THE ADDRESS IT IS SENDING FROM — at both widths.
 *
 * The row this closes said "Compose never names the sending address, at either width", and
 * it was true: the form rendered To, Subject and an editor, and resolved the sender behind them
 * from whichever mailbox had received the newest message. One change put the From row in as the
 * first field — a `<select>` when there is something to choose, a static `<output>` naming the
 * address when there is one — and a second made the picked From the mailbox that actually
 * sends, which is what turned the line from a courtesy into a claim.
 *
 * `compose-from.test.ts` drives the RESOLUTION exhaustively (93 cases: the default, the stored
 * pick, the domain match, the refusals) and `compose-composition.test.ts` asserts the control is
 * in the head. Neither reads the ADDRESS off the screen, and neither varies the width — so the
 * sentence the row is about, in the words the row uses, was the part nothing held.
 *
 * ── WHAT "AT EITHER WIDTH" CAN AND CANNOT MEAN HERE ─────────────────────────────────────────
 *
 * jsdom lays nothing out, so a width is a `matchMedia` answer and a stylesheet, not a pixel. Both
 * are driven for what they can each say: the shell is mounted with the phone media query matching
 * and with it not matching (the app switches real layouts on that), and the stylesheet is read
 * for a rule that would hide the row or its region at a narrow width. A `display: none` inside a
 * media query is the only way this row disappears at 390px while passing every render test at
 * the default width, which is exactly the failure the row reported.
 *
 * ── WHICH BRANCH THIS FIXTURE ENTERS, SAID OUT LOUD ─────────────────────────────────────────
 *
 * The demo world holds SEVERAL mailboxes, so the row renders as the `<select>` and these cases
 * measure that branch (measured, not assumed: a probe printed `SELECT "first@example.test"`).
 * The one-mailbox `<output>` branch is NOT covered here, and saying so is the point — a mutation
 * aimed at it stays green in this file, which reads exactly like "that code is dead" and is not.
 * Covering it needs a compose rendered with a one-choice resolution, and nothing in this tree
 * renders `ComposeView` directly today (every compose test mounts the whole shell, deliberately),
 * so it is filed rather than faked. `compose-from.test.ts` holds the resolution for that case;
 * what is uncovered is its rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A file under `apps/webapp`, whichever directory the runner was started in. */
function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  return readFileSync(existsSync(fromRoot) ? fromRoot : rel, "utf8");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** `phone` decides what the app's own narrow queries answer — 390px versus 1440px. */
function setWidth(phone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: phone && /max-width/.test(query),
      media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  setWidth(false);
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
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function mountCompose(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
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
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** The From control, and the address a reader sees in it. */
function sender(): { present: boolean; named: string; labelled: boolean } {
  const control = host!.querySelector("#compose-from");
  if (!control) return { present: false, named: "", labelled: false };
  const named = control instanceof HTMLSelectElement
    /* A selector names the address on its CHOSEN option — the value is a mailbox id, which is
       not a thing anybody reads. */
    ? (control.selectedOptions[0]?.textContent ?? "")
    : (control.textContent ?? "");
  const label = host!.querySelector('label[for="compose-from"]');
  return { present: true, named: named.trim(), labelled: (label?.textContent ?? "").trim().length > 0 };
}

describe("compose says which address it is sending from", () => {
  it("at 1440: the From row is on screen and it names an address", async () => {
    await mountCompose();
    const s = sender();
    expect(s.present, "compose rendered no From control at all").toBe(true);
    expect(s.labelled, "the From control has no label beside it").toBe(true);
    /* An ADDRESS, not merely a non-empty node: a mailbox id or a placeholder would satisfy
       "something is rendered" while telling the reader nothing about where the mail leaves from. */
    expect(s.named, "the From row names no address").toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it("at 390: the same row, the same address — this is the half the row said was missing", async () => {
    setWidth(true);
    await mountCompose();
    const s = sender();
    expect(s.present, "the From control is absent at a phone width").toBe(true);
    expect(s.named, "the From row names no address at a phone width").toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it("and no stylesheet hides it at a narrow width", async () => {
    /* The rendered cases above cannot see this: `matchMedia` drives the app's own layout switch,
       not the browser's CSS. A `display: none` on the row or its region inside a `max-width`
       query is how this claim would come back — visible in every test and gone on a phone. */
    const css = readSource("app/app.css");
    const offenders: string[] = [];
    for (const m of css.matchAll(/@media[^{]*max-width[^{]*\{/g)) {
      /* The block, taken by counting braces from the query's own opening one. */
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      const start = i;
      do {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      } while (depth > 0 && i < css.length);
      const block = css.slice(start, i);
      for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = (rule[1] ?? "").trim();
        const body = rule[2] ?? "";
        if (!/\.compose-head\b|\.compose-from\b|#compose-from\b|\.c-static\b/.test(sel)) continue;
        if (/display\s*:\s*none/.test(body)) offenders.push(`${sel} { ${body.trim()} }`);
      }
    }
    expect(offenders, `a narrow width hides the From row:\n${offenders.join("\n")}`).toEqual([]);
  });
});
