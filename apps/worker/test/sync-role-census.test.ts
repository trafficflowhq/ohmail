import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY COMPOSITION NAMES THE ROLE — the "absent config selects the dangerous branch" guard
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `SyncDeps.role` and `PlanDeps.readerMode` are REQUIRED fields, and for both of them the absent
 * default is the DANGEROUS one: an omitted role reads as `organizer`, and an organizer that is
 * not the organizer is two installs moving one person's mail.
 *
 * ── THE TYPE IS NOT THE GUARD, WHICH IS WHY THIS FILE EXISTS ────────────────────────────────
 *
 * `pnpm typecheck` covers `src` only for every package here, so a required field is enforced for
 * PRODUCT SOURCE and for nothing else — and that is exactly the right scope for this question
 * (tests are not compositions), but it means the enforcement is invisible: nothing tells a reader
 * which files it is protecting, and nothing goes red if a new composition root appears in a
 * package whose `src` somehow escapes the build. This is that list, written down.
 *
 * It is also the half a type CANNOT do. `trustedAuthservIds` was optional-and-empty at all five
 * production sites and the branch it gated protected nothing; making it required fixed the type
 * and left no record of where the five were. A census answers "which compositions exist" — the
 * question somebody has to ask before adding the sixth.
 *
 * ── EXACT SET, BOTH DIRECTIONS ─────────────────────────────────────────────────────────────
 *
 * A new file that runs the cycle goes red until it is named here, which is the point; and a file
 * that DROPS its call also goes red, which catches a composition being deleted or silently
 * routed through a wrapper that forgets the field.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The three entry points that run mail through the pipeline. */
const CYCLE_NEEDLES = [/runSyncCycle\(/, /reconcileMailbox\(/, /planChange\(/];

/**
 * Every product-source file that composes a cycle, and what each one must say.
 *
 *  · `role`      — the three composition roots that build `SyncDeps` from scratch.
 *  · `readerMode`— the one file that derives it, plus the one direct `planChange` caller.
 *  · neither     — files that PASS ALONG a `SyncDeps` they were handed, and the definitions
 *                  themselves. Naming them here is what stops the list being read as "these
 *                  files are unchecked".
 *
 * `apps/worker/src/dead-letter.ts` is deliberately ABSENT: it names `planChange` in a comment
 * (its header explains what a throw out of one costs) and calls nothing. It was on this list
 * until the walk started stripping comments, and its removal is the change working.
 */
const CYCLE_SITES: Record<string, "role" | "readerMode" | "passes-through" | "defines"> = {
  [["apps", "worker", "src", "sync.ts"].join(sep)]: "defines",
  // `planChange` and `commitChange` themselves. Named so the list is the whole answer to "which
  // files run the pipeline" rather than "which files call it".
  [["packages", "core", "src", "pipeline.ts"].join(sep)]: "defines",
  [["apps", "worker", "src", "index.ts"].join(sep)]: "role",
  [["apps", "worker", "src", "reconcile-cron.ts"].join(sep)]: "role",
  [["apps", "sidecar", "src", "engine.ts"].join(sep)]: "role",
  // `reconcileOnRestart(deps)` takes a whole `SyncDeps` and hands it straight on — it composes
  // nothing, so it cannot forget a field, and requiring it to restate one would be a second place
  // for the two to disagree.
  [["apps", "worker", "src", "restart.ts"].join(sep)]: "passes-through",
  // The Sent projection: one direct `planChange`, typing `readerMode: false` — a reader MAY send,
  // so this runs on both sides of the role, and it says `false` because `ownAuthored` reaches the
  // same plan first. See its own note.
  [["packages", "core", "src", "sent-record.ts"].join(sep)]: "readerMode",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
      yield p;
    }
  }
}

function rootsOf(): string[] {
  const roots: string[] = [];
  for (const bucket of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const p = join(REPO, bucket, name, sub);
        try {
          if (statSync(p).isDirectory()) roots.push(p);
        } catch { /* no such subdir — fine */ }
      }
    }
  }
  return roots;
}

/**
 * COMMENTS REMOVED BEFORE ANY MATCH, and this file learned why the useful way.
 *
 * The first version matched raw source. Deleting `role: "organizer"` from `reconcile-cron.ts` —
 * the exact mutation this census exists to catch — left it GREEN, because the file's own comment
 * about the field still contained the words. A census a comment can satisfy certifies a
 * composition by prose, which is worse than not having one: it reads as a guard.
 *
 * (The compiler caught that mutation, loudly — `role` is required and the worker's `src` IS
 * typechecked. That is the primary defence and this census does not replace it. What the census
 * adds is the ENUMERATION: which compositions exist, so the next one has to be named on purpose.)
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

function found(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of rootsOf()) {
    for (const file of walk(root)) {
      const src = withoutComments(readFileSync(file, "utf8"));
      if (CYCLE_NEEDLES.some((n) => n.test(src))) out.set(relative(REPO, file), src);
    }
  }
  return out;
}

describe("every composition that runs the pipeline names the role", () => {
  it("the cycle call sites are exactly the known ones", () => {
    expect([...found().keys()].sort()).toEqual(Object.keys(CYCLE_SITES).sort());
  });

  it("every COMPOSITION ROOT passes `role`", () => {
    const files = found();
    // Non-vacuous by construction: the loop below runs over the roots named above, and the
    // assertion one test up guarantees the walk found them.
    let checked = 0;
    for (const [file, kind] of Object.entries(CYCLE_SITES)) {
      if (kind !== "role") continue;
      const src = files.get(file);
      expect(src, `${file} is listed as a composition root and the walk did not find it`).toBeDefined();
      expect(
        /* `organizing` is the sidecar's spelling since its drain took the gate's role as a VALUE:
           the root used to read `organizer.organizing` off the engine, a field that outlives the
           gate. The alternation names the value as well as the field — a root that names neither
           is what this refuses. */
        /\brole:\s*(rt\.role|role|organizing|organizer|"organizer"|organizer\.organizing)/.test(src!),
        `${file} builds SyncDeps and does not name \`role\` — an omitted role reads as ORGANIZER, `
        + "and an organizer that is not the organizer is two installs moving one person's mail",
      ).toBe(true);
      checked++;
    }
    expect(checked, "no composition roots were checked — the list lost its entries").toBe(3);
  });

  it("every COMPOSITION ROOT hands the cycle its config's blank repair mode", () => {
    /* `SyncDeps.blankRepair` absent is APPLY, a pass that writes to people's mailboxes, so a root
       that forgets the field runs the repair while OHMAIL_BLANK_REPAIR says off or dry. The reconcile
       backstop and the desktop and phone engine did, and `off` held on the worker's own loop only.
       Each root states the mode from its own configuration, the one the operator's variable fills. */
    const files = found();
    let checked = 0;
    for (const [file, kind] of Object.entries(CYCLE_SITES)) {
      if (kind !== "role") continue;
      const src = files.get(file);
      expect(src, `${file} is listed as a composition root and the walk did not find it`).toBeDefined();
      expect(
        /\bblankRepair:\s*config\.blankRepair\b/.test(src!),
        `${file} builds SyncDeps without \`blankRepair\` — the repair would run as apply there `
        + "whatever OHMAIL_BLANK_REPAIR says",
      ).toBe(true);
      checked++;
    }
    expect(checked, "no composition roots were checked — the list lost its entries").toBe(3);
  });

  it("`readerMode` is DERIVED IN ONE PLACE, and that place is `sync.ts`", () => {
    // The property that makes the role and the router unable to disagree about one message. A
    // second derivation anywhere is two answers to one question, which is how `screeningCutoff`'s
    // predecessor came to be computed twice with different arithmetic.
    const files = found();
    const derivations: string[] = [];
    for (const [file, src] of files) {
      // `=(?!=)` — an ASSIGNMENT, not a comparison. Without the lookahead this matched
      // `deps.readerMode === true` inside `pipeline.ts`, i.e. it counted the READER of the field
      // as a second derivation of it, which is the opposite of what the property says.
      if (/\breaderMode\s*=(?!=)/.test(src)) derivations.push(file);
    }
    expect(derivations).toEqual([["apps", "worker", "src", "sync.ts"].join(sep)]);
  });

  it("the direct `planChange` caller types `readerMode`", () => {
    const src = found().get(["packages", "core", "src", "sent-record.ts"].join(sep));
    expect(src).toBeDefined();
    expect(/readerMode:\s*false/.test(src!)).toBe(true);
  });
});
