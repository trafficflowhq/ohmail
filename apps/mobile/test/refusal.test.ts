import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { faultDetail, refuse, sayRefusal, type Refusal } from "../src/refusal";
import { REFUSAL_KEYS } from "../src/refusal-keys";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { StoreFault } from "../src/state/servers";

/**
 * ═══ A REFUSAL IS A VALUE, AND THIS IS WHERE ITS ARITY IS CHECKED ════════════════════════════
 *
 * `Refusal` names a deck key and carries `args`. The KEY is type-checked — a typo does not compile
 * — and the arity deliberately is not, because a mapped conditional type per arity reads worse than
 * the thing it protects. That trade is only honest if the arity is checked somewhere, so it is
 * checked here, at runtime, against every refusal the app can actually produce.
 *
 * The refusals are found by parsing the source for `refuse("key", …)` calls rather than by a list
 * somebody maintains: a list would drift, and the drift would be silent in exactly the way this
 * whole lane keeps finding.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const APP_DIR = path.join(HERE, "..", "app");
const WEB_SRC = path.join(HERE, "..", "web", "src");

/**
 * EVERY REFUSAL THE APP CAN PRODUCE, read off the source rather than off a list.
 *
 * Four things it used to miss, each of which made every assertion below vacuous for the calls it
 * could not see:
 *
 *  · **A KEY BEHIND A CONDITIONAL.** Only `ts.isStringLiteral(first)` was read, so
 *    `refuse(closed ? "a" : "b")` was skipped entirely — SIX keys in three call sites, none of
 *    them ever checked for deck membership, arity or an unfilled hole.
 *  · **AN ALIASED IMPORT.** The callee was compared to the literal text `refuse`, so
 *    `import { refuse as r }` would have hidden every call in that file. The local name is read
 *    off the import instead.
 *  · **`app/`.** The walk was given `src` only. Nothing there produces a refusal today; the point
 *    is that the first one would arrive unchecked.
 *  · **A KEY THAT CANNOT BE READ AT ALL** was silently dropped. It is recorded as unresolved now
 *    and fails, because a refusal nothing can check is exactly the one that breaks.
 */
interface FoundRefusal { key: string | null; args: number; where: string }

function refusalsIn(roots: string[]): FoundRefusal[] {
  const out: FoundRefusal[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, base); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
        true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

      /* THE LOCAL NAME OF THE BUILDER. `refuse` unless the file renamed it on import; a file that
         does not import it at all contributes nothing. The control's fixture declares it, so the
         fallback keeps that file readable too. */
      let local = "refuse";
      let imports = false;
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const clause = st.importClause?.namedBindings;
        if (clause === undefined || !ts.isNamedImports(clause)) continue;
        for (const el of clause.elements) {
          if ((el.propertyName ?? el.name).getText(sf) === "refuse") {
            local = el.name.getText(sf); imports = true;
          }
        }
      }
      if (!imports && !/\brefuse\s*\(/.test(sf.text)) continue;

      /** Every key a call site can produce — both arms of a conditional, recursively. */
      const keysOf = (n: ts.Node): (string | null)[] => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
        if (ts.isConditionalExpression(n)) return [...keysOf(n.whenTrue), ...keysOf(n.whenFalse)];
        if (ts.isParenthesizedExpression(n)) return keysOf(n.expression);
        if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return keysOf(n.expression);
        return [null];
      };

      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === local) {
          const first = n.arguments[0];
          const where = `${path.relative(base, full)}:`
            + `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
          if (first === undefined) out.push({ key: null, args: 0, where });
          else for (const key of keysOf(first)) {
            out.push({ key, args: n.arguments.length - 1, where });
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
  };
  for (const r of roots) walk(r, path.join(HERE, ".."));
  return out;
}

const refusalsInSource = (): FoundRefusal[] => refusalsIn([SRC, APP_DIR]);

/**
 * HOW MANY ARGUMENTS EACH DECK SENTENCE TAKES — required and total, read off `copy.en.ts`.
 *
 * `Function.length` stops at the first optional parameter, so it is a FLOOR and the arity check
 * built on it could only catch passing too few. Passing too MANY went unremarked, and a call that
 * hands a sentence an argument it does not interpolate is a value the reader never sees — the
 * shape a renamed or re-ordered parameter leaves behind.
 */
function deckArities(): Map<string, { required: number; total: number }> {
  const file = path.join(HERE, "..", "src", "copy.en.ts");
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Map<string, { required: number; total: number }>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n)) {
      const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)
        ? n.name.text : null;
      const fn = n.initializer;
      if (name !== null && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const params = fn.parameters;
        out.set(name, {
          required: params.filter((pp) => pp.questionToken === undefined
            && pp.initializer === undefined && pp.dotDotDotToken === undefined).length,
          total: params.some((pp) => pp.dotDotDotToken !== undefined)
            ? Number.POSITIVE_INFINITY : params.length,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * THE LOCAL NAME OF AN IMPORT IN ONE FILE — `refuse` unless that file renamed it.
 *
 * Every guard below matches a callee BY TEXT, and `import { refuse as r }` makes that text `r`.
 * The census at the top of this file already resolved the alias; the two AST guards did not, so
 * an aliased call escaped both of them while the census counted it. One resolver now, because
 * the same gap in two of three places is what a second copy always produces.
 */
const localNameOf = (sf: ts.SourceFile, imported: string, fallback: string): string => {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const named = st.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if ((el.propertyName ?? el.name).getText(sf) === imported) return el.name.getText(sf);
    }
  }
  return fallback;
};

const sample = (n: number): string[] => Array.from({ length: n }, (_, i) => `«v${i}»`);

describe("every refusal the app can produce", () => {
  const found = refusalsInSource();

  it("is found by parsing the source, and there are a lot of them", () => {
    /* The walk's own reach, for the reason the census has one: an empty list would make every
       assertion below vacuously true. */
    expect(found.length).toBeGreaterThan(25);
    expect(found.map((f) => f.key)).toContain("notPairedHere");
    /* BOTH ROOTS. `app/` produces no refusal today and the point is the first one that does. */
    expect(fs.existsSync(APP_DIR), "the app/ root does not exist, so scanning it proves nothing")
      .toBe(true);
    /* THE KEYS BEHIND A CONDITIONAL, which the previous walk skipped whole. Six of them, in three
       call sites, none of which had ever been checked for anything. */
    for (const key of ["pairManagedDeferred", "pairNoPairing", "pairNotStoredClosed",
      "pairNotStoredOpen", "baseApiStopped", "baseApiTimeout"]) {
      expect(found.map((f) => f.key), `a key behind a conditional is invisible: ${key}`)
        .toContain(key);
    }
  });

  it("names every key of the phone's list: a key no call names any more leaves the list and the catalogue", () => {
    /* The list (`refusal-keys.ts`) is what the phone's catalogue answers, sentence by sentence. A `refuse()` call
       removed later leaves its key and both its sentences behind unless this reads them off the source. */
    const named = new Set(refusalsIn([SRC, APP_DIR, WEB_SRC]).map((f) => f.key));
    expect(REFUSAL_KEYS.filter((key) => !named.has(key)), "listed, and named by no refuse() call").toEqual([]);
  });

  it("has no key it could not read — an unreadable key is one nothing checks", () => {
    const unreadable = found.filter((f) => f.key === null).map((f) => f.where);
    expect(unreadable, "a refusal key that cannot be read from the source was silently dropped")
      .toEqual([]);
  });

  it("FINDS the aliased, nested and conditional shapes — the control", () => {
    const control = refusalsIn([path.join(HERE, "fixtures", "refusal-control")]);
    const keys = control.map((c) => c.key);
    /* An aliased builder in a nested directory: the alias, then the two arms, then the one that
       cannot be resolved and must be reported rather than dropped. */
    expect(keys, "an aliased `refuse` was not recognised").toContain("notPairedHere");
    expect(keys, "a conditional's first arm was skipped").toContain("pairNotStoredClosed");
    expect(keys, "a conditional's second arm was skipped").toContain("pairNotStoredOpen");
    expect(keys.filter((k) => k === null).length,
      "an unreadable key was dropped instead of reported").toBeGreaterThan(0);
    expect(control.some((c) => c.where.includes("nested")),
      "the walk did not recurse into a subdirectory").toBe(true);
  });

  it("names a key that exists in both decks", () => {
    const keys = new Set(Object.keys(EN));
    for (const { key, where } of found) {
      if (key === null) continue;                    // reported by its own case above
      expect(keys, `${where}: refuse("${key}") names no deck key`).toContain(key);
      expect(Object.keys(DE), `${where}: "${key}" is missing from the German deck`).toContain(key);
    }
  });

  it("passes EXACTLY the arguments its sentence takes — too many is as wrong as too few", () => {
    /*
     * This was a floor (`>= Function.length`), which cannot see a call passing an argument the
     * sentence does not interpolate — the value a reader never sees, and the shape a renamed or
     * re-ordered parameter leaves behind. The deck's real signature is read from its source, so
     * optional parameters raise the ceiling instead of lowering the floor.
     */
    const arities = deckArities();
    for (const { key, args, where } of found) {
      if (key === null) continue;
      const member = (EN as unknown as Record<string, unknown>)[key];
      if (typeof member !== "function") {
        expect(args, `${where}: refuse("${key}") passes ${args} argument(s) to a plain sentence`)
          .toBe(0);
        continue;
      }
      const arity = arities.get(key);
      expect(arity, `${where}: "${key}" is a function in the deck but its signature was not read`)
        .toBeDefined();
      expect(args, `${where}: refuse("${key}") passes ${args} argument(s), the sentence needs at `
        + `least ${arity!.required}`).toBeGreaterThanOrEqual(arity!.required);
      expect(args, `${where}: refuse("${key}") passes ${args} argument(s), the sentence takes at `
        + `most ${arity!.total}`).toBeLessThanOrEqual(arity!.total);
    }
  });

  it("renders in both languages with nothing left unfilled", () => {
    /*
     * The failure this catches: a sentence rendered with a missing argument comes back with
     * `undefined` in it, which is what a reader sees. Every refusal is rendered in both languages
     * with a full set of markers and checked for that.
     */
    try {
      for (const { key, args, where } of found) {
        if (key === null) continue;                  // reported by its own case above
        const r: Refusal = refuse(key as Parameters<typeof refuse>[0], ...sample(Math.max(args, 3)));
        for (const locale of ["en", "de"] as const) {
          setActiveLocale(locale);
          const said = sayRefusal(r);
          expect(said, `${where}: "${key}" renders nothing in ${locale}`).not.toBe("");
          expect(said, `${where}: "${key}" leaves an unfilled hole in ${locale}`)
            .not.toMatch(/undefined|\[object Object\]|NaN/);
        }
      }
    } finally {
      resetLocaleRegisterForTests();
    }
  });
});

describe("a refusal held in state follows a later language switch", () => {
  /*
   * THE DEFECT THIS TYPE EXISTS FOR, ASSERTED RATHER THAN DESCRIBED.
   *
   * `net/connection.tsx` used to put a FORMATTED sentence into React state, so switching language
   * with a refusal on screen left the sentence in the language it was produced in. It stores a
   * `Refusal` now and `app/servers.tsx` renders it, so the same value says the right thing on
   * either side of the switch.
   */
  it("says the same thing in whichever language is active when it is rendered", () => {
    try {
      resetLocaleRegisterForTests();
      const held = refuse("notPairedHere");           // …as connection.tsx now stores it
      expect(sayRefusal(held)).toBe(EN.notPairedHere);
      setActiveLocale("de");
      expect(sayRefusal(held), "the refusal did not follow the switch").toBe(DE.notPairedHere);
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("is stored as a KEY, not as words — the property that makes the above possible", () => {
    /* If a producer ever went back to storing the sentence, the test above would still pass for
       whatever it happened to store. This asserts the shape instead. */
    const held: Refusal = refuse("pairUnreachable", "ECONNREFUSED");
    expect(held.say).toBe("pairUnreachable");
    expect(held.args).toEqual(["ECONNREFUSED"]);
    expect(JSON.stringify(held)).not.toContain("could not reach");
  });

  it("carries a nested refusal WHOLE, so the clause inside follows the switch too", () => {
    /* The defect one level down. `connection.tsx` built `refuse("outer", sayRefusal(inner))`,
       which renders the inner half at production time: the outer sentence followed a language
       change and the clause inside it did not. The inner refusal is passed whole now. */
    try {
      resetLocaleRegisterForTests();
      const held = refuse("serversPurgeRefused", refuse("installPurgeFailed", "EPERM"));
      const en = sayRefusal(held);
      expect(en).toBe(EN.serversPurgeRefused(EN.installPurgeFailed("EPERM")));
      setActiveLocale("de");
      const de = sayRefusal(held);
      expect(de, "the nested clause did not follow the switch")
        .toBe(DE.serversPurgeRefused(DE.installPurgeFailed("EPERM")));
      expect(de).not.toBe(en);
      expect(de, "an English clause survived inside the German sentence")
        .not.toContain(EN.installPurgeFailed("EPERM"));
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("words a fault this app authored and quotes anything else verbatim — both LATE", () => {
    /* `faultDetail` used to return `Copy.storeFault(code)`, formatted where the error was caught,
       which put frozen English inside six otherwise-live refusals. It returns a nested refusal. */
    try {
      resetLocaleRegisterForTests();
      const ours = faultDetail(new StoreFault("purge_refused", "the keystore would not give it up"));
      const theirs = faultDetail(new Error("ECONNREFUSED 10.0.0.2:993"));
      expect(theirs, "a platform diagnostic was reworded").toContain("ECONNREFUSED 10.0.0.2:993");
      expect(sayRefusal(refuse("forgetMailRemains", ours))).toBe(
        EN.forgetMailRemains(EN.storeFault("purge_refused")));
      setActiveLocale("de");
      expect(sayRefusal(refuse("forgetMailRemains", ours)), "the fault stayed in English")
        .toBe(DE.forgetMailRemains(DE.storeFault("purge_refused")));
      expect(sayRefusal(refuse("forgetMailRemains", theirs)),
        "the platform's own words were translated").toContain("ECONNREFUSED 10.0.0.2:993");
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  /*
   * ═══ AND THE GUARD, WITH SOMETHING IT MUST FIND ══════════════════════════════════════════
   *
   * The guard this replaces read the producers for `reason:\s*Copy\.` — and the real defect was
   * spelled `refuse("outer", sayRefusal(inner))`, which that pattern cannot match. It was green
   * over the thing it was written for, for its whole life.
   *
   * So the shape is the one that matters — copy FORMATTED inside a refusal's arguments, however
   * it is spelled — and the same detector is pointed at a fixture of plants it must find and
   * non-plants it must leave alone. A guard nobody has watched find something is not evidence.
   */
  const formattedCopyInRefusals = (root: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
          true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        /** A subtree that turns copy into words: a deck read, or a refusal rendered early. */
        const copyName = localNameOf(sf, "Copy", "Copy");
        const sayNames = new Set([
          localNameOf(sf, "sayRefusal", "sayRefusal"),
          localNameOf(sf, "sayArg", "sayArg"),
        ]);
        const formats = (n: ts.Node): boolean => {
          if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === copyName) return true;
          if (ts.isCallExpression(n) && sayNames.has(n.expression.getText(sf))) return true;
          let found = false;
          ts.forEachChild(n, (c) => { if (!found && formats(c)) found = true; });
          return found;
        };
        const refuseName = localNameOf(sf, "refuse", "refuse");
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === refuseName) {
            for (const arg of n.arguments.slice(1)) {
              if (!formats(arg)) continue;
              const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
              hits.push(`${path.relative(root, full)}:${line}  ${arg.getText(sf)}`);
            }
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
      }
    };
    walk(root);
    return hits;
  };

  it("FINDS formatted copy in a refusal's arguments — the control, on planted shapes", () => {
    const hits = formattedCopyInRefusals(path.join(HERE, "fixtures", "refusal-control"));
    const planted = hits.map((h) => h.split(":")[1]).sort();
    /* Five plants, at the five lines the fixture marks PLANT. If a capability stops working the
       count moves and the message names the shape that got through. */
    /* Six: five in `planted.ts`, plus the ALIASED one in `nested/deep.ts` — `r("outer", say(x))`,
       which carries the alias on the builder and on the renderer at once. */
    expect(hits.length, `the control missed a plant — found:\n${hits.join("\n")}`).toBe(6);
    expect(hits.join("\n"), "an aliased refuse/sayRefusal pair escaped the guard")
      .toContain("say(inner2 as never)");
    expect(hits.join("\n")).toContain("sayRefusal(inner)");
    expect(hits.join("\n"), "a deck read past the first argument was missed")
      .toContain('Copy.pairFailed("x")');
    expect(hits.join("\n"), "a template hole was missed").toContain("held: ${sayRefusal(inner)}");
    expect(hits.join("\n"), "a read nested in a call was missed").toContain("[Copy.notPairedHere]");
    /* …and the four non-plants: rendering copy is normal everywhere that is not a refusal arg. */
    expect(hits.join("\n"), "String(err) was flagged").not.toContain("String(err)");
    expect(hits.join("\n"), "the nested refusal itself was flagged").not.toContain("inner as never");
  });

  /**
   * A CAUGHT ERROR STRINGIFIED STRAIGHT INTO A REFUSAL.
   *
   * `String(err)` is right for a platform exception and wrong for a failure this app authored:
   * a `StoreFault` carries a code the deck has a sentence for, and stringifying it puts English
   * inside a German sentence. `faultDetail` is the seam that tells the two apart, so a CATCH
   * VARIABLE must reach a refusal through it. Six refusals were built the other way — the boot's
   * mirror failure, three from the install marker, two from the connection layer — and each was
   * a live sentence with a frozen clause in it.
   *
   * The catch variable is resolved by walking to the enclosing `catch`, so `String(res.status)`
   * and `String(n)` are not swept up with it.
   */
  const stringifiedCatchInRefusals = (root: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
          true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        /** The names bound by every `catch` this node sits inside. */
        const caughtNames = (n: ts.Node): Set<string> => {
          const names = new Set<string>();
          for (let p: ts.Node | undefined = n; p !== undefined; p = p.parent) {
            if (ts.isCatchClause(p) && p.variableDeclaration !== undefined) {
              names.add(p.variableDeclaration.name.getText(sf));
            }
          }
          return names;
        };
        const refuseName = localNameOf(sf, "refuse", "refuse");
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === refuseName) {
            const caught = caughtNames(n);
            for (const arg of n.arguments.slice(1)) {
              const scan = (x: ts.Node): void => {
                if (ts.isCallExpression(x) && x.expression.getText(sf) === "String"
                  && x.arguments.length === 1
                  && caught.has(x.arguments[0]!.getText(sf))) {
                  hits.push(`${path.relative(root, full)}:`
                    + `${sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1}  `
                    + `${x.getText(sf)}`);
                }
                ts.forEachChild(x, scan);
              };
              scan(arg);
            }
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
      }
    };
    walk(root);
    return hits;
  };

  it("FINDS a stringified catch variable — the control, on planted shapes", () => {
    const hits = stringifiedCatchInRefusals(path.join(HERE, "fixtures", "refusal-control"));
    /* Four: three in `planted.ts`, plus the ALIASED one in `nested/deep.ts`. */
    expect(hits.length, `the control missed a plant — found:\n${hits.join("\n")}`).toBe(4);
    expect(hits.join("\n"), "an aliased refuse escaped the stringified-catch guard")
      .toContain("deep.ts");
    expect(hits.join("\n"), "faultDetail was flagged").not.toContain("faultDetail");
    expect(hits.join("\n"), "a non-error String() was flagged").not.toContain("String(n)");
    expect(hits.join("\n"), "a status code was flagged").not.toContain("res.status");
  });

  /**
   * COPY HANDED TO A REACT SETTER — the shape `refuse(...)` guards cannot see.
   *
   * `FoldersGroup.tsx` held its folder-name problem as `useState<string | null>` and fed it
   * `Copy.folderNameSpaces`. Nothing in this file looked at that: both AST guards above start
   * from a `refuse(...)` call, and a setter is not one. Type an invalid name on an English
   * phone, change the phone's language, come back — German heading, English line under it.
   *
   * The rule is the setter convention, which React makes reliable: a call to `setX` whose
   * argument tree reads the deck is storing words instead of the reason for them.
   */
  const copyIntoSetters = (root: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
          true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const copyName = localNameOf(sf, "Copy", "Copy");
        const reads = (n: ts.Node): boolean => {
          if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === copyName) return true;
          let f = false;
          ts.forEachChild(n, (c) => { if (!f && reads(c)) f = true; });
          return f;
        };
        /* A DECK READ REACHED THROUGH A LOCAL NAME. `const words = Copy.x; setProblem(words)`
           stores exactly the same frozen sentence, and a check that only looks INSIDE the
           setter's argument sees an identifier and nothing else. Every local initialised from
           the deck is collected first, and an argument naming one of them counts as a read. */
        const viaLocal = new Set<string>();
        const collect = (n: ts.Node): void => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
            && n.initializer !== undefined && reads(n.initializer)) {
            viaLocal.add(n.name.text);
          }
          ts.forEachChild(n, collect);
        };
        ts.forEachChild(sf, collect);
        const readsOrNames = (n: ts.Node): boolean => {
          if (reads(n)) return true;
          if (ts.isIdentifier(n) && viaLocal.has(n.text)) return true;
          let f = false;
          ts.forEachChild(n, (c) => { if (!f && readsOrNames(c)) f = true; });
          return f;
        };
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
            && /^set[A-Z]/.test(n.expression.text)) {
            for (const arg of n.arguments) {
              if (!readsOrNames(arg)) continue;
              hits.push(`${path.relative(root, full)}:`
                + `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  `
                + `${n.getText(sf).replace(/\s+/g, " ").slice(0, 90)}`);
            }
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
      }
    };
    walk(root);
    return hits;
  };

  it("FINDS copy handed to a setter — the control", () => {
    const hits = copyIntoSetters(path.join(HERE, "fixtures", "refusal-control"));
    /* Three: a direct read, one nested a level deeper, and one reached through a LOCAL NAME —
       `const words = Copy.x; setProblem(words)`, where the argument is only an identifier and a
       check that looks inside the argument alone sees nothing. */
    expect(hits.length, `the control missed a plant — found:\n${hits.join("\n")}`).toBe(3);
    expect(hits.join("\n")).toContain("setProblem");
    expect(hits.join("\n"), "a deck read reached through a local name escaped")
      .toContain("setProblem(words)");
    expect(hits.join("\n"), "a setter given a REFUSAL was flagged").not.toContain("setOk");
  });

  it("the engine throws CODES, never English — its throws end up inside German refusals", () => {
    /*
     * `engine/boot.ts` threw bare `Error`s with English messages, and two paths carry them
     * straight into a translated sentence: `forgetProfile` catches `forgetMirror` and hands the
     * error to `faultDetail`, and `SyncRunner` catches the account guard and stores the result as
     * the standing sync failure. `faultDetail` words OUR failures and quotes everyone else's — it
     * decides which by asking `isStoreFault`, so a bare `Error` is quoted verbatim, in English,
     * inside a German refusal.
     *
     * Scoped to `engine/` because that is where the refusal path begins. The four
     * `useX() outside <XProvider>` throws elsewhere are developer faults no reader can reach.
     */
    const dir = path.join(SRC, "engine");
    /** A bare `throw err` inside a catch is a re-throw: it carries whatever it caught. */
    const isRethrow = (e: ts.Node, sf: ts.SourceFile): boolean => {
      if (!ts.isIdentifier(e)) return false;
      for (let q: ts.Node | undefined = e; q !== undefined; q = q.parent) {
        if (ts.isCatchClause(q) && q.variableDeclaration !== undefined
          && q.variableDeclaration.name.getText(sf) === e.text) return true;
      }
      return false;
    };
    const scan = (dir: string): { bare: string[]; looked: number } => {
    const bare: string[] = [];
    let looked = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        looked += 1;
        /* INVERTED, because a list of forbidden spellings is a list somebody has to keep.
           This matched the exact form `throw new Error(...)` and let through `throw Error(...)`,
           `throw new TypeError(...)`, and an Error held in a variable — each of which reaches
           `faultDetail`, is classified as somebody else's, and is quoted in English inside a
           German refusal. The engine may throw a StoreFault, or re-throw what it caught. */
        if (ts.isThrowStatement(n) && n.expression !== undefined
          && !(ts.isNewExpression(n.expression)
            && n.expression.expression.getText(sf) === "StoreFault")
          && !isRethrow(n.expression, sf)) {
          bare.push(`${path.basename(dir)}/${entry.name}:`
            + `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  `
            + `${n.getText(sf).replace(/\s+/g, " ").slice(0, 90)}`);
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    return { bare, looked };
    };

    /* THE CONTROL FIRST: four ways to throw the same English sentence, and two that are fine. */
    const ctl = scan(path.join(HERE, "fixtures", "engine-control"));
    expect(ctl.bare.length, `the control missed a plant — found:\n${ctl.bare.join("\n")}`).toBe(4);
    expect(ctl.bare.join("\n"), "a StoreFault was flagged").not.toContain("StoreFault");
    expect(ctl.bare.join("\n"), "a re-throw was flagged").not.toContain("throw err");

    const { bare, looked } = scan(dir);
    expect(looked, "no engine file was parsed, so finding nothing means nothing")
      .toBeGreaterThan(500);
    expect(bare, "the engine throws something other than a StoreFault — whatever it is, its "
      + "message reaches a reader through faultDetail, in the language it was written in:\n"
      + bare.join("\n"))
      .toEqual([]);
  });

  /**
   * A TOAST THAT HOLDS WORDS — the last state in this app that did.
   *
   * The toast queue carried `{ id, message: string }` and every producer called
   * `toast(Copy.x)`, so a toast already on screen kept the language it was raised in while the
   * heading above it followed a switch. It carries a refusal now and `chrome.tsx` writes it out
   * with `sayArg`, which is the same rule the refusals and the sync failure already follow.
   *
   * The guard is on the PRODUCERS, because that is where the defect can come back: widening the
   * queue to accept a string again would be visible here, and a guard that tolerated one would
   * be no guard at all.
   */
  const copyIntoToasts = (root: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest,
          true, entry.name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const copyName = localNameOf(sf, "Copy", "Copy");
        const reads = (n: ts.Node): boolean => {
          if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === copyName) return true;
          let f = false;
          ts.forEachChild(n, (c) => { if (!f && reads(c)) f = true; });
          return f;
        };
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && /^(toast|showToast)$/.test(n.expression.getText(sf))) {
            for (const arg of n.arguments) {
              if (!reads(arg)) continue;
              hits.push(`${path.relative(root, full)}:`
                + `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  `
                + `${n.getText(sf).replace(/\s+/g, " ").slice(0, 84)}`);
            }
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
      }
    };
    walk(root);
    return hits;
  };

  it("finds NO copy handed to a toast — the producers, where it can come back", () => {
    const hits = [...copyIntoToasts(SRC), ...copyIntoToasts(APP_DIR)];
    expect(hits, "a toast is being raised with words instead of a refusal — it will keep the "
      + `language it was raised in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the toast entry carries a refusal, not a sentence", () => {
    /* The receiving half. A producer guard alone would stay green over the entry widened back
       to `string`, because every producer would still be passing a refusal — and the next one
       would not have to. Read as a TYPE and not as a line of text: this asked `world.tsx` for
       the words `toastQueue … say: RefusalArg` and went red the day the queue became one slot,
       while the property it defends never moved. The entry lives in `state/toast-one.ts` now. */
    const file = path.join(SRC, "state/toast-one.ts");
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let say: string | null = null;
    const visit = (n: ts.Node): void => {
      if (ts.isInterfaceDeclaration(n) && n.name.text === "ToastEntry") {
        for (const m of n.members) {
          if (ts.isPropertySignature(m) && m.name.getText() === "say") say = m.type?.getText() ?? "«untyped»";
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    expect(say, "ToastEntry has no `say` — the receiving half moved and nothing read it").not.toBeNull();
    expect(say, "the toast entry holds words again").toBe("RefusalArg");
    const live = fs.readFileSync(path.join(SRC, "state/live.ts"), "utf8");
    expect(live, "the toast port takes a sentence again").not.toMatch(/toast: \(sentence: string\)/);
    expect(live).toMatch(/toast: \(say: RefusalArg, opts\?: ToastOpts\)/);
  });

  it("finds NO copy handed to a setter in the shipped source", () => {
    /* BOTH ROOTS. This scanned `src/` only, and `app/` is this lane's too — a screen there
       could store a deck read in state and nothing would say so. */
    const hits = [...copyIntoSetters(SRC), ...copyIntoSetters(APP_DIR)];
    expect(hits, "a deck read is being stored in React state — it will freeze in the language it "
      + `was read in; store the refusal and format it where it is shown:\n${hits.join("\n")}`)
      .toEqual([]);
  });

  it("finds NO stringified catch variable in the shipped source", () => {
    const hits = stringifiedCatchInRefusals(SRC);
    expect(hits, "a caught error is being stringified into a refusal — use faultDetail(err), so a\n"
      + `fault this app authored is worded where it is shown:\n${hits.join("\n")}`).toEqual([]);
  });

  it("finds NONE in the shipped source", () => {
    const hits = formattedCopyInRefusals(SRC);
    expect(hits, `copy is being formatted into a refusal's arguments again:\n${hits.join("\n")}`)
      .toEqual([]);
  });
});
