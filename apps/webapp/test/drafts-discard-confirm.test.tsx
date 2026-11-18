/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";

/**
 * THE DISCARD QUESTION SITS WHERE THE HAND IS, AND MUST NOT EAT THE DRAFT. Twice wrong: a confirm
 * at `flex: 1 0 100%` beside the draft collapsed it to its padding (measured in Chromium); the fix
 * moved it into its own grid track — sentence and buttons at the far LEFT below the list while
 * Discard sat at the far RIGHT (as reported). Now the confirm REPLACES the action area at
 * the trailing edge, Escape is Keep, the draft keeps a 12rem basis, the confirm has `flex: 0 0
 * auto` with `max-width: 100%` and the confirming row's line wraps — the collapse made
 * unrepresentable, measured again by `kit/drafts/drafts-row-walk.mjs`. jsdom lays nothing out, so
 * the stylesheet is read as source (`readFileSync`, the `screener-row-actions-overlay` idiom).
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A file under `apps/webapp`, from the app dir or the repo root — the root run is what CI does. */
function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  try {
    return readFileSync(resolve(process.cwd(), fromRoot), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }
}

/** Comment-stripped, so a rule quoted in prose cannot satisfy an assertion about the rule. */
const appCss = readSource("app/app.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first top-level rule whose selector list starts with `sel` (no nested braces). */
function ruleBody(css: string, sel: string): string | null {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*(?:,[^{}]*)?\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
}

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Quarterly numbers, revised",
  body: "Hi both — attaching the revised sheet, the third tab is the one that changed.",
  to: [{ name: "Petra Lindqvist", address: "petra@example.com" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T14:02:00.000Z",
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let discarded: string[] = [];

async function mountDrafts(drafts: EngineDraft[] = [draft()]): Promise<void> {
  discarded = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-07T15:00:00.000Z"),
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts,
          scheduled: [],
          now: new Date("2026-08-07T15:00:00.000Z"),
          onOpen: () => {},
          onDiscard: (id: string) => { discarded.push(id); },
          onResolve: () => {},
          onSendAgain: () => {},
          onCancelSchedule: () => {},
          onEditScheduled: () => {},
          repliesHere: () => false,
        }),
      }),
    );
  });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

beforeEach(() => { discarded = []; });

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("the confirm replaces the row's action area, at the trailing edge", () => {
  /**
   * ══ THE CENTRAL GUARD ═══════════════════════════════════════════════════════════════════
   *
   * Mutation: move the `.draft-confirm` block back out of `.draft-row-main`, as a sibling.
   * Real failure text:
   *   AssertionError: the confirm is not inside the row's main line — it is somewhere else on the
   *   page, which is press-right-accept-left again: expected null not to be null
   */
  it("renders the confirm INSIDE `.draft-row-main`, in place of the action area", async () => {
    await mountDrafts();
    expect(q(".draft-confirm"), "the confirm is open before anything was pressed").toBeNull();
    expect(q(".draft-row-main .draft-actions .draft-discard"), "the Discard control is not in the action area").not.toBeNull();

    await press(q<HTMLButtonElement>(".draft-discard")!);

    const confirm = q<HTMLElement>(".draft-row-main > .draft-confirm");
    expect(
      confirm,
      "the confirm is not inside the row's main line — it is somewhere else on the page, which is "
      + "press-right-accept-left again",
    ).not.toBeNull();
    expect(
      q(".draft-row-main .draft-actions"),
      "the action area is still rendered beside the question — two things to press where there should be one",
    ).toBeNull();
    expect(q(".draft-discard"), "the Discard control survived into the question — a third button").toBeNull();
    expect(
      q(".draft-row")!.classList.contains("draft-row-confirming"),
      "the row is not marked as confirming, so the main line cannot wrap on a narrow pane",
    ).toBe(true);
  });

  it("keeps the draft's subject, recipients and preview rendered beside the question", async () => {
    await mountDrafts();
    await press(q<HTMLButtonElement>(".draft-discard")!);

    const open = q<HTMLElement>(".draft-row-main .draft-open")!;
    expect(open.querySelector(".draft-subject")?.textContent).toContain("Quarterly numbers");
    expect(open.querySelector(".draft-to")?.textContent).toContain("Petra");
    expect(open.querySelector(".draft-preview")?.textContent).toContain("revised sheet");
  });

  it("opens at most one confirm across the whole list", async () => {
    await mountDrafts([draft({ id: "d1" }), draft({ id: "d2", subject: "Second" })]);
    const discards = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-discard"));
    expect(discards).toHaveLength(2);

    await press(discards[0]!);
    expect(host!.querySelectorAll(".draft-confirm")).toHaveLength(1);
    // The second row still has its control; pressing it moves the question, never doubles it.
    await press(q<HTMLButtonElement>('.draft-row[data-id="d2"] .draft-discard')!);
    expect(host!.querySelectorAll(".draft-confirm")).toHaveLength(1);
    expect(q('.draft-row[data-id="d2"] .draft-confirm')).not.toBeNull();
    expect(q('.draft-row[data-id="d1"] .draft-confirm')).toBeNull();
  });
});

describe("the stylesheet keeps the draft readable while the question is open", () => {
  /**
   * Mutation: give `.draft-open` `flex: 1` (basis 0) again. Real failure text:
   *   AssertionError: the draft's basis is 0, so a confirm that fits the line squeezes it to its
   *   padding instead of wrapping under it: expected '…' to match /flex:\s*1 1 12rem/
   */
  it("`.draft-open` has a 12rem basis, so the confirm wraps rather than squeezes", () => {
    const open = ruleBody(appCss, "\\.draft-open");
    expect(open, "no `.draft-open` rule").not.toBeNull();
    expect(
      open!,
      "the draft's basis is 0, so a confirm that fits the line squeezes it to its padding instead of wrapping under it",
    ).toMatch(/flex:\s*1 1 12rem/);
    expect(open!).toMatch(/min-width:\s*0/);
  });

  /**
   * Mutation: give `.draft-confirm` its old `flex` again. Real failure text: the assertion that
   *   the confirm neither grows nor claims a whole-row basis — the shape that collapsed the draft
   */
  it("`.draft-confirm` neither grows nor claims a 100% basis, and is bounded by the row", () => {
    const confirm = ruleBody(appCss, "\\.draft-confirm");
    expect(confirm, "no `.draft-confirm` rule").not.toBeNull();
    expect(confirm!, "the confirm grows or claims a 100% basis — the shape that collapsed the draft")
      .toMatch(/flex:\s*0 0 auto/);
    expect(confirm!, "the confirm claims a 100% basis").not.toMatch(/flex:[^;]*100%/);
    expect(confirm!, "the confirm can outgrow the pane").toMatch(/max-width:\s*100%/);
    expect(confirm!, "the confirm is not pushed to the trailing edge").toMatch(/margin-left:\s*auto/);
  });

  it("the confirming row's and the held row's main lines wrap, and an ordinary row's does not", () => {
    const wrapping = ruleBody(appCss, "\\.draft-row-confirming \\.draft-row-main");
    expect(wrapping, "no wrap rule for the confirming row").not.toBeNull();
    expect(wrapping!).toMatch(/flex-wrap:\s*wrap/);
    // The held row shares the rule (one selector list): three controls beside the draft squeezed it
    // to a sliver at a phone width, measured in the Chromium walk before this selector existed.
    expect(appCss).toMatch(/\.draft-row-confirming \.draft-row-main,\s*\.draft-row-held \.draft-row-main\s*\{[^}]*flex-wrap:\s*wrap/);
    const main = ruleBody(appCss, "\\.draft-row-main");
    expect(main, "no `.draft-row-main` rule").not.toBeNull();
    expect(main!, "an ordinary row wraps too — a held row's verbs would fall under the draft").not.toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("the two presses", () => {
  it("deletes on the confirm and on nothing else", async () => {
    await mountDrafts();
    await press(q<HTMLButtonElement>(".draft-discard")!);
    expect(discarded, "the first press deleted").toEqual([]);

    const buttons = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Keep", "Discard"]);
    await press(buttons[1]!);
    expect(discarded).toEqual(["d1"]);
    expect(q(".draft-confirm"), "the question stayed open after the act").toBeNull();
  });

  it("names the question for assistive technology, and moves focus into it", async () => {
    await mountDrafts();
    await press(q<HTMLButtonElement>(".draft-discard")!);

    const confirm = q<HTMLElement>(".draft-confirm")!;
    expect(confirm.getAttribute("role")).toBe("alertdialog");
    expect(confirm.getAttribute("aria-label")).toBe("Discard");
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain("only copy");
    expect(document.activeElement, "focus did not move into the question").toBe(confirm);
  });

  it("`Keep` puts focus back on the trigger it came from", async () => {
    await mountDrafts([draft({ id: "d1" }), draft({ id: "d2", subject: "Second" })]);
    await press(q<HTMLButtonElement>('.draft-row[data-id="d2"] .draft-discard')!);
    const keep = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
      .find((b) => b.textContent?.trim() === "Keep")!;
    await press(keep);
    expect(q(".draft-confirm")).toBeNull();
    expect(discarded).toEqual([]);
    expect(document.activeElement).toBe(q('.draft-row[data-id="d2"] .draft-discard'));
  });

  /**
   * Mutation: drop the `onKeyDown` Escape arm from `.draft-confirm`. Real failure text:
   *   AssertionError: Escape did not keep — the question stays open under the finger that wanted out
   */
  it("Escape is Keep: the question closes, nothing is deleted, focus returns to Discard", async () => {
    await mountDrafts();
    await press(q<HTMLButtonElement>(".draft-discard")!);
    const confirm = q<HTMLElement>(".draft-confirm")!;
    await act(async () => {
      confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q(".draft-confirm"), "Escape did not keep — the question stays open under the finger that wanted out").toBeNull();
    expect(discarded).toEqual([]);
    expect(document.activeElement).toBe(q(".draft-discard"));
  });
});
