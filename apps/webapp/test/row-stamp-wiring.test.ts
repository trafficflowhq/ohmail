import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The flag and its flip live in `shell-open-state.ts` since ARCH-022; the frame is resolved
   from the manifest by the declaration, never by a path. */
import { shellFrameOf } from "./source-anchor.js";

/**
 * THE DATE FLIP IS AN APP-WIDE ROW LANGUAGE, NOT AN OHBOX FEATURE.
 *
 * `MessageRow` renders whichever form of the stamp it is handed and reports a press on it — so the
 * question this file answers is not "does the row work" (`packages/ui` owns that) and not "does
 * the press flip the list" (`list-stamp.test.tsx` owns that, against a real view). It is: does
 * EVERY mail list hand the row the two forms and the flip.
 *
 * That is a wiring fact spread over seven files with a silent failure mode. A list that forgets
 * the props looks completely normal — relative dates, exactly as before — it simply has one pile
 * whose dates cannot be read exactly while every other pile's can, and no render test that nobody
 * wrote will say so. This is the same census `row-participants-wiring.test.ts` keeps for the
 * thread circles, over the same six lists and for the same reason: adding a new mail list means
 * adding it here, which is the point.
 *
 * ScreenerView is deliberately absent, and it is the same exception it is there. Its rows are a
 * decision about a SENDER, not a message: the stamp on one is the newest held message's, a
 * detail of the queue rather than a date anybody is comparing.
 */

const at = (p: string) => fileURLToPath(new URL(`../app/${p}`, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");

/** Every list surface that renders a mail row, and therefore stamps a flippable date. */
const MAIL_LISTS = [
  "ReadsView",
  "ReceiptsView",
  "HistoryView",
  "TagView",
  "TriageView",
] as const;

describe("the row stamp is wired into every mail list", () => {
  it.each(MAIL_LISTS)("%s takes the shell's flip and puts both forms on its rows", (view) => {
    const src = read(`views/${view}.tsx`);
    // (a) the props exist, with the shape the shell binds…
    expect(src).toMatch(/^\s*absoluteTime\?: boolean;$/m);
    expect(src).toMatch(/^\s*onToggleTime\?: \(\) => void;$/m);
    // …and are destructured rather than left on an unread props object.
    expect(src).toMatch(/^\s*absoluteTime,$/m);
    expect(src).toMatch(/^\s*onToggleTime,$/m);
    // (b) and a row is actually given the stamp derived from BOTH of them. `rowStamp` decides
    // which form shows and whether there is a second one to offer; `MessageRow` draws it.
    expect(src).toContain("rowStamp(");
    expect(src).toMatch(/rowStamp\([^)]*absoluteTime,\s*onToggleTime\)/);
  });

  /**
   * NO LIST MAY STILL BE STAMPING ROWS THE OLD WAY. `displayTime` is the relative form alone, so a
   * row still calling it directly renders a date that never flips and never names its instant —
   * the exact half-wired state this census exists to catch, and it would otherwise look normal.
   * `rowStamp` calls it internally; the views must not.
   */
  it.each(MAIL_LISTS)("%s no longer stamps a row with the bare relative form", (view) => {
    expect(read(`views/${view}.tsx`)).not.toMatch(/time=\{displayTime\(/);
  });

  it("the shell hands its own flag and toggle to every one of them", () => {
    const shell = read("shell/AppShell.tsx");
    for (const view of MAIL_LISTS) {
      const open = shell.indexOf(`<${view}`);
      expect(open, `${view} is not rendered by the shell`).toBeGreaterThan(-1);
      /* The props have to be inside THIS element, not merely somewhere in a file thousands of lines long — the
         lesson `row-participants-wiring.test.ts` records, where a hard-coded indentation ran the
         slice on into the NEXT view's props and found the string there. The opening tag ends at
         the first `/>` sitting at the element's own indentation, so the bound comes from the tag. */
      const indent = " ".repeat(open - shell.lastIndexOf("\n", open) - 1);
      const close = shell.indexOf(`\n${indent}/>`, open);
      expect(close, `${view}'s opening tag does not terminate at its own indentation`).toBeGreaterThan(open);
      const tag = shell.slice(open, close);
      expect(tag, `${view} is mounted without the absolute-time flag`).toContain(
        "absoluteTime={absoluteTime}",
      );
      expect(tag, `${view} is mounted without the flip`).toContain(
        "onToggleTime={toggleAbsoluteTime}",
      );
    }
  });

  /**
   * ONE STATE FOR THE LISTS AND THE OPEN MESSAGE. The reader's stamp (`MessageChrome`) and every
   * row's now flip together because they read the same boolean and call the same callback. Two
   * booleans would let a list and the message open beside it show one date two ways — and that is
   * also the keyboard route to the flip, since the reader's stamp is a real `<button>` and a list
   * row's cannot be one (see `MessageRow.onToggleTime`).
   */
  it("the flip the rows are given IS the one the open message is given", () => {
    /* Two frames, one flip: the state and its callback are the open state's, and the chrome memo
       that hands it to the reader is still `AppShell.tsx`'s — which is the join this pins. */
    expect(shellFrameOf("toggleAbsoluteTime").source)
      .toMatch(/const toggleAbsoluteTime = useStableCallback\(\(\) => setAbsoluteTime\(\(v\) => !v\)\)/);
    expect(read("shell/AppShell.tsx")).toContain("onToggleAbsoluteTime: toggleAbsoluteTime");
  });

  /**
   * AND IT IS STILL MOMENTARY. The flip resets when the reader moves to another pile — it answers
   * "let me read the exact dates on THIS". `viewer-tags-and-stamp.test.ts` pins the same effect
   * for the open message; it is one flag, so this is the same guard seen from the list side, and
   * the reason it is repeated is that the rows are now the loudest thing it governs.
   */
  it("the flip is reset on a view switch, for the rows as much as for the reader", () => {
    expect(shellFrameOf("toggleAbsoluteTime").source, "the absolute-time flag survives a view switch")
      .toMatch(/setAbsoluteTime\(false\);\s*\}\s*,\s*\[route\.view\]\)/);
  });
});
