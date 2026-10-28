import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SHELL_DIR, SHELL_FRAMES, shellFramePaths } from "./source-anchor.js";

/**
 * ═══ THE COMPOSITION ROOT IS A COMPOSITION ROOT ═════════════════════════════════════════════
 *
 * ARCH-022 moved `ShellInner`'s logic into six hooks in a fixed order — dispatch → derivations
 * → open state → compose → verbs → keys. The order is not a preference: each hook READS what
 * the ones above it returned, so a call moved up is a call handed `undefined`, and a call moved
 * down changes which of two effects writing the hash in one commit wins
 * (`mailto-over-the-route-mirror.test.tsx` is that pair, measured).
 */

/**
 * The closing census of the six lanes, four questions: every frame's hook is called EXACTLY
 * once (a second call is a second set of state); the six stand in the ruled ORDER; the order
 * list and the manifest name the same frames, so a seventh module cannot join by being added
 * to one list alone; and the composition root is under the ruling's line ceilings.
 *
 * Every arm is driven over a DOCTORED copy of the real source as well as the real one, because
 * a reader that finds nothing answers every question with a pass.
 */

const ROOT = resolve(process.cwd());
const SHELL = resolve(ROOT, SHELL_DIR, "AppShell.tsx");

/**
 * THE RULED ORDER (ARCH-022 §1.2), hook name → the frame that exports it. The list is the
 * claim; `SHELL_FRAMES` is the other half of it and arm 3 holds the two together.
 */
const ORDER: ReadonlyArray<{ hook: string; frame: string }> = [
  { hook: "useShellDispatch", frame: "shell-dispatch.ts" },
  { hook: "useShellDerivations", frame: "shell-derivations.ts" },
  { hook: "useShellOpenState", frame: "shell-open-state.ts" },
  { hook: "useShellCompose", frame: "shell-compose.ts" },
  { hook: "useShellVerbs", frame: "shell-verbs.ts" },
  { hook: "useShellKeys", frame: "shell-keys.tsx" },
];

/**
 * THE RULING'S OWN FIGURE (§2, "expected end state"): `ShellInner`'s remaining logic at ≈ 900 +
 * the glue the ruling leaves in it. The whole file's line ceiling is retired: it counted
 * lines four legitimate rows added and measured no behaviour.
 */
const CEILINGS = { shellInnerLogic: 1113 } as const; // raised 2026-10-25 from 1100: the setup resume's one call (`setup-resume.ts` holds its logic); from 1101: a forward's kept files, one destructured pair and one reader prop (`forward-files.ts` holds their logic); 2026-10-26 from 1104: the Rules pane's reader-only list, its posture flag and two memos (`rulesShown` in client-engine holds their logic); from 1111: the in-place reply host's one call (`stream-in-place.tsx` holds its logic); 2026-10-27 from 1112: the pipe door's Show images press, one prop line (`remote-images.ts` holds its logic)

/**
 * WHICH CONTROL MEASURES WHICH FRAME'S MOVED CODE. The golden render test is DOM identity, so it
 * reddens only for code that reaches the DOM AT REST. L5 measured that `shell-verbs.ts` does not
 * (`abar-rall`/`abar-del` appear zero times across all fourteen snapshots); L6 measured that its
 * own frame is HALF covered — dropping a rail row takes 14 of 14 red, and changing a global
 * chord's destination leaves all 14 green while `keyboard-walkthrough` refuses by name.
 */

/**
 * So a frame may name more than one, and the kinds are the claim: `dom` reddens in the golden,
 * `behavioural` only under a real press, `claim` is an anchored source census. A frame with no
 * `dom` row is a frame the golden cannot see, stated rather than covered by its silence.
 */
const CONTROLS: ReadonlyArray<{ frame: string; control: string; kind: "dom" | "behavioural" | "claim" }> = [
  { frame: "AppShell.tsx", control: "shell-golden.test.tsx", kind: "dom" },
  { frame: "shell-dispatch.ts", control: "filing-refresh-on-decision.test.tsx", kind: "claim" },
  { frame: "shell-derivations.ts", control: "shell-golden.test.tsx", kind: "dom" },
  { frame: "shell-open-state.ts", control: "shell-golden.test.tsx", kind: "dom" },
  { frame: "shell-compose.ts", control: "shell-golden.test.tsx", kind: "dom" },
  { frame: "shell-verbs.ts", control: "triage-keys.test.tsx", kind: "behavioural" },
  /* The rail half renders; the chords and the palette list do not. Both rows, or the second
     frame in the manifest whose key map no press covers goes unnoticed. */
  { frame: "shell-keys.tsx", control: "shell-golden.test.tsx", kind: "dom" },
  { frame: "shell-keys.tsx", control: "keyboard-walkthrough.test.tsx", kind: "behavioural" },
];

function parseText(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(
    name, text, ts.ScriptTarget.Latest, true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Every call of a named hook, by source position. A parse and not a regex, for
 * `render-scope-census.test.ts`'s measured reason: a hook name quoted in a docblock is not a
 * call, and eleven of the twelve names below are also spelled in the comments beside them.
 */
function hookCallsIn(text: string, label: string): Array<{ hook: string; pos: number; line: number }> {
  const sf = parseText(text, label);
  const wanted = new Set(ORDER.map((o) => o.hook));
  const out: Array<{ hook: string; pos: number; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wanted.has(node.expression.text)) {
      const pos = node.getStart(sf);
      out.push({ hook: node.expression.text, pos, line: sf.getLineAndCharacterOfPosition(pos).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out.sort((a, b) => a.pos - b.pos);
}

/** The reader under test: the order the shell calls the six hooks in, or a refusal by name. */
function calledOrderOf(text: string, label: string): string[] {
  const calls = hookCallsIn(text, label);
  const seen = new Map<string, number>();
  for (const c of calls) seen.set(c.hook, (seen.get(c.hook) ?? 0) + 1);
  for (const { hook } of ORDER) {
    const n = seen.get(hook) ?? 0;
    if (n === 0) throw new Error(`hook not called: ${hook} in ${label}`);
    if (n > 1) throw new Error(`hook called ${n} times: ${hook} in ${label}`);
  }
  return calls.map((c) => c.hook);
}

/** `ShellInner`'s logic: its opening brace to its `return (`, which is where the JSX starts. */
function shellInnerLogicLines(text: string): number {
  const sf = parseText(text, "AppShell.tsx");
  let fn: ts.FunctionDeclaration | null = null;
  ts.forEachChild(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "ShellInner") fn = n;
  });
  const decl = fn as ts.FunctionDeclaration | null;
  if (decl === null || decl.body === undefined) throw new Error("anchor not found: function ShellInner");
  const body = decl.body;
  const ret = body.statements[body.statements.length - 1];
  if (ret === undefined || !ts.isReturnStatement(ret)) {
    throw new Error("ShellInner's last statement is not its `return` — the JSX moved");
  }
  const from = sf.getLineAndCharacterOfPosition(body.getStart(sf)).line;
  const to = sf.getLineAndCharacterOfPosition(ret.getStart(sf)).line;
  return to - from;
}

const source = readFileSync(SHELL, "utf8");

describe("the shell's six hooks are called once each, in the ruled order", () => {
  it("calls every one of them exactly once", () => {
    const calls = hookCallsIn(source, "AppShell.tsx");
    for (const { hook } of ORDER) {
      expect(calls.filter((c) => c.hook === hook), `${hook} in AppShell.tsx`).toHaveLength(1);
    }
    expect(calls).toHaveLength(ORDER.length);
  });

  it("calls them in the order the ruling fixed", () => {
    expect(calledOrderOf(source, "AppShell.tsx")).toEqual(ORDER.map((o) => o.hook));
  });

  /**
   * THE RED CONTROL, run rather than described: the two neighbours the cycle is tightest between
   * — `useShellCompose` reads the open state's `setReaderFor`, the open state reads the shell's
   * `setReplyTo` — swapped in a copy of the real source. A reader that cannot see this swap
   * cannot see any of them.
   */
  it("refuses a source whose calls are out of order", () => {
    const swapped = swapCalls(source, "useShellOpenState", "useShellCompose");
    expect(swapped, "the swap changed nothing — the arm would pass for a reader that measures nothing")
      .not.toEqual(source);
    expect(calledOrderOf(swapped, "AppShell.tsx.swapped")).not.toEqual(ORDER.map((o) => o.hook));
  });

  it("refuses a source that calls one of them twice", () => {
    const call = hookCallsIn(source, "AppShell.tsx").find((c) => c.hook === "useShellKeys")!;
    const doubled = `${source}\nfunction __twice() { return useShellKeys(undefined as never); }\n`;
    expect(call).toBeTruthy();
    expect(() => calledOrderOf(doubled, "AppShell.tsx.doubled"))
      .toThrow(/hook called 2 times: useShellKeys/);
  });

  it("refuses a source that calls none of them", () => {
    expect(() => calledOrderOf("export function ShellInner() { return null; }\n", "empty"))
      .toThrow(/hook not called: useShellDispatch/);
  });
});

describe("the order list and the frame manifest are one claim", () => {
  it("names the same frames as `SHELL_FRAMES`, less the composition root", () => {
    const framesInOrder = ORDER.map((o) => o.frame).sort();
    const manifest = SHELL_FRAMES.filter((f) => f !== "AppShell.tsx").slice().sort();
    expect(framesInOrder).toEqual(manifest);
  });

  it("every frame in the order list exports the hook the shell calls", () => {
    for (const { hook, frame } of ORDER) {
      const path = resolve(ROOT, SHELL_DIR, frame);
      expect(existsSync(path), `${SHELL_DIR}/${frame}`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`export function ${hook}(`);
    }
  });

  /** The manifest resolves — `shellFramePaths` refuses a frame the tree does not have. */
  it("resolves every manifest frame on disk", () => {
    expect(shellFramePaths(ROOT)).toHaveLength(SHELL_FRAMES.length);
  });
});

describe("what measures each frame's moved code", () => {
  it("names a control for every frame in the manifest, and the control exists", () => {
    expect([...new Set(CONTROLS.map((c) => c.frame))].sort()).toEqual(SHELL_FRAMES.slice().sort());
    for (const { frame, control } of CONTROLS) {
      expect(existsSync(resolve(ROOT, "apps/webapp/test", control)), `${control} for ${frame}`).toBe(true);
    }
  });

  /**
   * The two frames measured NOT covered by the golden alone keep a behavioural row: the verbs
   * render nothing at rest, and the key map's chords and palette entries render nothing until
   * somebody presses. Dropping either row would leave a frame claiming cover the golden measured
   * it cannot give.
   */
  it("names a behavioural control for both frames the golden cannot see at rest", () => {
    const behavioural = CONTROLS.filter((c) => c.kind === "behavioural").map((c) => c.frame);
    expect(behavioural).toContain("shell-verbs.ts");
    expect(behavioural).toContain("shell-keys.tsx");
  });
});

describe("the composition root is under the ruling's ceilings", () => {
  it("keeps what is left of `ShellInner`'s logic under its own", () => {
    const logic = shellInnerLogicLines(source);
    expect(logic, `ShellInner's logic is ${logic} lines`).toBeLessThanOrEqual(CEILINGS.shellInnerLogic);
  });
});

/**
 * Swap two hook CALL STATEMENTS in a copy of the source, for the red arm. It moves the whole
 * statement (the `const { … } = useX({ … });` the shell writes), because a swap of the call
 * expressions alone would leave the destructured names where they were and prove nothing about
 * the order the effects run in.
 */
function swapCalls(text: string, a: string, b: string): string {
  const sf = parseText(text, "AppShell.tsx");
  const spans: Record<string, { start: number; end: number }> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const init = node.declarationList.declarations[0]?.initializer;
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
        && (init.expression.text === a || init.expression.text === b)) {
        spans[init.expression.text] = { start: node.getStart(sf), end: node.getEnd() };
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  const first = spans[a];
  const second = spans[b];
  if (first === undefined || second === undefined) throw new Error(`anchor not found: ${a} or ${b} as a statement`);
  const [lo, hi] = first.start < second.start ? [first, second] : [second, first];
  return text.slice(0, lo.start) + text.slice(hi.start, hi.end)
    + text.slice(lo.end, hi.start) + text.slice(lo.start, lo.end) + text.slice(hi.end);
}
