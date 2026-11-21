import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const column = "packages/app/src/stream/StreamColumn.tsx";
const sheet = "packages/ui/src/mail/Shell/Sheet.tsx";
const sheetCss = "packages/ui/src/mail/Shell/sheet.css";
const scroller = "oh-sheet-scroll";
const sheets = [
  "packages/app/src/stream/stream.css",
  "packages/ui/src/mail/Reading/message.css",
  "packages/ui/src/mail/Reading/message-head.css",
  "packages/ui/src/mail/Reading/letter-columns.css",
  sheetCss,
  "apps/webapp/app/app.css",
  "packages/letter-body/src/message-body.css",
];
const parts = [
  "packages/app/src/stream/StreamItem.tsx",
  "packages/app/src/reader/Letter.tsx",
  "packages/ui/src/mail/Reading/Message.tsx",
  "packages/ui/src/mail/Reading/MessageHead.tsx",
  "packages/letter-body/src/MessageBody.tsx",
];

function streamClasses(): Set<string> {
  const classes = new Set<string>();
  for (const part of parts) {
    for (const match of read(part).matchAll(/className=\{?["`']([^"`']+)["`']/g)) {
      for (const word of match[1]!.split(/\s+/)) classes.add(word);
    }
  }
  return classes;
}

function rules(css: string): { selector: string; declarations: string }[] {
  return Array.from(withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    declarations: match[2]!,
  }));
}

/** The outer sheet owns the wheel. Its own shorthand names both axes. */
function cardScrollers(css: string, classes: ReadonlySet<string>): string[] {
  return rules(css).flatMap(({ selector, declarations }) => {
    const scrollsVertically =
      /(?:^|;)\s*overflow-y\s*:\s*(?:auto|scroll)\b/.test(declarations) ||
      /(?:^|;)\s*overflow\s*:\s*(?:auto|scroll)\s*(?:;|$)/.test(declarations) ||
      /(?:^|;)\s*overflow\s*:\s*\w+\s+(?:auto|scroll)\b/.test(declarations);
    if (!scrollsVertically) return [];
    return selector.split(",").filter((part) => {
      const last = [...part.matchAll(/\.([A-Za-z][\w-]*)/g)].at(-1)?.[1];
      return last !== undefined && classes.has(last);
    }).map((part) => part.trim());
  });
}

describe("one scroll owner per reading stream (the source census)", () => {
  it("no rule declares overflow-x without naming overflow-y", () => {
    const offenders: string[] = [];
    for (const path of sheets) {
      for (const { selector, declarations } of rules(read(path))) {
        if (!/overflow-x\s*:\s*(auto|scroll)/.test(declarations)) continue;
        if (/overflow-y\s*:/.test(declarations)) continue;
        offenders.push(`${path}: ${selector.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the reading stream is the only thing anchoring the reading stream", () => {
    expect(read(column)).toMatch(/<Sheet\b[\s\S]+?manualScrollAnchor=\{shown\.length > 0\}/);
    expect(read(sheet)).toMatch(/data-manual-anchor=\{props\.manualScrollAnchor \?/);
    expect(read(sheetCss)).toMatch(/\.oh-sheet-scroll\[data-manual-anchor\] \{\s*overflow-anchor: none;\s*\}/);
  });

  it("the derived class set is the card's own, and it is not empty", () => {
    expect(read(sheet)).toContain(`className="${scroller}"`);
    expect(read(column)).toContain("<StreamItem");
    const classes = streamClasses();
    expect(classes.size).toBeGreaterThan(10);
    for (const required of ["oh-message-clip", "oh-message-body", "oh-messagehead", "oh-message"]) {
      expect(classes.has(required), required).toBe(true);
    }
  });

  it("no rule makes a vertical scroller of anything inside a card — only the stream itself", () => {
    const classes = streamClasses();
    const captors = sheets.flatMap((path) => cardScrollers(read(path), classes).map((name) => `${path}: ${name}`));
    expect(captors).toEqual([]);
  });

  it("the census SEES a captor — the planted one, in the rule's own shape", () => {
    const classes = streamClasses();
    const captor = ".oh-message .oh-message-clip";
    expect(cardScrollers(`${captor}{overflow-y:auto;max-height:200px}`, classes)).toEqual([captor]);
    expect(cardScrollers(`${captor}{overflow:hidden auto;max-height:200px}`, classes)).toEqual([captor]);
  });
});
