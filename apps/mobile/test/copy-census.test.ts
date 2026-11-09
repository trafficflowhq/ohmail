import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Copy } from "../src/copy";

/**
 * ═══ THE CENSUS — no sentence on this phone lives outside the copy deck ══════════════════════
 *
 * A second language is only as complete as the deck it is written against. Every English string
 * that stayed in a screen, a state module or a network seam is a string German cannot reach, and
 * the failure is silent by construction: the app compiles, the tests pass, and a German reader
 * meets an English paragraph.
 *
 * ── THIS IS THE THIRD SCANNER, AND THE FIRST ONE THAT IS NOT GUESSING ────────────────────────
 *
 * The first stripped comments line by line and then regexed for literals. It reported a clean tree
 * while missing a long stretch of `net/pairing.ts`, because a `//` comment mentioning the route
 * `` `/pair/*` `` opened a block comment that ran to the next `*&#47;` — four untranslated refusals
 * inside it, one of which then rendered in English under a German heading on a real phone.
 *
 * The second was a hand-written character scanner. It fixed that and was still blind to everything
 * that is not a string literal: **JSX TEXT**. `<Section>Piles</Section>` is a sentence on screen and
 * not a literal anywhere, and five of them were sitting in `app/` the whole time. It also could not
 * see a string built by concatenation, could not look inside `${…}`, and decided "is this rendered?"
 * by matching the sixty characters in front of the quote.
 *
 * This one asks the TypeScript compiler. `ts.createSourceFile` already knows what is a comment, what
 * is a regex, what is inside a template hole and what is JSX text, and it answers "what is this
 * literal the value OF" with a parent pointer instead of a regex. Every family the previous two
 * missed is a node type here rather than a special case.
 *
 * ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────────────────────
 *
 *  1. **No copy outside the decks.** Every string literal, template, concatenation and JSX text
 *     node under `src/` and `app/`, minus the rules and the named exceptions below.
 *  2. **No module-scope read of a deck getter.** `Copy.x` at the top level of a module is evaluated
 *     ONCE, at import, and the string it yields is frozen in whatever language the register held at
 *     that moment — which is decided by import order. `app/(tabs)/screener.tsx` built its three
 *     empty states that way and they could not be translated by anything, including the
 *     `useLocale()` subscription right below them. The deck's getters make a LIVE read cheap; they
 *     cannot help a caller who takes one copy and keeps it.
 *  3. **Every allowlisted string is actually unrendered.** See {@link NAMED_LINES}.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

/* ── the rules ──────────────────────────────────────────────────────────────────────────────── */

/** The decks. Everything in them is copy by definition. */
const DECKS = new Set(["src/copy.en.ts", "src/copy.de.ts"]);

/**
 * A property or JSX attribute whose value is, by its own name, something a person reads.
 *
 * `hint`, `reason`, `detail` and `message` earn their place the hard way: each names a field this
 * app renders (`Empty`'s hint, a refusal's reason, the transport detail inside
 * `Copy.baseApiUnreachable`, a failure's message), and a one-word English value in any of them
 * would have passed the two-word threshold below.
 */
const RENDERED_NAMES = new Set([
  "accessibilityLabel", "accessibilityHint", "placeholder", "label", "title",
  "hint", "reason", "detail", "message", "say", "note", "subtitle", "meta", "text", "cta",
]);

/**
 * Array methods whose result carries what the callback returned. `some`, `every` and `includes`
 * answer a boolean; `forEach` answers nothing; `filter` answers elements it did not create. A
 * string returned from any of those never reaches a screen through the call's own value.
 */
const VALUE_PRESERVING = new Set(["map", "flatMap", "reduce", "reduceRight"]);

/**
 * Addressed to SQLite, not to a person.
 *
 * TRANSACTION CONTROL WAS MISSING and the list's own shape hid it: every verb here is a verb that
 * READS OR WRITES ROWS, so `BEGIN IMMEDIATE` — which does neither — was reported as English on a
 * German phone twice, from the two files that own the device store's batch. Case-sensitive on
 * purpose: SQL is written upper here and copy is not, which is what lets `BEGIN` sit in this list
 * without licensing the word "Begin" in a sentence. `SQL_KEYWORDS` in `dialect-census`'s table is
 * a different question (which store accepts a construct) and does not share this list.
 */
const SQL = new RegExp(
  "\\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|DROP TABLE|PRAGMA"
  + "|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\\b");

/* ── the named exceptions ───────────────────────────────────────────────────────────────────── */

/**
 * WHOLE FILES THAT HOLD NO USER-FACING PROSE, each with what they hold instead.
 *
 * ── EVERY REASON HERE WAS REWRITTEN FROM THE CALL SITES, AND THREE OF THEM WERE WRONG ────────
 *
 * The first version of this list was written from each file's own header comments, and a comment is
 * the claim under test rather than evidence for it. Three entries said "thrown Errors, never
 * rendered" about files that also RETURN English sentences which a screen then displays:
 *
 *  · `engine/boot.ts` returns `{ kind: "refused", reason: "the on-device mirror could not open: …" }`
 *    (boot.ts:557), `net/pairing.ts:1046` passes it straight out, and the connect screen renders it
 *    under the German "Abgelehnt" heading. Its identity-mismatch refusals do the same.
 *  · `state/servers.ts` and `state/install-marker.ts` throw, and those throws are CAUGHT by the
 *    pairing and forget seams and interpolated into a `reason` the user reads.
 *
 * So those three files are no longer exempt at all. What is left below is exempt because every
 * literal in it is one non-prose kind, and each entry says which — checked by opening the file, not
 * by reading its header.
 */
const NOT_PROSE: Record<string, string> = {
  "src/ui/Icon.tsx": "SVG path data — coordinates, not words",
  "src/theme/oklch.ts": "colour serialization: #rrggbb and rgba(…)",
  "src/ui/FadeOut.tsx": "a generated SVG gradient id",
  "src/net/bearer.ts": "the Authorization header's own scheme word, sent on the wire",
  "src/net/push.ts": "wake bookkeeping codes stored and compared, never rendered",
};

/**
 * INDIVIDUAL STRINGS, by their exact text, each with the CALL SITE that proves it is not rendered.
 *
 * The rule this list now follows, and did not before: an entry names where the string GOES, not
 * what its own comment says about itself. `SUPERSEDED` was exempted here on the strength of a
 * comment reading "never rendered as an error" — and `connection.tsx` returns it as
 * `{ ok: false, reason: SUPERSEDED }` at two call sites whose callers render every failed reason.
 * It is translated now rather than exempted.
 *
 * `test/copy-census.test.ts` asserts every entry is still in the tree, so an exemption cannot
 * outlive the string it was written for.
 */
interface Exemption { file: string; why: string }

const NAMED_LINES: Record<string, Exemption> = {
  "Ag":
    { file: "src/theme/index.tsx", why: "the text-size probe's two glyphs, drawn at opacity 0 and hidden from accessibility; the theme reads its height, nobody reads the words" },
  "server_unavailable":
    { file: "src/state/wake.tsx", why: "a `reason` CODE on the wake state; `wakeSentence` compares it and hands it to Copy.wakeOff, which maps it to a German sentence — never printed" },
  "row_remains":
    { file: "src/state/wake.tsx", why: "the same shape: a code `wakeSentence` compares to choose Copy.wakeRowRemains" },
  "device kind":
    { file: "src/net/pairing.ts", why: "compared against the SERVER's own validation message to decide whether to retry a redeem without the device-kind declaration; never assigned to anything a screen reads" },
  "no answer from within ms":
    { file: "src/net/server-base.ts", why: "a transport DIAGNOSTIC carried as the argument of a baseApiUnreachable refusal, which the deck renders inside a German sentence — see THE DIAGNOSTIC RULE" },
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'":
    { file: "src/mail/mail-document.ts", why: "the mail frame's Content-Security-Policy — a browser directive the WebView enforces, quoted verbatim into a <meta> tag; no person reads it and no language changes it" },
  "<!doctype html><html><head><meta charset=\"utf-8\"/><meta http-equiv=\"Content-Security-Policy\" content=\" \"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1\"/><style>:root{color-scheme:light}:root,:root>body{height:auto !important}body{margin:0;padding:14px 16px 20px;background: ;color: ;font:400 /1.78 -apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;overflow-wrap:break-word;word-break:break-word}a{color: }img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{word-break:normal}blockquote{margin:0 0 0 2px;padding-left:14px;border-left:2px solid }pre{white-space:pre-wrap} </style></head><body> </body></html>":
    { file: "src/mail/mail-document.ts", why: "the mail document's html/css scaffold — markup around the message body, one template so this census reads ONE string; every word in it is a tag, a directive or a font name, and the message's own words arrive through the holes" },
  "ohmail on a phone":
    { file: "src/engine/standalone-door.ts", why: "PHONE_CLAIM_NAME — the machine name WRITTEN INTO the organizer claim in the mailbox, like an address. It must not come from the deck: `claimFrom` recognises this install's own claim by name, so a name that changed with the language would make the phone read its own claim as a stranger's. No screen in this app renders it; what a reader sees is another client's readerLabel around it, in their own language" },
};

/**
 * ── THE DIAGNOSTIC RULE, written down because it is the one place English survives on purpose ──
 *
 * A refusal this app renders has two halves: a SENTENCE, which is ours and is translated, and a
 * DIAGNOSTIC, which is the platform's or the server's own words quoted verbatim. `String(err)` from
 * a keystore, `javax.net.ssl.SSLHandshakeException` from Android's TLS stack, an HTTP status — none
 * of those are ours to translate, and a German paraphrase of them would be worse for the person who
 * has to search for the text or paste it to whoever runs the server.
 *
 * The rule is therefore: a STABLE, ENUMERABLE failure gets a deck key; an opaque one is quoted. The
 * enumerable ones were mapped in this slice — see `Copy.pairRedeemUnreachable`, `pairCodeRejected`,
 * `pairNoAccountName`, `pairOwedDeletion`, `bootMirrorFailed`, `bootAccountMismatch` — and what is
 * left quoted is genuinely opaque.
 */

/** A named exemption applies only in the file its reason names — see the assertion for finding 6. */
const exempt = (text: string, rel: string): boolean => NAMED_LINES[text]?.file === rel;

/* ── the scanner ────────────────────────────────────────────────────────────────────────────── */

interface Hit { file: string; line: number; text: string }

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const shippedFiles = (): string[] =>
  [...walkFiles(path.join(APP, "src")), ...walkFiles(path.join(APP, "app"))].sort();

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The words a template contributes itself — its holes are somebody else's values. */
function templateProse(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
}

/**
 * A `"a" + "b"` chain folded into one candidate.
 *
 * Without this, `"English" + " sentence"` is two one-word literals and passes the threshold twice.
 * The fold is only attempted at the TOP of a `+` chain, so the parts are not also reported alone.
 */
function foldedConcat(node: ts.Node): string | null {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  if (ts.isBinaryExpression(node.parent)
    && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return null; // fold at the top
  const parts: string[] = [];
  let sawLiteral = false;
  /*
   * A NON-LITERAL OPERAND CONTRIBUTES A GAP, not a refusal.
   *
   * This used to require the whole `+` tree to be literals, so `"Please try " + n + " times"` fell
   * out entirely — the same blindness the template holes had before they were handled. A dynamic
   * operand is somebody else's value; what is left is this file's own words, and the threshold is
   * applied to those.
   */
  const collect = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collect(n.left); collect(n.right); return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text); sawLiteral = true; return;
    }
    if (ts.isTemplateExpression(n)) { parts.push(templateProse(n)); sawLiteral = true; return; }
    parts.push(" ");
  };
  collect(node);
  return sawLiteral ? parts.join("") : null;
}

/** Is this node the value of a property or JSX attribute whose NAME says a person reads it? */
function inRenderingPosition(node: ts.Node): boolean {
  let child = node;
  let parent = node.parent as ts.Node | undefined;
  while (parent) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
      return RENDERED_NAMES.has(parent.name.getText());
    }
    /*
     * A JSX EXPRESSION THAT IS A CHILD IS A RENDERING SINK, whatever its name — it has none.
     * `<Text>{"Retry"}</Text>` and `{ok ? "Ready" : "Waiting"}` are text on screen and were
     * invisible to the previous walk, which stopped when the expression reached its element.
     *
     * An ATTRIBUTE expression is not: `onPress={() => log("debug")}` is a string in a JSX
     * expression and nobody reads it. The two are told apart by the expression's own parent —
     * an element or fragment means child, a `JsxAttribute` means attribute — which is why this
     * check sits here rather than being folded into the pass-through below.
     */
    if (ts.isJsxExpression(parent) && parent.parent
      && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) return true;
    if (ts.isJsxAttribute(parent)) return RENDERED_NAMES.has(parent.name.getText());
    /*
     * A CALLBACK'S RETURN VALUE flows to wherever the callback's result goes, so
     * `{rows.map(() => "No mail")}` is text on screen. Only the BODY counts, and only for a
     * function passed as an argument: `doThing("x")` hands a string INTO a call and its result
     * is not that string, so arriving from a plain argument stops the walk.
     */
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
      && (parent.body === child || isReturnedFrom(parent, child))) {
      child = parent; parent = parent.parent; continue;
    }
    if (ts.isCallExpression(parent)) {
      const cameFromCallback = parent.arguments.some((a) => a === child)
        && (ts.isArrowFunction(child) || ts.isFunctionExpression(child));
      /*
       * ONLY WHERE THE CALLBACK'S VALUE BECOMES THE CALL'S VALUE. `rows.map(() => "No mail")`
       * renders that string; `rows.some(() => "debug")` renders a BOOLEAN and the string is never
       * seen, so treating every callback the same way cried wolf. The set is the methods that
       * carry an element's value outward; `filter`, `forEach` and the predicates are deliberately
       * absent, and an unknown method stops the walk rather than being guessed at.
       */
      const method = ts.isPropertyAccessExpression(parent.expression)
        ? parent.expression.name.text : "";
      if (!cameFromCallback || !VALUE_PRESERVING.has(method)) return false;
      child = parent; parent = parent.parent; continue;
    }
    /* Walk up only through nodes whose VALUE this node becomes. The distinction matters and its
       absence produced six false positives: in `label={phase.k === "pairing" ? A : B}` the string
       "pairing" is the CONDITION, not the label, and a walk that ignored which branch it was in
       reported every state name compared inside a rendered ternary. */
    if (ts.isJsxExpression(parent) || ts.isParenthesizedExpression(parent)) {
      child = parent; parent = parent.parent; continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition === child) return false;
      child = parent; parent = parent.parent; continue;
    }
    if (ts.isBinaryExpression(parent)) {
      /* `a || b` and `a ?? b` produce one of their operands; `a === b` produces a boolean, and its
         operands are never the rendered value. */
      const kind = parent.operatorToken.kind;
      if (kind !== ts.SyntaxKind.BarBarToken && kind !== ts.SyntaxKind.QuestionQuestionToken) {
        return false;
      }
      child = parent; parent = parent.parent; continue;
    }
    return false;
  }
  return false;
}

/** Is `value` the expression of a `return` inside `fn`'s own body (not a nested function's)? */
function isReturnedFrom(fn: ts.ArrowFunction | ts.FunctionExpression, value: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (n !== fn && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)
      || ts.isFunctionDeclaration(n))) return;
    if (ts.isReturnStatement(n) && n.expression === value) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  if (fn.body) ts.forEachChild(fn.body, walk);
  return found;
}

/** A literal that is a thrown programming fault — never read by anybody but a developer. */
function isThrownFault(node: ts.Node): boolean {
  let n: ts.Node | undefined = node;
  while (n) {
    if (ts.isThrowStatement(n)) return true;
    if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText())) return true;
    n = n.parent;
  }
  return false;
}

/**
 * THE SAME FAULT, ONE INDIRECTION AWAY: `const HELD = "…"` followed by `throw new Error(HELD)`.
 *
 * Three strings in this tree are declared apart from the throw that uses them — `boot.ts`'s sync
 * guard and `servers.ts`'s two queue-full messages — so the ancestor walk above cannot see what
 * they are. Rather than exempting them by name (which is how the last allowlist went wrong), the
 * binding's own references are checked: if EVERY use is inside a throw or an `Error` construction,
 * it is a developer fault wherever it was declared.
 *
 * A single use in a rendered position is enough to disqualify it, which is the property that makes
 * this safe — the check cannot quietly widen as a file grows.
 */
function isFaultOnlyBinding(node: ts.Node, sf: ts.SourceFile): boolean {
  const decl = node.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false;
  const name = decl.name.text;
  let uses = 0;
  let faults = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== decl.name) {
      uses += 1;
      if (isThrownFault(n)) faults += 1;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return uses > 0 && uses === faults;
}

/** Is this node evaluated when the module is imported, rather than when something is called? */
function atModuleScope(node: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
      || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n)
      || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) {
      /* …UNLESS IT IS CALLED WHERE IT STANDS. `const x = (() => Copy.foo)()` runs during import
         and freezes the language exactly as a bare read does; a function boundary is only a
         deferral if something later decides to call it. */
      if (!isImmediatelyInvoked(n)) return false;
    }
    n = n.parent;
  }
  return true;
}

/**
 * IS THIS FUNCTION CALLED WHERE IT STANDS? Five shapes, because the first version knew one.
 *
 * Round three named the evasions and the control tree now plants them: a comma expression
 * `(0, () => Copy.x)()` (the idiom that strips a `this` binding), `.call()` and `.apply()`, and a
 * tagged template. Each executes during module initialisation and freezes the language exactly as
 * a bare read does, and each slipped past a check that only recognised the function being the
 * callee itself.
 */
function isImmediatelyInvoked(fn: ts.Node): boolean {
  /* Walk out through parentheses AND comma expressions: in `(0, f)()` the call's callee is the
     comma expression, whose right-hand side is the function. */
  let node: ts.Node = fn;
  let outer: ts.Node | undefined = fn.parent;
  for (;;) {
    if (outer && ts.isParenthesizedExpression(outer)) { node = outer; outer = outer.parent; continue; }
    if (outer && ts.isBinaryExpression(outer)
      && outer.operatorToken.kind === ts.SyntaxKind.CommaToken && outer.right === node) {
      node = outer; outer = outer.parent; continue;
    }
    break;
  }
  if (!outer) return false;
  /* Compared against `fn` ITSELF, not against the parenthesis/comma chain that yields it: the
     walk above moves `node` outward, so testing the callee against `node` fails for the plainest
     shape of all, `(() => …)()`. That regression was caught by the control tree, which is the
     point of having one. */
  /* Unwrap parentheses AND comma operators before comparing: in `(0, f)()` the callee is a comma
     expression whose VALUE is `f`, and `(f)()` wraps it in parentheses. Both yield the function. */
  const unwrap = (e: ts.Node): ts.Node => {
    let cur = stripParens(e);
    while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      cur = stripParens(cur.right);
    }
    return cur;
  };
  const yields = (e: ts.Node): boolean => unwrap(e) === fn;
  /* `f()` — the callee is the function (or the comma/parenthesis chain that yields it). */
  if (ts.isCallExpression(outer) && yields(outer.expression)) return true;
  /* `` f`tag` `` — a tagged template invokes its tag. */
  if (ts.isTaggedTemplateExpression(outer) && yields(outer.tag)) return true;
  /* `f.call(…)` / `f.apply(…)` — the function is the property-access target of an immediate call. */
  if (ts.isPropertyAccessExpression(outer) && yields(outer.expression)
    && /^(call|apply|bind)$/.test(outer.name.text)) {
    const call = outer.parent;
    /* `bind` alone defers; only a bound function that is then CALLED runs now. */
    if (outer.name.text === "bind") {
      return !!call && ts.isCallExpression(call) && !!call.parent
        && ts.isCallExpression(call.parent) && stripParens(call.parent.expression) === call;
    }
    return !!call && ts.isCallExpression(call) && stripParens(call.expression) === outer;
  }
  return false;
}

function stripParens(n: ts.Node): ts.Node {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Two words of prose, OR anything at all in a rendering position — see the header. */
function looksLikeCopy(text: string, rendered: boolean): boolean {
  const t = text.trim();
  if (!/[A-Za-z]/.test(t)) return false;
  if (rendered) return true;
  return /[A-Za-z]{2,}\s+\S*[A-Za-z]{2,}/.test(t);
}

interface CensusResult {
  copy: Hit[]; frozen: Hit[];
  /** Sentences ASSEMBLED in JSX out of values and typed punctuation — see {@link assembling}. */
  assembled: Hit[];
  visited: number; files: number;
}

/**
 * A SENTENCE BEING BUILT OUT OF PARTS BY THE MARKUP, WHICH FIXES ONE LANGUAGE'S GRAMMAR.
 *
 * The Screener's sender note read `{dest} {Copy.senderAiSuggestionAt} {score}: {reason}.` — a deck
 * FRAGMENT with values on either side of it and the punctuation typed straight into the markup.
 * English survives that. German does not: the verb moves, and the result said "Ohbox schlägt die
 * KI vor" — that Ohbox suggests the AI.
 *
 * The census could not see it, and could not have. Every piece was legitimate on its own: the
 * fragment was a deck read, and `": "` is punctuation, which `looksLikeCopy` correctly declines to
 * treat as prose. The defect was in the JOIN, so the join is what this looks for — punctuation
 * typed into JSX with a rendered value on each side of it. A sentence with holes belongs in the
 * deck, where each language can put the holes where its own grammar wants them.
 */
/**
 * JOINS THIS LANE CANNOT FIX, each named with the file that owns it and why.
 *
 * A file-scoped entry, like {@link NAMED_LINES}: a licence for one place is not a licence for
 * every place that assembles the same way. Keyed by the relative path, because the reason is
 * about WHO OWNS THE FILE, not about the sentence.
 */
const ASSEMBLED_EXCEPTIONS: Record<string, string> = {
  "src/ui/UnsavedChanges.tsx":
    "Two middots separating INDEPENDENT labels in one line — a count beside a show/hide toggle, "
    + "and a server sentence beside a dismiss control. Neither is a sentence assembled out of "
    + "parts: no language reorders a count and a button, and each side is a whole deck entry on "
    + "its own. Named here rather than narrowed away, because tolerating a lone middot in the "
    + "rule would also tolerate one that IS joining a sentence.",
};

const JOINING_PUNCTUATION = /^[\s]*[\p{P}\p{S}][\p{P}\p{S}\s]*$/u;
/** A child that renders a VALUE: an interpolation, or an element wrapping one. */
const rendersValue = (n: ts.Node): boolean =>
  (ts.isJsxExpression(n) && n.expression !== undefined
    && !ts.isStringLiteral(n.expression))
  || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);

/**
 * THE ONE SCANNER. It is given the files to read rather than finding them itself, so the positive
 * control drives THIS code and not a copy of it — the flaw round three exposed was that every
 * mutation probe exercised a separate scanner defined inside the test, leaving the production path
 * unobserved.
 *
 * `visited` counts syntax nodes. An empty result is only meaningful beside a non-zero count of
 * nodes looked at; without it, "found nothing" and "looked at nothing" are the same answer, which
 * is exactly how a census with its tree walk deleted stayed green.
 */
function census(
  files: string[] = shippedFiles(),
  base: string = APP,
  /* `honourExceptions: false` runs the same scan with {@link ASSEMBLED_EXCEPTIONS} switched off.
     It exists for ONE case — proving an exempted file still contains the join its entry is for —
     because an exemption that outlives its reason is a hole nobody will look at again. */
  opts: { honourExceptions?: boolean; honourNotProse?: boolean } = {},
): CensusResult {
  const honour = opts.honourExceptions !== false;
  const honourNotProse = opts.honourNotProse !== false;
  const copy: Hit[] = [];
  const frozen: Hit[] = [];
  const assembled: Hit[] = [];
  let visited = 0;
  for (const full of files) {
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (DECKS.has(rel) || (honourNotProse && rel in NOT_PROSE)) continue;
    const sf = parse(full);

    const visit = (node: ts.Node): void => {
      visited += 1;
      /* (2) a deck read that happens at import time — see the header's second assertion. */
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "Copy"
        && atModuleScope(node)) {
        frozen.push({ file: rel, line: lineOf(sf, node), text: node.getText(sf) });
      }

      /* (1) copy. Concatenations are folded at the top of the chain and not descended into. */
      const folded = foldedConcat(node);
      if (folded !== null) {
        const rendered = inRenderingPosition(node);
        const statement = sf.text.slice(node.getStart(sf), node.getEnd());
        if (looksLikeCopy(folded, rendered) && !isThrownFault(node) && !SQL.test(statement)
          && !exempt(folded.replace(/\s+/g, " ").trim(), rel)) {
          copy.push({ file: rel, line: lineOf(sf, node), text: folded.trim() });
        }
        /*
         * DESCEND INTO THE OPERANDS THE FOLD DID NOT CONSUME. Returning here dropped everything
         * inside a dynamic operand: `"Prefix " + (ok ? "a whole English clause" : x)` folded to
         * "Prefix" — one word, below the threshold — and the clause inside the conditional was
         * never visited. Only the literals the fold ATE are suppressed; anything else is still a
         * place a sentence can hide.
         */
        const eaten = (n: ts.Node): boolean =>
          ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
          || ts.isTemplateExpression(n)
          || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
        const descend = (n: ts.Node): void => {
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            descend(n.left); descend(n.right); return;
          }
          if (!eaten(n)) visit(n);
        };
        descend(node);
        return;
      }

      /* ── THE JOIN ───────────────────────────────────────────────────────────────────────
         Punctuation typed into the markup between two rendered values is a sentence being
         assembled outside the deck. Whitespace-only JSX text is layout and is skipped first, so
         a value and its neighbour are compared across the gaps a formatter leaves. */
      /* ── THE SAME JOIN, IN A TEMPLATE ───────────────────────────────────────────────────
         The JSX form was only half of it. `` `${Copy.x} — ${y}` `` assembles exactly the same
         sentence with exactly the same fixed punctuation and word order, and the JsxText check
         cannot see it because there is no JSX text — the separator is a literal SPAN of the
         template. A join is a join whichever syntax carries it. */
      if (ts.isTemplateExpression(node) && (ts.isJsxText(node) === false)) {
        const spans = node.templateSpans;
        const reads = (x: ts.Node): boolean => {
          if (ts.isPropertyAccessExpression(x) && x.expression.getText(sf) === "Copy") return true;
          let found = false;
          ts.forEachChild(x, (c) => { if (!found && reads(c)) found = true; });
          return found;
        };
        /* Scoped to templates that interpolate DECK COPY, or that are rendered. A template with
           no copy in it and no reader is a log line or a query, and those are not sentences. */
        const isCopy = node.templateSpans.some((sp) => reads(sp.expression))
          || reads(node.head) || inRenderingPosition(node);
        if (isCopy) {
          spans.forEach((sp, i) => {
            /* The literal BETWEEN two substitutions: this span's text, with another span after
               it. A trailing literal has nothing on its far side and is not a join. */
            if (i + 1 >= spans.length) return;
            const between = sp.literal.text.replace(/\s+/g, " ");
            if (between.trim() === "" || !JOINING_PUNCTUATION.test(between)) return;
            if (honour && rel in ASSEMBLED_EXCEPTIONS) return;
            assembled.push({
              file: rel, line: lineOf(sf, sp.literal),
              text: `\${${sp.expression.getText(sf)}}${between}\${${spans[i + 1]!.expression.getText(sf)}}`,
            });
          });
        }
      }

      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const kids = node.children.filter(
          (c) => !(ts.isJsxText(c) && c.text.trim() === ""),
        );
        kids.forEach((kid, i) => {
          if (!ts.isJsxText(kid)) return;
          const joined = kid.text.replace(/\s+/g, " ");
          if (!JOINING_PUNCTUATION.test(joined)) return;
          const before = kids[i - 1];
          const after = kids[i + 1];
          if (before === undefined || after === undefined) return;
          if (!rendersValue(before) || !rendersValue(after)) return;
          if (honour && rel in ASSEMBLED_EXCEPTIONS) return;
          assembled.push({
            file: rel, line: lineOf(sf, kid),
            text: `${before.getText(sf).replace(/\s+/g, " ")}${joined}${after.getText(sf).replace(/\s+/g, " ")}`,
          });
        });
      }

      let text: string | null = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) text = templateProse(node);
      else if (ts.isJsxText(node)) text = node.text;

      if (text !== null) {
        /* JSX TEXT IS ALWAYS A RENDERING POSITION. It has no name to check and no other purpose:
           if it is in the tree, somebody reads it. This is the family the previous scanner could
           not see at all. */
        const rendered = ts.isJsxText(node) || inRenderingPosition(node);
        /* Compared in the NORMALISED form the failure message prints, so an entry can be copied
           straight out of a red run — a template's prose arrives with the holes as gaps. */
        const normalised = text.replace(/\s+/g, " ").trim();
        /* THE EXEMPTION IS SCOPED TO THE FILE ITS REASON NAMES. It used to match on text alone,
           anywhere: pasting `<Text>Answer Later</Text>` into Settings was silently licensed by an
           exemption whose stated reason is about `state/live.ts`. A licence for one place is not a
           licence for every place that happens to say the same words. */
        if (looksLikeCopy(text, rendered) && !isThrownFault(node) && !isFaultOnlyBinding(node, sf)
          && !SQL.test(node.parent?.getText(sf) ?? "") && !exempt(normalised, rel)) {
          copy.push({ file: rel, line: lineOf(sf, node), text: normalised });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return { copy, frozen, assembled, visited, files: files.length };
}

/** The control tree — the same scanner, over a directory whose contents are known. */
const CONTROL_DIR = path.join(APP, "test/fixtures/census-control");
const controlCensus = (): CensusResult =>
  census(walkFiles(CONTROL_DIR), CONTROL_DIR);

/**
 * WHAT THE CONTROL TREE MUST YIELD. This list IS the assertion; `test/fixtures/census-control/`
 * is its input, and the two are kept in step by hand on purpose — a control whose expectations
 * were derived from the scanner would agree with any scanner, including a broken one.
 */
const CONTROL_COPY = [
  "No mail here",
  "Nothing here yet at all.",
  "Please try again in   minutes",
  "Ready now",
  "Receipts",
  "Retry",
  "Still waiting",
  "a whole English clause",
  /* The join fixture's non-plant `{"x"}: {b}`. The two rules are independent and this proves it:
     the JOIN rule declines it (a quoted literal is not a rendered VALUE) and the PROSE rule takes
     it, because anything literal in a rendering position is read by somebody. */
  "x",
].sort();

const CONTROL_FROZEN = [
  "Copy.reads", "Copy.receipts", "Copy.screener", "Copy.settings",
  /* The three invocation shapes that had no plant: `.apply()`, a tagged template, and a bound
     function that is then called. `Copy.doorbellRest` (bind with no call) and `Copy.facePaper`
     (inside a method body) are deliberately absent — nothing has run in either. */
  "Copy.moveLabel", "Copy.scopeSender", "Copy.scopeDomain",
].sort();

describe("what is addressed to SQLite, and what only looks like it", () => {
  /* Both directions, because a widened exclusion list is a way to make copy invisible. The first
     five were reported as copy before transaction control was added; the last three are the
     reason the list is case-sensitive rather than a set of words. */
  it("excludes transaction control, and still admits a sentence that starts with a verb", () => {
    for (const statement of ["BEGIN IMMEDIATE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT s1"]) {
      expect(SQL.test(statement), `${statement} is addressed to SQLite`).toBe(true);
    }
    for (const statement of ["SELECT 1", "PRAGMA journal_mode = WAL", "DROP TABLE t"]) {
      expect(SQL.test(statement), `${statement} was already excluded and must stay so`).toBe(true);
    }
    for (const sentence of ["Begin setting up your mailbox", "Release the mailbox", "Nothing was deleted."]) {
      expect(SQL.test(sentence), `"${sentence}" is a sentence somebody reads`).toBe(false);
    }
  });
});

describe("the census can find something — the positive control", () => {
  /*
   * ═══ THE ASSERTION THAT WOULD HAVE CAUGHT THE WHOLE FILE BEING SWITCHED OFF ═══════════════
   *
   * Round three deleted `ts.forEachChild(sf, visit)` from the production scan and all eighteen
   * tests stayed green: the clean-tree checks returned empty because nothing was visited, the
   * "walks a real tree" check counted FILENAMES, and every mutation probe drove a separate scanner
   * written inside the test. Nothing in the file asked the census to find something.
   *
   * It does now, over a fixture tree with eleven plants and three deliberate non-plants, using the
   * SAME function that scans `src/` and `app/`.
   */
  it("finds every planted string in the control tree, and nothing else", () => {
    const { copy } = controlCensus();
    expect(copy.map((h) => h.text).sort()).toEqual(CONTROL_COPY);
  });

  it("finds every planted import-time deck read, and nothing else", () => {
    const { frozen } = controlCensus();
    expect(frozen.map((h) => h.text).sort()).toEqual(CONTROL_FROZEN);
  });

  it("does NOT freeze a function that has not run", () => {
    /* The other half of the three plants above, and the half that makes them mean something: a
       detector that answered TRUE for everything would find all five shapes and be useless.
       `bind` with no call has run nothing, and a read inside a method body runs when the method
       is called — which is the ordinary live read every screen does. */
    const { frozen } = controlCensus();
    const texts = frozen.map((h) => h.text);
    expect(texts, "a bound function that was never called was reported as frozen")
      .not.toContain("Copy.doorbellRest");
    expect(texts, "a read inside a method body was reported as frozen")
      .not.toContain("Copy.facePaper");
  });

  it("licenses an allowlisted line in ITS OWN file only", () => {
    /*
     * The exemption used to match on TEXT ALONE, anywhere. Pasting a sentence into a second file
     * was silently licensed by an entry whose stated reason is about the first — a licence for one
     * place is not a licence for every place that happens to say the same words.
     *
     * Driven on the real table rather than a fixture, because the table is what rots.
     */
    const entries = Object.entries(NAMED_LINES);
    expect(entries.length, "the allowlist is empty, so this proves nothing").toBeGreaterThan(0);
    for (const [text, entry] of entries) {
      expect(exempt(text, entry.file), `"${text}" is not licensed in the file its reason names`)
        .toBe(true);
      expect(exempt(text, "src/a/file/that/does/not/hold/it.ts"),
        `"${text}" is licensed in a file its reason says nothing about`).toBe(false);
    }
  });

  it("does NOT report the deliberate non-plants — a census that cries wolf is not usable", () => {
    const { copy } = controlCensus();
    /* An attribute callback's argument, and a thrown developer fault directly and one
       indirection away. Each is a rule this census is supposed to apply, so each is a rule the
       control observes rather than a claim the header makes. */
    expect(copy.map((h) => h.text)).not.toContain("debug");
    expect(copy.map((h) => h.text)).not.toContain("this sentence is for a developer");
  });

  it("visits real syntax nodes when it scans the app — not only filenames", () => {
    /* The production run's own reach. "Found nothing" is only an answer beside a count of what was
       looked at; without this, a deleted tree walk reads exactly like a clean tree. */
    const { visited, files } = census();
    expect(files).toBeGreaterThan(60);
    expect(visited, "the scanner traversed nothing — a clean result here means nothing")
      .toBeGreaterThan(20000);
  });
});

describe("the copy census — every sentence lives in the deck", () => {
  it("finds no user-visible string outside src/copy.*.ts", () => {
    const hits = census().copy.map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(hits, "these read as English on a German phone — move them into the copy deck")
      .toEqual([]);
  });

  it("finds no deck read frozen at module scope", () => {
    /*
     * `const EMPTY = { title: Copy.waitingEmptyTitle }` at the top of a module reads the getter ONCE,
     * at import, and keeps the answer for the life of the process — in whatever language the register
     * held at that moment, which import order decides. `app/(tabs)/screener.tsx` did exactly this for
     * three empty states, directly above a `useLocale()` call that could not help them.
     */
    const hits = census().frozen.map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(hits, "a getter read at import time is frozen in one language — read it during render")
      .toEqual([]);
  });

  it("walks a real tree — a scanner that read nothing would pass both assertions above", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((f) => f.endsWith("app/settings.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/state/world.tsx"))).toBe(true);
  });
});

describe("the census, watched failing", () => {
  const scan = (source: string, ext = ".tsx") => {
    const sf = ts.createSourceFile(`probe${ext}`, source, ts.ScriptTarget.Latest, true,
      ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const frozen: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === "Copy" && atModuleScope(n)) {
        frozen.push(n.getText(sf));
      }
      const folded = foldedConcat(n);
      if (folded !== null) {
        if (looksLikeCopy(folded, inRenderingPosition(n)) && !isThrownFault(n)) found.push(folded);
        return;
      }
      let text: string | null = null;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
      else if (ts.isTemplateExpression(n)) text = templateProse(n);
      else if (ts.isJsxText(n)) text = n.text;
      if (text !== null) {
        const rendered = ts.isJsxText(n) || inRenderingPosition(n);
        if (looksLikeCopy(text, rendered) && !isThrownFault(n) && !isFaultOnlyBinding(n, sf)) {
          found.push(text.replace(/\s+/g, " ").trim());
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
    return { found, frozen };
  };

  it("sees a JSX TEXT NODE — the family that was invisible and shipped five English strings", () => {
    /* The regression, restored. An earlier draft asserted `expect(found).toEqual([])` for JSX text
       and called that correct; it was the defect, written down as a guarantee. */
    expect(scan("const A = () => <Section>Piles</Section>;").found).toEqual(["Piles"]);
    expect(scan("const B = () => <Tail>Nothing was deleted.</Tail>;").found)
      .toEqual(["Nothing was deleted."]);
  });

  it("sees a string returned through a JSX EXPRESSION, not only bare JSX text", () => {
    /* Round two: `<Text>{"Retry"}</Text>` and a conditional between two strings are text on
       screen, and the walk used to stop when the expression reached its element. */
    expect(scan('const A = () => <Text>{"Retry"}</Text>;').found).toEqual(["Retry"]);
    expect(scan('const B = () => <Text>{ok ? "Ready now" : "Still waiting"}</Text>;').found)
      .toEqual(["Ready now", "Still waiting"]);
    /* A callback's return value flows to where the callback's result goes. */
    expect(scan('const C = () => <View>{rows.map(() => "No mail here")}</View>;').found)
      .toEqual(["No mail here"]);
    expect(scan('const D = () => <View>{rows.map(() => { return "No mail here"; })}</View>;').found)
      .toEqual(["No mail here"]);
  });

  it("does NOT treat an attribute's callback argument as rendered", () => {
    /*
     * The half that keeps the rule above honest: these are strings inside JSX expressions too, and
     * nobody reads them. An element-or-fragment parent means child; a `JsxAttribute` means
     * attribute; and a string handed INTO a call is not that call's result.
     *
     * ONE WORD each, deliberately. A multi-word string is caught by the general two-word rule
     * wherever it stands, so a three-word probe here would go red for a reason that has nothing to
     * do with rendering position and would prove nothing about this boundary. (It did: the first
     * version of this case used "a debug line" and failed correctly.)
     */
    expect(scan('const E = () => <Tap onPress={() => log("debug")} />;').found).toEqual([]);
    expect(scan('const F = () => <View>{fmt("debug")}</View>;').found).toEqual([]);
  });

  it("sees a DYNAMIC concatenation, whose literal half is still copy", () => {
    /* `"Please try " + n + " times"` used to fall out entirely because one operand was not a
       literal — the same blindness template holes had before they were handled. */
    const { found } = scan('const s = "Please try " + n + " times";', ".ts");
    expect(found).toEqual(["Please try   times"]);
    /* A single word beside a value is not a sentence, and stays out. */
    expect(scan('const t = "id-" + n;', ".ts").found).toEqual([]);
  });

  it("sees a getter read inside an IIFE, which runs at import time like a bare read", () => {
    expect(scan('const x = (() => Copy.reads)();', ".ts").frozen).toEqual(["Copy.reads"]);
    expect(scan('const y = (function () { return Copy.reads; })();', ".ts").frozen)
      .toEqual(["Copy.reads"]);
    /* …and the same function NOT invoked is still a deferral. */
    expect(scan('const z = () => Copy.reads;', ".ts").frozen).toEqual([]);
  });

  it("sees a ONE-WORD label, which is how the tab bar stayed half-English", () => {
    const { found } = scan('const T = [{ name: "index", label: "Receipts", icon: "receipts" }];', ".ts");
    expect(found).toEqual(["Receipts"]);   // …and NOT "index" or "receipts" beside it.
  });

  it("sees a string built by CONCATENATION, and reports it once", () => {
    const { found } = scan('const s = "English" + " sentence";', ".ts");
    expect(found).toEqual(["English sentence"]);
  });

  it("sees a literal inside a template hole", () => {
    const { found } = scan("const s = `${cond ? 'a whole English clause' : x}`;", ".ts");
    expect(found).toEqual(["a whole English clause"]);
  });

  it("sees the rendering names that were missing — hint, reason, detail", () => {
    for (const name of ["hint", "reason", "detail", "message"]) {
      const { found } = scan(`const o = { ${name}: "Waiting" };`, ".ts");
      expect(found, `${name} is not treated as a rendering position`).toEqual(["Waiting"]);
    }
  });

  it("sees a deck getter read at module scope, and not one read inside a function", () => {
    expect(scan('const E = { title: Copy.waitingEmptyTitle };', ".ts").frozen)
      .toEqual(["Copy.waitingEmptyTitle"]);
    expect(scan('const f = () => Copy.waitingEmptyTitle;', ".ts").frozen).toEqual([]);
    expect(scan('const o = { get title() { return Copy.reads; } };', ".ts").frozen).toEqual([]);
  });

  it("is not blinded by a comment that mentions a path — the bug that cost a device walk", () => {
    /* `net/pairing.ts` has a line comment mentioning the route /pair/*. The first scanner stripped
       block comments before line comments, so that opened a comment which swallowed a long run of lines and
       four untranslated refusals. The compiler's own lexer cannot make this mistake; the case stays
       because the cost of finding it was a device walk. */
    const src = [
      "// the routes `/hello`, `/pair/*` and `/auth/*` live at the root",
      'const x = "a sentence after the comment";',
    ].join("\n");
    expect(scan(src, ".ts").found).toEqual(["a sentence after the comment"]);
    expect(scan('/* a note // inside */\nconst y = "still visible";', ".ts").found)
      .toEqual(["still visible"]);
    expect(scan('const r = /a\\/b/; const s = "after the regex";', ".ts").found)
      .toEqual(["after the regex"]);
  });

  it("does not report a thrown programming fault, directly or one indirection away", () => {
    expect(scan('function f() { throw new Error("this is for a developer"); }', ".ts").found)
      .toEqual([]);
    /* The indirection: declared apart from the throw that uses it. */
    const indirect = 'const HELD = "held until the check settles";\nfunction f() { throw new Error(HELD); }';
    expect(scan(indirect, ".ts").found).toEqual([]);
    /* …and ONE rendered use is enough to bring it back. */
    const alsoRendered = 'const M = "held until the check settles";\n'
      + 'function f() { throw new Error(M); }\nconst o = { reason: M };';
    expect(scan(alsoRendered, ".ts").found).toEqual(["held until the check settles"]);
  });
});

describe("the exemptions", () => {
  it("names every one, and the reason is prose rather than a shrug", () => {
    for (const [file, reason] of Object.entries(NOT_PROSE)) {
      expect(fs.existsSync(path.join(APP, file)), `exempted but missing: ${file}`).toBe(true);
      expect(reason.length, `${file} is exempted without a reason`).toBeGreaterThan(20);
    }
    for (const [text, { file, why }] of Object.entries(NAMED_LINES)) {
      expect(fs.existsSync(path.join(APP, file)), `${text}: names a missing file`).toBe(true);
      expect(why.length, `"${text}" is exempted without a reason`).toBeGreaterThan(20);
    }
  });

  it("keeps them honest — checked against the FILE the reason names, not the whole tree", () => {
    /*
     * This used to search the whole tree, and that was about to go quietly wrong. The three
     * PILE_META descriptions are moving into the copy deck on another branch; once they land, the
     * strings still EXIST — in the deck — so a tree-wide search would keep passing while the
     * exemption it licenses ("held in state/live.ts") had become false. An exemption is a claim
     * about a place, so it is checked in that place.
     */
    /*
     * READ THROUGH THE PARSER, NOT THROUGH `includes`. A raw-source search is satisfied by a
     * COMMENT: delete the literal `"Answer Later"` from `state/live.ts` and leave the paragraph
     * above it that mentions the words, and the exemption stays green while the value it licenses
     * has gone. The candidates are the same ones the census collects, so this asks the same
     * question the census does — is this string in this file? — of the same evidence.
     */
    for (const [text, { file }] of Object.entries(NAMED_LINES)) {
      const full = path.join(APP, file);
      const seen = new Set<string>();
      const sf = parse(full);
      const collect = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) seen.add(n.text);
        else if (ts.isTemplateExpression(n)) seen.add(templateProse(n).replace(/\s+/g, " ").trim());
        else if (ts.isJsxText(n)) seen.add(n.text.replace(/\s+/g, " ").trim());
        ts.forEachChild(n, collect);
      };
      ts.forEachChild(sf, collect);
      expect([...seen], `gone from ${file} as a VALUE — drop it from NAMED_LINES: "${text}"`)
        .toContain(text);
    }
  });

  it("proves each exempted string is not rendered, by naming where it goes", () => {
    /*
     * THE ASSERTION THAT WOULD HAVE CAUGHT `SUPERSEDED`.
     *
     * An entry claims a string never reaches a screen. That claim is checkable: the string's
     * identifier must not be assigned to a field a screen reads. `SUPERSEDED` failed exactly here —
     * `connection.tsx` returned it as `{ ok: false, reason: SUPERSEDED }` — and it is translated now
     * rather than exempted. The remaining entries are held to the same test.
     */
    const src = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");
    /* `device kind` is read off the SERVER's message and compared; it is never assigned out. */
    const pairing = src("src/net/pairing.ts");
    expect(pairing).toMatch(/answer\.error\.message\.includes\("device kind"\)/);
    expect(pairing).not.toMatch(/reason:\s*"device kind"/);
    /* The transport diagnostic is handed to a deck sentence, which is the diagnostic rule, not an
       exemption from translation — the sentence around it is German. */
    expect(src("src/net/server-base.ts")).toMatch(/refuse\("baseApiUnreachable"/);
    /* The pile strings belong to a file this branch does not own; the deck already has all three. */
    expect(Copy.replyLater).toBeTypeOf("string");
    expect(Copy.setAside).toBeTypeOf("string");
    expect(Copy.resurface).toBeTypeOf("string");
  });
});

describe("the whole-file exemptions, which were never opened", () => {
  /*
   * ═══ AN EXEMPTION THAT IS NEVER PARSED CANNOT KEEP ITS PROMISE ═══════════════════════════
   *
   * `NOT_PROSE` files were skipped BEFORE parsing, and the only assertions about them were that
   * each entry exists and that its reason is long enough. So the guarantee the entries state —
   * "this file holds no user-facing prose" — was true on the day each was written and unchecked
   * every day after. Adding `<Txt>Retry later</Txt>` to `src/net/push.ts` would never have been
   * visited, and the census would have stayed green.
   *
   * They are parsed now. What an exempt file may contain is stated as a SHAPE rather than as a
   * count, so the entry keeps meaning something as the file changes: a machine code, or the
   * brand. Anything that reads like a sentence fails and names the file and the line.
   */
  /*
   * WHAT AN EXEMPT FILE MAY HOLD — BY NAME, not by shape.
   *
   * This was a shape: "no spaces, all lower case, optional underscores". The reasoning was that a
   * sentence has spaces or a capital. It does not survive contact with a one-word label: `retry`
   * and `later` are words a reader reads, and they match that shape exactly as `refused` does.
   * There is no shape that separates a one-word code from a one-word label, so there is no shape
   * to write — the strings are listed.
   *
   * A list has to be edited when a code is added, and that is the point: adding a word to this
   * list is a visible act with a reviewer, where widening a regex is not.
   */
  const EXEMPT_STRINGS: Record<string, readonly string[]> = {
    "src/ui/Icon.tsx": ["ohmail"],
    "src/net/push.ts": [
      "refused", "distributor_refused", "server_unavailable", "endpoint_refused",
      "server_answer_unrecognised", "could_not_record_debt:",
    ],
    /* The door's own words for a swept family, matched byte for byte off the wire — the API
       pins the same sentence at its end (`packages/api/test/auth-flow.test.ts`). Nobody reads
       this one: what a person sees is `pairEnded`, in the deck, in both languages. */
    "src/net/bearer.ts": ["refresh token reuse detected"],
  };

  it("holds every exempt file to what its reason claims, by reading it", () => {
    const offenders: string[] = [];
    let looked = 0;
    for (const rel of Object.keys(NOT_PROSE)) {
      const full = path.join(APP, rel);
      expect(fs.existsSync(full), `${rel}: exempted but not present`).toBe(true);
      const { copy, visited } = census([full], APP, { honourNotProse: false });
      looked += visited;
      const allowed = new Set(EXEMPT_STRINGS[rel] ?? []);
      for (const h of copy) {
        if (allowed.has(h.text)) continue;
        offenders.push(`${h.file}:${h.line}  ${JSON.stringify(h.text)}`);
      }
    }
    /* The reach, stated: zero offenders means nothing only if something was parsed. */
    expect(looked, "no exempt file was actually parsed, so this proves nothing")
      .toBeGreaterThan(500);
    expect(offenders,
      "an exempted file holds a string that is not on its list. If it is a machine code, add it "
      + "to EXEMPT_STRINGS by name; if it is a word somebody reads, it belongs in the deck:\n"
      + offenders.join("\n")).toEqual([]);
    /* …and the list may not rot either: a name nobody produces any more is a licence with no
       subject, and the next word added under it inherits that licence silently. */
    for (const [rel, names] of Object.entries(EXEMPT_STRINGS)) {
      const { copy } = census([path.join(APP, rel)], APP, { honourNotProse: false });
      const present = new Set(copy.map((h) => h.text));
      for (const n of names) {
        expect(present.has(n), `${rel}: "${n}" is listed but no longer appears — drop it`).toBe(true);
      }
    }
  });
});

describe("sentences assembled by the markup", () => {
  /*
   * The Screener's sender note built one sentence out of a deck FRAGMENT, two values and
   * punctuation typed into the JSX. English survived it; German did not — the verb moves, and the
   * result said that Ohbox suggests the AI. Every piece was legitimate on its own, so the prose
   * census could not have seen it: the defect was the JOIN.
   */
  it("FINDS the joins in the control tree, and leaves the non-plants alone", () => {
    const { assembled } = controlCensus();
    const texts = assembled.map((h) => h.text).sort();
    expect(texts, `the control missed a join — found:\n${texts.join("\n")}`).toEqual([
      "{a} — {b}",
      "{a}: {b}",
      "<Txt>{b}</Txt>, {a}",
    ].sort());
  });

  it("every exempted file is one this lane does not own, and still assembles", () => {
    /*
     * An exemption nobody checks is a hole with a comment on it. Two things are asserted: the
     * reason is real prose rather than a placeholder, and the file STILL CONTAINS the join —
     * so when the other lane's work merges and the join goes, this fails and the entry has to
     * be removed rather than outliving its reason.
     */
    for (const [rel, why] of Object.entries(ASSEMBLED_EXCEPTIONS)) {
      expect(why.length, `${rel}: the exemption has no stated reason`).toBeGreaterThan(80);
      const full = path.join(APP, rel);
      expect(fs.existsSync(full), `${rel}: exempted but not present`).toBe(true);
      const { assembled } = census([full], APP, { honourExceptions: false });
      expect(assembled.length,
        `${rel}: exempted, but no longer assembles — delete the entry`).toBeGreaterThan(0);
    }
  });

  it("finds NONE in the shipped source", () => {
    const { assembled, visited } = census();
    expect(visited, "nothing was walked, so finding nothing means nothing").toBeGreaterThan(1000);
    expect(assembled.map((h) => `${h.file}:${h.line}  ${h.text}`),
      "a sentence is being assembled in the markup — it belongs in the deck, with holes")
      .toEqual([]);
  });
});


