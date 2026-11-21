/**
 * ═══ THE COPY CENSUS — THE SCAN ═══════════════════════════════════════════════════════════
 *
 * Finds every user-visible string a component writes ITSELF, rather than reading from
 * `messages/{en,de}.json`. The dispositions live in `./copy-census.ledger.ts`; this file only
 * enumerates, so a lane's exemptions and a scanner fix stop colliding in one file (the shape
 * `one-ui-census` settled on).
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * The German window was shipping a German rail, German filter chips and an ENGLISH decision
 * bar, because `packages/ui` — the one place in this tree that cannot read a catalogue — held
 * "Screen out", "this sender", "whole domain" and "Becomes a rule …" as literals. The same
 * shape, in ten other components: "protected" on every held row, "2 held" beside it,
 * "Reply run", "Answer Later is empty.", the palette's foot, the reader's "to return".
 * Nothing failed, nothing was red, and typecheck cannot see a string.
 *
 * ── WHAT COUNTS, AND WHY THIS AND NOT "EVERY STRING" ───────────────────────────────────────
 *
 * A first cut flagged every prose-looking literal in the scanned roots and answered thousands —
 * import specifiers, `localStorage` keys, media queries and the pre-paint boot script, which is
 * a census that has to be read rather than run. What is scanned instead is a string in a
 * POSITION THAT RENDERS:
 *
 *   `jsx-text`  a JSX text node
 *   `attr:x`    a literal in a JSX attribute that is not on {@link STRUCTURAL_ATTRS}
 *   `child`     a literal inside a JSX expression child (`{n === 1 ? "one" : "many"}`)
 *   `default`   a literal defaulting a destructured prop (`doneLabel = "Done → next"`)
 *   `return`    a literal a function HANDS BACK (`case "failed": return "Stopped.";`)
 *
 * The last three are not decoration. `local-suggest.tsx` said `label={total === 1 ? "Suggest for
 * 1 sender" : …}` and `FocusReplyOverlay` defaulted `doneLabel` and `skipLabel` to English; an
 * attribute-name scan sees neither.
 *
 * ── AND `return` IS HERE BECAUSE ITS ABSENCE WAS MEASURED, NOT BECAUSE IT SEEMED TIDY ───────
 *
 * The first cut looked only at JSX positions, and the ledger said so in as many words: the
 * desktop window's `DesktopSettings.tsx` "carries three more tables inside helper functions
 * (`credentialLine`, `engineWhy`, `engineLine`) that no scan of JSX positions can see". There
 * were four, not three — `doorDescription` as well — and the same shape ran through five more
 * files: `bootSentence`'s six phases, `errorSentence`'s fallback, `afterRequestSentence` and
 * `stateValue`, the gate's OS notification. **A string the scan cannot see is a string the
 * ratchet cannot hold**, so a pane could have been ratcheted to zero with fifty sentences of
 * English still in it.
 *
 * The widening costs 87 findings over 13 files in the scanned roots — measured before it was
 * adopted, and small enough to disposition honestly. Six of those files hold no copy at all:
 * `MessageBody` returns the message frame's whole document and its CSP, `ThemeProvider` returns
 * the pre-paint boot script, `zone-nav` returns CSS selectors. Those are exempted BY NAME in the
 * ledger, with a reason each — the same bargain {@link STRUCTURAL_ATTRS} strikes, where a new
 * non-text case costs a line rather than a silent hole.
 *
 * Arguments to a translator (`t(…)`, `tm(…)`, `COPY.x`) are skipped — a key is not prose, and
 * the value bag beside it is data.
 *
 * ── WHAT IT DOES NOT CLAIM ─────────────────────────────────────────────────────────────────
 *
 * Data flow is not traced. `const NOTE = "…"; <p>{NOTE}</p>` passes: the literal is not in a
 * scanned position and the reference is not a literal. Closing that needs a call graph this file
 * does not build, and the ledger's job is to be read by someone who knows that.
 *
 * Two more boundaries, both measured rather than assumed, both left open deliberately:
 *
 *  · MODULE-SCOPE CONSTANTS are not scanned. `const DOOR = { local: "Your own mail server" }` is
 *    copy and reads exactly like the tables above — but widening to it answers 186 findings over
 *    21 files, and the great majority are `localStorage` names, dotted catalogue keys, CSS
 *    selectors, MIME types and vendor names. A census needing hundreds of exemption rows to say nothing
 *    new is one nobody reads. The desktop window's own constants of that shape were closed by
 *    MOVING them into the render instead, so there is nothing left there for a rule to hold.
 *  · `.ts` FILES are not walked; the walk takes `.tsx`, as it always has. Adding them doubles the
 *    same noise (186 findings over 39 files, dominated by HTTP verbs and URL paths).
 *    `apps/desktop/src/install-role.ts` is the one module of real copy outside this line, and it
 *    is translated and held by `apps/desktop/test/desktop-door-copy.test.ts` instead.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** The interface sources: the shared UI package, the shell and views, and the desktop window, the paired page. */
export const COPY_CENSUS_ROOTS = [
  "packages/ui/src",
  "apps/webapp/app/shell",
  "apps/webapp/app/views",
  "apps/webapp/app/components",
  "packages/letter-body/src",
  "apps/desktop/src",
  "apps/paired-page/src",
];

/**
 * Attributes that carry structure, not words. Everything NOT here is treated as text-bearing,
 * which is the safe direction: a new text attribute is scanned by default, and a new structural
 * one costs a line here rather than a silent hole.
 */
const STRUCTURAL_ATTRS = new Set([
  "className", "id", "key", "ref", "type", "role", "name", "href", "src", "srcSet", "rel",
  "target", "style", "htmlFor", "dir", "lang", "method", "action", "encType", "autoComplete",
  "autoCapitalize", "autoCorrect", "inputMode", "enterKeyHint", "spellCheck", "tabIndex",
  "width", "height", "size", "variant", "tone", "icon", "hue", "face", "layout", "storageKey",
  "dateTime", "value", "defaultValue", "min", "max", "step", "pattern", "accept", "capture",
  "form", "list", "rows", "cols", "maxLength", "minLength", "colSpan", "rowSpan", "scope",
  "as", "is", "media", "sizes", "crossOrigin", "referrerPolicy", "loading", "decoding",
  "fetchPriority", "xmlns", "viewBox", "d", "fill", "stroke", "transform", "points",
  "preserveAspectRatio", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray",
  "fontFamily", "textAnchor", "dominantBaseline", "sandbox", "allow", "srcDoc", "seamless",
  "aria-live", "aria-current", "aria-haspopup", "aria-orientation", "aria-relevant",
  "aria-atomic", "aria-controls", "aria-describedby", "aria-labelledby", "aria-owns",
  "aria-activedescendant", "aria-checked", "aria-selected", "aria-expanded", "aria-hidden",
  "aria-modal", "aria-pressed", "aria-busy", "aria-disabled", "aria-invalid", "aria-required",
  "aria-sort", "aria-level", "aria-setsize", "aria-posinset", "aria-multiselectable",
  "aria-readonly", "aria-colcount", "aria-rowcount", "aria-multiline",
]);

/** A callee whose arguments are keys and values, never prose: the translators and copy tables. */
const TRANSLATOR = /^(t|copy|COPY|fmt)[A-Za-z0-9_]*$/;

/**
 * PROSE, as this scan defines it: at least one run of two letters, and either two letter-runs
 * separated by something (a phrase) or a leading capital (a label). That keeps `"scn-bulk"`,
 * `"status"` and `"ohbox"` out and lets `"Stop"`, `"Suggestions"` and `"whole domain"` in.
 *
 * A LOWERCASE MULTI-WORD STRING IS PROSE, and the first cut of this rule said it was a class
 * list. "whole domain" and "this sender" are the decision bar's own scope toggle — the exact
 * strings this census was written to catch — and they were falling through the class-list
 * heuristic. Class names never needed a heuristic: `className` is on {@link STRUCTURAL_ATTRS},
 * and nothing else puts one in a rendering position.
 */
export function isProse(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3) return false;
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false;
  if (/^[a-z0-9]+([-_.][a-z0-9]+)+$/.test(s)) return false;
  return /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/.test(s) || /^[A-Z][A-Za-z]/.test(s);
}

export interface CopyFinding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walkFiles(p, out);
    } else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

export function scanCopy(repo: string): CopyFinding[] {
  const findings: CopyFinding[] = [];
  for (const root of COPY_CENSUS_ROOTS) {
    const abs = path.join(repo, root);
    if (!fs.existsSync(abs)) {
      throw new Error(`copy census: ${root} is missing — the scan would report zero and pass`);
    }
    for (const file of walkFiles(abs)) {
      const sf = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const rel = path.relative(repo, file);
      const push = (kind: string, node: ts.Node, text: string) => {
        findings.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind,
          text: text.replace(/\s+/g, " ").trim(),
        });
      };

      /** Collect prose literals inside a JSX value, skipping translator calls and nested attrs. */
      const collect = (node: ts.Node, kind: string): void => {
        const inner = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const callee = n.expression;
            const nameOf =
              ts.isIdentifier(callee) ? callee.text
                : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
                  ? callee.expression.text
                  : "";
            if (TRANSLATOR.test(nameOf)) return;
          }
          if (ts.isJsxAttribute(n)) return;      // handled by the attribute pass
          if (ts.isJsxText(n)) return;           // handled by the text pass
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
            if (isProse(n.text)) push(kind, n, n.text);
            return;
          }
          if (ts.isTemplateExpression(n)) {
            const flat = n.head.text + n.templateSpans.map((s) => "{}" + s.literal.text).join("");
            if (isProse(flat)) push(kind, n, flat);
            return;
          }
          ts.forEachChild(n, inner);
        };
        ts.forEachChild(node, inner);
      };

      /**
       * The `return` pass: prose a function hands back, rather than markup it renders.
       *
       * It starts AT the returned expression (unlike {@link collect}, whose node is a container
       * whose CHILDREN are the value) and it stops at the first JSX element it meets — a
       * component's own markup is walked by the three passes below, and descending into it here
       * would report every label twice.
       */
      const collectReturn = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const nameOf =
            ts.isIdentifier(callee) ? callee.text
              : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
                ? callee.expression.text
                : "";
          if (TRANSLATOR.test(nameOf)) return;
        }
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
          return;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (isProse(node.text)) push("return", node, node.text);
          return;
        }
        if (ts.isTemplateExpression(node)) {
          const flat =
            node.head.text + node.templateSpans.map((sp) => "{}" + sp.literal.text).join("");
          if (isProse(flat)) push("return", node, flat);
          return;
        }
        ts.forEachChild(node, collectReturn);
      };

      const visit = (n: ts.Node): void => {
        if (ts.isJsxText(n)) {
          const text = n.text.replace(/\s+/g, " ").trim();
          if (text && /[A-Za-z]{2,}/.test(text)) push("jsx-text", n, text);
        } else if (ts.isJsxAttribute(n)) {
          const name = n.name.getText(sf);
          if (!STRUCTURAL_ATTRS.has(name) && !name.startsWith("data-") && !name.startsWith("on")) {
            const init = n.initializer;
            if (init && ts.isStringLiteral(init)) {
              if (isProse(init.text)) push(`attr:${name}`, init, init.text);
            } else if (init && ts.isJsxExpression(init)) {
              collect(init, `attr:${name}`);
            }
          }
        } else if (ts.isJsxExpression(n) && n.parent && ts.isJsxElement(n.parent)) {
          collect(n, "child");
        } else if (ts.isReturnStatement(n) && n.expression) {
          collectReturn(n.expression);
        } else if (ts.isBindingElement(n) && n.initializer) {
          const d = n.initializer;
          if (
            (ts.isStringLiteral(d) || ts.isNoSubstitutionTemplateLiteral(d)) &&
            isProse(d.text)
          ) {
            push("default", d, d.text);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return findings;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE OTHER HALF: A KEY THE CODE READS THAT THE CATALOGUE HAS NOT GOT.

   The census above catches a word that never reached the catalogue. This catches the inverse —
   a `t("…")` whose key is absent — and it is worth its own scan because THE SUITE DOES NOT FAIL
   ON ONE. `use-intl` reports `MISSING_MESSAGE` through its error channel and renders the dotted
   key; a render test asserting structure passes, and the only trace is stderr. Measured here on
   2026-09-03: a missing `palette.ariaLabel` produced thousands of stderr lines across the webapp suite
   and exit code 0, while the shell drew the raw key as the palette's accessible name.

   ── AND `t("…")` IS NOT THE ONLY WAY A KEY IS NAMED ──

   `liveCopy("<ns>", TABLE)` (`app/shell/locale.ts`) is the route every surface takes that cannot
   call a hook: the reading pane's three components, `format.ts`, the away responder — and the
   whole of the desktop window's chrome, whose 153 keys are named ONLY there. A scan that looked
   for `t("…")` alone could not see one of them, so the namespace this guard exists for would
   have been the one namespace it could not check. Each member name of the table is a key under
   that namespace, and the table is read through its identifier where it is declared as a
   module-scope `const` (which is how every one of them is written).

   ── THE BINDING HAS TO BE SCOPED, AND THE FIRST CUT WAS NOT ──

   One file holds several components and each has its own translator, usually all called `t`:
   `InlineReply.tsx` binds `t` to `reply` at the top and to `compose` and `draftReply` further
   down. A file-wide map resolves them all to whichever came last and reports 36 keys missing
   that are all present. So the binding walks a scope stack, and an identifier resolves to the
   nearest enclosing declaration — the same rule the language uses.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export interface KeyRead {
  file: string;
  line: number;
  /** The dotted key as it resolves against the catalogue root. */
  dotted: string;
}

/**
 * ── A READER CAN ALSO BE HANDED IN ─────────────────────────────────────────────────────────
 *
 * The files below call no `useTranslations`: their caller hands them the reader (a hook in
 * `packages/app-logic` may not import `next-intl`). The binding the scan keys on is then in
 * another file, and every `t("…")` here was outside the census until this table: 77 reads in the
 * first three, measured when they moved, and 37 in the dispatch spine, which moved before them;
 * the Ohbox's key table and walk (26), since its behaviour left the view for `useOhboxList`.
 * Each row names the identifier the file reads through and the namespace its caller binds,
 * and `glue` names where that choice is made, which `handedReaderNamespaces` reads back.
 */
type MountedReader =
  | "junk" | "composer" | "press" | "ohbox" | "cursorKeys" | "cursorHint" | "ohboxWords"
  | "contact" | "verdict" | "stream" | "trash" | "search";

export interface HandedReaders {
  /** Identifier in the file → the namespace of the reader it holds ("" is the catalogue root). */
  readers: Record<string, string | readonly string[]>;
  /** This file passes its reader onward without calling it. */
  forwardsTo?: string;
  /**
   * Where the namespaces are chosen: every reader bound in that file, or every reader handed at each call of that
   * hook. The mounted suggestion record is resolved through its consumer.
   */
  glue:
    | { file: string }
    | { call: string }
    | { calls: readonly string[] }
    | { mountedScreener: "state" | "suggestions" }
    | { mounted: MountedReader };
}

const SCREENER_WORDS = "packages/app/src/screener/words.ts";
const SCREENER_MOUNT = "packages/app/src/mail/ground/ScreenerMount.tsx";

export const HANDED_READERS: Record<string, HandedReaders> = {
  "packages/app-logic/src/screener/screener-state.ts": {
    readers: { t: "screener", ts: "screening", tWhy: "ohbox", tSession: "session" },
    glue: { mountedScreener: "state" },
  },
  "packages/app-logic/src/screener/junk-window.ts": {
    readers: { t: "screener" },
    glue: { mounted: "junk" },
  },
  "packages/app-logic/src/screener/screener-suggest.ts": {
    readers: { t: "screener", tAi: "aiRefusal" },
    glue: { mountedScreener: "suggestions" },
  },
  /* The send machine's words are made from the composer's own reader (`useSendText`), chosen where the composer is called. */
  "packages/app-logic/src/writing/mail-send.ts": {
    readers: { t: "" },
    glue: { mounted: "composer" },
  },
  /* The drafted reply's hook is handed the composer's own reader: the one chosen at each call of the composer. */
  "packages/app-logic/src/writing/draft-reply.ts": {
    readers: { t: "" },
    glue: { mounted: "composer" },
  },
  "packages/app-logic/src/writing/shell-compose.ts": {
    readers: { t: "" },
    glue: { mounted: "composer" },
  },
  /* The rows' words: the badges' hook is handed the `message` reader, the sent label's hook the `ohbox` one. */
  "packages/app-logic/src/text/row-copy.ts": {
    readers: { t: "message", tOhbox: "ohbox" },
    glue: { calls: ["useRowBadgeCopy", "useSentLabel"] },
  },
  "packages/app-logic/src/keys/zone-nav.ts": {
    readers: { t: "shortcuts" },
    glue: { call: "useZoneNav" },
  },
  "packages/app-logic/src/press/shell-dispatch.ts": {
    readers: { t: "" },
    glue: { mounted: "press" },
  },
  "packages/app-logic/src/ohbox/keys.ts": {
    readers: { t: "ohbox" },
    glue: { mounted: "ohbox" },
  },
  "packages/app-logic/src/ohbox/walk.ts": {
    readers: { t: "ohbox" },
    glue: { mounted: "ohbox" },
  },
  "packages/app-logic/src/ohbox/cursor-verbs.ts": {
    readers: { t: "shortcuts" },
    glue: { mounted: "cursorKeys" },
  },
  "packages/app-logic/src/ohbox/live.ts": {
    readers: { "own.cursor": "cursor" },
    forwardsTo: "packages/app-logic/src/keys/keymap.ts",
    glue: { mounted: "cursorHint" },
  },
  // Ohbox and the shared list setup hand the reader to cursorPlacementText.
  "packages/app-logic/src/keys/keymap.ts": {
    readers: { cursor: "cursor" },
    glue: { mounted: "cursorHint" },
  },
  "packages/app-logic/src/ohbox/live-verbs.ts": {
    readers: { words: "" },
    glue: { mounted: "ohboxWords" },
  },
  "packages/app-logic/src/press/contact-screening.ts": {
    readers: { t: "" },
    glue: { mounted: "contact" },
  },
  "packages/app-logic/src/press/press-verdict.ts": {
    readers: { t: "screening" },
    glue: { mounted: "verdict" },
  },
  "packages/app-logic/src/streams/live.ts": {
    readers: { t: ["news", "receipts"] },
    glue: { mounted: "stream" },
  },
  "packages/app-logic/src/trash/live.ts": {
    readers: { t: "shortcuts" },
    glue: { mounted: "trash" },
  },
  "packages/app-logic/src/search/facets.ts": {
    readers: { t: "search" },
    glue: { mounted: "search" },
  },
  "packages/app-logic/src/search/keys.ts": {
    readers: { t: "search" },
    glue: { mounted: "search" },
  },
};

/** `useTranslations()` → "", `useTranslations("ns")` → "ns", a variable namespace → null, anything else → undefined. */
function readerNamespace(e: ts.Expression, hook = "useTranslations"): string | null | undefined {
  e = unwrapped(e);
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== hook) {
    return undefined;
  }
  const arg = e.arguments[0];
  return arg === undefined ? "" : ts.isStringLiteral(arg) ? arg.text : null;
}

function unwrapped(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function sourceFiles(repo: string, roots: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
    }
  };
  for (const root of roots) walk(path.join(repo, root));
  return files;
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

type SourceScope = ts.SourceFile | ts.FunctionDeclaration;

function findOne<T extends ts.Node>(scope: SourceScope, label: string, matches: (n: ts.Node) => n is T): T {
  const found: T[] = [];
  const visit = (n: ts.Node): void => {
    if (matches(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  if (found.length !== 1) throw new Error(`${scope.getSourceFile().fileName}: expected one ${label}, found ${found.length}`);
  return found[0]!;
}

/** Follow the reader records from the mounted frame to the state and suggestion hooks. */
export function mountedScreenerReaderBindings(repo: string) {
  const logic = "packages/app-logic/src/screener";
  const declared = (file: string, name: string) =>
    findOne(parse(path.join(repo, file)), name,
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  const call = (scope: SourceScope, name: string) =>
    findOne(scope, name, (n): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);
  const initializer = (scope: SourceScope, name: string): ts.Expression => {
    const decl = findOne(scope, name, (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name);
    if (!decl.initializer) throw new Error(`${name} has no initializer`);
    return unwrapped(decl.initializer);
  };
  const field = (record: ts.Expression | undefined, name: string): ts.Expression => {
    if (!record || !ts.isObjectLiteralExpression(record) || record.properties.some(ts.isSpreadAssignment)) {
      throw new Error(`expected an explicit reader record for ${name}`);
    }
    const props = record.properties.filter((prop) => prop.name?.getText() === name);
    const prop = props.length === 1 ? props[0] : undefined;
    if (prop && ts.isShorthandPropertyAssignment(prop)) return prop.name;
    if (prop && ts.isPropertyAssignment(prop)) return unwrapped(prop.initializer);
    throw new Error(`expected one reader field named ${name}`);
  };
  const requireSource = (node: ts.Node | undefined, expected: string): void => {
    if (node?.getText() !== expected) throw new Error(`expected reader ${expected}, found ${node?.getText()}`);
  };
  const memoRecord = (expr: ts.Expression): ts.Expression => {
    const fn = ts.isCallExpression(expr) && expr.expression.getText() === "useMemo" ? expr.arguments[0] : undefined;
    if (!fn || !ts.isArrowFunction(fn) || ts.isBlock(fn.body)) throw new Error("expected a memoized reader record");
    return unwrapped(fn.body);
  };
  const namespace = (scope: SourceScope, reader: ts.Expression): string | null => {
    const expr = ts.isIdentifier(reader) ? initializer(scope, reader.text) : reader;
    return readerNamespace(expr, "useText") ?? null;
  };

  const mount = declared(SCREENER_MOUNT, "ScreenerMount");
  const liveInput = call(mount, "useScreenerLive").arguments[0];
  const words = field(liveInput, "text");
  requireSource(ts.isIdentifier(words) ? initializer(mount, words.text) : words, "useScreenerWords()");
  const producer = declared(SCREENER_WORDS, "useScreenerWords");
  const record = memoRecord(call(producer, "useMemo"));

  const live = declared(`${logic}/live.ts`, "useScreenerLive");
  const input = live.parameters[0]?.name;
  for (const name of ["text", "aiRefusal"]) {
    if (!input || !ts.isObjectBindingPattern(input) ||
        !input.elements.some((element) => !element.propertyName && element.name.getText() === name)) {
      throw new Error(`the live hook no longer receives ${name} from its mounted caller`);
    }
  }
  requireSource(field(call(live, "useScreenerModel").arguments[0], "text"), "text");
  const model = declared(`${logic}/model.ts`, "useScreenerModel");
  requireSource(call(model, "useScreenerState").arguments[4], "input.text");
  const stateHook = declared(`${logic}/screener-state.ts`, "useScreenerState");
  requireSource(stateHook.parameters[4]?.name, "text");
  const state = Object.fromEntries(Object.entries({
    t: "screener", ts: "screening", tWhy: "ohbox", tSession: "session",
  }).map(([reader, fieldName]) => {
    requireSource(initializer(stateHook, reader), `text.${fieldName}`);
    return [reader, namespace(producer, field(record, fieldName))];
  }));

  const suggestionsText = field(call(live, "useScreenerSuggestions").arguments[0], "text");
  const suggestionsRecord = memoRecord(ts.isIdentifier(suggestionsText)
    ? initializer(live, suggestionsText.text) : suggestionsText);
  requireSource(field(suggestionsRecord, "screener"), "text.screener");
  requireSource(field(suggestionsRecord, "aiRefusal"), "aiRefusal");
  const suggestHook = declared(`${logic}/screener-suggest.ts`, "useScreenerSuggestions");
  requireSource(initializer(suggestHook, "t"), "opts.text.screener");
  requireSource(initializer(suggestHook, "tAi"), "opts.text.aiRefusal");
  return {
    state,
    suggestions: {
      t: state.t ?? null,
      tAi: namespace(mount, field(liveInput, "aiRefusal")),
    },
  };
}

/** Verify the reader's path through the mounted shell, including each forwarding record. */
function mountedNamespaces(repo: string, mounted: MountedReader): Set<string | null> {
  const printer = ts.createPrinter({ removeComments: true });
  const compact = (source: string) => source.replace(/\s+/g, "");
  const source = (file: string, ...links: string[]) => {
    const code = compact(printer.printFile(parse(path.join(repo, file))));
    for (const link of links) {
      if (!code.includes(compact(link))) throw new Error(`${file}: missing reader link ${link}`);
    }
  };
  const logic = "packages/app-logic/src";
  const app = "packages/app/src";
  if (mounted === "junk") {
    source(`${logic}/screener/live.ts`, "useJunkHere(press, junkWire, text.screener, at,",
      "useJunkWindow(on && at.third, press.undoToast, wire, t, on && at.screener, keep)");
    return new Set([mountedScreenerReaderBindings(repo).state.t ?? null]);
  }
  if (mounted === "composer") {
    source(`${app}/mail/ground/WritingMount.tsx`, "const inputs = useWritingInputs();",
      "useShellCompose(inputs.composer)");
    source(`${app}/mail/ground/writing-inputs.ts`, "const t = useCatalogue();",
      "const composer: ShellComposeInput = { engine, reader, t,",
      "return { composer, engine, scope, replyTo, facts, lists, t };",
      "return useMemo(() => catalogueOver(textOf), [textOf]);",
      "const textOf = useTextLookup();",
      "textOf(key.slice(0, dot))(key.slice(dot + 1), values as never)");
    source(`${logic}/writing/shell-compose.ts`, "useDraftReply({ onDraft, wire: draftReplyWire, t })",
      "useMailSend(engine, scope, toast, useSendText(t, words.scheduleLabel),");
    return new Set([""]);
  }
  if (mounted === "press") {
    source(`${app}/frame/room.tsx`,
      "useShellDispatch({ engine, reader, toast: report, t, placeLabel, demo, refreshFacts, scope })",
      "const t = useMemo(() => pressWords({ ohbox, screener, trash, screening, session, shortcuts })",
      ...["ohbox", "screener", "trash", "screening", "session", "shortcuts"].map(
        (ns) => `const ${ns} = useText("${ns}");`,
      ));
    source(`${logic}/reader/press-words.ts`, "return wordsOver(texts);",
      "const text = dot > 0 ? texts[key.slice(0, dot)] : undefined;",
      "return text ? text(key.slice(dot + 1), values)");
    return new Set([""]);
  }
  if (mounted === "cursorKeys" || mounted === "cursorHint") {
    source(`${app}/ohbox/Seat.tsx`, "const own = useOwn(", "useOhboxLive(args, own)",
      mounted === "cursorKeys" ? 'shortcuts: useText("shortcuts")' : 'cursor: useText("cursor")');
    if (mounted === "cursorKeys") {
      source(`${logic}/ohbox/live.ts`, "cursorRowKeys({ t: own.shortcuts,");
      return new Set(["shortcuts"]);
    }
    source(`${logic}/ohbox/live.ts`, "args.report(cursorPlacementText(own.cursor, label),");
    source(`${app}/place-list/own.ts`, 'const cursor = useText("cursor");',
      "placed: (label: string) => cursorPlacementText(cursor, label)");
    source(`${logic}/keys/keymap.ts`, 'return cursor("placed", { label });');
    return new Set(["cursor"]);
  }
  if (mounted === "ohboxWords") {
    source(`${app}/ohbox/Seat.tsx`, 'const markAll = useText("markAll");',
      "wordsOver({ ohbox: t, screening, session, tag, markAll })", "return { t, words,",
      "const own = useOwn(", "useOhboxLive(args, own)");
    source(`${logic}/ohbox/live.ts`, "useOhboxVerbs({", "words: own.words");
    source(`${logic}/ohbox/live-verbs.ts`, "const { args, mirror, words } = input;");
    return new Set([""]);
  }
  if (mounted === "contact") {
    source(`${app}/reader/contact/Screening.tsx`, "const lookup = useTextLookup();",
      "screenContact({ ...input, dest,", "toast: report, t: (key, values) =>",
      "return lookup(key.slice(0, dot))(key.slice(dot + 1), values);");
    return new Set([""]);
  }
  if (mounted === "verdict") {
    source(`${logic}/screener/screener-state.ts`, "verdictSentence(ts, verdict, sender, piles[d.dest])");
    return new Set([mountedScreenerReaderBindings(repo).state.ts ?? null]);
  }
  if (mounted === "stream") {
    source(`${app}/stream/Seat.tsx`, "const t = useStreamText(place);",
      "const own: StreamLiveOwn = useMemo(() => ({ t, zone, onPageHide: subscribe })",
      "useStreamLive(place, args, own)");
    source(`${app}/stream/words.ts`, 'const news = useText("news");',
      'const receipts = useText("receipts");', 'return place === "news" ? news : receipts;');
    return new Set(["news", "receipts"]);
  }
  if (mounted === "search") {
    source(`${app}/search/Seat.tsx`, 'const t = useText("search");',
      "(): SearchLiveOwn => ({", "useSearchLive(args, useOwn())");
    source(`${logic}/search/live.ts`, "const model = useSearchList({", "t: own.t,");
    source(`${logic}/search/search-list.ts`, "const facets = useFacets({", "useSearchKeys({", "t,");
    return new Set(["search"]);
  }
  if (mounted === "trash") {
    source(`${app}/trash/Seat.tsx`, 'shortcuts: useText("shortcuts")', "useTrashLive(args, useOwn())");
    source(`${logic}/trash/live.ts`, "useKeyBindings(noEraseKeys(own.shortcuts));");
    return new Set(["shortcuts"]);
  }
  source(`${app}/ohbox/Seat.tsx`, 'const t = useText("ohbox");',
    "return { t, words, shortcuts:", "const own = useOwn(", "useOhboxLive(args, own)");
  source(`${logic}/ohbox/live.ts`, "const model = useOhboxList({", "t: own.t,");
  source(`${logic}/ohbox/ohbox-list.ts`, "const t = input.t;",
    "walkSteps({ order, at, t, selectByUser, setLandedOn:", "ohboxKeys({ ...pickSet, ...pickVerbs, ...marks, ...steps, t,");
  return new Set(["ohbox"]);
}

/**
 * The namespaces a row's glue chooses: for `{ file }` every reader bound in that file, for
 * `{ call }` (and each of `{ calls }`) every reader handed at a call of that hook, as an argument (`useZoneNav(
 * useTranslations("shortcuts"), …)`) or as a property of one (`useShellDispatch({ t })`, where
 * `t` is resolved to the nearest binding as the scan does). A variable namespace answers null.
 */
export function handedReaderNamespaces(repo: string, roots: string[], glue: HandedReaders["glue"]): Set<string | null> {
  if ("mounted" in glue) return mountedNamespaces(repo, glue.mounted);
  if ("mountedScreener" in glue) return new Set(Object.values(mountedScreenerReaderBindings(repo)[glue.mountedScreener]));
  const out = new Set<string | null>();
  const files = "file" in glue ? [path.join(repo, glue.file)] : sourceFiles(repo, roots);
  for (const file of files) {
    const sf = parse(file);
    const calls = "call" in glue ? [glue.call] : "calls" in glue ? glue.calls : [];
    const scopes: Map<string, string | null>[] = [new Map()];
    const lookup = (name: string): string | null | undefined => {
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.has(name)) return scopes[i]!.get(name);
      return undefined;
    };
    const isScope = (n: ts.Node): boolean =>
      ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
      || ts.isMethodDeclaration(n) || ts.isBlock(n) || ts.isSourceFile(n);
    const handed = (e: ts.Expression): string | null | undefined => {
      const ns = readerNamespace(e);
      if (ns !== undefined) return ns;
      let inner = e;
      while (ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner)) inner = inner.expression;
      return ts.isIdentifier(inner) ? lookup(inner.text) : undefined;
    };
    const visit = (n: ts.Node): void => {
      const opened = isScope(n);
      if (opened) scopes.push(new Map());
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const ns = readerNamespace(n.initializer);
        if (ns !== undefined) {
          scopes[scopes.length - 1]!.set(n.name.text, ns);
          if ("file" in glue) out.add(ns);
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && calls.includes(n.expression.text)) {
        for (const arg of n.arguments) {
          if (ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              const value = ts.isShorthandPropertyAssignment(prop) ? prop.name
                : ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
              const ns = value === undefined ? undefined : handed(value);
              if (ns !== undefined) out.add(ns);
            }
          } else {
            const ns = handed(arg);
            if (ns !== undefined) out.add(ns);
          }
        }
      }
      ts.forEachChild(n, visit);
      if (opened) scopes.pop();
    };
    visit(sf);
  }
  return out;
}

/** A verb bridge forwards its reader to the shared actions without reading any key itself. */
export function checkForwardedReader(repo: string): void {
  const file = "packages/app-logic/src/place-list/verbs.ts";
  const scope = parse(path.join(repo, file));
  const words = findOne(scope, "forwarded own.words",
    (n): n is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(n) && n.getText() === "own.words");
  const property = words.parent;
  if (!ts.isPropertyAssignment(property) || property.name.getText() !== "t" ||
      !ts.isObjectLiteralExpression(property.parent) || !ts.isCallExpression(property.parent.parent) ||
      property.parent.parent.expression.getText() !== "useListVerbs") {
    throw new Error(`${file}: own.words must be handed directly to useListVerbs`);
  }
}

/**
 * Every file in the roots that takes a `Translator` (the type a handed reader carries), binds
 * no reader of its own and calls anything with a string first (`x("…")`, `x.rich("…")`, and a
 * reader reached through a record, `text.screener("…")`, which the scan cannot read): each must
 * be a row of {@link HANDED_READERS}, or its reads are outside the census. A file that only names
 * the type (`ohbox/types.ts`, the input's declaration) makes no call and holds no read, and a
 * string's own method on another value (`key.indexOf(".")`) is no reader, unless its name is
 * also a catalogue namespace (`text.search("…")` stays a read).
 */
export function filesHandedAReader(repo: string, roots: string[]): string[] {
  const out: string[] = [];
  const namespaces = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, "apps/webapp/messages/en.json"), "utf8")));
  const stringMethod = (name: string): boolean =>
    Object.getOwnPropertyNames(String.prototype).includes(name) && !namespaces.includes(name);
  for (const file of sourceFiles(repo, roots)) {
    const sf = parse(file);
    const takesTranslator = sf.statements.some((st) =>
      ts.isImportDeclaration(st) && st.importClause?.namedBindings !== undefined
      && ts.isNamedImports(st.importClause.namedBindings)
      && st.importClause.namedBindings.elements.some((el) => (el.propertyName ?? el.name).text === "Translator"));
    if (!takesTranslator) continue;
    let binds = false;
    let readShaped = false;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && readerNamespace(n.initializer) !== undefined) binds = true;
      if (
        ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])
        && (ts.isIdentifier(n.expression)
          || ts.isPropertyAccessExpression(n.expression) && !stringMethod(n.expression.name.text))
      ) {
        // This exact call reads tag entities from the engine; its argument is a record type.
        const tagEntities = path.relative(repo, file) === "packages/app-logic/src/place-list/verbs.ts"
          && n.expression.getText(sf) === "engine.read().list"
          && n.typeArguments?.length === 1
          && n.typeArguments[0]?.getText(sf) === "TagDTO"
          && n.arguments.length === 1 && n.arguments[0]?.getText(sf) === '"tag"';
        if (!tagEntities) readShaped = true;
      }
      if (!binds) ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!binds && readShaped) out.push(path.relative(repo, file));
  }
  return out.sort();
}

/** Every `t("…")` in the scanned roots, with the namespace its translator was bound to. */
export function scanKeyReads(repo: string, roots: string[]): KeyRead[] {
  const reads: KeyRead[] = [];
  for (const root of roots) {
    const abs = path.join(repo, root);
    if (!fs.existsSync(abs)) throw new Error(`copy census: ${root} is missing`);
    const files: string[] = [];
    const walkAll = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walkAll(p);
        } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
      }
    };
    walkAll(abs);
    for (const file of files) {
      const sf = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const rel = path.relative(repo, file);
      /* THE `liveCopy` TABLES, first: a module-scope `const X = { … }` whose name is handed to
         `liveCopy("<ns>", X)` contributes `<ns>.<member>` for every member. Collected in one
         pass over the top-level statements rather than through the scope walk below, because a
         copy table is module state by construction — `liveCopy` builds getters once, at import,
         and a table declared inside a function would be rebuilt per call. */
      const tables = new Map<string, string[]>();
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          if (!ts.isObjectLiteralExpression(d.initializer)) continue;
          tables.set(
            d.name.text,
            d.initializer.properties.flatMap((prop) => {
              const name = prop.name;
              if (name === undefined) return [];
              if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return [name.text];
              return [];
            }),
          );
        }
      }
      const liveCopyKeys = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && n.expression.text === "liveCopy"
          && n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[0])
        ) {
          const ns = (n.arguments[0] as ts.StringLiteral).text;
          const table = n.arguments[1]!;
          const members = ts.isIdentifier(table)
            ? tables.get(table.text) ?? []
            : ts.isObjectLiteralExpression(table)
              ? table.properties.flatMap((prop) =>
                  prop.name !== undefined
                  && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                    ? [prop.name.text]
                    : [])
              : [];
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          for (const key of members) reads.push({ file: rel, line, dotted: `${ns}.${key}` });
        }
        ts.forEachChild(n, liveCopyKeys);
      };
      liveCopyKeys(sf);

      /** Innermost first. Each frame maps a translator identifier to its namespace prefix. The
          outermost holds the readers a caller hands this file ({@link HANDED_READERS}). */
      type Prefix = string | readonly string[] | null;
      const scopes: Map<string, Prefix>[] = [new Map(Object.entries(HANDED_READERS[rel]?.readers ?? {}))];
      const lookup = (name: string): Prefix | undefined => {
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (scopes[i]!.has(name)) return scopes[i]!.get(name);
        }
        return undefined;
      };
      const isScope = (n: ts.Node): boolean =>
        ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
        || ts.isMethodDeclaration(n) || ts.isBlock(n) || ts.isSourceFile(n);

      const visit = (n: ts.Node): void => {
        const opened = isScope(n);
        if (opened) scopes.push(new Map());
        if (
          ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
          && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)
          && n.initializer.expression.text === "useTranslations"
        ) {
          const arg = n.initializer.arguments[0];
          /* `null` means the namespace is a VARIABLE (`useTranslations(scope)` — `SendStatus`
             takes the namespace as a prop). Its keys cannot be resolved without knowing the
             caller, and treating the prefix as empty resolved them against the catalogue ROOT,
             which reported three keys missing that are present under two namespaces. Recorded
             as unresolvable and skipped, which is the honest answer and not a silent pass:
             the binding EXISTS, so an inner `t("…")` is not mistaken for a root-level key. */
          const frame = scopes[opened ? scopes.length - 2 : scopes.length - 1]!;
          /* NO ARGUMENT is the ROOT translator (`useTranslations()`), whose keys are already the
             full dotted path — `AppShell` uses it for everything. Binding it to `null` with the
             dynamic case skipped every key in the shell's largest file, and the guard went green
             while `palette.ariaLabel` was missing. That is the exact failure it exists to catch,
             so the two cases are told apart: absent → "", non-literal → null. */
          frame.set(
            n.name.text,
            arg === undefined ? "" : ts.isStringLiteral(arg) ? arg.text : null,
          );
        }
        /* ── `t("…")` IS NOT THE ONLY CALL SHAPE EITHER, AND THIS ONE WAS ALREADY BLIND ──────
         *
         * `t.rich("…")` is a PROPERTY ACCESS call, so the identifier test below could not see it
         * — and it is in use in the scanned roots today (the shell's ribbon, two view hints, the
         * doorbell). Every one of those keys was outside this guard for its whole life, which is
         * exactly the shape it exists to catch: a missing one renders the raw dotted key and the
         * suite stays green.
         *
         * `rich`, `markup` and `raw` are the three members of the translator that take a key.
         * Anything else called off `t` is not a key read, and matching the member by name rather
         * than accepting every property call is what keeps this from collecting `t.length`. */
        const richMembers = new Set(["rich", "markup", "raw"]);
        if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
          const reader = ts.isPropertyAccessExpression(n.expression) && richMembers.has(n.expression.name.text)
            ? n.expression.expression.getText()
            : n.expression.getText();
          const prefix = lookup(reader);
          const key = n.arguments[0].text;
          if (prefix !== undefined && prefix !== null) {
            for (const ns of typeof prefix === "string" ? [prefix] : prefix) reads.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              dotted: ns ? `${ns}.${key}` : key,
            });
          }
        }
        ts.forEachChild(n, visit);
        if (opened) scopes.pop();
      };
      visit(sf);
    }
  }
  return reads;
}
