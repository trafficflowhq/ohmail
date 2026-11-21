import { readdirSync, readFileSync, statSync } from "node:fs";
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
/* @reads: packages/app/src/reader, packages/ui/src/mail/Reading, packages/app/src/write, packages/ui/src/mail/Editor, packages/letter-body/src, packages/ui/src/mail/Lists, packages/ui/src/calendar/Shell, packages/ui/src/primitives, packages/app-logic/src/keys, packages/app-logic/src/writing */
const ROOT = join(__dirname, "..", "..", "..");
/** Every source file under a folder, by its path from the repository's root. */
const under = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return under(rel);
    return /\.tsx?$/.test(name) ? [rel] : [];
  });
/**
 * The reader tree: every file whose code runs inside the reading column or the sheet. Re-pointed by path from today's
 * reader's ten files (its pane, its reply, its letters, its squares, its menus, its files, its editor and its people
 * line) to the parts that draw the same column now: the reader and the kit's reading parts whole; the reply Write hands the column (its sheet, editors, people line, marks and
 * Send later); the body, the squares, the day pickers and the walks, as before.
 */
const FILES = [
  ...under("packages/app/src/reader"),
  ...under("packages/ui/src/mail/Reading"),
  "packages/app/src/write/Reply.tsx",
  "packages/app/src/write/editor/RichEditor.tsx",
  "packages/app/src/write/editor/commands.ts",
  "packages/app/src/write/plain/PlainEditor.tsx",
  "packages/app/src/write/head/People.tsx",
  "packages/app/src/write/text/Marks.tsx",
  "packages/app/src/write/verbs/Later.tsx",
  "packages/ui/src/mail/Editor/Recipients.tsx",
  "packages/ui/src/mail/Editor/recipient-type.tsx",
  "packages/app-logic/src/writing/sent-reveal.ts",
  "packages/letter-body/src/MessageBody.tsx",
  "packages/ui/src/mail/Lists/ReadSquares.tsx",
  "packages/app-logic/src/keys/zone-nav.ts",
  "packages/app-logic/src/keys/focus-follows.ts",
  "packages/ui/src/primitives/DatePicker.tsx",
  "packages/ui/src/calendar/Shell/MiniMonth.tsx",
];
/**
 * Focus moves admitted without `preventScroll`, each with its reason, counted so a new one is a
 * reviewed diff: the reply editor's toolbar runs TipTap's `chain().focus()` on a press of one of its
 * own buttons (Write's editor: its four marks, `marksOf`'s `run`; the link's and the insert's chains are not a
 * toolbar's press and are not admitted) — the button's `onMouseDown` calls `preventDefault()`, so the press leaves the focus where it
 * is, and TipTap's `focus()` on an editor that already has it returns without scrolling.
 */
const ADMITTED: Record<string, { pattern: RegExp; count: number }> = {
  "packages/app/src/write/editor/RichEditor.tsx": { pattern: /editor\.chain\(\)\.focus\(\)\.toggle/g, count: 4 },
  "packages/app/src/write/editor/commands.ts": { pattern: /\.chain\(\)\s*\.focus\(\)/g, count: 7 },
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
