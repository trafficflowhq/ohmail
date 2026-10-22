import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * NO SCROLL IN THE READER IS THE APP'S UNLESS IT IS STAMPED, AND NO APP FOCUS MOVE SCROLLS IT.
 * Scroll-to-read counts a scroll under a pointer resting on a framed body as the person's unless the
 * scroller carries a live stamp (`programmatic-scroll.ts`), so a raw `.scrollTop =`, `.scrollTo(`,
 * `.scrollBy(` or `.scrollIntoView` in these files, or a `.focus(` without `preventScroll: true`,
 * would mark the panels it passed read. Comments and strings are blanked first (one pass,
 * `source-scan.mjs`); a planted raw write and a planted bare focus are the positive controls.
 */
/* @reads: apps/webapp/app/shell, apps/webapp/app/components, packages/ui/src/primitives */
const ROOT = join(__dirname, "..", "app");
/** The reader tree: every file whose code runs inside the reading column or the sheet. */
const FILES = [
  "shell/MessagePane.tsx",
  "shell/InlineReply.tsx",
  "components/MessageBody.tsx",
  "shell/MessageCard.tsx",
  "shell/Conversation.tsx",
  "shell/ThreadMarks.tsx",
  "shell/zone-nav.tsx",
  "shell/focus-follows.ts",
  "shell/MoreMenu.tsx",
  "shell/ForwardAsk.tsx",
  "shell/MessageFiles.tsx",
  "shell/RichEditor.tsx",
  "shell/RecipientField.tsx",
  "../../../packages/ui/src/primitives/DatePicker.tsx",
];
/**
 * Focus moves admitted without `preventScroll`, each with its reason, counted so a new one is a
 * reviewed diff: the reply editor's toolbar runs TipTap's `chain().focus()` on a press of one of its
 * own buttons — the button's `onMouseDown` calls `preventDefault()`, so the press leaves the focus where it
 * is, and TipTap's `focus()` on an editor that already has it returns without scrolling.
 */
const ADMITTED: Record<string, { pattern: RegExp; count: number }> = {
  "shell/RichEditor.tsx": { pattern: /\.chain\(\)\s*\.focus\(\)/g, count: 10 },
};
const RAW = /\.scrollTop\s*(?:=(?!=)|\+=|-=)|\.scrollTo\s*\(|\.scrollBy\s*\(|\.scrollIntoView\b/g;

function rawWrites(name: string, src: string): string[] {
  const blank = withoutCommentsAndLiterals(src);
  return [...blank.matchAll(RAW)].map((m) => `${name}:${lineOf(src, m.index!)}`);
}
/**
 * Every `.focus(` whose argument does not say `preventScroll: true` (TipTap's own spelling,
 * `scrollIntoView: false`, is the same promise), read with strings kept; a file's admitted pattern
 * is taken out first.
 */
function bareFocus(name: string, src: string): string[] {
  const code = withoutComments(src);
  const blank = withoutCommentsAndLiterals(src);
  const admitted = new Set<number>();
  const rule = ADMITTED[name];
  if (rule) for (const m of blank.matchAll(rule.pattern)) admitted.add(m.index! + m[0].indexOf(".focus"));
  const out: string[] = [];
  for (const m of blank.matchAll(/\.focus\s*\(/g)) {
    if (admitted.has(m.index!)) continue;
    const span = bracketSpan(blank, m.index! + m[0].length - 1);
    const args = code.slice(span.start, span.end);
    if (!/preventScroll\s*:\s*true|scrollIntoView\s*:\s*false/.test(args)) out.push(`${name}:${lineOf(src, m.index!)}`);
  }
  return out;
}
const sources = FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const);

describe("the reader's programmatic scrolls and focus moves", () => {
  it("every scroll write goes through the stamp door", () => {
    expect(sources.flatMap(([f, s]) => rawWrites(f, s))).toEqual([]);
  });

  it("every focus move passes preventScroll: true", () => {
    expect(sources.flatMap(([f, s]) => bareFocus(f, s))).toEqual([]);
  });

  it("the admitted focus moves are exactly the ones counted", () => {
    for (const [f, rule] of Object.entries(ADMITTED)) {
      const src = withoutCommentsAndLiterals(sources.find(([n]) => n === f)![1]);
      expect([...src.matchAll(rule.pattern)].length, f).toBe(rule.count);
    }
  });

  it("the census reads a planted raw write and a planted bare focus, and not one in a comment or a string", () => {
    const planted = [
      "const a = 1;",
      "el.scrollTop = 5;",
      "// el.scrollTop = 6;",
      'const s = "x.scrollIntoView()";',
      "box.current?.scrollIntoView?.({ block: 'end' });",
      "if (el.scrollTop === 3) el.scrollBy(0, 1);",
      "btn.focus();",
      "btn.focus({ preventScroll: true });",
      "// btn.focus();",
      "ref.current?.focus({ preventScroll: false });",
      'editor.commands.focus("end");',
      'editor.commands.focus("end", { scrollIntoView: false });',
    ].join("\n");
    expect(rawWrites("planted", planted)).toEqual(["planted:2", "planted:5", "planted:6"]);
    expect(bareFocus("planted", planted)).toEqual(["planted:7", "planted:10", "planted:11"]);
  });
});
