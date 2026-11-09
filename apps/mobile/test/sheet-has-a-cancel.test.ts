/**
 * EVERY SHEET HAS A WAY OUT — the reader's ⋯ sheet shipped with six verbs and no dismiss
 * control, so a pointer could drag the panel down and a screen reader, a switch or a keyboard
 * had nothing to press (measured on the iPhone 18 Pro and the iPad). The row now lives in the
 * `Sheet` primitive, which is what makes a sheet without one unrepresentable rather than
 * merely absent today; this census holds the two halves that a primitive cannot:
 *
 *  · a caller that renders its OWN cancel beside the primitive's — two ways out, one meaning;
 *  · `cancel="own"`, the confirmation's escape hatch, claimed by a sheet that has no such row.
 *
 * It reads the syntax tree, never the text: the rows sit behind conditionals and inside
 * wrappers, and a `grep` for `Cancel` matches a comment and misses `label={Copy.folderDeleteCancel}`
 * on the line below.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const PRIMITIVE = path.join(APP, "src", "ui", "Sheet.tsx");

/**
 * The dismissal labels that are NOT spelled `…Cancel`. One entry, and it is named rather than
 * matched: the notification ask's pair is Continue / Not now, where "Not now" IS the way out.
 */
const DISMISS_LABELS: Record<string, string> = {
  organizerNotifyNotNow: "the notification ask's pair is Continue / Not now — 'Not now' is the dismissal",
  awayLeaveKeep: "the away leave question's pair is Discard changes / Keep editing — 'Keep editing' is the dismissal",
};

interface Finding { file: string; line: number; code: string; detail: string }

/** Which `Copy.<key>` a `label={…}` attribute reads, or null for anything else. */
function copyKeyOf(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  const e = init.expression;
  if (ts.isPropertyAccessExpression(e) && e.expression.getText() === "Copy") return e.name.text;
  return null;
}

function isDismissRow(el: ts.JsxSelfClosingElement | ts.JsxOpeningElement): boolean {
  const tag = el.tagName.getText();
  if (tag === "CancelRow") return true;
  if (tag !== "SheetRow") return false;
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== "label") continue;
    const key = copyKeyOf(a);
    if (key === null) return false;
    return /Cancel$/.test(key) || key in DISMISS_LABELS;
  }
  return false;
}

/**
 * Every `<Sheet>` in one file, with the two facts this census decides on. The subtree walk stops
 * at a nested `<Sheet>` so an inner sheet's row cannot answer for the outer one — there is none
 * today, which is exactly why the guard is written now rather than after one appears.
 */
/** The text fields a sheet can hold: the platform's and the app's two wrappers of it. */
const TEXT_FIELDS = new Set(["TextInput", "Field", "RecipientInput"]);

interface SheetFacts { line: number; own: string | null; dismissRows: number; fields: number; avoidKeyboard: boolean }

function sheetsIn(file: string, text: string): SheetFacts[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: SheetFacts[] = [];
  const openingOf = (n: ts.Node) =>
    ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;

  const visit = (n: ts.Node): void => {
    const open = openingOf(n);
    if (open && open.tagName.getText() === "Sheet") {
      let own: string | null = null;
      // `avoidKeyboard` bare or `={true}`; `={false}` or any other value does not lift the panel.
      const avoidKeyboard = open.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === "avoidKeyboard"
        && (a.initializer === undefined || (ts.isJsxExpression(a.initializer) && a.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)));
      for (const a of open.attributes.properties) {
        if (!ts.isJsxAttribute(a) || a.name.getText() !== "cancel") continue;
        const init = a.initializer;
        own = init && ts.isStringLiteral(init) ? init.text : "«not a string literal»";
      }
      let rows = 0;
      let fields = 0;
      const inner = (c: ts.Node): void => {
        const co = openingOf(c);
        if (co && c !== n && co.tagName.getText() === "Sheet") return;
        if (co && isDismissRow(co)) rows += 1;
        if (co && TEXT_FIELDS.has(co.tagName.getText())) fields += 1;
        ts.forEachChild(c, inner);
      };
      ts.forEachChild(n, inner);
      out.push({ line: src.getLineAndCharacterOfPosition(open.getStart()).line + 1, own, dismissRows: rows, fields, avoidKeyboard });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The census proper, over whatever sources it is handed — the fixtures drive this same call. */
function census(files: { rel: string; text: string }[]): { findings: Finding[]; sheets: number } {
  const findings: Finding[] = [];
  let sheets = 0;
  for (const { rel, text } of files) {
    for (const s of sheetsIn(rel, text)) {
      sheets += 1;
      /* The Tag sheet held its field and no avoidKeyboard: on the iPhone and the iPad the keyboard rose
         over the whole panel, field, rows, Create and Cancel. */
      if (s.fields > 0 && !s.avoidKeyboard) {
        findings.push({ file: rel, line: s.line, code: "FIELD-UNDER-KEYBOARD", detail: "holds a text field and does not pass avoidKeyboard — the keyboard covers the panel" });
      }
      if (s.own !== null && s.own !== "own") {
        findings.push({ file: rel, line: s.line, code: "BAD-CANCEL-VALUE", detail: `cancel=${s.own}; the only value is "own"` });
      } else if (s.own === "own" && s.dismissRows === 0) {
        findings.push({
          file: rel, line: s.line, code: "OWN-WITHOUT-A-ROW",
          detail: 'claims cancel="own" and renders no dismissing row — the sheet has no way out',
        });
      } else if (s.own === null && s.dismissRows > 0) {
        findings.push({
          file: rel, line: s.line, code: "DOUBLE-CANCEL",
          detail: `renders ${s.dismissRows} dismissing row(s) beside the primitive's — drop it, or declare cancel="own"`,
        });
      }
    }
  }
  return { findings, sheets };
}

/** Every `.tsx` under the app's two source roots. `test/` is not walked: it renders no sheet. */
function appSources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      out.push({ rel: path.relative(APP, full), text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(path.join(APP, "src"));
  walk(path.join(APP, "app"));
  return out;
}

describe("the Sheet primitive renders the way out", () => {
  it("the panel renders CancelRow on every path but cancel=\"own\"", () => {
    const text = fs.readFileSync(PRIMITIVE, "utf8");
    const src = ts.createSourceFile(PRIMITIVE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let guarded = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isConditionalExpression(n) && /cancel\s*===\s*"own"/.test(n.condition.getText())) {
        const arms = [n.whenTrue.getText(), n.whenFalse.getText()];
        if (arms.some((a) => a.includes("<CancelRow")) && arms.includes("null")) guarded += 1;
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    expect(
      guarded,
      "Sheet.tsx no longer renders <CancelRow /> under a cancel === \"own\" guard — every sheet's way out went with it",
    ).toBe(1);
  });

  it("nobody else can render one: CancelRow is not exported", () => {
    const text = fs.readFileSync(PRIMITIVE, "utf8");
    expect(/export function CancelRow/.test(text)).toBe(false);
  });
});

describe("every sheet in the app", () => {
  const files = appSources();

  it("walks a real tree — the count is the proof it read one", () => {
    const { sheets } = census(files);
    // Sixteen sheets at the time of writing; the floor is what makes a walk that read nothing
    // (a moved root, a changed extension) a red rather than a green. It carries the corpus half
    // of the per-call-site census this file replaced: that one asked each `<Sheet>` block for the
    // TEXT of a dismissing row, which no call site has now that the primitive draws it, so it
    // passed without measuring the thing it was about. The rule is proved here instead — at the
    // primitive, and per sheet for the one that opts out.
    expect(sheets).toBeGreaterThanOrEqual(16);
    expect(files.length).toBeGreaterThan(50);
  });

  it("a sheet that holds a text field: the census reads at least the folder name and the Tag sheet", () => {
    const withFields = files.flatMap(({ rel, text }) => sheetsIn(rel, text).filter((x) => x.fields > 0).map(() => rel));
    expect(withFields).toEqual(expect.arrayContaining(["src/ui/FoldersGroup.tsx", "src/ui/MessageActions.tsx"]));
  });

  it("carries no double cancel, no unearned cancel=\"own\" and no text field under the keyboard", () => {
    const { findings } = census(files);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.code} — ${f.detail}`)).toEqual([]);
  });

  it("every named dismissal label is a key the deck holds, with its reason", () => {
    const en = fs.readFileSync(path.join(APP, "src", "copy.en.ts"), "utf8");
    for (const [key, reason] of Object.entries(DISMISS_LABELS)) {
      expect(en.includes(`  ${key}:`), `${key}: named here, absent from the English deck`).toBe(true);
      expect(reason.length, `${key}: the reason is a shrug`).toBeGreaterThan(30);
    }
  });
});

/**
 * THE CENSUS, WATCHED FAILING. Each arm is a source the shipped tree does not contain, driven
 * through the same `census` call — a refusal rule nobody has seen fire is not evidence.
 */
describe("the census, watched failing", () => {
  const fixture = (body: string) => [{ rel: "fixture.tsx", text: body }];

  it("refuses cancel=\"own\" on a sheet with no dismissing row, by name", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionMore} cancel="own">
          <SheetRow label={Copy.actionDelete} onPress={go} />
        </Sheet>
      );`));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("OWN-WITHOUT-A-ROW");
  });

  it("refuses a caller's own cancel row beside the primitive's", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionMore}>
          <SheetRow label={Copy.actionDelete} onPress={go} />
          <CancelRow onPress={close} />
        </Sheet>
      );`));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("DOUBLE-CANCEL");
  });

  it("sees a dismissing row named by its Copy key, not only <CancelRow>", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.folderDelete}>
          <SheetRow icon="x" label={Copy.folderDeleteCancel} onPress={close} />
        </Sheet>
      );`));
    expect(findings.map((f) => f.code)).toEqual(["DOUBLE-CANCEL"]);
  });

  it("sees one behind a conditional and inside a wrapper — the shape the real sheets have", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionMore} cancel="own">
          <View>{ready ? <SheetRow label={Copy.signInAgainCancel} onPress={close} /> : null}</View>
        </Sheet>
      );`));
    expect(findings).toEqual([]);
  });

  it("refuses a cancel value that is not \"own\"", () => {
    const { findings } = census(fixture(`
      const X = () => <Sheet open onClose={close} label={Copy.search} cancel="none" />;`));
    expect(findings.map((f) => f.code)).toEqual(["BAD-CANCEL-VALUE"]);
  });

  it("refuses a sheet with a text field that does not lift over the keyboard", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionTag}>
          <View>{ready ? <TextInput value={q} onChangeText={setQ} /> : null}</View>
        </Sheet>
      );
      const Y = () => <Sheet open onClose={close} label={Copy.actionTag} avoidKeyboard={false}><Field label="" /></Sheet>;`));
    expect(findings.map((f) => f.code)).toEqual(["FIELD-UNDER-KEYBOARD", "FIELD-UNDER-KEYBOARD"]);
  });

  it("ADMITS a sheet with a text field that passes avoidKeyboard", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionTag} avoidKeyboard>
          <TextInput value={q} onChangeText={setQ} />
        </Sheet>
      );`));
    expect(findings).toEqual([]);
  });

  it("ADMITS the ordinary sheet — a rule that refused everything would pass the arms above", () => {
    const { findings, sheets } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.search}>
          <Txt>{Copy.searchLater}</Txt>
        </Sheet>
      );`));
    expect(findings).toEqual([]);
    expect(sheets).toBe(1);
  });

  it("an inner sheet's row does not answer for the outer one", () => {
    const { findings } = census(fixture(`
      const X = () => (
        <Sheet open onClose={close} label={Copy.actionMore} cancel="own">
          <Sheet open onClose={close} label={Copy.search}>
            <CancelRow onPress={close} />
          </Sheet>
        </Sheet>
      );`));
    // The outer claims "own" and holds no row of its own; the inner renders a double.
    expect(findings.map((f) => f.code).sort()).toEqual(["DOUBLE-CANCEL", "OWN-WITHOUT-A-ROW"]);
  });
});
