import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * EVERY LIST VIEW MOUNTS ITS WINDOW, NOT ITS LIST. A switch into the Screener mounted all its
 * waiting senders and the Windows reading paid for it on every visit (switch p95 1 394 ms against
 * 200). This reads each view's `<ListRows>` as an AST: every row-producing `.map(` inside one is
 * over a `.slice(…)` whose bounds come from `useListWindow`, or is named below with its bound. A
 * doctored source runs through the same reader first, so a reader that finds nothing cannot pass.
 * And a view that windows renders ONE top spacer carrying `data-window-top`, never behind a
 * `padTop` condition: slot 0 starts where it stands, so a list that marks none counts its rows
 * from the scroller's top and shifts them by whatever stands above.
 */

const VIEWS_DIR = resolve(process.cwd(), "apps/webapp/app/views");

/**
 * THE MAPS THAT ARE NOT A WINDOW, AND WHAT BOUNDS EACH. A row here is a decision somebody can
 * read; an entry that no longer matches a map in its file refuses as stale.
 */
const BOUNDED: readonly { file: string; receiver: string; bound: string }[] = [
  { file: "FolderView.tsx", receiver: "olderRows", bound: "server pages past the mirror, one per Load older press" },
  { file: "TrashView.tsx", receiver: "byDateDesc(live.items)", bound: "the server's own Trash, one page per press" },
  { file: "ScreenerView.tsx", receiver: "junk.visible.slice(0, localCount)", bound: "the live Junk window: one provider page per press" },
  { file: "ScreenerView.tsx", receiver: "junk.visible.slice(localCount)", bound: "the Junk search's appended server hits, one page" },
];

/** Files with a `<ListRows>` that call no `useListWindow`, and why. */
const NO_WINDOW: readonly { file: string; why: string }[] = [];

interface Finding {
  line: number;
  receiver: string;
  windowed: boolean;
}

interface Reading {
  listRows: number;
  callsWindow: boolean;
  maps: Finding[];
  /** Elements carrying `data-window-top`, and those rendered only while a `padTop` holds. */
  origins: number;
  gatedOrigins: number;
}

/** Names whose initializer reads the window (`win.`), to a fixpoint — `itemsFrom`, `newTo`, … */
function windowNames(file: ts.SourceFile): Set<string> {
  const decls: { name: string; init: string }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      decls.push({ name: node.name.text, init: node.initializer.getText(file) });
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  const names = new Set<string>();
  const reads = (text: string): boolean =>
    /\bwin\./.test(text) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decls) {
      if (!names.has(d.name) && reads(d.init)) {
        names.add(d.name);
        grew = true;
      }
    }
  }
  return names;
}

function readListViews(source: string, name = "View.tsx"): Reading {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = windowNames(file);
  const fromWindow = (arg: ts.Expression): boolean => {
    const text = arg.getText(file);
    return /\bwin\./.test(text) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
  };
  let listRows = 0;
  let callsWindow = false;
  const maps: Finding[] = [];
  let origins = 0;
  let gatedOrigins = 0;
  /** Is `node` inside a `?:` or `&&` whose condition reads a `padTop`? */
  const gatedOnPad = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isConditionalExpression(p) && /padTop/.test(p.condition.getText(file))) return true;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          && /padTop/.test(p.left.getText(file))) return true;
    }
    return false;
  };
  const walk = (node: ts.Node, inRows: boolean): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useListWindow") {
      callsWindow = true;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "data-window-top") {
      origins += 1;
      if (gatedOnPad(node)) gatedOrigins += 1;
      return;
    }
    if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName)
        && node.openingElement.tagName.text === "ListRows") {
      listRows += 1;
      for (const child of node.children) walk(child, true);
      return;
    }
    // A row's own props (`tags={….map(…)}`) are not rows.
    if (ts.isJsxAttribute(node)) return;
    if (inRows && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "map") {
      const recv = node.expression.expression;
      const windowed = ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression)
        && recv.expression.name.text === "slice" && recv.arguments.length === 2
        && recv.arguments.every(fromWindow);
      maps.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        receiver: recv.getText(file),
        windowed,
      });
      // The outermost map produces the rows; one nested in its callback is inside a row.
      return;
    }
    ts.forEachChild(node, (c) => walk(c, inRows));
  };
  walk(file, false);
  return { listRows, callsWindow, maps, origins, gatedOrigins };
}

/** What the census refuses in one file, by line. */
function refusals(file: string, r: Reading): string[] {
  const out: string[] = [];
  if (r.listRows > 0 && !r.callsWindow && !NO_WINDOW.some((x) => x.file === file)) {
    out.push(`${file}: renders <ListRows> and calls no useListWindow`);
  }
  if (r.callsWindow && r.origins !== 1) {
    out.push(`${file}: windows and marks ${r.origins} top spacer(s) with data-window-top — slot 0 needs exactly one`);
  }
  if (r.gatedOrigins > 0) out.push(`${file}: its data-window-top spacer is rendered only while padTop holds`);
  for (const m of r.maps) {
    if (m.windowed) continue;
    if (BOUNDED.some((b) => b.file === file && b.receiver === m.receiver)) continue;
    out.push(`${file}:${m.line}: ${m.receiver}.map inside <ListRows> is not a window slice`);
  }
  return out;
}

const viewFiles = readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".tsx")).sort();
const readings = new Map(viewFiles.map((f) => [f, readListViews(readFileSync(join(VIEWS_DIR, f), "utf8") + (f === "OhboxView.tsx" ? readFileSync(resolve(process.cwd(), "packages/app-logic/src/ohbox/window.ts"), "utf8") : ""), f)]));

describe("every list view mounts its window", () => {
  it("the reader sees a planted raw map, and admits the window's own slice", () => {
    const planted = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows ariaLabel="x"><div data-window-top="" />{items.map((x) => <MessageRow key={x.id} tags={x.t.map((y) => y)} />)}</ListRows>;
      }`);
    expect(planted.listRows).toBe(1);
    expect(planted.callsWindow).toBe(true);
    expect(planted.maps).toEqual([{ line: 4, receiver: "items", windowed: false }]);
    expect(refusals("Planted.tsx", planted)).toHaveLength(1);

    const admitted = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        const from = Math.min(win.start, items.length);
        const to = Math.min(win.end, items.length);
        return <ListRows ariaLabel="x"><div data-window-top="" />{items.slice(from, to).map((x, k) => row(x, from + k))}</ListRows>;
      }`);
    expect(admitted.maps.map((m) => m.windowed)).toEqual([true]);
    expect(refusals("Admitted.tsx", admitted)).toEqual([]);
  });

  it("a slice with a literal bound is not a window, and a list with no window call is refused", () => {
    const literal = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows ariaLabel="x">{items.slice(0, 5000).map(row)}</ListRows>;
      }`);
    expect(literal.maps.map((m) => m.windowed)).toEqual([false]);
    const unwindowed = readListViews(`function V({ items }) { return <ListRows ariaLabel="x">{items.slice(a, b).map(row)}</ListRows>; }`);
    expect(unwindowed.callsWindow).toBe(false);
    expect(refusals("NoWindow.tsx", unwindowed).some((r) => r.includes("calls no useListWindow"))).toBe(true);
  });

  it("the reader refuses a window with no origin or a gated one, and admits the marked spacer", () => {
    const unmarked = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        const from = win.start;
        return <ListRows ariaLabel="x">{win.padTop > 0 ? <div style={{ height: win.padTop }} /> : null}{items.slice(from, win.end).map(row)}</ListRows>;
      }`);
    expect(refusals("Unmarked.tsx", unmarked)).toEqual([
      "Unmarked.tsx: windows and marks 0 top spacer(s) with data-window-top — slot 0 needs exactly one",
    ]);
    const gated = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows ariaLabel="x">{win.padTop > 0 ? <div data-window-top="" style={{ height: win.padTop }} /> : null}{items.slice(win.start, win.end).map(row)}</ListRows>;
      }`);
    expect(refusals("Gated.tsx", gated)).toEqual(["Gated.tsx: its data-window-top spacer is rendered only while padTop holds"]);
    const marked = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows ariaLabel="x">{items.length ? <><div data-window-top="" style={{ height: win.padTop }} />{items.slice(win.start, win.end).map(row)}</> : null}</ListRows>;
      }`);
    expect(refusals("Marked.tsx", marked)).toEqual([]);
  });

  it("reads the views it is about", () => {
    for (const f of ["ScreenerView.tsx", "HistoryView.tsx", "TagView.tsx", "TriageView.tsx", "DraftsView.tsx"]) {
      expect(readings.get(f)?.listRows ?? 0, `${f} holds no <ListRows> — the census reads nothing there`).toBeGreaterThan(0);
      expect(readings.get(f)?.callsWindow, `${f} calls no useListWindow`).toBe(true);
    }
    const screener = readings.get("ScreenerView.tsx")!.maps;
    expect(screener.filter((m) => m.windowed).map((m) => m.receiver)).toEqual([
      "items.slice(itemsFrom, itemsTo)",
      "decidedRows.slice(decidedFrom, decidedTo)",
    ]);
  });

  it("no list view maps a list into its rows outside the window", () => {
    const all = [...readings].flatMap(([f, r]) => refusals(f, r));
    expect(all, all.join("\n")).toEqual([]);
  });

  it("every named bound still names a map in its file", () => {
    const stale = BOUNDED.filter((b) => !readings.get(b.file)?.maps.some((m) => !m.windowed && m.receiver === b.receiver));
    expect(stale.map((b) => `${b.file}: ${b.receiver}`)).toEqual([]);
    const staleNoWindow = NO_WINDOW.filter((x) => readings.get(x.file)?.callsWindow !== false);
    expect(staleNoWindow.map((x) => x.file)).toEqual([]);
  });
});
