import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * EVERY LIST VIEW MOUNTS ITS WINDOW, NOT ITS LIST. A switch into the Screener mounted all its
 * waiting senders and the Windows reading paid for it on every visit (switch p95 1 394 ms against
 * 200). This reads each view's `<ListRows>` or `<Rows>` as an AST: every row-producing `.map(` inside one is
 * over a `.slice(…)` whose bounds come from the list window, or is named below with its bound. A
 * doctored source runs through the same reader first, so a reader that finds nothing cannot pass.
 * And a view that windows renders ONE top spacer carrying `data-window-top`, never behind a
 * `padTop` condition: slot 0 starts where it stands, so a list that marks none counts its rows
 * from the scroller's top and shifts them by whatever stands above.
 */

const TRASH = "TrashList.tsx";
const JUNK = "Junk.tsx";
const STREAM = "StreamList.tsx";
const WINDOW_CALLS = new Set(["useListWindow", "useCursorWindow"]);
const WINDOW_ACCESS = /\b(?:win|window)\./;
const DRAFTS = "DraftsList.tsx";
const DRAFTS_SOURCE = resolve(process.cwd(), "packages/app/src/drafts/DraftsList.tsx");

/**
 * THE MAPS THAT ARE NOT A WINDOW, AND WHAT BOUNDS EACH. A row here is a decision somebody can
 * read; an entry that no longer matches a map in its file refuses as stale.
 */
const BOUNDED: readonly { file: string; receiver: string; bound: string }[] = [
  { file: TRASH, receiver: "live.items", bound: "the server's own Trash, one page per press" },
  { file: JUNK, receiver: "kept", bound: "the live Junk window: one provider page per press" },
  { file: JUNK, receiver: "found", bound: "the Junk search's appended server hits, one page" },
];

/** Files with a `<ListRows>` that call no `useListWindow`, and why. */
const NO_WINDOW: readonly { file: string; why: string }[] = [{ file: JUNK, why: "server-sized Junk and search pages" }];

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
    WINDOW_ACCESS.test(text) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
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
  // Bind the scanned source in isolation. Only local declarations matter to this check.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const checker = ts.createProgram([name], options, {
    ...ts.createCompilerHost(options),
    getSourceFile: (path) => path === name ? file : undefined,
  }).getTypeChecker();
  const names = windowNames(file);
  const fromWindow = (arg: ts.Expression): boolean => {
    const text = arg.getText(file);
    return WINDOW_ACCESS.test(text) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
  };
  const fromWindowSlice = (expr: ts.Expression): boolean =>
    ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
    && expr.expression.name.text === "slice" && expr.arguments.length === 2
    && expr.arguments.every(fromWindow);
  const namedWindowSlice = (receiver: ts.Identifier): boolean => {
    const decl = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
    return decl !== undefined && ts.isVariableDeclaration(decl)
      && ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0
      && decl.initializer !== undefined && fromWindowSlice(decl.initializer);
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WINDOW_CALLS.has(node.expression.text)) {
      callsWindow = true;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "data-window-top") {
      origins += 1;
      if (gatedOnPad(node)) gatedOrigins += 1;
      return;
    }
    if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName)
        && ["ListRows", "Rows"].includes(node.openingElement.tagName.text)) {
      listRows += 1;
      for (const child of node.children) walk(child, true);
      return;
    }
    // A row's own props (`tags={….map(…)}`) are not rows.
    if (ts.isJsxAttribute(node)) return;
    if (inRows && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "map") {
      const recv = node.expression.expression;
      const windowed = fromWindowSlice(recv) || (ts.isIdentifier(recv) && namedWindowSlice(recv));
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

const readings = new Map<string, ReturnType<typeof readListViews>>();
readings.set(JUNK, readListViews(readFileSync("packages/app/src/screener/list/Junk.tsx", "utf8"), JUNK));
readings.set(STREAM, readListViews(readFileSync("packages/app/src/stream/StreamList.tsx", "utf8"), STREAM));
readings.set(TRASH, readListViews(readFileSync("packages/app/src/trash/TrashList.tsx", "utf8"), TRASH));
readings.set(DRAFTS, readListViews(readFileSync(DRAFTS_SOURCE, "utf8"), DRAFTS));

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

    const named = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        const visible = items.slice(win.start, win.end);
        return <Rows label="x"><div data-window-top="" />{visible.map(row)}</Rows>;
      }`);
    expect(named.maps.map((m) => m.windowed)).toEqual([true]);
    expect(refusals("Named.tsx", named)).toEqual([]);
    const bypass = readListViews(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        const visible = items.slice(win.start, items.length);
        return <Rows label="x"><div data-window-top="" />{visible.map(row)}</Rows>;
      }`);
    expect(bypass.maps.map((m) => m.windowed)).toEqual([false]);
    expect(refusals("Bypass.tsx", bypass)).toHaveLength(1);
  });

  it("refuses a full-list map even when another scope slices a list with the same name", () => {
    const shadowed = readListViews(`
      function Windowed({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        const visible = items.slice(win.start, win.end);
        return <Rows label="x"><div data-window-top="" />{visible.map(row)}</Rows>;
      }
      function Unwindowed({ items }) {
        const visible = items;
        return <Rows label="y">{visible.map(row)}</Rows>;
      }`);
    expect(shadowed.maps.map(({ receiver, windowed }) => [receiver, windowed])).toEqual([
      ["visible", true],
      ["visible", false],
    ]);
    expect(refusals("Shadowed.tsx", shadowed)).toEqual([
      "Shadowed.tsx:9: visible.map inside <ListRows> is not a window slice",
    ]);
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
    for (const f of [STREAM, DRAFTS]) {
      expect(readings.get(f)?.listRows ?? 0, `${f} holds no row list — the census reads nothing there`).toBeGreaterThan(0);
      expect(readings.get(f)?.callsWindow, `${f} calls no useListWindow`).toBe(true);
    }
    const tags = readFileSync("packages/app/src/tags/TagsList.tsx", "utf8");
    const tagRows = readFileSync("packages/app/src/place-list/LetterRows.tsx", "utf8");
    expect(tags).toMatch(/const win = useListWindow\(/);
    expect(tags).toMatch(/<OneTag[^>]*win=\{win\}/);
    expect(tags).toMatch(/<LetterRows[\s\S]*?slots: model\.list\.rows\.slice\(win\.start, win\.end\)/);
    const window = readListViews(tagRows, "LetterRows.tsx");
    expect(window.origins).toBe(1);
    expect(window.gatedOrigins).toBe(0);
    expect(window.maps.map(({ receiver }) => receiver)).toEqual(["(windowed?.slots ?? rows)"]);
    const folder = readFileSync("packages/app/src/folder/FolderList.tsx", "utf8");
    expect(folder).toMatch(/const \{ scroller, window \} = useCursorWindow\(/);
    expect(folder).toMatch(/const first = Math\.max\(0, window\.start - index\)/);
    expect(folder).toMatch(/const slice = list\.slice\(first, Math\.max\(0, window\.end - index\)\)/);
    expect(folder).toMatch(/<LetterRows[\s\S]*?rows=\{slice\}/);
    expect(folder).toMatch(/rows\(t\("group\.earlier"\), model\.earlier,/);
    const folderWindow = readListViews(folder, "FolderList.tsx");
    expect(folderWindow.origins).toBe(1);
    expect(folderWindow.gatedOrigins).toBe(0);
    const history = readFileSync("packages/app-logic/src/history/live.ts", "utf8");
    expect(history).toMatch(/const window = useListWindow\(/);
    expect(history).toMatch(/for \(let i = window\.start; i < window\.end; i\+\+\)/);
    const historyList = readFileSync("packages/app/src/history/HistoryList.tsx", "utf8");
    expect(historyList).toMatch(/<LetterRows[\s\S]*?slots: windowed\.slots/);
    const piles = readListViews(readFileSync("packages/app/src/piles/PilesList.tsx", "utf8"), "PilesList.tsx");
    expect(piles.callsWindow).toBe(true);
    expect(piles.maps.map(({ receiver, windowed }) => [receiver, windowed])).toEqual([
      ["model.rows.slice(win.start, win.end)", true],
    ]);
    expect(refusals("PilesList.tsx", piles)).toEqual([]);
    expect(readings.get(TRASH)?.callsWindow).toBe(true);
    expect(readings.get(TRASH)?.maps.map(({ receiver, windowed }) => [receiver, windowed])).toEqual([
      ["page.items.slice(window.start, window.end)", true],
      ["live.items", false],
    ]);
    const screener = readFileSync("packages/app/src/screener/list/Rows.tsx", "utf8");
    expect(screener).toContain("rows.slice(win.start, Math.min(win.end, rows.length))");
    expect(screener).toContain("decided.slice(pendingFrom, Math.max(0, win.end - pendingStart))");
    expect(screener).toMatch(/<SenderRowsWindow[\s\S]*?scroller=\{scroller\}/);
    expect(screener).toContain('data-window-top="" style={{ height: win.padTop }}');
    const stream = readFileSync("packages/app/src/stream/StreamList.tsx", "utf8");
    expect(stream).toMatch(/for \(let w = win\.start; w < win\.end; w\+\+\)/);
    const junk = readFileSync("packages/app/src/screener/list/Junk.tsx", "utf8");
    expect(junk).toContain("kept = junk.visible.slice(0, localCount)");
    expect(junk).toContain("found = junk.visible.slice(localCount)");
    expect(readings.get(JUNK)?.maps.map(({ receiver }) => receiver)).toEqual(["kept", "found"]);
    expect(readings.get(DRAFTS)?.maps.map(({ receiver, windowed }) => [receiver, windowed])).toEqual([
      ["scheduled", true],
      ["drafts", true],
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
