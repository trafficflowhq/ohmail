import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ NO MEMOIZED CLOSURE SHARES A SCOPE WITH A WHOLE-MIRROR DERIVATION ══════════════════════
 *
 * The released desktop's webview grew about a gigabyte an idle hour, and the mechanism —
 * The project's design notes §2, read off heap-snapshot retainer paths — is one
 * sentence: every closure created in ONE render of a component shares ONE engine-level scope
 * holding that render's entire frame. So a memoized callback React hands back unchanged pins the
 * render it was made in, including whatever whole-mirror derivation that render computed. In this
 * shell that is a consent partition and a projection over every message in the mailbox.
 *
 * `useStableCallback` is the fix, and it is not enough on its own: it removes the closures that
 * exist today and says nothing about the next one. This is the half that refuses the next one.
 *
 * ── WHY A SOURCE CENSUS AND NOT A REACHABILITY TEST ─────────────────────────────────────────
 *
 * Because the reachability test was tried and MEASURED not to reproduce it (§8): mounting the
 * shell and driving forty real derivations leaves four alive under a unit collector, so the
 * jsdom/V8 census cannot tell a bounded scope from a chain. `stable-callback.test.tsx` keeps the
 * hook's own reachability property, where a collector can see it. What is decidable here is the
 * MECHANISM: a memoized closure in a scope that also holds a derivation over the whole mirror.
 *
 * ── WHAT IS AN OFFENCE ──────────────────────────────────────────────────────────────────────
 *
 * Three arms, over the FRAMES the new shell composes (`SHELL_FRAMES` below): the mail ground's pieces
 * (`packages/app/src/mail/ground/`, stood by `MailGround.tsx` once per mounted frame) and the hook modules
 * they call there, the consent row and the partition, each place's `Seat.tsx`, and the places' live hooks
 * (the `live*.ts` files of `packages/app-logic/src`, at any depth). Re-pointed from today's `ShellInner` and its `shell-*` frames,
 * which the switch deletes (RULING-NEW-SHELL-FIRST D (3): "render-scope-census (no memo keeps the whole
 * mirror)"); the arms and their expectations are today's, word for word:
 *
 *  1. No frame holds a memoized closure at all: no `useCallback`, and no `useMemo` whose callback
 *     returns a function. Every frame is a scope that reaches the whole mirror.
 *  2. A hook a frame calls WITH one of that frame's memoized values holds no memoized closure
 *     either. A custom hook runs in its own frame, but that frame holds the arguments it was
 *     handed, so a surviving closure there pins the same derivation one level out. A value a
 *     frame BOUND from another frame's hook counts as one of its own: after the split the
 *     partition and the projection reach `useScreenerState` through `useShellDerivations`'s
 *     record, and a `memoNames`-only reading stopped seeing them the moment they moved.
 *  3. No ground module, no `Seat.tsx` and no live hook module exporting a hook the composition calls
 *     is MISSING from the manifest. Without it a frame escapes arms 1 and 2 by not being listed, which
 *     is the quietest way for this census to stop covering the code it is about.
 *
 * Arm 2 admits a scalar: a hook handed a timestamp string pins a timestamp, and the same document
 * records the measurement behind that — the engine context-allocates only what an inner closure
 * REFERENCES, so a closure over nothing heavy holds nothing. Those pairs are named in
 * {@link EXCEPTIONS} with the reason, one line each, and everything else is refused.
 */

const ROOT = resolve(process.cwd());
/** The ground's folder: every piece `MailGround.tsx` stands, and the hook modules the pieces call. */
const GROUND_DIR = "packages/app/src/mail/ground";
/** Where a place's seat stands (`<place>/Seat.tsx`). */
const SEATS_DIR = "packages/app/src";
/** Where the places' live hooks stand (`live*.ts`, at any depth). */
const LIVE_DIR = "packages/app-logic/src";

/** The frames, from the repository's root. A module lands here in the same commit that creates it. */
const SHELL_FRAMES: readonly string[] = [
  /* The mail ground's pieces, in `MailGround.tsx`'s order. */
  `${GROUND_DIR}/ManagedMount.tsx`, `${GROUND_DIR}/MailStateMount.tsx`, `${GROUND_DIR}/ConsentMount.tsx`,
  `${GROUND_DIR}/PresentedMount.tsx`, `${GROUND_DIR}/DoorsMount.tsx`, `${GROUND_DIR}/MailBoot.tsx`,
  `${GROUND_DIR}/ScreenerMount.tsx`, `${GROUND_DIR}/WritingMount.tsx`, `${GROUND_DIR}/PullMount.tsx`,
  `${GROUND_DIR}/SendWaitsRelay.tsx`,
  `${GROUND_DIR}/MailKeys.tsx`, `${GROUND_DIR}/MailNotices.tsx`, `${GROUND_DIR}/MailConnection.ts`,
  `${GROUND_DIR}/MailRail.ts`, `${GROUND_DIR}/MailBadge.ts`, `${GROUND_DIR}/MailSystemNotices.ts`,
  /* The hook modules the pieces call. */
  "packages/app/src/settings/general/boot-face.ts", `${GROUND_DIR}/boot-locale.ts`, `${GROUND_DIR}/boot-marks.ts`,
  `${GROUND_DIR}/boot-setup.ts`, `${GROUND_DIR}/boot-visit.ts`, `${GROUND_DIR}/boot-wake.ts`,
  `${GROUND_DIR}/door-inputs.ts`, `${GROUND_DIR}/first-run-owed.ts`, `${GROUND_DIR}/send-notices.ts`,
  `${GROUND_DIR}/update-notice.ts`, `${GROUND_DIR}/writing-inputs.ts`,
  /* The list "Show them" opens, which `MailNotices` draws, and its `useQueued`. */
  `${GROUND_DIR}/UnsavedList.tsx`,
  /* The consent row's call and the partition's derivation (frames of today's manifest, called by the ground). */
  "packages/app-logic/src/consent/consent-row.ts", "packages/app-logic/src/consent/partition.ts",
  /* Each place's seat, and the live hooks it and the ground call. */
  "packages/app/src/address/Seat.tsx",
  "packages/app/src/ohbox/Seat.tsx",
  "packages/app/src/drafts/Seat.tsx",
  "packages/app/src/folder/Seat.tsx",
  "packages/app/src/history/Seat.tsx",
  "packages/app/src/piles/Seat.tsx",
  "packages/app/src/search/Seat.tsx",
  "packages/app/src/stream/Seat.tsx",
  "packages/app/src/tags/Seat.tsx",
  "packages/app/src/trash/Seat.tsx",
  `${GROUND_DIR}/desktop-offer.ts`,
  "packages/app-logic/src/place-list/live.ts",
  "packages/app-logic/src/address/live.ts",
  "packages/app-logic/src/folder/live.ts",
  "packages/app-logic/src/history/live.ts",
  "packages/app-logic/src/piles/live.ts",
  "packages/app-logic/src/search/live.ts",
  "packages/app-logic/src/search/live-open.ts",
  "packages/app-logic/src/streams/live.ts",
  "packages/app-logic/src/tags/live.ts",
  "packages/app-logic/src/trash/live.ts",
  "packages/app-logic/src/ohbox/live.ts", "packages/app-logic/src/ohbox/live-mirror.ts",
  "packages/app-logic/src/ohbox/live-open.ts", "packages/app-logic/src/ohbox/live-verbs.ts",
  "packages/app-logic/src/screener/live.ts",
];

/** Absolute paths for the manifest, refusing a frame the tree does not have. */
function shellFramePaths(root: string): string[] {
  return SHELL_FRAMES.map((name) => {
    const full = resolve(root, name);
    if (!existsSync(full)) throw new Error(`shell frame not found: ${name}`);
    return full;
  });
}

const FRAMES = shellFramePaths(ROOT);

/**
 * THE FLOORS, AS SUMS OVER THE MANIFEST. They were per-file while the shell was one file, and a
 * split would have walked each of them under its threshold with nothing red. A move carries its
 * memos and its callbacks from one frame to another, so the SUM holds; these may only hold or
 * rise, and a lane that lowers one is refused by name in review.
 *
 * Measured afresh over THIS manifest when the census was re-pointed from today's shell (whose sums were
 * 64, 96 and 51 over its nine frames): the numbers are the new composition's own, read once with every
 * frame above parsed, and from here they only hold or rise.
 */
const FLOORS = { memoNames: 36, stableCallbacks: 27, hookCalls: 236 } as const;

/**
 * Hook calls whose module keeps a memoized closure while taking one of the shell's memoized
 * values — accepted because the value is a SCALAR and pins nothing.
 *
 * A pair reaches this table only with the argument's own definition read: `settingsStamp` is
 * `string | null` (the settings entity's `updatedAt`), not a derivation over the mirror.
 */
const EXCEPTIONS: ReadonlyArray<{ hook: string; argument: string; because: string }> = [
  {
    hook: "useConsentState",
    argument: "settingsStamp",
    because: "a `string | null` timestamp, not a derivation — the frame pins a stamp",
  },
  {
    hook: "useConsentState",
    argument: "windowOwners",
    because: "a `string | null` key of sorted `id:role` pairs, not a derivation — the frame pins a string",
  },
];

/** Hooks whose frame cannot hold a derivation: React's own state and ref primitives. */
const PRIMITIVES = new Set(["useMemo", "useState", "useRef", "useEffect", "useLayoutEffect", "useContext"]);

function parseText(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(
    name, text, ts.ScriptTarget.Latest, true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function parse(file: string): ts.SourceFile {
  return parseText(readFileSync(file, "utf8"), file);
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * The memoized closures in one file: `useCallback`, and `useMemo` whose callback RETURNS a
 * function. A `useMemo` over data is not one of these — the value it keeps is not a closure and
 * carries no scope.
 *
 * A real parse and not a regex, on `scripts/box-files.mjs`'s measured lesson: a token scanner
 * reads an `import … from` sequence out of a template literal, and the same would go for a hook
 * name quoted in a docblock. To a parser a comment is not a call.
 */
function memoizedClosuresIn(text: string, label: string): string[] {
  const sf = parseText(text, label);
  const sites: string[] = [];
  const returnsAFunction = (fn: ts.Expression): boolean => {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
    const body = fn.body;
    if (!ts.isBlock(body)) return ts.isArrowFunction(body) || ts.isFunctionExpression(body);
    let found = false;
    const scan = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression
        && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) found = true;
      // Not into a nested function: its `return` belongs to it, not to the memo.
      if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node)) {
        ts.forEachChild(node, scan);
      }
    };
    ts.forEachChild(body, scan);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "useCallback") sites.push(`useCallback at ${label}:${lineOf(sf, node)}`);
      const first = node.arguments[0];
      if (name === "useMemo" && first !== undefined && returnsAFunction(first)) {
        sites.push(`useMemo returning a function at ${label}:${lineOf(sf, node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function memoizedClosures(file: string): string[] {
  return memoizedClosuresIn(readFileSync(file, "utf8"), relative(ROOT, file));
}

interface ShellRead {
  memoNames: Set<string>;
  /** Names this frame BOUND from a manifest hook's record — another frame's derivations. */
  fromFrames: Set<string>;
  stableCallbacks: number;
  /** Every `use…` call in the shell that is not a React primitive, with its identifier arguments. */
  hookCalls: Array<{ hook: string; args: string[] }>;
  imports: Map<string, string>;
}

function readFrame(file: string, frameHooks: ReadonlySet<string> = new Set()): ShellRead {
  const sf = parse(file);
  const out: ShellRead = {
    memoNames: new Set(), fromFrames: new Set(), stableCallbacks: 0, hookCalls: [], imports: new Map(),
  };
  const visit = (node: ts.Node): void => {
    /* `const { presented, … } = useShellDerivations(…)`: the record's fields ARE this frame's
       derivations, held here exactly as a local `useMemo` would be. Counted for arm 2 and NOT
       for the floors, which stay a count of the memos a frame actually computes. */
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.initializer && ts.isCallExpression(node.initializer)) {
      const hook = calleeName(node.initializer.expression);
      if (hook !== null && frameHooks.has(hook)) {
        for (const el of node.name.elements) if (ts.isIdentifier(el.name)) out.fromFrames.add(el.name.text);
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause.name) out.imports.set(clause.name.text, spec);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const e of clause.namedBindings.elements) out.imports.set(e.name.text, spec);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "useStableCallback") out.stableCallbacks += 1;
      if (name === "useMemo" && node.parent && ts.isVariableDeclaration(node.parent)
        && ts.isIdentifier(node.parent.name)) {
        out.memoNames.add(node.parent.name.text);
      }
      if (name !== null && /^use[A-Z]/.test(name) && !PRIMITIVES.has(name) && name !== "useStableCallback") {
        const args: string[] = [];
        for (const a of node.arguments) {
          if (ts.isIdentifier(a)) args.push(a.text);
          // A hook taking one options object: its shorthand and identifier properties are its
          // arguments, and this shell hands `{ count }`-shaped options to two of them.
          else if (ts.isObjectLiteralExpression(a)) {
            for (const p of a.properties) {
              if (ts.isShorthandPropertyAssignment(p)) args.push(p.name.text);
              else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) args.push(p.initializer.text);
            }
          }
        }
        out.hookCalls.push({ hook: name, args });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A hook declared in this frame or imported from a relative or app-logic module. */
function moduleOf(frame: string, shell: ShellRead, hook: string): string | null {
  const spec = shell.imports.get(hook);
  if (spec === undefined) {
    const local = parse(frame).statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === hook);
    return local ? frame : null;
  }
  const logic = /^@ohmail\/app-logic\/(.+)$/.exec(spec);
  if (logic === null && !spec.startsWith(".")) return null;
  const base = logic !== null
    ? resolve(ROOT, "packages/app-logic/src", logic[1]!)
    : resolve(dirname(frame), spec.replace(/\.js$/, ""));
  return [".ts", ".tsx", "/index.ts", "/index.tsx"].map((e) => base + e).find((f) => existsSync(f)) ?? null;
}

/**
 * Every `use…` identifier the composition CALLS: each frame of the manifest. Arm 3 asks which ground modules,
 * seats and live modules those names come from, so a module reached only through a re-export is judged by the
 * call, not the import.
 */
function hooksCalledByTheShell(): Set<string> {
  const out = new Set<string>();
  for (const frame of FRAMES) {
    const sf = parse(frame);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name !== null && /^use[A-Z]/.test(name)) out.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** The files arm 3 walks: the ground's folder, every `Seat.tsx` of a place, every `live*.ts` of app-logic. */
function walked(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, GROUND_DIR)).sort()) {
    if (/\.tsx?$/.test(entry)) out.push(`${GROUND_DIR}/${entry}`);
  }
  for (const entry of readdirSync(resolve(ROOT, SEATS_DIR), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(resolve(ROOT, SEATS_DIR, entry.name, "Seat.tsx"))) {
      out.push(`${SEATS_DIR}/${entry.name}/Seat.tsx`);
    }
  }
  const live = (dir: string): void => {
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) live(`${dir}/${entry.name}`);
      else if (/^live.*\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
    }
  };
  live(LIVE_DIR);
  return out.sort();
}

/** The `use…` hooks a module EXPORTS, by declaration or by an export clause. */
function hooksExportedBy(file: string): string[] {
  const sf = parse(file);
  const out: string[] = [];
  const named = (n: string): void => { if (/^use[A-Z]/.test(n)) out.push(n); };
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st)
      && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st) && exported && st.name) named(st.name.text);
    if (ts.isVariableStatement(st) && exported) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) named(d.name.text);
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const e of st.exportClause.elements) named(e.name.text);
    }
  }
  return out;
}

describe("the shell's render scopes", () => {
  it("PARSES every frame — so nothing below can pass by reading an empty file", () => {
    /* The parser's own positive control, and it is not decoration: a walk that silently found
       nothing would satisfy "no memoized closure" and "no offending hook" perfectly. Asked twice
       — per frame, so a listed file that parses to nothing is named, and as the manifest's SUM,
       so a move that carries a memo from one frame to another leaves the floor where it was. */
    const sums = { memoNames: 0, stableCallbacks: 0, hookCalls: 0 };
    for (const frame of FRAMES) {
      const read = readFrame(frame);
      const total = read.memoNames.size + read.stableCallbacks + read.hookCalls.length;
      expect(total, `${relative(ROOT, frame)} parsed to nothing at all`).toBeGreaterThan(0);
      sums.memoNames += read.memoNames.size;
      sums.stableCallbacks += read.stableCallbacks;
      sums.hookCalls += read.hookCalls.length;
    }
    // eslint-disable-next-line no-console
    console.log(`render-scope manifest: ${SHELL_FRAMES.join(", ")} — ${JSON.stringify(sums)}`);
    expect(sums.memoNames, "the manifest lost memoized values").toBeGreaterThanOrEqual(FLOORS.memoNames);
    expect(sums.hookCalls, "the manifest lost hook calls").toBeGreaterThanOrEqual(FLOORS.hookCalls);
    // And the shell HAS callbacks: "zero memoized closures" is a property of how they are written,
    // not of a component that has none.
    expect(sums.stableCallbacks, "the manifest lost stable callbacks")
      .toBeGreaterThanOrEqual(FLOORS.stableCallbacks);
  });

  it("DETECTS both shapes of memoized closure, and neither a comment nor a string", () => {
    /* The detector's own positive control, over source this test owns rather than over a file
       that may stop carrying the shape. A detector that finds nothing satisfies every arm below
       — which is how a census dies quietly — and one that reads a hook name out of a comment or
       a string literal refuses code that is correct. */
    /* THE HOOK NAMES ARE ASSEMBLED FROM FRAGMENTS, and that is not decoration: written out, this
       fixture is a string naming a declaration together with its hook, which is exactly the shape
       `anchor-census.test.ts` sweeps this directory for — and it refused this file. Its own
       offender is planted from fragments for the same reason. */
    const cb = `use${"Callback"}`;
    const memo = `use${"Memo"}`;
    const probe = [
      `const a = ${cb}(() => x, []);`,
      `const b = ${memo}(() => (id: string) => id, []);`,
      `const c = ${memo}(() => { const n = 1; return () => n; }, []);`,
      `const d = ${memo}(() => rows.filter(Boolean), [rows]);`,
      `// ${cb}(() => x, []) in a comment is not a call`,
      `const e = "${cb}(() => x, [])";`,
      `const f = ${memo}(() => ({ run: () => 1 }), []);`,
    ].join("\n");
    const found = memoizedClosuresIn(probe, "probe.ts");
    expect(found, `the detector answered ${JSON.stringify(found)}`).toHaveLength(3);
  });

  it("holds NO memoized closure in any frame that derives over the whole mirror", () => {
    const sites = FRAMES.flatMap((frame) => memoizedClosures(frame));
    expect(
      sites,
      "a memoized callback here pins the render it was made in — with that render's consent "
      + "partition and its projection over every message. Use `useStableCallback`:\n"
      + sites.join("\n"),
    ).toEqual([]);
  });

  it("hands its memoized values only to hooks that keep no memoized closure", () => {
    const excepted = new Set(EXCEPTIONS.map((e) => `${e.hook}/${e.argument}`));
    const offences: string[] = [];
    const classified: string[] = [];
    const frameHooks = new Set(FRAMES.flatMap((f) => hooksExportedBy(f)));
    for (const frame of FRAMES) {
      const shell = readFrame(frame, frameHooks);
      for (const { hook, args } of shell.hookCalls) {
      const derived = args.filter((a) => shell.memoNames.has(a) || shell.fromFrames.has(a));
      if (derived.length === 0) continue;
      const file = moduleOf(frame, shell, hook);
      if (file === null) {
        offences.push(`${hook}: takes ${derived.join(", ")} and its module cannot be resolved`);
        continue;
      }
      const sites = memoizedClosures(file);
      classified.push(`${hook}(${derived.join(", ")}) → ${relative(ROOT, file)}: ${sites.length} memoized closure(s)`);
      if (sites.length === 0) continue;
      const unexcused = derived.filter((a) => !excepted.has(`${hook}/${a}`));
      if (unexcused.length > 0) {
        offences.push(
          `${hook} keeps ${sites.length} memoized closure(s) and is handed ${unexcused.join(", ")} — `
          + `its frame pins that value for as long as the closure lives (${sites[0]})`,
        );
      }
      }
    }
    // The classification is printed either way: a census whose reasoning is invisible is a census
    // whose next reader cannot tell an empty result from an unasked question.
    // eslint-disable-next-line no-console
    console.log(`render-scope census:\n  ${classified.join("\n  ")}`);
    expect(classified.length, "no hook takes a memoized value — the census measured nothing").toBeGreaterThan(0);
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("lists every `shell-*` frame the shell calls a hook from — arm 3", () => {
    /* THE ARM THAT KEEPS THE OTHER TWO HONEST. Arms 1 and 2 judge the manifest; a module left off
       it is not judged at all, and the split that is under way creates one module per lane. So the
       directory is walked and every `shell-*` module exporting a hook this shell CALLS must be
       listed — an omission is named here rather than passing as an absence. */
    const called = hooksCalledByTheShell();
    const missing: string[] = [];
    const seen: string[] = [];
    for (const file of walked()) {
      const exported = hooksExportedBy(resolve(ROOT, file)).filter((h) => called.has(h));
      /* A seat is a frame by what it is: the place's composition, called by the frame's registration. */
      if (exported.length === 0 && !file.endsWith("/Seat.tsx")) continue;
      seen.push(`${file} (${exported.join(", ") || "a seat"})`);
      if (!SHELL_FRAMES.includes(file)) {
        missing.push(`${file} exports ${exported.join(", ") || "a place's seat"}, which the composition calls, `
          + "and is not in SHELL_FRAMES — arms 1 and 2 never read it");
      }
    }
    // eslint-disable-next-line no-console
    console.log(`arm 3 walked ${GROUND_DIR}, the seats and the live hooks: ${seen.length === 0 ? "no frame yet" : seen.join(", ")}`);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("names every exception with a live pair, so the table cannot outlive what it excuses", () => {
    const calls = FRAMES.flatMap((frame) => readFrame(frame).hookCalls);
    for (const e of EXCEPTIONS) {
      const call = calls.find((c) => c.hook === e.hook && c.args.includes(e.argument));
      expect(call, `the exception for ${e.hook}/${e.argument} excuses a call that no longer exists`)
        .toBeDefined();
      expect(e.because.length, `the exception for ${e.hook}/${e.argument} gives no reason`).toBeGreaterThan(20);
    }
  });
});
