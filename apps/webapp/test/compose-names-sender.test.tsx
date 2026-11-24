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
import { readFileSync } from "node:fs";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

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

/*
 * OVER WRITE (the older tests' sorting): the shell is the new shell's test door (`MailShell`,
 * `_todays-shell.js`'s old name of it) on the demo world, `#/compose` is Write's new letter. Its From line is found as a
 * person finds it (`compose-from.test.ts`): the line labelled "From"; its chooser the button
 * named "From <address>: choose another address" where there is a choice, else the address as words.
 */
/** The sentence beside the address where Write says it switched or substituted (Write's own words). */
const SAID = [/^Switched to match the recipient's domain$/, /is disconnected, so this message sends from the address above\.$/];
const isState = (el: Element): boolean => SAID.some((re) => re.test((el.textContent ?? "").trim()));
const LETTER = '[role="region"][aria-label="New message"]';
/** The From line of the letter on screen: the element its "From" label stands in. */
const fromLine = (): HTMLElement | null =>
  [...host!.querySelectorAll<HTMLElement>(`${LETTER} b`)].find((el) => el.textContent === "From")?.parentElement ?? null;
/** The chooser, by its name: present only where there is a choice. */
const fromChooser = (): HTMLButtonElement | null =>
  [...host!.querySelectorAll<HTMLButtonElement>(`${LETTER} button`)].find((b) =>
    /^From .+: choose another address$/.test(b.getAttribute("aria-label") ?? "")) ?? null;

/** The From control, and the address a reader sees in it. */
function sender(): { present: boolean; named: string; labelled: boolean } {
  const line = fromLine();
  const control = fromChooser()
    ?? ([...(line?.children ?? [])] as HTMLElement[]).find((el) => el.tagName !== "B" && !isState(el)) ?? null;
  if (!control) return { present: false, named: "", labelled: false };
  /* The chooser names the address it sends from (today's select named it on its CHOSEN option); the words name it
     where there is no choice. */
  const named = control.textContent ?? "";
  const label = line?.querySelector("b");
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
    /* Re-pointed by path: Write's From line is the kit's people head (`Recipients.tsx`, its line
       `data-line="from"` in `.oh-recipients-line`, the address `.oh-recipients-static`), styled by the kit's own sheets;
       today's `app.css` rules for `.compose-head` leave with today's composer. A narrow width is a media query or the
       kit's container query. */
    const css = ["recipients.css", "composer.css"]
      .map((f) => readFileSync(`packages/ui/src/mail/Editor/${f}`, "utf8")).join("\n");
    const offenders: string[] = [];
    for (const m of css.matchAll(/@(?:media|container)[^{]*max-width[^{]*\{/g)) {
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
        if (!/\.oh-recipients(?:-line|-static|-label)?\b|data-line="from"/.test(sel)) continue;
        if (/display\s*:\s*none/.test(body)) offenders.push(`${sel} { ${body.trim()} }`);
      }
    }
    expect(offenders, `a narrow width hides the From row:\n${offenders.join("\n")}`).toEqual([]);
  });
});
