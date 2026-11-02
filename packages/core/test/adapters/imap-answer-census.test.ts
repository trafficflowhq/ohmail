import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { FetchMessageObject } from "imapflow";
import { ANY_UID, askedRow, type AskedItem } from "../../src/adapters/imap.js";

/**
 * ═══ EVERY FETCH ROW IS ASKED WHETHER IT ANSWERS (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS) ═══
 *
 * imapflow's `fetch()` yields every untagged FETCH its command receives, including another
 * session's flag change, and five readers in this file took such a row for the answer: an empty
 * create stood in a letter's place, a stated size read as none, a date as no date, a Message-ID as
 * null. Each reader now passes its rows through `askedRow` — the UID was asked, the row carries what
 * the reader needs — after its own clock, row and byte accounting.
 *
 * The same instrument as `imap-bounds-census.test.ts` (the same AST walk, the same
 * `function|method` key), pointed at one question: a new `this.client.fetch` or `fetchAll` cannot
 * enter `imap.ts` without saying whether its rows are asked. `asked_rows`: every site of the key
 * reaches `askedRow` from the code that consumes its rows (the loop body, the bounded read's `map`,
 * the loop over a `fetchAll`'s rows, or a local function those call), and the items asked across
 * the key's sites are the ledger's. `rows_are_true`: every row the command can receive is true for
 * that reader, and the reason is written down. The mutation case removes `askedRow` from each site
 * in turn, in memory, and the census names that site.
 */

const ADAPTER = resolve(__dirname, "../../src/adapters/imap.ts");

type Answer =
  | { how: "asked_rows"; carries: readonly AskedItem[] }
  | { how: "rows_are_true"; why: string };

const READS: Record<string, Answer> = {
  "enumerateUids|fetch": { how: "asked_rows", carries: ["uid"] },
  "enumerateNewestUids|fetch": { how: "asked_rows", carries: ["uid"] },
  "arrivalDatesFor|fetch": { how: "asked_rows", carries: ["date"] },
  "readArrivals|fetch": { how: "asked_rows", carries: ["date"] },
  "fetchCapped|fetch": { how: "asked_rows", carries: ["size", "uid"] },
  "fetchUnsized|fetch": { how: "asked_rows", carries: ["source"] },
  "fetchSized|fetch": { how: "asked_rows", carries: ["source"] },
  "messageIdsHeld|fetch": { how: "asked_rows", carries: ["headers"] },
  "fetchByUid|fetch": { how: "asked_rows", carries: ["size", "source", "uid"] },
  "moveMany|fetchAll": { how: "asked_rows", carries: ["envelope", "uid"] },
  "messageIdsGone|fetchAll": { how: "asked_rows", carries: ["envelope"] },
  "listFolderPage|fetch": { how: "asked_rows", carries: ["envelope"] },
  "searchFolderPage|fetch": { how: "asked_rows", carries: ["envelope"] },

  "changesSinceInner|fetch": {
    how: "rows_are_true",
    why: "the flag scan asks FLAGS of every message in its range, so another session's flag change is the very statement it reads; a row for an unknown UID is stepped over, and every row counts against IMAP_FLAG_SCAN_MAX_ROWS",
  },
  "enumerateUidsFrom|fetch": {
    how: "rows_are_true",
    why: "a UID-only read of `n:*`: a row naming a UID at or above the floor names a message the folder holds, flag change or not; `uid >= fromUid` drops a row naming none, and the list is taken once per UID",
  },
  "sampleSenders|fetch": {
    how: "rows_are_true",
    why: "a sample of senders: a flag change carries no envelope, so it adds no address and costs one examined row against IMAP_SAMPLE_MAX_ROWS",
  },
  "scanSentRecipients|fetch": {
    how: "rows_are_true",
    why: "a sample of recipients: a flag change carries no envelope, so it adds no address and costs one examined row against IMAP_SAMPLE_MAX_ROWS",
  },
  "oversizeHeads|fetch": {
    how: "rows_are_true",
    why: "a header block is kept only when `wholeHeadBlock` finds one in the row's own bytes and the UID is one the size gate refused (`sizeOf`); a flag change carries no header and is skipped there",
  },
};

interface Site { key: string; line: number; asks: ts.CallExpression[]; carries: string[] }

/** Every `this.client.fetch`/`fetchAll` in the source, with the `askedRow` calls its rows reach. */
function answerSites(text: string): Site[] {
  const sf = ts.createSourceFile(ADAPTER, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];

  const enclosing = (n: ts.Node): ts.MethodDeclaration | ts.FunctionDeclaration | null => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
      if (ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) return c;
    }
    return null;
  };

  /** `const name = (…) => …` and `function name(…)` declared inside the method. */
  const localFunctions = (fn: ts.Node): Map<string, ts.Node> => {
    const out = new Map<string, ts.Node>();
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) out.set(n.name.text, n.initializer);
      if (ts.isFunctionDeclaration(n) && n.name && n !== fn) out.set(n.name.text, n);
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return out;
  };

  /** The `askedRow(…)` calls a node reaches, itself or through the method's own local functions. */
  const askedCalls = (node: ts.Node, locals: Map<string, ts.Node>, seen = new Set<ts.Node>()): ts.CallExpression[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        if (n.expression.text === "askedRow") out.push(n);
        else {
          const local = locals.get(n.expression.text);
          if (local) out.push(...askedCalls(local, locals, seen));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  /** The code that reads the rows of the fetch `call`: a loop body, a bounded read's `map`, or a loop over the rows. */
  const consumers = (call: ts.CallExpression, fn: ts.Node | null): ts.Node[] => {
    let top: ts.Node = call;
    while (ts.isAsExpression(top.parent) || ts.isParenthesizedExpression(top.parent) || ts.isAwaitExpression(top.parent)) {
      top = top.parent;
    }
    const parent = top.parent;
    if (ts.isForOfStatement(parent) && parent.expression === top) return [parent.statement];
    if (ts.isCallExpression(parent) && parent.arguments.includes(top as ts.Expression)) {
      return parent.arguments.flatMap((a) => (ts.isObjectLiteralExpression(a) ? a.properties : []))
        .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === "map")
        .map((p) => p.initializer);
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && fn) {
      const name = parent.name.text;
      const loops: ts.Node[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isForOfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === name) loops.push(n.statement);
        ts.forEachChild(n, visit);
      };
      visit(fn);
      return loops;
    }
    return [];
  };

  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.expression.getText(sf) === "this.client"
      && (n.expression.name.text === "fetch" || n.expression.name.text === "fetchAll")) {
      const fn = enclosing(n);
      const locals = fn ? localFunctions(fn) : new Map<string, ts.Node>();
      const asks = consumers(n, fn).flatMap((c) => askedCalls(c, locals));
      sites.push({
        key: `${fn?.name?.getText(sf) ?? "<module>"}|${n.expression.name.text}`,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        asks,
        carries: asks.map((a) => a.arguments[2]).filter((a): a is ts.StringLiteral => a !== undefined && ts.isStringLiteral(a)).map((a) => a.text),
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return sites;
}

/** What the census refuses: an `asked_rows` site that reaches no `askedRow`. */
function unasked(sites: readonly Site[]): string[] {
  return sites.filter((s) => READS[s.key]?.how === "asked_rows" && s.asks.length === 0).map((s) => `${s.key}:${s.line}`);
}

describe("every FETCH row the adapter reads is asked whether it answers", () => {
  const source = readFileSync(ADAPTER, "utf8");
  const sites = answerSites(source);

  it("the census is not vacuous — it found the reads it audits", () => {
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.map((s) => s.key)).toContain("fetchSized|fetch");
    expect(sites.map((s) => s.key)).toContain("moveMany|fetchAll");
  });

  it("EXACT: every fetch and fetchAll in the adapter is in the ledger, and every ledger row is real", () => {
    const inSource = [...new Set(sites.map((s) => s.key))].sort();
    expect(inSource.filter((k) => !(k in READS)), "a read nobody ruled on").toEqual([]);
    expect(Object.keys(READS).filter((k) => !inSource.includes(k)), "a stale ledger row").toEqual([]);
  });

  it("every site of an asked_rows read reaches askedRow, asking the ledger's items", () => {
    expect(unasked(sites)).toEqual([]);
    for (const [key, answer] of Object.entries(READS)) {
      if (answer.how !== "asked_rows") continue;
      const asked = [...new Set(sites.filter((s) => s.key === key).flatMap((s) => s.carries))].sort();
      expect(asked, key).toEqual([...answer.carries].sort());
    }
  });

  it("a rows_are_true read says why", () => {
    for (const [key, answer] of Object.entries(READS)) {
      if (answer.how === "rows_are_true") expect(answer.why.length, key).toBeGreaterThan(80);
    }
  });

  it("MUTATION: askedRow taken out of any one site turns the census red at that site", () => {
    const asking = sites.filter((s) => READS[s.key]?.how === "asked_rows");
    expect(asking.length).toBeGreaterThan(10);
    for (const site of asking) {
      // Same length, so every line number stands: `askedRow(` becomes a call to nothing the census knows.
      let mutated = source;
      for (const call of site.asks) {
        const at = call.expression.getStart();
        mutated = `${mutated.slice(0, at)}askedRoW${mutated.slice(at + "askedRow".length)}`;
      }
      expect(unasked(answerSites(mutated)), `${site.key}:${site.line}`).toContain(`${site.key}:${site.line}`);
    }
  });
});

describe("askedRow — a row answers when its UID was asked and it carries the item", () => {
  const row = (r: Record<string, unknown>): FetchMessageObject => ({ seq: 1, ...r }) as unknown as FetchMessageObject;
  const flagsOnly = row({ uid: 7, flags: new Set(["\\Seen"]), modseq: 9n });
  const asked = new Set([7]);

  it("another session's flag change carries nothing a reader asks for", () => {
    for (const item of ["source", "headers", "envelope", "size", "date"] as const) {
      expect(askedRow(flagsOnly, asked, item), item).toBe(false);
    }
    // …and it does name an asked UID: existence is all `uid` asks.
    expect(askedRow(flagsOnly, asked, "uid")).toBe(true);
  });

  it("a UID nobody asked, or none at all, answers nothing", () => {
    const full = { source: Buffer.from("x"), size: 1, envelope: {}, internalDate: new Date(0), headers: Buffer.from("x") };
    expect(askedRow(row({ uid: 8, ...full }), asked, "source")).toBe(false);
    expect(askedRow(row({ ...full }), asked, "uid")).toBe(false);
    expect(askedRow(row({ uid: 0, ...full }), new Set([0]), "uid")).toBe(false);
    expect(askedRow(row({ uid: 8, ...full }), ANY_UID, "source")).toBe(true);
  });

  it("source is a non-empty Buffer, headers any Buffer; size is a finite number, 0 included", () => {
    expect(askedRow(row({ uid: 7, source: Buffer.alloc(0) }), asked, "source")).toBe(false);
    expect(askedRow(row({ uid: 7, source: false }), asked, "source")).toBe(false);
    expect(askedRow(row({ uid: 7, source: Buffer.from("\r\n") }), asked, "source")).toBe(true);
    // GreenMail's answer for a header field the letter does not have: an empty literal, still an answer.
    expect(askedRow(row({ uid: 7, headers: Buffer.alloc(0) }), asked, "headers")).toBe(true);
    expect(askedRow(row({ uid: 7, headers: Buffer.from("\r\n") }), asked, "headers")).toBe(true);
    expect(askedRow(row({ uid: 7 }), asked, "headers")).toBe(false);
    expect(askedRow(row({ uid: 7, size: 0 }), asked, "size")).toBe(true);
    expect(askedRow(row({ uid: 7, size: Number.NaN }), asked, "size")).toBe(false);
  });

  it("a date is an INTERNALDATE (even one imapflow could not parse) or an ENVELOPE", () => {
    expect(askedRow(row({ uid: 7, internalDate: new Date(0) }), asked, "date")).toBe(true);
    expect(askedRow(row({ uid: 7, internalDate: "garbage" }), asked, "date")).toBe(true);
    expect(askedRow(row({ uid: 7, envelope: { date: new Date(0) } }), asked, "date")).toBe(true);
    expect(askedRow(row({ uid: 7, envelope: { subject: "s" } }), asked, "envelope")).toBe(true);
  });
});
