import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * ANCHOR A SOURCE CENSUS ON THE DECLARED NAME, never on a hook spelling.
 *
 * Several censuses under this directory read a shell or a pane AS SOURCE, because the arms they
 * judge are inline in files of several thousand lines and the claim is often an ORDER — a gate
 * standing before a dispatch — that no mounted component can show. Each of them has to find one
 * declaration in that source, and they used to do it with
 * `indexOf("const onBulkAction = useCallback")`: the identifier the census is about, plus the
 * hook it happened to be declared with.
 *
 * ── WHAT THE HOOK SPELLING COSTS ────────────────────────────────────────────────────────────
 *
 * The render-identity codemod rewrote every `useCallback` in `AppShell.tsx` to
 * `useStableCallback`. Every anchor spelled with the old hook returned -1, and what followed
 * depended on the assertion under it:
 *
 *   · `slice(at, …)` with `at = -1` hands back the EMPTY string, and every `toContain` /
 *     `not.toContain` over it is vacuously TRUE — the census reports a pass while measuring
 *     nothing;
 *   · `slice(indexOf(…))` with no end hands back the file's LAST CHARACTER — one newline — which
 *     fails a positive `toMatch`, so it does redden, but with the sentence for a different
 *     defect: "the shell stopped using this name", when the truth is a stale anchor;
 *   · a fixed `+ N` window drifts as the declaration it aims at grows, and nothing says so.
 *
 * Re-spelling the hook is a stopgap that holds until the next rename — it was tried once, in
 * `search-locate.test.ts`, and this is the second rename.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 *
 * Find `const <name> =` (or `function <name>(`) — the identifier the census is ABOUT — and slice
 * to its next SIBLING: the next `const` / `function` / `export` at the declaration's own
 * indentation, less that sibling's leading comment block, because a docblock belongs to what it
 * documents rather than to what precedes it.
 *
 * An anchor that finds nothing, or a slice with nothing in it, THROWS `anchor not found: <name>`.
 * A census with nothing under it refuses; it never passes. That sentence is the whole point: it
 * names the stale anchor instead of describing an absence of behaviour that is still there.
 *
 * `anchor-census.test.ts` refuses the hook spelling across every test source under this
 * directory, so the rule is enforced rather than merely written here.
 *
 * ── WHAT A CALLER STILL OWES ────────────────────────────────────────────────────────────────
 *
 * The declaration is the natural window and is usually the right one. It is NOT always: where a
 * case needs a narrower window than the whole declaration, it narrows the helper's result with a
 * STRUCTURAL bound of its own and says why. `attachments-wired.test.ts` is the worked example —
 * it stops at the object literal that closes the memo, because the dependency array inside the
 * full declaration carries the same identifier the case is looking for, and a mutation dropping
 * the key from the object was measured GREEN against the wider slice.
 */
export function sliceOfDeclaration(source: string, name: string): string {
  let start = -1;
  for (const spelling of [`const ${name} =`, `function ${name}(`]) {
    const at = source.indexOf(spelling);
    if (at !== -1 && (start === -1 || at < start)) start = at;
  }
  if (start === -1) throw new Error(`anchor not found: ${name}`);
  const indent = /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", start) + 1, start))![0];
  const rest = source.slice(start);
  const ownLine = rest.indexOf("\n");
  const sibling = ownLine === -1
    ? null
    : new RegExp(`^${indent}(?:const |function |export )`, "m").exec(rest.slice(ownLine));
  let end = sibling === null ? rest.length : ownLine + sibling.index;
  /* Give the sibling back its own leading comment: a docblock belongs to what it documents. */
  while (end > 0) {
    const prev = rest.lastIndexOf("\n", end - 2) + 1;
    const line = rest.slice(prev, end).trim();
    if (line !== "" && !/^(\/\/|\/\*|\*)/.test(line)) break;
    end = prev;
  }
  const slice = rest.slice(0, end);
  if (slice.length === 0) throw new Error(`anchor not found: ${name}`);
  return slice;
}

/**
 * ═══ THE SHELL IS MORE THAN ONE FILE ════════════════════════════════════════════════════════
 *
 * `ShellInner`'s logic is being moved into `shell-*.ts` hooks (ARCH-022), so a census that reads
 * "the shell" as `AppShell.tsx` alone stops seeing whatever moved. The MANIFEST below is that
 * one list: the frames `ShellInner` composes, and the only files the render-scope census judges.
 * A frame that is missing from it is refused by that census's third arm, not silently unjudged.
 */
export const SHELL_DIR = "apps/webapp/app/shell";

/** The frames, newest last. A module lands here in the same commit that creates it. */
export const SHELL_FRAMES: readonly string[] = [
  "AppShell.tsx", "shell-dispatch.ts", "shell-derivations.ts", "shell-open-state.ts",
  "shell-compose.ts", "shell-verbs.ts", "shell-keys.tsx",
];

/** A frame that left the shell's folder for app-logic, by where it is now. It stays a frame: the shell composes it. */
const FRAME_HOMES: Readonly<Record<string, string>> = {
  "shell-dispatch.ts": "packages/app-logic/src/press/shell-dispatch.ts",
};

/** Where a frame of the manifest is, from the repository's root. */
export function shellFramePath(name: string): string {
  return FRAME_HOMES[name] ?? `${SHELL_DIR}/${name}`;
}

/** Absolute paths for the manifest, refusing a frame the tree does not have. */
export function shellFramePaths(root: string): string[] {
  return SHELL_FRAMES.map((name) => {
    const full = resolve(root, shellFramePath(name));
    if (!existsSync(full)) throw new Error(`shell frame not found: ${shellFramePath(name)}`);
    return full;
  });
}

/**
 * WHICH FRAME DECLARES `name`. Zero hits and two hits are both refusals: a census re-homed onto a
 * frame where the name now means a different declaration is the way a claim outlives its code,
 * and an anchor that finds nothing is the stale-anchor defect this module exists to name.
 */
export function shellFrameOf(name: string, root: string = process.cwd()): { path: string; source: string } {
  const hits: { path: string; source: string }[] = [];
  for (const path of shellFramePaths(root)) {
    const source = readFileSync(path, "utf8");
    if (source.includes(`const ${name} =`) || source.includes(`function ${name}(`)) hits.push({ path, source });
  }
  if (hits.length === 0) throw new Error(`anchor not found: ${name} in any shell frame (${SHELL_FRAMES.join(", ")})`);
  if (hits.length > 1) {
    throw new Error(`anchor is ambiguous: ${name} is declared in ${hits.map((h) => relative(root, h.path)).join(" and ")}`);
  }
  return hits[0]!;
}

/** The declaration, from whichever frame holds it — `sliceOfDeclaration` over `shellFrameOf`. */
export function shellSliceOf(name: string, root: string = process.cwd()): string {
  return sliceOfDeclaration(shellFrameOf(name, root).source, name);
}
