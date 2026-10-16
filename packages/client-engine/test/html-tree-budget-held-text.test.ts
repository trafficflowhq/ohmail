/* @reads: apps/mobile/src/mail/frame-budget.ts node_modules/parse5/dist/parser/index.js
   The phone frame's step figures, and the parse5 build whose in-table-text flush the counter takes over
   (the copy this package resolves: its own node_modules first, then each parent's). */
/**
 * NO COUNT STEP DOES MORE THAN ITS WORK SHARE PLUS ONE TOKEN, AND EVERY READING IS treeWithin's. Text placed
 * directly inside a `<table>` is held by parse5 and processed whole inside the tag that ends it; the counter
 * takes that flush over and stops it where a step must. The meter is private, so its work is re-read here from
 * the three places it charges, and the tap is proved to be the meter by summing to the reading's own `work`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Parser, Tokenizer, defaultTreeAdapter, parse, type DefaultTreeAdapterMap, type Token, type TreeAdapter } from "parse5";
import { treeStepper, treeWithin, type TreeReading } from "@ohmail/client-engine/html-tree-budget";
import { FRAME_BUDGET, FRAME_STEP_CHARS, FRAME_STEP_WORK } from "../../../apps/mobile/src/mail/frame-budget.js";

type Patched = { restore: () => void; work: () => number; chars: () => number };

/** Re-reads the meter's charges: adapter reads, attribute-name comparisons, and stack scans at an eighth. */
function tapWork(): Patched {
  let work = 0;
  let scanned = 0;
  let chars = 0;
  const parserProto = Parser.prototype as unknown as { _insertCharacters: (t: Token.CharacterToken) => void };
  const origInsert = parserProto._insertCharacters;
  parserProto._insertCharacters = function (this: unknown, t) {
    chars += t.chars.length;
    return origInsert.call(this, t);
  };
  const proto = Tokenizer.prototype as unknown as {
    write: (chunk: string, last: boolean) => void;
    _createAttr: (ch: string) => void;
  };
  const origWrite = proto.write;
  const origAttr = proto._createAttr;
  const adapter = defaultTreeAdapter as unknown as Record<string, (e: unknown) => unknown>;
  const reads = ["getNamespaceURI", "getTagName", "getAttrList"] as const;
  const origReads = reads.map((k) => adapter[k]);
  const tapped = new WeakSet<object>();
  class TapItems extends Array<unknown> {
    override lastIndexOf(el: unknown, from: number): number {
      const at = super.lastIndexOf(el, from);
      scanned += from - at;
      if (scanned >= 8) {
        work += scanned >>> 3;
        scanned &= 7;
      }
      return at;
    }
  }
  proto.write = function (this: { handler: { openElements: { items: unknown[] } } }, chunk, last) {
    const stack = this.handler.openElements;
    if (!tapped.has(stack)) {
      tapped.add(stack);
      const items = new TapItems();
      for (const x of stack.items) items.push(x);
      stack.items = items;
    }
    return origWrite.call(this, chunk, last);
  };
  proto._createAttr = function (this: { currentToken: Token.TagToken }, ch) {
    work += this.currentToken.attrs.length;
    return origAttr.call(this, ch);
  };
  reads.forEach((k, i) => {
    const orig = origReads[i];
    adapter[k] = (e: unknown) => {
      work += 1;
      return orig(e);
    };
  });
  return {
    work: () => work,
    chars: () => chars,
    restore: () => {
      parserProto._insertCharacters = origInsert;
      proto.write = origWrite;
      proto._createAttr = origAttr;
      reads.forEach((k, i) => {
        adapter[k] = origReads[i];
      });
    },
  };
}

let tap: Patched | null = null;
afterEach(() => {
  tap?.restore();
  tap = null;
});

type Budget = { elements: number; textChars?: number };

function stepped(
  html: string, chars: number, share: number, budget: Budget = FRAME_BUDGET,
): { reading: TreeReading; steps: number; maxDelta: number; maxText: number; sum: number } {
  tap = tapWork();
  const step = treeStepper(html, budget, chars, share);
  let reading: TreeReading | null = null;
  let steps = 0;
  let maxDelta = 0;
  let maxText = 0;
  let before = tap.work();
  let textBefore = tap.chars();
  while (reading === null) {
    reading = step();
    const now = tap.work();
    const text = tap.chars();
    maxDelta = Math.max(maxDelta, now - before);
    maxText = Math.max(maxText, text - textBefore);
    before = now;
    textBefore = text;
    steps += 1;
  }
  const sum = tap.work();
  tap.restore();
  tap = null;
  return { reading, steps, maxDelta, maxText, sum };
}

/** A reading through the stepper alone, untapped. */
function readStepped(html: string, chars: number, share: number, budget: Budget): TreeReading {
  const step = treeStepper(html, budget, chars, share);
  let r: TreeReading | null = null;
  while (r === null) r = step();
  return r;
}

const DEEP = `<b>${"<span>".repeat(240)}<table>`;
/** The verify round's shape: whitespace and letters alternate, so every letter is its own held token. */
const ALTERNATING = `${DEEP}${"a ".repeat(65_500)}</table>`;
/** The same text with nothing open above the table: the work meter barely moves, and the run is still held whole. */
const SHALLOW = `<table>${"a ".repeat(65_500)}</table>`;
/** The same text in the body, where parse5 inserts it as it is read: the control for the text bound. */
const IN_BODY = `<b>${"<span>".repeat(240)}${"a ".repeat(65_500)}`;
/** One unbroken non-whitespace run held whole. */
const UNBROKEN = `${DEEP}${"a".repeat(131_000)}</table>`;

describe("a step over text held inside a <table> stays within its work share", () => {
  it("the tap re-reads the meter: its sum is the reading's own work, and the reading is treeWithin's", () => {
    for (const html of [ALTERNATING, UNBROKEN, SHALLOW, IN_BODY]) {
      const r = stepped(html, FRAME_STEP_CHARS, FRAME_STEP_WORK);
      expect(r.reading).toEqual(treeWithin(html, FRAME_BUDGET));
      expect(r.reading.fits).toBe(true);
      if (r.reading.fits) expect(r.sum).toBe(r.reading.work);
    }
  });

  it("alternating letters under 240 open elements: no step past the share plus one token", () => {
    const r = stepped(ALTERNATING, FRAME_STEP_CHARS, FRAME_STEP_WORK);
    // One held token's cost here is one stack scan of the open elements at an eighth: well under a share.
    expect(r.maxDelta, `max step work ${r.maxDelta} over ${r.steps} steps, share ${FRAME_STEP_WORK}`).toBeLessThanOrEqual(2 * FRAME_STEP_WORK);
  });

  it("control: one unbroken run is one held token, and stays within the share plus one token", () => {
    const r = stepped(UNBROKEN, FRAME_STEP_CHARS, FRAME_STEP_WORK);
    expect(r.maxDelta, `max step work ${r.maxDelta} over ${r.steps} steps, share ${FRAME_STEP_WORK}`).toBeLessThanOrEqual(2 * FRAME_STEP_WORK);
  });

  it("no step inserts more text than its characters per step plus one token, where held text is", () => {
    // Work alone cannot split this: the meter reads 7 units over the whole run.
    const r = stepped(SHALLOW, FRAME_STEP_CHARS, FRAME_STEP_WORK);
    expect(r.maxText, `max step text ${r.maxText} over ${r.steps} steps, ${FRAME_STEP_CHARS} a step`).toBeLessThanOrEqual(2 * FRAME_STEP_CHARS);
  });

  it("control: text in the body is inserted as it is read, within its characters per step", () => {
    const r = stepped(IN_BODY, FRAME_STEP_CHARS, FRAME_STEP_WORK);
    expect(r.maxText).toBeLessThanOrEqual(2 * FRAME_STEP_CHARS);
    expect(r.maxDelta).toBeLessThanOrEqual(2 * FRAME_STEP_WORK);
  });
});

/** Smaller table-text shapes, so a step of one character stays quick. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["deep alternating", `<b>${"<span>".repeat(120)}<table>${"a ".repeat(6_000)}</table>after`],
  ["shallow alternating", `<table>${"a ".repeat(6_000)}</table>`],
  ["under three formatting elements, in a row", `<b><i><u><table><tr>${"x y ".repeat(3_000)}<td>cell</td></tr></table>`],
  ["whitespace only, then a comment", `<b><table>${" \n".repeat(5_000)}<!-- c --><tr><td>t</td></tr></table>`],
  ["held at the end of the input", `<i>${"<span>".repeat(60)}<table>${"q ".repeat(5_000)}`],
  ["ended by a doctype and a caption", `<table>${"m ".repeat(4_000)}<!doctype html><caption>c</caption></table>`],
  ["many small tables", `<b>${"<table>a b c</table>".repeat(600)}`],
];

describe("the reading is treeWithin's at every step size and share", () => {
  const big = { elements: 1_000_000 };
  for (const [name, html] of SHAPES) {
    it(name, () => {
      const once = treeWithin(html, big);
      expect(once.fits, `${name} fits the large budget`).toBe(true);
      for (const chars of [1, 7, 1_024, 16_384]) {
        for (const share of [997, 10_000]) {
          expect(readStepped(html, chars, share, big), `${chars} a step, share ${share}`).toEqual(once);
        }
      }
    });
  }
});

describe("no step does more than its share plus one token's cost", () => {
  /** The largest single step at a share of one unit: one token's cost, plus that unit. */
  it("at shares 997 and 10,000, over every shape", () => {
    const big = { elements: 1_000_000 };
    for (const [name, html] of SHAPES) {
      const token = stepped(html, 16_384, 1, big).maxDelta;
      for (const share of [997, 10_000]) {
        const r = stepped(html, 16_384, share, big);
        expect(r.maxDelta, `${name}: share ${share}, one token ${token}`).toBeLessThanOrEqual(share + token);
      }
    }
  });
});

/** Elements and text outside `<style>` counted over parse5's own, unmodified parse: the spec's answer. */
function vanilla(html: string): { elements: number; textChars: number } {
  let elements = 0;
  let textChars = 0;
  const text = (parent: unknown, chars: string): void => {
    const p = parent as { tagName?: string };
    if (p.tagName !== "style") textChars += chars.length;
  };
  const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createElement(tagName, ns, attrs) {
      elements += 1;
      return defaultTreeAdapter.createElement(tagName, ns, attrs);
    },
    insertText: (p, t) => text(p, t),
    insertTextBefore: (p, t) => text(p, t),
  };
  parse(html, { scriptingEnabled: false, treeAdapter: adapter });
  return { elements, textChars };
}

/** A seeded generator, so a red names a document that can be rebuilt. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "<table>", "<table>", "<table>", "</table>", "<tr>", "<td>", "</td>", "<tbody>", "<caption>", "</caption>",
  "<colgroup>", "<col>", "<th>", "<b>", "<i>", "<a href=x>", "<font>", "<span>", "</b>", "</i>", "<p>", "</p>",
  "<!-- c -->", "<!doctype html>", "<select>", "<option>", "</select>", "<template>", "</template>", "<svg>",
  "</svg>", "<math>", "<pre>\n", "<textarea>", "</textarea>", "<style>s{}</style>", "<script>x</script>",
  "<form>", "<input type=hidden>", "<hr>", "<br>", "</tr>", "</td>", "\u0000",
];

function fuzzDoc(next: () => number): string {
  let html = "";
  const n = 10 + Math.floor(next() * 60);
  for (let i = 0; i < n; i++) {
    const r = next();
    if (r < 0.45) {
      const len = 1 + Math.floor(next() * 40);
      const kind = next();
      html += kind < 0.4 ? "a ".repeat(len) : kind < 0.7 ? " \n\t".repeat(len) : "word".repeat(len);
    } else {
      html += PIECES[Math.floor(next() * PIECES.length)];
    }
  }
  return html;
}

describe("500 documents biased to table text: the stepped reading is treeWithin's, and both are parse5's", () => {
  it("every document, at small and frame-sized steps", () => {
    const next = rng(20261004);
    const big = { elements: 1_000_000 };
    let held = 0;
    for (let d = 0; d < 500; d++) {
      const html = fuzzDoc(next);
      const once = treeWithin(html, big);
      expect(once.fits, `doc ${d} fits`).toBe(true);
      if (once.fits) {
        expect({ elements: once.elements, textChars: once.textChars }, `doc ${d} against parse5`).toEqual(vanilla(html));
      }
      const chars = 1 + Math.floor(next() * 64);
      const share = 1 + Math.floor(next() * 50);
      expect(readStepped(html, chars, share, big), `doc ${d} at ${chars}/${share}`).toEqual(once);
      expect(readStepped(html, 16_384, 10_000, big), `doc ${d} at the frame's step`).toEqual(once);
      if (/<table>[^<]*[a-z]/.test(html)) held += 1;
    }
    expect(held, "the corpus holds table text").toBeGreaterThan(150);
  });
});

/**
 * THE FLUSH IS parse5 7.3.0's, TAKEN OVER BY NAME. The counter reimplements `tokenInTableText` and intercepts
 * the five places it is called; a parse5 that moves either reads differently here before a reading drifts.
 */
describe("parse5's in-table-text internals are the ones the counter takes over", () => {
  // The parse5 this package resolves, the one the counter imports: its own node_modules entry where it
  // has one, else the nearest parent's (npm hoists it to the workspace root).
  const dir = (() => {
    for (let d = join(dirname(fileURLToPath(import.meta.url)), ".."); ; d = dirname(d)) {
      const p = join(d, "node_modules", "parse5");
      if (existsSync(join(p, "package.json"))) return p;
      if (dirname(d) === d) throw new Error("no parse5 resolvable from packages/client-engine");
    }
  })();
  const pkgPath = join(dir, "package.json");
  const PARSER = join(dir, "dist", "parser", "index.js");
  const src = readFileSync(PARSER, "utf8");
  const body = (name: string): string => {
    const start = src.indexOf(`function ${name}(p, token) {`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n}\n", start) + 2).replace(/\s+/g, " ");
  };

  it("parse5 is 7.3.0", () => {
    expect((JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version).toBe("7.3.0");
  });

  it("the two insertion modes the counter names have the numbers it uses", () => {
    expect(src).toContain('InsertionMode[InsertionMode["IN_BODY"] = 6] = "IN_BODY";');
    expect(src).toContain('InsertionMode[InsertionMode["IN_TABLE_TEXT"] = 9] = "IN_TABLE_TEXT";');
  });

  it("the flush and the per-token rule are the ones reimplemented", () => {
    expect(body("tokenInTableText")).toBe(
      "function tokenInTableText(p, token) { let i = 0; if (p.hasNonWhitespacePendingCharacterToken) { for (; i < p.pendingCharacterTokens.length; i++) { tokenInTable(p, p.pendingCharacterTokens[i]); } } else { for (; i < p.pendingCharacterTokens.length; i++) { p._insertCharacters(p.pendingCharacterTokens[i]); } } p.insertionMode = p.originalInsertionMode; p._processToken(token); }",
    );
    expect(body("tokenInTable")).toBe(
      "function tokenInTable(p, token) { const savedFosterParentingState = p.fosterParentingEnabled; p.fosterParentingEnabled = true; // Process token in `In Body` mode modeInBody(p, token); p.fosterParentingEnabled = savedFosterParentingState; }",
    );
  });

  it("the flush is called from exactly the five methods the counter overrides", () => {
    const callers: string[] = [];
    let at = src.indexOf("tokenInTableText(this, token)");
    while (at !== -1) {
      const names = [...src.slice(0, at).matchAll(/\n {4}(\w+)\(token\) \{/g)];
      callers.push(names.length > 0 ? names[names.length - 1][1] : "?");
      at = src.indexOf("tokenInTableText(this, token)", at + 1);
    }
    expect(callers.sort()).toEqual(["_endTagOutsideForeignContent", "_startTagOutsideForeignContent", "onComment", "onDoctype", "onEof"]);
  });
});
