import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * EVERY WINDOWED LIST STAMPS ITS SLOTS. `useListWindow` measures the items that carry
 * `data-index`; a list that stamps none is priced at ONE measured row height, and rows of mixed
 * height then drift past the reader — the 0.19.2 defect, live above a page of rows in Receipts, News,
 * Folder and Trash until each stamped its rows. This reads every component that calls the window:
 * each `<MessageRow>` in it carries `windowIndex`, sits inside an element carrying `data-index`,
 * or is mapped from a list named below as not windowed; and the component stamps a slot. A row
 * with a slot also states its place in the list (`inSet`, or `aria-setsize` + `aria-posinset` on
 * a list item of its own), or a screen reader counts only the mounted rows.
 */

const VIEWS_DIR = resolve(process.cwd(), "apps/webapp/app/views");

/** Rows rendered whole beside the window in the same component — server pages past the mirror. */
const UNWINDOWED: readonly { file: string; receiver: string }[] = [
  { file: "FolderView.tsx", receiver: "olderRows" },
];

interface Reading {
  callsWindow: boolean;
  stamps: number;
  /** `<MessageRow>` elements with no slot of their own or around them, by line and map receiver. */
  bare: { line: number; receiver: string | null }[];
  /** Rows with a slot that do not state their size and position in the set, by line. */
  unplaced: number[];
}

const SLOT_ATTRS = new Set(["data-index", "windowIndex"]);
/** `index` is the slot prop of the two non-row items a list can put in its index space. */
const SLOT_ITEMS = new Set(["ListGroupLabel", "Waterline"]);

function tagOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function attrsOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  return attrs.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText());
}

/** A string-literal attribute's value (`role="listitem"`), else null. */
function literalAttr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | null {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const a = attrs.properties.filter(ts.isJsxAttribute).find((x) => x.name.getText() === name);
  return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null;
}

const ITEM_ROLES = new Set(["listitem", "option"]);

/** The top-level components of a file: capitalised function declarations and const functions. */
function componentsOf(file: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  for (const st of file.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && /^[A-Z]/.test(st.name.text)) out.push(st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^[A-Z]/.test(d.name.text) && d.initializer) out.push(d.initializer);
      }
    }
  }
  return out;
}

/** The window, called where it is: by a view, or by the Ohbox's behaviour hook its view calls (held below). */
const WINDOW_CALLS = new Set(["useListWindow", "useOhboxList"]);
const OHBOX_LIST = resolve(process.cwd(), "packages/app-logic/src/ohbox/window.ts");

function readComponent(file: ts.SourceFile, root: ts.Node): Reading {
  let callsWindow = false;
  let stamps = 0;
  const bare: Reading["bare"] = [];
  const unplaced: number[] = [];
  const walk = (node: ts.Node, slotted: boolean, receiver: string | null): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WINDOW_CALLS.has(node.expression.text)) {
      callsWindow = true;
    }
    let inSlot = slotted;
    let recv = receiver;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
      recv = node.expression.expression.getText(file);
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = attrsOf(node);
      const tag = tagOf(node);
      const own = attrs.some((a) => SLOT_ATTRS.has(a)) || (SLOT_ITEMS.has(tag) && attrs.includes("index"));
      if (own) stamps += 1;
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (tag === "MessageRow" && !own && !slotted) bare.push({ line, receiver });
      if (tag === "MessageRow" && (own || slotted) && !attrs.includes("inSet")) unplaced.push(line);
      const item = ITEM_ROLES.has(literalAttr(node, "role") ?? "");
      if (tag !== "MessageRow" && own && item && !(attrs.includes("aria-setsize") && attrs.includes("aria-posinset"))) {
        unplaced.push(line);
      }
      if (own) inSlot = true;
    }
    ts.forEachChild(node, (c) => walk(c, inSlot, recv));
  };
  walk(root, false, null);
  return { callsWindow, stamps, bare, unplaced };
}

/** A file's reading: the components that call the window, merged. */
function readView(source: string, name = "View.tsx"): Reading {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const windowed = componentsOf(file).map((c) => readComponent(file, c)).filter((r) => r.callsWindow);
  return {
    callsWindow: windowed.length > 0,
    stamps: windowed.reduce((n, r) => n + r.stamps, 0),
    bare: windowed.flatMap((r) => r.bare),
    unplaced: windowed.flatMap((r) => r.unplaced),
  };
}

function refusals(file: string, r: Reading): string[] {
  if (!r.callsWindow) return [];
  const out: string[] = [];
  if (r.stamps === 0) out.push(`${file}: calls useListWindow and stamps no slot — its rows are priced at one height`);
  for (const b of r.bare) {
    if (UNWINDOWED.some((u) => u.file === file && u.receiver === b.receiver)) continue;
    out.push(`${file}:${b.line}: a <MessageRow> with no windowIndex and no data-index around it${b.receiver ? ` (mapped from ${b.receiver})` : ""}`);
  }
  for (const line of r.unplaced) out.push(`${file}:${line}: a windowed row that does not state its size and position in the list`);
  return out;
}

const viewFiles = readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".tsx")).sort();
const readings = new Map(viewFiles.map((f) => [f, readView(readFileSync(join(VIEWS_DIR, f), "utf8"), f)]));

describe("every windowed list stamps its slots", () => {
  it("the reader refuses a bare row and a stampless window, and admits both stamps", () => {
    const bareRow = readView(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows>{items.slice(win.start, win.end).map((m) => <MessageRow key={m.id} id={m.id} />)}</ListRows>;
      }`);
    expect(refusals("Bare.tsx", bareRow)).toHaveLength(2);
    const stampless = readView(`
      function V({ rules }) {
        const win = useListWindow({ scrollerRef, count: rules.length });
        return <div>{rules.slice(win.start, win.end).map((r) => <div key={r.id} className="rules-item" />)}</div>;
      }`);
    expect(refusals("Stampless.tsx", stampless)).toEqual([
      "Stampless.tsx: calls useListWindow and stamps no slot — its rows are priced at one height",
    ]);
    const stamped = readView(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows>{items.slice(win.start, win.end).map((m, k) => <MessageRow key={m.id} windowIndex={win.start + k} inSet={{ size: items.length, position: win.start + k + 1 }} />)}</ListRows>;
      }`);
    expect(refusals("Stamped.tsx", stamped)).toEqual([]);
    const wrapped = readView(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows>{items.slice(win.start, win.end).map((m, k) => <div key={m.id} data-index={win.start + k}><MessageRow id={m.id} inSet={{ size: items.length, position: win.start + k + 1 }} /></div>)}</ListRows>;
      }`);
    expect(refusals("Wrapped.tsx", wrapped)).toEqual([]);
    const beside = readView(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows>{items.slice(win.start, win.end).map((m, k) => <MessageRow key={m.id} windowIndex={win.start + k} inSet={{ size: items.length, position: win.start + k + 1 }} />)}</ListRows>;
      }
      function Paged({ page }) { return <ListRows>{page.map((m) => <MessageRow key={m.id} />)}</ListRows>; }`);
    expect(refusals("Beside.tsx", beside), "a component with no window of its own is not asked").toEqual([]);
  });

  it("the reader refuses a windowed row that does not say where it stands, and admits both spellings", () => {
    const silentRow = readView(`
      function V({ items }) {
        const win = useListWindow({ scrollerRef, count: items.length });
        return <ListRows>{items.slice(win.start, win.end).map((m, k) => <MessageRow key={m.id} windowIndex={win.start + k} />)}</ListRows>;
      }`);
    expect(refusals("Silent.tsx", silentRow)).toEqual([
      "Silent.tsx:4: a windowed row that does not state its size and position in the list",
    ]);
    const silentItem = readView(`
      function V({ rules }) {
        const win = useListWindow({ scrollerRef, count: rules.length });
        return <div role="list">{rules.slice(win.start, win.end).map((r, k) => <div key={r.id} role="listitem" data-index={win.start + k} aria-setsize={rules.length} />)}</div>;
      }`);
    expect(refusals("SilentItem.tsx", silentItem)).toHaveLength(1);
    const placedItem = readView(`
      function V({ rules }) {
        const win = useListWindow({ scrollerRef, count: rules.length });
        return <div role="list">{rules.slice(win.start, win.end).map((r, k) => <div key={r.id} role="listitem" data-index={win.start + k} aria-setsize={rules.length} aria-posinset={win.start + k + 1} />)}</div>;
      }`);
    expect(refusals("PlacedItem.tsx", placedItem)).toEqual([]);
    const ghost = readView(`
      function V({ n }) {
        const win = useListWindow({ scrollerRef, count: n });
        return <div role="list">{[win.start].map((i) => <div key={i} data-index={i} className="hit-ghost" aria-hidden />)}</div>;
      }`);
    expect(refusals("Ghost.tsx", ghost), "a placeholder slot with no item role is not a row").toEqual([]);
  });

  it("reads the lists it is about", () => {
    expect(readFileSync(OHBOX_LIST, "utf8"), "useOhboxList mounts no window").toMatch(/useListWindow\(\{ scrollerRef: listScrollerRef/);
    for (const f of ["ReceiptsView.tsx", "ReadsView.tsx", "FolderView.tsx", "TrashView.tsx", "RulesView.tsx"]) {
      expect(readings.get(f)?.callsWindow, `${f} calls no useListWindow — the census reads nothing there`).toBe(true);
      expect(readings.get(f)?.stamps ?? 0, `${f} stamps no slot`).toBeGreaterThan(0);
    }
  });

  it("no windowed view renders a row the window cannot measure or place", () => {
    const all = [...readings].flatMap(([f, r]) => refusals(f, r));
    expect(all, all.join("\n")).toEqual([]);
  });

  it("every named unwindowed list still names a bare row in its file", () => {
    const stale = UNWINDOWED.filter((u) => !readings.get(u.file)?.bare.some((b) => b.receiver === u.receiver));
    expect(stale.map((u) => `${u.file}: ${u.receiver}`)).toEqual([]);
  });
});
