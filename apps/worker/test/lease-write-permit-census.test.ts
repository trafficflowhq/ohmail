import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ═══ EVERY DESTRUCTIVE IMAP WRITE ASKS ONE FUNCTION ════════════════════════════════════════
 *
 * A review named four call sites and said in the same breath that a
 * patch per site was the wrong shape. This is the instrument that makes the shape hold: a write
 * verb cannot reach somebody's mailbox from this tree without a permit asked at the write
 * boundary by {@link assertMayWriteToMailbox}, and a new call site is red until an author places
 * it.
 *
 * Three censuses, each exact over a stated domain:
 *
 *  1. every call to a destructive verb in the two organizing roots is CLASSIFIED, and each site
 *     classified `needs_permit` is preceded, inside its own function, by the one predicate;
 *  2. the predicate has exactly ONE definition in the tree — the census that cannot be satisfied
 *     by a second spelling;
 *  3. every production `runSyncCycle(` call names `writeAuthority` in its OWN argument list, and
 *     the field is REQUIRED on `SyncDeps`. A fixture that supplies none is a fixture; a production
 *     root that supplies none is the row.
 *
 * SCANNED ROOTS are `apps/worker/src` and `apps/sidecar/src` — this file lives in the worker's
 * test dir and reads the sidecar's source, so a touched-package selection that moved only the
 * sidecar does not reach it. Run it whenever either root moves.
 *
 * What it does NOT claim: that the predicate refuses correctly. That is `lease-permit.test.ts`
 * and the GreenMail arms, which drive a lapsing permit and watch the write refused.
 *
 * NAMED EXCLUSION: `ensureFolders()`. It creates ohmail's OWN `ohmail/*` tree, idempotently, and
 * its call sites each sit one statement below the gate or permit that admitted them rather than
 * behind a page ask. Each of its CREATEs asks the write door the caller hands it — the last census
 * in this file holds that half.
 */

const REPO = resolve(__dirname, "../../..");

/** The verbs that change somebody's mailbox. `expunge` is absent because ohmail never issues one. */
const DESTRUCTIVE_VERBS = [
  "move", "moveMany", "moveAll", "deleteFolder", "createFolder", "renameFolder", "setFlags",
] as const;

type Verb = (typeof DESTRUCTIVE_VERBS)[number];

/**
 * WHY A SITE MAY WRITE — one entry per call site, keyed `<file>:<enclosing function>:<verb>`.
 *
 *  · `needs_permit` — an organizer-only write; the predicate must precede it in the same function.
 *  · `reader_writes_seen` — `\Seen` is the reader's one IMAP write verb and `sync.ts:1450` states
 *    why it runs without the lease. The predicate is still called, and admits on a reader
 *    authority; the entry records that the ADMISSION is deliberate.
 *
 * The domain is CALLS. `folderOpsPass`'s capability probe reads the same four verbs as VALUES
 * (`adapter.createFolder && …`) and writes nothing, so it is out of the domain by construction;
 * turning one into a call puts it in, and the exactness case above refuses it until placed.
 */
type Disposition = "needs_permit" | "reader_writes_seen";

const CENSUS: Readonly<Record<string, Disposition>> = {
  // The reconcile pass's two filing paths — the batch and the per-message fallback.
  "apps/worker/src/sync.ts:fileChunk:moveMany": "needs_permit",
  "apps/worker/src/sync.ts:fileOne:move": "needs_permit",
  // `\Seen`, which a reader pushes too.
  "apps/worker/src/sync.ts:reconcileFlags:setFlags": "reader_writes_seen",
  // The one-time Quarantine→\Junk sweep, both paths.
  "apps/worker/src/junk-sweep.ts:junkSweepPass:moveMany": "needs_permit",
  "apps/worker/src/junk-sweep.ts:junkSweepPass:move": "needs_permit",
  // The queued "not junk", one move per press — a user-commanded organizing act the organizer
  // executes, so the permit is asked before every one of them and never once per pass.
  "apps/worker/src/junk-rescue.ts:junkRescuePass:move": "needs_permit",
  // The blank repair's one server write: a letter the blank's own move filed away goes back to INBOX.
  "apps/worker/src/blank-repair.ts:blankRepairPass:move": "needs_permit",
  // The user-commanded folder verbs.
  "apps/worker/src/folder-ops.ts:runCreate:createFolder": "needs_permit",
  "apps/worker/src/folder-ops.ts:runRename:renameFolder": "needs_permit",
  "apps/worker/src/folder-ops.ts:runDelete:moveAll": "needs_permit",
  "apps/worker/src/folder-ops.ts:runDelete:deleteFolder": "needs_permit",
};

/** The ONE predicate. A second spelling is the thing census 2 refuses. */
const PREDICATE = "assertMayWriteToMailbox";

interface Site {
  readonly key: string;
  readonly file: string;
  readonly fn: string;
  readonly verb: Verb;
  readonly pos: number;
  /** Offsets of every `PREDICATE` call inside the same enclosing function. */
  readonly guardsInFn: readonly number[];
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** The enclosing named function of a node, or `<module>` for a top-level call. */
function enclosingFunctionOf(n: ts.Node): { name: string; node: ts.Node } {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) {
      return { name: p.name ? p.name.getText() : "<anonymous>", node: p };
    }
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) {
      return { name: p.parent.name.getText(), node: p };
    }
  }
  return { name: "<module>", node: n.getSourceFile() };
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const root of ["apps/worker/src", "apps/sidecar/src"]) {
    for (const file of tsFilesUnder(join(REPO, root))) {
      const rel = file.slice(REPO.length + 1);
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          // `a.move(…)`, `a.move!(…)` and `a?.move(…)` all reach the same server verb.
          let callee: ts.Node = n.expression;
          if (ts.isNonNullExpression(callee)) callee = callee.expression;
          if (ts.isPropertyAccessExpression(callee)) {
            const name = callee.name.getText();
            if ((DESTRUCTIVE_VERBS as readonly string[]).includes(name)) {
              const { name: fn, node: fnNode } = enclosingFunctionOf(n);
              const guardsInFn: number[] = [];
              const scan = (m: ts.Node): void => {
                if (ts.isCallExpression(m)) {
                  const t = m.expression.getText();
                  if (t === PREDICATE || t.endsWith(`.${PREDICATE}`)) guardsInFn.push(m.getStart());
                }
                ts.forEachChild(m, scan);
              };
              ts.forEachChild(fnNode, scan);
              sites.push({
                key: `${rel}:${fn}:${name}`, file: rel, fn, verb: name as Verb,
                pos: n.getStart(), guardsInFn,
              });
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
  }
  return sites;
}

/**
 * ═══ AND EVERY CYCLE IS COMPOSED WITH A PERMIT ═══════════════════════════════════════════════
 *
 * `SyncDeps.writeAuthority` is what every boundary above asks. It was OPTIONAL, and this census
 * read the token `writeAuthority:` FILE-WIDE — which `apps/worker/src/index.ts` satisfied with the
 * junk-sweep port's own field while the hosted cycle was composed WITHOUT a permit, so the guard
 * for "exactly one active organizer per mailbox" was green for nothing. It reads the `runSyncCycle(`
 * call's own argument list now: a spread does not count, because a spread is how the attach-time
 * deps got there in the first place.
 *
 *  · `supplies_permit` — the call composes a cycle and must name `writeAuthority` itself.
 *  · `forwards_deps`   — the call hands on a whole `SyncDeps` it was given. It cannot name a field,
 *                        and restating one would be a second place for the two to disagree.
 */
const CYCLE_CALLS: Readonly<Record<string, "supplies_permit" | "forwards_deps">> = {
  // The always-on hosted worker's cycle — the call that had no permit at all.
  "apps/worker/src/index.ts:visitMailbox": "supplies_permit",
  // The backstop sweep's two cycles, which asked at the edge and never inside.
  "apps/worker/src/reconcile-cron.ts:runReconcileCron": "supplies_permit",
  // The desktop and phone engine's drain.
  "apps/sidecar/src/engine.ts:drain": "supplies_permit",
  // `reconcileOnRestart(deps)` — see `sync-role-census.test.ts` for the same classification.
  "apps/worker/src/restart.ts:reconcileOnRestart": "forwards_deps",
};

interface CycleCall {
  readonly key: string;
  readonly line: number;
  readonly isObjectLiteral: boolean;
  /** A PROPERTY named `writeAuthority` in this call's own literal. A spread is not one. */
  readonly namesWriteAuthority: boolean;
}

function collectCycleCalls(): CycleCall[] {
  const calls: CycleCall[] = [];
  for (const root of ["apps/worker/src", "apps/sidecar/src"]) {
    for (const file of tsFilesUnder(join(REPO, root))) {
      const rel = file.slice(REPO.length + 1);
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && n.expression.getText() === "runSyncCycle") {
          const arg = n.arguments[0];
          const isObjectLiteral = arg !== undefined && ts.isObjectLiteralExpression(arg);
          const namesWriteAuthority = isObjectLiteral
            && (arg as ts.ObjectLiteralExpression).properties.some(
              (pr) => (ts.isPropertyAssignment(pr) || ts.isShorthandPropertyAssignment(pr))
                && pr.name.getText() === "writeAuthority",
            );
          calls.push({
            key: `${rel}:${enclosingFunctionOf(n).name}`,
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            isObjectLiteral, namesWriteAuthority,
          });
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
  }
  return calls;
}

describe("every destructive IMAP write asks one function", () => {
  const sites = collectSites();

  it("the census is EXACT over the two organizing roots — no unplaced site, no dead entry", () => {
    const found = [...new Set(sites.map((s) => s.key))].sort();
    const declared = Object.keys(CENSUS).sort();
    expect({ unplaced: found.filter((k) => !(k in CENSUS)) }).toEqual({ unplaced: [] });
    expect({ dead: declared.filter((k) => !found.includes(k)) }).toEqual({ dead: [] });
  });

  it("every organizer-only write is preceded by the predicate INSIDE its own function", () => {
    const gated = sites.filter((s) => CENSUS[s.key] === "needs_permit");
    // A site with no permit ask, or one whose ask sits after the write, is the row.
    const unguarded = gated
      .filter((s) => !s.guardsInFn.some((g) => g < s.pos))
      .map((s) => s.key)
      .sort();
    expect({ unguarded }).toEqual({ unguarded: [] });
    // The domain is not empty — a census over nothing passes for the wrong reason.
    expect(gated.length).toBeGreaterThanOrEqual(8);
  });

  it("the reader's `\\Seen` push asks the predicate too, and is admitted by its authority", () => {
    const seen = sites.filter((s) => CENSUS[s.key] === "reader_writes_seen");
    expect(seen.length).toBe(1);
    expect(seen.every((s) => s.guardsInFn.some((g) => g < s.pos))).toBe(true);
  });

  it("the predicate has exactly ONE definition in the tree", () => {
    const defs: string[] = [];
    for (const root of ["apps/worker/src", "apps/sidecar/src", "packages/core/src", "packages/services/src"]) {
      for (const file of tsFilesUnder(join(REPO, root))) {
        const text = readFileSync(file, "utf8");
        if (new RegExp(`(export )?(async )?function ${PREDICATE}\\b`).test(text)) {
          defs.push(file.slice(REPO.length + 1));
        }
      }
    }
    expect(defs).toEqual(["apps/worker/src/lease.ts"]);
  });

  it("every production `runSyncCycle(` call names the permit in its OWN argument list", () => {
    const calls = collectCycleCalls();
    const found = [...new Set(calls.map((c) => c.key))].sort();
    expect({ unplaced: found.filter((k) => !(k in CYCLE_CALLS)) }).toEqual({ unplaced: [] });
    expect({ dead: Object.keys(CYCLE_CALLS).filter((k) => !found.includes(k)) }).toEqual({ dead: [] });
    // EVERY call, not one per key: `reconcile-cron.ts` runs two cycles from one function, and a
    // census keyed by function would certify the pair on the strength of the first.
    const composing = calls.filter((c) => CYCLE_CALLS[c.key] === "supplies_permit");
    expect({
      withoutPermit: composing.filter((c) => !c.namesWriteAuthority).map((c) => `${c.key}:${c.line}`),
    }).toEqual({ withoutPermit: [] });
    // A census over nothing passes for the wrong reason — three composing roots, four calls.
    expect(composing.length).toBe(4);
    // A forwarding call hands on a whole `SyncDeps` and cannot name anything: it must not be an
    // object literal, or it is composing and is on the wrong list.
    const forwarding = calls.filter((c) => CYCLE_CALLS[c.key] === "forwards_deps");
    expect({ literals: forwarding.filter((c) => c.isObjectLiteral).map((c) => c.key) })
      .toEqual({ literals: [] });
  });

  it("the cycle's `writeAuthority` is REQUIRED — the compiler is the first refusal", () => {
    const file = join(REPO, "apps/worker/src/sync.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let seen: { optional: boolean } | null = null;
    const walk = (n: ts.Node): void => {
      if (ts.isInterfaceDeclaration(n) && n.name.getText() === "SyncDeps") {
        for (const m of n.members) {
          if (ts.isPropertySignature(m) && m.name.getText() === "writeAuthority") {
            seen = { optional: m.questionToken !== undefined };
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    expect(seen, "`SyncDeps.writeAuthority` was not found — the field was renamed or removed").not.toBeNull();
    expect(
      seen!.optional,
      "`SyncDeps.writeAuthority` is optional again. An omitted authority reads as `not_supplied`, "
      + "which both guards refuse, so a cycle composed without one files nothing — the compiler is "
      + "the first place that composition should have been refused",
    ).toBe(false);
  });
});

/**
 * ═══ AND EVERY POST-PASS ORGANIZER WRITE ASKS ONE FACT ═══════════════════════════════════════
 *
 * The census above covers the IMAP verbs. The channel that runs AFTER the cycle writes to
 * `ohmail/_meta` through its own IO and is invisible to it: `applyMetaRequests` acknowledges and
 * EXPUNGES a reader's records, `settleOwnOutstandingRequests` settles this install's own, and the
 * profile publish appends and expunges a settings document. Each ran on the strength of the role
 * the gate answered BEFORE the drain — which says nothing about a mailbox that changed hands
 * during it.
 *
 * Asking the class of the held throw does not answer it: `fileOne`, `reconcileFlags` and
 * `folderOpsPass` each catch everything but a fence, so the ordinary shape of a mid-pass
 * stand-down arrives with no error at all. {@link leaseStoodDown} is the fact, and this census is
 * what keeps a new call site from arriving without it.
 *
 * NAMED EXCLUSION: `driveOutstandingRequests`, the READER's half. A reader holds no permit and
 * appends only its own decisions; refusing it on a receipt from before its demotion would stop a
 * person's decisions reaching the organizer that is meant to serve them.
 */
const CHANNEL_VERBS = ["applyMetaRequests", "settleOwnOutstandingRequests", "onOrganize"] as const;

/** The one fact. A second spelling is what the definition case below refuses. */
const STOOD_DOWN = "leaseStoodDown";

const CHANNEL_CENSUS: readonly string[] = [
  // The always-on hosted worker's cycle.
  "apps/worker/src/index.ts:visitMailbox:applyMetaRequests",
  "apps/worker/src/index.ts:visitMailbox:settleOwnOutstandingRequests",
  "apps/worker/src/index.ts:visitMailbox:onOrganize",
  // The backstop sweep.
  "apps/worker/src/reconcile-cron.ts:runReconcileCron:applyMetaRequests",
  // The desktop and phone engine's drain.
  "apps/sidecar/src/engine.ts:drainPass:applyMetaRequests",
  "apps/sidecar/src/engine.ts:drainPass:settleOwnOutstandingRequests",
  "apps/sidecar/src/engine.ts:drainPass:onOrganize",
  // The last settings write before a stop or a hand-back lets the mailbox go.
  "apps/worker/src/profile.ts:flushBeforeLeaving:onOrganize",
].sort();

function collectChannelSites(): Site[] {
  const sites: Site[] = [];
  for (const root of ["apps/worker/src", "apps/sidecar/src"]) {
    for (const file of tsFilesUnder(join(REPO, root))) {
      const rel = file.slice(REPO.length + 1);
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          let callee: ts.Node = n.expression;
          if (ts.isNonNullExpression(callee)) callee = callee.expression;
          const name = ts.isPropertyAccessExpression(callee)
            ? callee.name.getText()
            : ts.isIdentifier(callee) ? callee.getText() : "";
          if ((CHANNEL_VERBS as readonly string[]).includes(name)) {
            const { name: fn, node: fnNode } = enclosingFunctionOf(n);
            // The DEFINITION of `onOrganize` is a method whose own body is the publish; it is not
            // a call site and is excluded by construction — a method declaration is not a call.
            const guardsInFn: number[] = [];
            const scan = (m: ts.Node): void => {
              if (ts.isCallExpression(m)) {
                const t = m.expression.getText();
                if (t === STOOD_DOWN || t.endsWith(`.${STOOD_DOWN}`)) guardsInFn.push(m.getStart());
              }
              ts.forEachChild(m, scan);
            };
            ts.forEachChild(fnNode, scan);
            sites.push({
              key: `${rel}:${fn}:${name}`, file: rel, fn, verb: name as Verb,
              pos: n.getStart(), guardsInFn,
            });
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
  }
  return sites;
}

describe("every post-pass organizer write asks whether the permit stood down", () => {
  const sites = collectChannelSites();

  it("the census is EXACT over the two organizing roots — no unplaced site, no dead entry", () => {
    const found = [...new Set(sites.map((s) => s.key))].sort();
    expect({ unplaced: found.filter((k) => !CHANNEL_CENSUS.includes(k)) })
      .toEqual({ unplaced: [] });
    expect({ dead: CHANNEL_CENSUS.filter((k) => !found.includes(k)) }).toEqual({ dead: [] });
  });

  it("each one is preceded by the fact INSIDE its own function", () => {
    const unguarded = sites
      .filter((s) => !s.guardsInFn.some((g) => g < s.pos))
      .map((s) => s.key)
      .sort();
    expect({ unguarded }).toEqual({ unguarded: [] });
    // A census over nothing passes for the wrong reason.
    expect(sites.length).toBe(CHANNEL_CENSUS.length);
  });

  it("the fact has exactly ONE definition in the tree", () => {
    const defs: string[] = [];
    for (const root of ["apps/worker/src", "apps/sidecar/src", "packages/core/src", "packages/services/src"]) {
      for (const file of tsFilesUnder(join(REPO, root))) {
        const text = readFileSync(file, "utf8");
        if (new RegExp(`(export )?(async )?function ${STOOD_DOWN}\\b`).test(text)) {
          defs.push(file.slice(REPO.length + 1));
        }
      }
    }
    expect(defs).toEqual(["apps/worker/src/lease.ts"]);
  });
});

/**
 * ═══ AND EVERY ORGANIZER WRITE HANDS THE ADAPTER THE ONE DOOR ════════════════════════════════
 *
 * The page predicate above is asked before a page; the adapter asks a DOOR immediately before each
 * command it issues (`packages/core/test/adapters/imap-write-door-census.test.ts`). This is the
 * caller half: every write verb called in the two organizing roots — `ensureFolders` included,
 * whose CREATEs now ask per folder — passes as its door a `writeDoorOf(…)` call, or a binding made
 * from one in the same function. A literal door or a second door function is how the worker, the
 * local engine and the phone would come to answer the same claim differently.
 */
const DOOR_FN = "writeDoorOf";
const DOOR_VERBS = [...DESTRUCTIVE_VERBS, "ensureFolders"] as const;

function collectDoorCalls(): Array<{ key: string; line: number; ok: boolean }> {
  const out: Array<{ key: string; line: number; ok: boolean }> = [];
  for (const root of ["apps/worker/src", "apps/sidecar/src"]) {
    for (const file of tsFilesUnder(join(REPO, root))) {
      const rel = file.slice(REPO.length + 1);
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          let callee: ts.Node = n.expression;
          if (ts.isNonNullExpression(callee)) callee = callee.expression;
          if (ts.isPropertyAccessExpression(callee)
            && (DOOR_VERBS as readonly string[]).includes(callee.name.getText())) {
            const { name: fn, node: fnNode } = enclosingFunctionOf(n);
            const last = n.arguments[n.arguments.length - 1];
            const isDoorCall = (e: ts.Node | undefined): boolean =>
              e !== undefined && ts.isCallExpression(e) && e.expression.getText() === DOOR_FN;
            let ok = isDoorCall(last);
            if (!ok && last !== undefined && ts.isIdentifier(last)) {
              const scan = (m: ts.Node): void => {
                if (ts.isVariableDeclaration(m) && m.name.getText() === last.getText()
                  && isDoorCall(m.initializer)) ok = true;
                ts.forEachChild(m, scan);
              };
              ts.forEachChild(fnNode, scan);
            }
            out.push({
              key: `${rel}:${fn}:${callee.name.getText()}`,
              line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, ok,
            });
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
    }
  }
  return out;
}

describe("every organizer write hands the adapter the one door", () => {
  it("each write verb's door is `writeDoorOf(…)`, in both organizing roots", () => {
    const calls = collectDoorCalls();
    expect({ withoutTheDoor: calls.filter((c) => !c.ok).map((c) => `${c.key}:${c.line}`) })
      .toEqual({ withoutTheDoor: [] });
    // Every classified write site above, plus the six `ensureFolders` calls — a census over
    // nothing passes for the wrong reason.
    expect(calls.length).toBeGreaterThanOrEqual(Object.keys(CENSUS).length + 6);
  });

  it("the door function has exactly ONE definition in the tree", () => {
    const defs: string[] = [];
    for (const root of ["apps/worker/src", "apps/sidecar/src", "packages/core/src", "packages/services/src"]) {
      for (const file of tsFilesUnder(join(REPO, root))) {
        if (new RegExp(`(export )?function ${DOOR_FN}\\b`).test(readFileSync(file, "utf8"))) {
          defs.push(file.slice(REPO.length + 1));
        }
      }
    }
    expect(defs).toEqual(["apps/worker/src/lease.ts"]);
  });
});
