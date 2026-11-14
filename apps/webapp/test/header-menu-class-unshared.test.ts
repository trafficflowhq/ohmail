/* @reads: apps/webapp/app/shell/MessageCard.tsx apps/webapp/app/app.css packages/ui/src/composites/message.css */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { lineOf, withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE HEADER'S ⋯ TRIGGER OWNS ITS CLASS. Its look is app.css's alone; a packages/ui rule naming the
 * same class adds to it. The body pager took `.msg-more` beside the history chip's pill rule, and the
 * 26px trigger drew a ring and a second row of dots (2026-10-05), while the pager took its 26px box.
 * The trigger's classes are read off MessageCard.tsx, so a renamed trigger is still the subject.
 * Mutations, each watched red: the pill rule naming `.msg-more` again; BodyText's pager carrying it.
 */

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** Repo-relative paths under `dir` ending in `ext`. */
const walk = (dir: string, ext: string): string[] =>
  readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p, ext);
    return e.name.endsWith(ext) ? [relative(ROOT, resolve(ROOT, p))] : [];
  });

/** Every class a rule's selector names, with its line, read off comment-blanked CSS. */
const selectorClasses = (css: string): { cls: string; line: number }[] => {
  const bare = withoutComments(css);
  const out: { cls: string; line: number }[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{/g)) {
    for (const c of m[1]!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      out.push({ cls: c[1]!, line: lineOf(bare, m.index! + c.index!) });
    }
  }
  return out;
};

const parse = (p: string): ts.SourceFile =>
  ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The literal class words a JSX `className` initializer can produce, ternaries and calls included. */
const classWords = (init: ts.Node): string[] => {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(...n.text.split(/\s+/));
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(...n.text.split(/\s+/));
    ts.forEachChild(n, visit);
  };
  visit(init);
  return out.filter(Boolean);
};

type Jsx = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const jsxElements = (sf: ts.SourceFile): Jsx[] => {
  const out: Jsx[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};
const attr = (sf: ts.SourceFile, el: Jsx, name: string): ts.JsxAttribute | undefined =>
  el.attributes.properties.find(
    (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name,
  );

const CARD = "apps/webapp/app/shell/MessageCard.tsx";
const cardFile = parse(CARD);
/** The header's menu trigger: MessageCard's one `<button aria-haspopup="menu">`. */
const triggers = jsxElements(cardFile).filter((el) => {
  const pop = attr(cardFile, el, "aria-haspopup")?.initializer;
  return el.tagName.getText(cardFile) === "button" && pop != null && ts.isStringLiteral(pop) && pop.text === "menu";
});
const trigger = triggers[0];
const cn = trigger ? attr(cardFile, trigger, "className")?.initializer : undefined;
const TRIGGER_CLASSES = cn ? classWords(cn) : [];

describe("the header's ⋯ trigger shares its class with nothing", () => {
  it("the trigger is found, once, and carries a class (the anchor)", () => {
    expect(triggers, "MessageCard.tsx no longer has exactly one menu trigger").toHaveLength(1);
    expect(TRIGGER_CLASSES.length, "the trigger's className read as no class at all").toBeGreaterThan(0);
  });

  it("app.css styles the trigger by those classes (the positive control)", () => {
    const styled = new Set(selectorClasses(read("apps/webapp/app/app.css")).map((s) => s.cls));
    for (const cls of TRIGGER_CLASSES) expect(styled.has(cls), `app.css names no .${cls}`).toBe(true);
  });

  it("no packages/ui stylesheet has a rule naming any of them", () => {
    const sheets = walk("packages/ui/src", ".css");
    const read_ = sheets.map((p) => ({ p, classes: selectorClasses(read(p)) }));
    // Through the same reader: the composite's own pill class is found, so an empty answer is a reading.
    const pill = read_.find((s) => s.p === "packages/ui/src/composites/message.css");
    expect(pill?.classes.some((s) => s.cls === "msg-history-toggle"), "the scan read no pill rule").toBe(true);
    const hits = read_.flatMap(({ p, classes }) =>
      classes.filter((s) => TRIGGER_CLASSES.includes(s.cls)).map((s) => `${p}:${s.line} .${s.cls}`));
    expect(hits, "a shared rule adds to the header trigger's look").toEqual([]);
  });

  it("no other element in the webapp or packages/ui carries them", () => {
    const files = [...walk("apps/webapp/app", ".tsx"), ...walk("packages/letter-body/src", ".tsx"), ...walk("packages/ui/src", ".tsx")];
    const carriers: string[] = [];
    for (const p of files) {
      const sf = p === CARD ? cardFile : parse(p);
      for (const el of jsxElements(sf)) {
        const init = attr(sf, el, "className")?.initializer;
        if (!init) continue;
        const words = classWords(init);
        for (const cls of TRIGGER_CLASSES.filter((c) => words.includes(c))) {
          carriers.push(`${p}:${sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1} .${cls}`);
        }
      }
    }
    const own = trigger ? `${CARD}:${cardFile.getLineAndCharacterOfPosition(trigger.getStart(cardFile)).line + 1}` : "";
    expect(carriers, "another element takes the header trigger's look from app.css")
      .toEqual(TRIGGER_CLASSES.map((cls) => `${own} .${cls}`));
  });
});
