import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ORGANIZED_FOLDERS } from "@trafficflow/core";

/**
 * ═══ EVERY MOVER PICKS ITS CANDIDATES BY AN ALLOW-LIST, NEVER BY A DENYLIST ════════════════
 *
 * The passes that write `folder_state.desired_folder` in bulk — the Screener's auto-decide,
 * the Ohbox tidy, the retro passes, the one-time junk sweep — select rows by the folder the
 * message is DESIRED in. `rule-retro.ts` states the rule this census enforces, because it is the
 * file that once got it wrong:
 *
 *     An ALLOW-LIST over the frozen six rather than "not in (sent, passive…)", because that is
 *     the safe form: a folder nobody has thought about is excluded by default, so the next
 *     observed folder does not become a mover's candidate the day it starts being read.
 *
 * Its candidate set had been `desired_folder <> rule.destination` and nothing about WHICH folder
 * the message was in, so a rule saying "mail from this sender goes to Reads" would have emptied
 * fifteen years of somebody's archive into a newsletter folder the day passive folders started
 * being read — and, on the Sent side, filed the mail they WROTE under Receipts.
 *
 * ── WHY THIS IS A CENSUS AND NOT A CLAUSE IN EACH PASS ────────────────────────────────────
 *
 * The property is already TRUE of all four sites, and adding a redundant clause to each would be
 * a condition whose contrary state is unreachable — a guard nobody can watch fail, which the next
 * reader takes for a guarantee. What is NOT guaranteed is that the FIFTH mover, written by
 * somebody who has not read that comment, keeps the shape. That is the thing worth pinning, and
 * this is the only form that pins it: the allow-list is a property of the SELECTION, so it is
 * asserted over the selection's source.
 *
 * ── RESOLVED TO PATHS, NOT TRUSTED BY NAME ───────────────────────────────────────────────
 *
 * A census that accepted an identifier because it is spelled `SCREENER` would pass a constant
 * repointed at the provider's Junk folder. So each operand is resolved to the string literals it
 * holds and every one of them is checked for membership in {@link ORGANIZED_FOLDERS} — the six and
 * the legacy News spelling, imported rather than re-typed. `OHBOX` is `"INBOX"`, which is why the
 * membership set is that list and not "paths beginning with ohmail/".
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (rel: string): string => readFileSync(`${HERE}../../../${rel}`, "utf8");

/** The four candidate selections, by the file that owns each. */
/* `passName`, not `pass`: the push gate reads a quoted value under a `pass` key as a password. */
const MOVERS: ReadonlyArray<{ passName: string; file: string }> = [
  { passName: "screener-auto", file: "apps/worker/src/screener-auto.ts" },
  { passName: "ohbox-tidy", file: "apps/worker/src/ohbox-tidy.ts" },
  { passName: "rule-retro", file: "apps/worker/src/rule-retro.ts" },
  { passName: "junk-sweep", file: "packages/db/src/junk-sweep.ts" },
];

/** Where an operand's own string literals are declared, when not in the mover's own file. */
const VOCABULARY_SOURCES: ReadonlyArray<string> = [
  "packages/core/src/types.ts",
  "packages/db/src/junk-sweep.ts",
];

type Constraint = { readonly polarity: "positive" | "negative"; readonly operand: string };

/**
 * Every constraint on `folderState.desiredFolder` in one source, with its polarity.
 *
 * A real parse, not a regex: two of the four sites express the clause inside a raw `sql`
 * template, and one of those holds `sql.join` over a mapped list — shapes a line-oriented match
 * reads wrongly in both directions. `ts.preProcessFile` is not usable here for the reason
 * recorded against `box-files.mjs`: it is a token scanner and reads sequences out of template
 * literals.
 */
export function desiredFolderConstraints(text: string): Constraint[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: Constraint[] = [];

  /** `folderState.desiredFolder` — the subject, however it is spelled at the site. */
  const isSubject = (n: ts.Node): boolean =>
    ts.isPropertyAccessExpression(n)
    && n.name.text === "desiredFolder"
    && ts.isIdentifier(n.expression)
    && n.expression.text === "folderState";

  /** The identifier or literal a clause compares the subject against. */
  const operandOf = (n: ts.Node): string => {
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isStringLiteral(n)) return JSON.stringify(n.text);
    if (ts.isArrayLiteralExpression(n)) {
      // `[...DEMOTING_FOLDERS]` — the spread's own operand is the vocabulary.
      const spread = n.elements.find(ts.isSpreadElement);
      if (spread) return operandOf(spread.expression);
    }
    if (ts.isPropertyAccessExpression(n)) {
      let root: ts.Node = n;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      return ts.isIdentifier(root) ? root.text : n.name.text;
    }
    if (ts.isCallExpression(n)) {
      // `sql.join(DESTINATIONS.map(…), …)` — the mapped list is the CALLEE's own object, so the
      // callee is read before the arguments; reading arguments first answered `map`.
      if (ts.isPropertyAccessExpression(n.expression)) {
        const via = operandOf(n.expression);
        if (via !== "?" && via !== "sql") return via;
      }
      for (const a of n.arguments) {
        const inner = operandOf(a);
        if (inner !== "?") return inner;
      }
    }
    if (ts.isTemplateExpression(n) || ts.isTaggedTemplateExpression(n)) {
      for (const s of collectSpans(n)) {
        const inner = operandOf(s);
        if (inner !== "?") return inner;
      }
    }
    return "?";
  };

  const collectSpans = (n: ts.Node): ts.Expression[] => {
    const spans: ts.Expression[] = [];
    const tpl = ts.isTaggedTemplateExpression(n) ? n.template : n;
    if (ts.isTemplateExpression(tpl)) for (const s of tpl.templateSpans) spans.push(s.expression);
    return spans;
  };

  const walk = (n: ts.Node): void => {
    // ── the drizzle helper forms: eq / ne / inArray / notInArray ──────────────────────────
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const fn = n.expression.text;
      const positive = fn === "eq" || fn === "inArray";
      const negative = fn === "ne" || fn === "notInArray";
      if ((positive || negative) && n.arguments.length >= 2 && isSubject(n.arguments[0]!)) {
        out.push({
          polarity: positive ? "positive" : "negative",
          operand: operandOf(n.arguments[1]!),
        });
      }
    }
    // ── the raw `sql` template form: the operator is TEXT between the spans ───────────────
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === "sql") {
      const tpl = n.template;
      if (ts.isTemplateExpression(tpl)) {
        // For each span whose expression IS the subject, read the literal text that FOLLOWS it
        // and classify the operator written there; the operand is the next span.
        tpl.templateSpans.forEach((span, i) => {
          if (!isSubject(span.expression)) return;
          const following = span.literal.text;
          const next = tpl.templateSpans[i + 1]?.expression;
          if (/(^|\s)(<>|!=)(\s|$)/.test(following)) {
            out.push({ polarity: "negative", operand: next ? operandOf(next) : "?" });
          } else if (/(^|\s)(=|in)(\s|$)/i.test(following.trim().length > 0 ? following : " ")
            || /\bin\b/i.test(following)) {
            out.push({ polarity: "positive", operand: next ? operandOf(next) : "?" });
          }
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/**
 * Every string literal an identifier is declared with, across the vocabulary sources. An
 * identifier inside the initializer (`[...DESTINATIONS, LEGACY_NEWS_FOLDER]`) is followed to its
 * own declaration, once per name.
 */
function literalsOf(name: string, texts: readonly string[], seen = new Set<string>()): string[] {
  const found: string[] = [];
  if (seen.has(name)) return found;
  seen.add(name);
  for (const text of texts) {
    const sf = ts.createSourceFile("y.ts", text, ts.ScriptTarget.Latest, true);
    const walk = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name
        && n.initializer) {
        const collect = (e: ts.Node): void => {
          if (ts.isStringLiteral(e)) found.push(e.text);
          else if (ts.isIdentifier(e)) found.push(...literalsOf(e.text, texts, seen));
          ts.forEachChild(e, collect);
        };
        collect(n.initializer);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return found;
}

describe("a mover's candidate set is an allow-list over the folders ohmail organizes", () => {
  const sources = new Map(MOVERS.map((m) => [m.file, src(m.file)]));
  const vocabulary = [...VOCABULARY_SOURCES, ...MOVERS.map((m) => m.file)]
    .map((f) => sources.get(f) ?? src(f));

  it.each(MOVERS.map((m) => [m.passName, m.file] as const))(
    "%s constrains `desired_folder` POSITIVELY, and to the organized folders only",
    (pass, file) => {
      const constraints = desiredFolderConstraints(sources.get(file)!);
      // The census must actually have found the clause — a parse that matched nothing would
      // otherwise pass every file in the tree, including one with no selection at all.
      expect(constraints.length, `${pass}: no \`desired_folder\` constraint parsed at all`)
        .toBeGreaterThan(0);

      const positives = constraints.filter((c) => c.polarity === "positive");
      expect(
        positives.length,
        `${pass} constrains \`desired_folder\` by NEGATION ONLY — the denylist form `
        + `rule-retro.ts's own comment refuses: a folder nobody has thought about becomes a `
        + `candidate the day it starts being read`,
      ).toBeGreaterThan(0);

      // …and every operand resolves to paths inside the frozen six.
      const six = new Set<string>(ORGANIZED_FOLDERS);
      for (const c of positives) {
        const bare = c.operand.startsWith("\"") ? [JSON.parse(c.operand) as string] : null;
        const paths = bare ?? literalsOf(c.operand, vocabulary);
        expect(paths.length, `${pass}: \`${c.operand}\` resolves to no string literal`)
          .toBeGreaterThan(0);
        for (const p of paths) {
          expect(six.has(p), `${pass}: \`${c.operand}\` admits ${JSON.stringify(p)}, which is `
            + `not one of the folders ohmail organizes`).toBe(true);
        }
      }
    },
  );

  it("the classifier tells the two forms apart — the census's own positive control", () => {
    // WITHOUT this the case above could pass by finding a "positive" in anything. Both arms on
    // text that stands for the two real shapes, so the discriminator is watched rather than
    // trusted: the allow-list form is recognised, and the denylist form rule-retro.ts used to
    // carry is NOT.
    const allow = `const f = [inArray(folderState.desiredFolder, [...DEMOTING_FOLDERS])];`;
    expect(desiredFolderConstraints(allow).map((c) => c.polarity)).toEqual(["positive"]);

    const deny = "const f = [sql`${folderState.desiredFolder} <> ${rule.destination}`];";
    const denyOnly = desiredFolderConstraints(deny);
    expect(denyOnly.length, "the denylist clause was not parsed").toBe(1);
    expect(denyOnly.every((c) => c.polarity === "negative"),
      "the denylist form was read as an allow-list").toBe(true);

    // And the `eq` form, which two of the four sites use.
    const eqForm = `const f = [eq(folderState.desiredFolder, SCREENER)];`;
    expect(desiredFolderConstraints(eqForm)).toEqual([{ polarity: "positive", operand: "SCREENER" }]);
  });

  it("…and an operand pointing OUTSIDE the six is refused — the vocabulary arm, driven", () => {
    // The membership half, on text rather than on a real mover: a constant repointed at the
    // provider's Junk folder passes every name-based reading and must fail here.
    const six = new Set<string>(ORGANIZED_FOLDERS);
    const repointed = literalsOf("JUNK", [`const JUNK = "INBOX/Junk";`]);
    expect(repointed).toEqual(["INBOX/Junk"]);
    expect(repointed.every((p) => six.has(p)),
      "a folder outside the six was admitted by the membership check").toBe(false);
    // …and the honest direction: the real constant does belong.
    expect(literalsOf("SCREENER", [`const SCREENER = "ohmail/Screener";`])
      .every((p) => six.has(p))).toBe(true);
  });
});
