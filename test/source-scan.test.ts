import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
// The shared scanner, imported the way packages/db's censuses import one.
import { withoutComments, withoutCommentsAndLiterals, withoutHashComments, bracketSpan, lineOf }
  from "../scripts/lib/source-scan.mjs";
import { presentRoots } from "./support/public-root.mjs";

/**
 * THE COMMENT SCANNER, AND THE LINE THAT BROKE THE TWO-REGEX PAIR.
 *
 * Every census that blanks comments and then walks brackets used to do it with two regexes. The
 * pair cannot tell a comment from a comment-shaped string, and one real line in
 * `packages/services/src/mailbox-service.ts` proves it: the `/*` inside a backtick quote opens a
 * block comment the pair closes at the next real end-of-comment, blanking everything between —
 * after which the bracket walk never finds its closing paren and swallows the rest of the file.
 *
 * A runaway span is not a red. It is a census reporting MORE coverage than exists, which is the
 * quiet direction. So the property asserted here is `0 runaway spans` over the real sources the
 * censuses read, plus the fixture line that produced the first one.
 */

const ROOT = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** The pair every census used before this module existed, kept here as the control. */
const twoRegexes = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the scanner reads what the two regexes could not", () => {
  /* The fixture is the shape of the real line, not a paraphrase: a line comment whose text quotes
     a glob in backticks. Written by concatenation so this file does not contain the hazard it
     describes and become its own subject. */
  const HAZARD = ["const w = insert(",
                  "  // the meta folder: `ohmail/" + "*` never appears;",
                  "  row,", ");",
                  "/" + "** an ordinary docblock further down *" + "/",
                  "const after = two(3);", ""].join("\n");

  it("the two regexes close the comment they invented at a REAL end-of-comment below", () => {
    // The `/*` inside the backticks opens; the docblock's own `*​/` closes; everything between —
    // the call's own arguments and its closing paren — is deleted.
    const wrong = twoRegexes(HAZARD);
    expect(wrong.includes("row,"), "the pair kept the argument").toBe(false);
    expect(wrong.includes("insert("), "the pair kept the opening bracket").toBe(true);
  });

  it("…and the walk that follows it runs off the end of the file", () => {
    const wrong = twoRegexes(HAZARD);
    const at = wrong.indexOf("insert(") + 6;
    expect(bracketSpan(wrong, at).closed, "the span closed under the two regexes").toBe(false);
    expect(bracketSpan(wrong, at).end, "the span swallowed the rest of the file").toBe(wrong.length);
  });

  it("the scanner keeps the code and blanks only the comment", () => {
    const right = withoutComments(HAZARD);
    expect(right.includes("row,")).toBe(true);
    expect(right.includes("two(3)")).toBe(true);
    expect(right.includes("never appears"), "the comment text is gone").toBe(false);
    // Positions are preserved, which is what keeps a census's file:line true.
    expect(right.length).toBe(HAZARD.length);
    expect(lineOf(right, right.indexOf("two(3)"))).toBe(lineOf(HAZARD, HAZARD.indexOf("two(3)")));
  });

  it("and the span it hands the walk CLOSES", () => {
    const right = withoutComments(HAZARD);
    const at = right.indexOf("insert(") + 6;
    const s = bracketSpan(right, at);
    expect(s.closed, "the span closed").toBe(true);
    expect(s.end).toBeLessThan(right.length);
  });

  it("a string body cannot open a span either — a lone paren in a message is blanked", () => {
    const src = 'const m = "a ( with no partner";\nconst n = f(1);\n';
    const right = withoutCommentsAndLiterals(src);
    const at = right.indexOf("f(") + 1;
    expect(bracketSpan(right, at).closed).toBe(true);
    // And the control: the two regexes leave the string's paren in, so the walk never closes.
    const at2 = twoRegexes(src).indexOf("(");
    expect(bracketSpan(twoRegexes(src), at2).closed).toBe(false);
  });

  it("a regex literal's bracket is blanked, and a division is not mistaken for one", () => {
    expect(withoutCommentsAndLiterals("const r = /)/;\nconst q = g(1);\n").includes(")/;")).toBe(false);
    // `a / b` is division: the `b` must survive, or every later index moves.
    expect(withoutCommentsAndLiterals("const x = a / b;\nconst y = 1;\n")).toContain("a / b");
  });

  /**
   * AND THE TWO READINGS ARE NOT THE SAME READING. A census that searches a block for an
   * identifier must keep string bodies: a column name inside a `sql` template is code, and
   * blanking it would change the census's finding rather than fix its parse.
   */
  it("withoutComments keeps string bodies; withoutCommentsAndLiterals does not", () => {
    const src = 'const q = sql`select organizer_event_at from t`; // a comment\n';
    expect(withoutComments(src)).toContain("organizer_event_at");
    expect(withoutComments(src)).not.toContain("a comment");
    expect(withoutCommentsAndLiterals(src)).not.toContain("organizer_event_at");
    expect(withoutComments(src).length).toBe(src.length);
  });

  it("neither reading treats a `//` inside a string as a comment", () => {
    const src = 'const u = "https://x/y"; const k = 1;\n';
    expect(withoutComments(src)).toContain("const k = 1");
    expect(withoutCommentsAndLiterals(src)).toContain("const k = 1");
    // The control: the pair every census used eats the rest of the line from the `//`.
    expect(src.replace(/\/\/.*$/gm, "")).not.toContain("const k = 1");
  });
});

/**
 * A REGEX CLASS, A REGEX AFTER `return`, AND A TEMPLATE'S `${…}`. A bare `/`
 * inside `[…]` ended the literal, so the import census lost a function body in
 * `phone-door-corpus.mjs` and read its selftest's `rmSync` as a module-scope write (2026-09-24).
 * The fixture line is that module's, verbatim, before the landing escaped it.
 */
describe("the one pass reads a regex class, a regex after a keyword and a template substitution", () => {
  const K64_LINE = "const b64 = /Content-ID: <[^>]+>\\r\\nContent-Disposition: inline; filename=\"rig-picture.png\"\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--related-/.exec(bp)?.[1]?.replace(/\\r\\n/g, \"\");";
  const inBody = (src: string, needle: string): boolean => {
    const clean = withoutCommentsAndLiterals(src);
    const open = clean.indexOf("{");
    const s = bracketSpan(clean, open, "{", "}");
    const at = clean.indexOf(needle);
    return s.closed && at > s.start && at < s.end;
  };

  it("the K64 line, unescaped, is one regex: the code after it survives and the body closes around it", () => {
    const src = `async function selftest() {\n  ${K64_LINE}\n  rmSync(dir);\n}\nconst after = 1;\n`;
    const clean = withoutCommentsAndLiterals(src);
    expect(clean).toContain(".exec(bp)?.[1]?.replace(");
    expect(clean).toContain("const after = 1;");
    expect(inBody(src, "rmSync(dir)"), "the write is inside the function body").toBe(true);
  });

  it("an escaped slash, in a class or outside one, does not end the literal either", () => {
    // A quote follows each escaped slash, so a literal that ended there would open a string.
    const clean = withoutCommentsAndLiterals("const r = /a\\/'b[\\/\"c]d/.test(x); const k = 2;\n");
    expect(clean).toContain(".test(x); const k = 2;");
  });

  it("a `/` after a closing paren divides", () => {
    expect(withoutCommentsAndLiterals("const r = (a + b) / 2 / c;\n")).toBe("const r = (a + b) / 2 / c;\n");
  });

  it("a `/` after `return` opens a regex, so a quote inside it opens no string", () => {
    const src = "function f(s) {\n  return /'/.test(s);\n}\nconst t = g(1);\n";
    const clean = withoutCommentsAndLiterals(src);
    expect(clean).toContain(".test(s);");
    expect(clean).toContain("const t = g(1);");
    expect(inBody(src, ".test(s)")).toBe(true);
  });

  it("a template's text is blanked and its `${…}` is read as code, nested templates and quoted backticks included", () => {
    const one = withoutCommentsAndLiterals("const u = `a/b/${c}/d`; const k = 1;\n");
    expect(one).toContain("const k = 1;");
    expect(one).toContain(" c ");
    expect(one).not.toContain("a/b");
    const two = withoutCommentsAndLiterals("const v = `x${ y ? `n${z}` : \"`\" }w`; const k2 = 3;\n");
    expect(two).toContain("const k2 = 3;");
    expect(two).toContain(" y ? ");
    expect(two).toContain(" z ");
    // A brace inside a substitution is the substitution's own: the `}` that closes an object
    // literal does not end the `${…}`, so the call's paren still closes.
    const three = withoutCommentsAndLiterals("const w = `${f({ a: 1 })}/x`; const k3 = 4;\n");
    expect(three).toContain("f({ a: 1 })");
    expect(bracketSpan(three, three.indexOf("f(") + 1).closed).toBe(true);
    // withoutComments keeps every body, and still ends the template where it ends.
    expect(withoutComments("const u = `a/b/${c}/d`; // gone\n")).toBe("const u = `a/b/${c}/d`;        \n");
  });
});

/**
 * THE THREE SPELLINGS THE SOURCE-READING GUARDS USED, AND THE ONE THEY USE NOW.
 *
 * The app test directories carried ~15 hand-written strips in three spellings, all of them
 * BLOCK-FIRST: a `/\*…*\/` pass, then a line pass anchored at the margin, or unanchored, or taking
 * the first `//` on the line. Order is the whole defect. A block-comment OPENER quoted inside a
 * LINE comment — a folder glob in backticks, which `engine.ts` and `pairing.ts` both wrote — is a
 * real opener to the block pass, which then closes it at the next terminator far below and deletes
 * every line between. The guard above it reads an extract that is not there, and a negative asked
 * about absent code PASSES. That is the quiet direction, and it is why these are moved rather than
 * re-spelled.
 */
describe("the block-first spellings, and why the guards left them", () => {
  /* Assembled from fragments so this file does not become its own subject. The line comment
     quotes a glob; the code under it is what a block-first pass deletes. */
  const OPEN = "/" + "*";
  const SHUT = "*" + "/";
  const TRAP = [
    "const permitted = await mayOrganize();",
    "// the pipeline routes into `ohmail" + OPEN + "` and a move to a missing folder fails",
    "if (permitted) await ensureFolders(conn);",
    OPEN + OPEN + " an ordinary docblock further down " + SHUT,
    "const after = drain();",
    "",
  ].join("\n");

  /** The three spellings, verbatim from the guards this lane moved. */
  const SPELLINGS: [string, (s: string) => string][] = [
    ["anchored at the margin", (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")],
    ["unanchored", (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")],
    ["first `//` on the line", (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "")],
  ];

  it("every one of them deletes the code the guard was asked about", () => {
    for (const [name, strip] of SPELLINGS) {
      expect(strip(TRAP), `${name} kept the call`).not.toContain("ensureFolders(conn)");
      // And it is not that they delete everything — the line ABOVE the trap survives, which is
      // exactly why the loss is invisible to the guard reading the extract.
      expect(strip(TRAP), `${name} lost the whole file`).toContain("mayOrganize()");
    }
  });

  it("the scanner keeps it, because it reads the line comment as a line comment", () => {
    const right = withoutComments(TRAP);
    expect(right).toContain("ensureFolders(conn)");
    expect(right).toContain("drain()");
    expect(right, "the comment text is gone").not.toContain("a move to a missing folder");
  });

  it("a `//` inside a string is not a comment, and the string survives the strip", () => {
    const src = 'const doc = "see https://ohmail.app/help";\nconst k = 1;\n';
    expect(withoutComments(src)).toContain("https://ohmail.app/help");
    expect(withoutComments(src)).toContain("const k = 1");
    // The control: the unanchored spelling eats the rest of the line from inside the string.
    expect(SPELLINGS[1]![1](src)).not.toContain("ohmail.app/help");
  });

  it("line numbers do not move across a stripped BLOCK", () => {
    const src = [
      "const a = 1;",
      OPEN + OPEN,
      " * four lines of docblock",
      " * that a strip must not shorten",
      " " + SHUT,
      "const b = 2;",
      "",
    ].join("\n");
    const right = withoutComments(src);
    expect(right.split("\n").length).toBe(src.split("\n").length);
    expect(lineOf(right, right.indexOf("const b"))).toBe(6);
    // The control: the block pass collapses the four-line docblock to the newlines around it,
    // so `const b` moves from line 6 to line 3 and every `file:line` a census reports is wrong.
    const wrong = SPELLINGS[0]![1](src);
    expect(lineOf(wrong, wrong.indexOf("const b"))).toBe(3);
  });
});

/**
 * AND THE REPO-WIDE READING: no source file under the app roots is a trap for the strips that
 * are still in the tree.
 *
 * Six files were, at the tip this was written against — five sites in `apps/sidecar/src/engine.ts`
 * and one in `apps/mobile/src/net/pairing.ts`, each a line comment quoting a folder glob. The
 * guards that read those two files are on the scanner now, so the hazard is closed at the reader;
 * this is the second line, for the ~40 hand-written strips elsewhere that nobody has moved. It
 * names `file:line`, so a new one is a sentence rather than a hunt.
 */
describe("0 block-first traps in the sources the guards read", () => {
  const ROOTS = presentRoots(["apps/desktop/src", "apps/mobile/src", "apps/sidecar/src", "apps/webapp/app", "apps/admin/app"]);

  /** A LINE comment — decided by the scanner, not by a regex — holding an unpaired opener. */
  const trapsIn = (src: string): number[] => {
    const clean = withoutComments(src).split("\n");
    const hits: number[] = [];
    src.split("\n").forEach((raw, i) => {
      const at = raw.indexOf("//");
      if (at === -1 || clean[i]!.slice(at).trim() !== "") return;
      const body = raw.slice(at);
      if (body.includes("/" + "*") && !body.includes("*" + "/")) hits.push(i + 1);
    });
    return hits;
  };

  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(resolve(ROOT, rel))) {
      if (e === "node_modules" || e === "dist" || e === ".next") continue;
      const p = `${rel}/${e}`;
      if (statSync(resolve(ROOT, p)).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(p)) files.push(p);
    }
  };
  for (const r of ROOTS) walk(r);

  it("names subjects at all", () => {
    // Anti-vacuity: a renamed root would make the case below a loop over nothing.
    expect(files.length).toBeGreaterThan(300);
  });

  it("no line comment under the app roots opens a block the pair would close below", () => {
    const traps = files.flatMap((f) => trapsIn(read(f)).map((n) => `${f}:${n}`));
    expect(traps, `block-first trap(s): ${traps.slice(0, 6).join(", ")}`).toEqual([]);
  });

  it("…and the detector finds one when there is one", () => {
    // The positive control. Without it the case above is green for a broken detector.
    expect(trapsIn("const a = 1;\n// the `ohmail" + "/" + "*` tree\nconst b = 2;\n")).toEqual([2]);
    // A line comment whose opener PAIRS on its own line is not a trap, and must not be reported.
    expect(trapsIn("// an inline " + "/" + "* pair " + "*" + "/ in one comment\n")).toEqual([]);
  });
});

/**
 * AND THE PROPERTY OVER THE REAL SOURCES: every census that walks brackets over blanked code is
 * pointed at this scanner, and over the files those censuses read there is not one runaway span.
 * The list is derived from the censuses themselves — a file that imports this module — so a new
 * census joins the reading by importing it rather than by being added to a list here.
 */
describe("0 runaway spans over the sources the censuses read", () => {
  const SUBJECTS = [
    "packages/services/src/mailbox-service.ts",   // the file that produced the first runaway
    "packages/" + "db/src/tx.ts",
    "packages/api/src/router.ts",
    "apps/sidecar/src/engine.ts",
    "apps/mobile/src/engine/background.ts",
  ].filter((p) => { try { readFileSync(resolve(ROOT, p)); return true; } catch { return false; } });

  it("names subjects at all", () => {
    // Anti-vacuity: the case below is a loop over this list.
    expect(SUBJECTS.length).toBeGreaterThanOrEqual(4);
  });

  it("every `(` in every subject closes under the scanner", () => {
    const runaway: string[] = [];
    for (const rel of SUBJECTS) {
      const clean = withoutCommentsAndLiterals(read(rel));
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] !== "(") continue;
        if (!bracketSpan(clean, i).closed) runaway.push(`${rel}:${lineOf(clean, i)}`);
      }
    }
    expect(runaway, `runaway span(s): ${runaway.slice(0, 5).join(", ")}`).toEqual([]);
  });

  it("…and the two regexes produce runaways on the same subjects, which is the difference", () => {
    // The control. If this ever reads 0 the case above has stopped measuring anything.
    let runaway = 0;
    for (const rel of SUBJECTS) {
      const clean = twoRegexes(read(rel));
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === "(" && !bracketSpan(clean, i).closed) { runaway++; break; }
      }
    }
    expect(runaway).toBeGreaterThan(0);
  });
});

describe("withoutHashComments reads a shell script or a workflow as code", () => {
  const SRC = ["# a whole-line comment", "echo hi # a trailing one", `echo "a # b" 'c # d' $# \${#x} a#b`,
    "name: don't stop here", "  # an indented one", 'summary="$(run)"', ""].join("\n");

  it("blanks whole-line and trailing comments, keeps quoted and mid-word hashes, keeps every position", () => {
    const out = withoutHashComments(SRC);
    expect(out.length).toBe(SRC.length);
    expect(out.split("\n")).toEqual([" ".repeat(22), "echo hi" + " ".repeat(17), `echo "a # b" 'c # d' $# \${#x} a#b`,
      "name: don't stop here", " ".repeat(19), 'summary="$(run)"', ""]);
  });

  it("a commented-out line is not code: the shape a raw toContain over the file reads as present", () => {
    const commented = SRC.replace('summary="$(run)"', '# summary="$(run)"');
    expect(commented).toContain('summary="$(run)"');
    expect(withoutHashComments(commented)).not.toContain('summary="$(run)"');
  });
});
