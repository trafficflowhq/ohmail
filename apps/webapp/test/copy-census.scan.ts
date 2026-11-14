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

/** The interface sources: the shared UI package, the shell and views, and the desktop window. */
export const COPY_CENSUS_ROOTS = [
  "packages/ui/src",
  "apps/webapp/app/shell",
  "apps/webapp/app/views",
  "apps/webapp/app/components",
  "apps/webapp/app/letter-body",
  "apps/desktop/src",
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

      /** Innermost first. Each frame maps a translator identifier to its namespace prefix. */
      const scopes: Map<string, string | null>[] = [new Map()];
      const lookup = (name: string): string | null | undefined => {
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
        const RICH_MEMBERS = new Set(["rich", "markup", "raw"]);
        if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && ts.isIdentifier(n.expression.expression)
          && RICH_MEMBERS.has(n.expression.name.text)
          && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])
        ) {
          const prefix = lookup(n.expression.expression.text);
          if (prefix !== undefined && prefix !== null) {
            const key = (n.arguments[0] as ts.StringLiteral).text;
            reads.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              dotted: prefix ? `${prefix}.${key}` : key,
            });
          }
        }
        if (
          ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])
        ) {
          const prefix = lookup(n.expression.text);
          if (prefix !== undefined && prefix !== null) {
            const key = (n.arguments[0] as ts.StringLiteral).text;
            reads.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              dotted: prefix ? `${prefix}.${key}` : key,
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
