/* THIS FILE IS THE EVIDENCE for the "worker may import core + db only" claims made in
 * `packages/db/src/{billing,credits,alerts,cloud,ai-gate}.ts` and in
 * `packages/services/src/{sensitive-rescreen,sensitive-rescreen-cli,attachment-flag-backfill-cli,
 * attachment-staging,mail/mail-service,mail/alert-sink}.ts`. Those comments used to cite this
 * file by full path; the paths were reworded to "the worker's dependency test" when the db and
 * services sources were prepared for publication (test directories are not yet published), and
 * the pointer moved here so the coupling is still written down at the end a grep can find. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST = fileURLToPath(new URL(".", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * Every `.ts` under `dir`, RECURSIVELY.
 *
 * The recursion is the fix for a guard that passed for the wrong reason: this used to be a
 * flat `readdirSync(dir).filter(…)`, which was correct only because `apps/worker/src` happens
 * to contain no subdirectories. The first `src/imap/` or `src/crons/` anyone added would have
 * escaped the boundary check silently — and the entire argument for putting the AI spend
 * gate in `packages/db` rather than `packages/services` rests on this check
 * being load-bearing. A guard whose reach depends on a directory layout nobody is pinning is
 * not a guard.
 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * the dependency boundary, ENFORCED rather than asserted in a review comment.
 *
 * The worker may import `@trafficflow/core` and `@trafficflow/db` and nothing else from the
 * workspace. `@trafficflow/services` in particular is an API-host concern: it resolves
 * through the vitest alias, so an accidental import would pass every test here and then fail
 * only inside the worker's Docker image, where `services` is not installed.
 *
 * ── WHAT THE RULE IS ACTUALLY WORTH, MEASURED ──────────────────────────────────────────────
 *
 * The paragraph above was written as a prediction and it came true, one step further along than
 * it says. `apps/worker/src/index.ts` imported the services barrel for the `attachment_staging`
 * retention sweep; the image build then died on TS5083 (`/.dockerignore` admitted the manifest
 * and not the package) and the fix that got a bootable image was to promote the dependency,
 * add the project reference and admit the package — three edits, each individually reasonable,
 * that together dissolved the boundary.
 *
 * What the promoted dependency actually bought: the services barrel in the worker's BOOT GRAPH,
 * so `node` loads an HTML sanitiser and its HTML parser on the way to a retention sweep. On
 * Node 23 the pair is a hard `ERR_REQUIRE_CYCLE_MODULE` at import time — a CJS `sanitize-html`
 * re-entering an ESM `htmlparser2` mid-evaluation. Reproduce it with
 * `cd apps/worker && node -e "import('@trafficflow/services')"`, which fails on Node 23 and
 * succeeds on Node 22. NO STATIC CHECK CAN SEE THIS: it is a property of the module graph at
 * runtime, so typecheck, `tsc -b` and every aliased test stayed green, and the image pins
 * `node:22-bookworm-slim`, which is the only reason the deployed worker booted at all — a
 * base-image bump would have been an unloggable crash-on-start for a dependency it has no use
 * for. `test/cli.smoke.test.ts` was the one thing that caught it, because it is the only test
 * that boots the CLI in a real process rather than through the vitest alias.
 *
 * The sweep now lives on `@trafficflow/db/cloud` beside the rows it deletes. The rule did not
 * move; the code did.
 *
 * The TEST-ONLY exception is deliberate and is asserted as such below: worker e2e tests drive
 * service-level flows (`api-move-handoff`, `send`, `attachments`, …) and therefore import
 * `@trafficflow/services`, which is why it is a devDependency. The rule is about `src/`; the
 * exception is about `test/`, and both halves are checked here so neither can drift silently.
 */
const FORBIDDEN_IN_SRC = ["@trafficflow/services", "@trafficflow/api", "@ohmail/"];

/** The repo root, for the two files outside this app that also state the worker's closure. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** `{ "path": "../../packages/x" }` → `x`, for a tsconfig's project references. */
function referencedPackages(tsconfigPath: string): string[] {
  const raw = readFileSync(tsconfigPath, "utf8");
  const cfg = JSON.parse(raw) as { references?: Array<{ path: string }> };
  return (cfg.references ?? []).map((r) => r.path.replace(/.*\//, ""));
}

/**
 * CODE WITH COMMENTS REMOVED — string literals are KEPT, deliberately.
 *
 * A module specifier IS a string literal (`import … from "@trafficflow/services"`), so a stripper
 * that also removed strings would blind this check completely. Only comments go.
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const c = src[i]!;
    // Skip over a string literal WHOLE, so a `//` or `/*` inside one cannot open a fake comment.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe("worker dependency boundary", () => {
  it("walks src/ recursively — the check must not depend on the tree happening to be flat", () => {
    // Pins the property the rule below relies on. If someone converts `tsFiles` back to a flat
    // read, this fails immediately rather than in whichever future subdirectory goes unchecked.
    const scanned = tsFiles(SRC).map((f) => f.slice(SRC.length + 1));
    expect(scanned.length).toBeGreaterThan(5);
    const dirs = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const d of dirs) {
      expect(scanned.some((f) => f.startsWith(`${d.name}/`)), `src/${d.name} unscanned`).toBe(true);
    }
  });

  it("imports NOTHING from services / api / the client packages anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const body = codeOnly(readFileSync(file, "utf8"));
      for (const bad of FORBIDDEN_IN_SRC) {
        if (body.includes(bad)) offenders.push(`${file.slice(SRC.length + 1)} → ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE SCANNER READS CODE, NOT PROSE — and it did not, until a comment tripped it.
   *
   * The check was `readFileSync(file).includes(bad)`: a raw substring match over the whole file.
   * So a COMMENT that names a forbidden package reported a boundary violation that does not exist.
   * It fired for real on `api-cron.ts`, whose entry for the away responder's clock explains that
   * the pass "now lives in `@trafficflow/services` and runs on the API host" — which is the reason
   * that cron target exists at all, and exactly the sentence a reader needs.
   *
   * This is the inverse of the hole `pass-registry.test.ts` documents (prose keeping a deleted
   * function's row green). Both come from a census that cannot tell a call from a sentence about
   * one, and both are fixed the same way. It matters more here than it looks: the obvious way to
   * "fix" a false offender is to delete the explanation, so a prose-matching boundary check
   * quietly pressures every file into saying less about why it is shaped the way it is.
   *
   * Stripping comments cannot HIDE a violation — an import is code — so the guard is strictly more
   * accurate, not weaker. The cases below hold both directions, and the last one is the one that
   * matters: a real import must still be caught.
   */
  it("the comment stripper is not the hole it closes", () => {
    // Prose is not an import, in each comment form.
    expect(codeOnly('// see @trafficflow/services\nconst a = 1;')).not.toContain("@trafficflow/services");
    expect(codeOnly('/* @trafficflow/services */ const a = 1;')).not.toContain("@trafficflow/services");
    expect(codeOnly('/**\n * @trafficflow/services\n */\nconst a = 1;')).not.toContain("@trafficflow/services");

    // …and a REAL import still is, in every form the worker could actually use.
    expect(codeOnly('import { x } from "@trafficflow/services";')).toContain("@trafficflow/services");
    expect(codeOnly("import { x } from '@trafficflow/services';")).toContain("@trafficflow/services");
    expect(codeOnly('const x = require("@trafficflow/services");')).toContain("@trafficflow/services");
    expect(codeOnly('await import("@trafficflow/services/mail");')).toContain("@trafficflow/services");
    // Code that follows a comment on the same line, and after a closed block comment.
    expect(codeOnly('// note\nimport "@trafficflow/services";')).toContain("@trafficflow/services");
    expect(codeOnly('/* note */ import "@trafficflow/services";')).toContain("@trafficflow/services");
    // A division is not a comment.
    expect(codeOnly('const r = a / b; import "@trafficflow/services";')).toContain("@trafficflow/services");
  });

  it("declares only core, db and its two runtime libraries as dependencies", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as {
      dependencies: Record<string, string>; devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@trafficflow/core", "@trafficflow/db", "drizzle-orm", "postgres",
    ]);
    // TEST-ONLY: never a runtime dependency. The tests reach it through the workspace (this manifest
    // declares no devDependencies; the root's carry the test tooling).
    expect(pkg.dependencies["@trafficflow/services"]).toBeUndefined();
  });

  /**
   * THE THREE FILES THAT STATE THIS CLOSURE MUST AGREE, and they are in three languages.
   *
   * `package.json` says it in dependencies, `tsconfig.json` in project references, `/.dockerignore`
   * in allow-list lines — and the violation this test exists for needed an edit to all three,
   * because each one refuses the build on its own until it is widened. Checking only the first is
   * how a widening looks half-reverted and compiles anyway.
   *
   * The dockerignore's set is the TRANSITIVE reference closure, not the direct one: `packages/db`
   * references `packages/db-mail`, so `tsc -b` inside the image needs its sources even though the
   * worker never names it. That transitivity is exactly what the first post-split deploy died on
   * (TS5083) — so it is computed here rather than hard-coded, and a new leaf under
   * `packages/db` fails this test in the commit that adds it instead of at a deploy.
   */
  it("package.json, tsconfig.json and /.dockerignore state the SAME closure", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as { dependencies: Record<string, string> };
    const workspaceDeps = Object.keys(pkg.dependencies)
      .filter((d) => d.startsWith("@trafficflow/") || d.startsWith("@ohmail/"))
      .map((d) => d.replace(/^@[^/]+\//, ""))
      .sort();

    // Compile-time face of the same set: a reference is what LETS src/ import a package.
    const direct = referencedPackages(join(ROOT, "apps", "worker", "tsconfig.json")).sort();
    expect(direct, "tsconfig references and runtime dependencies name different packages")
      .toEqual(workspaceDeps);

    // …and its transitive closure, which is what the image has to be able to compile.
    const closure = new Set<string>();
    const walk = (name: string): void => {
      if (closure.has(name)) return;
      closure.add(name);
      for (const next of referencedPackages(join(ROOT, "packages", name, "tsconfig.json"))) {
        walk(next);
      }
    };
    for (const d of direct) walk(d);

    const admitted = readFileSync(join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .flatMap((l) => {
        const m = /^!packages\/([A-Za-z0-9._-]+)$/.exec(l.trim());
        return m ? [m[1]!] : [];
      })
      .sort();
    expect(admitted, "/.dockerignore admits a different set of packages than the worker compiles")
      .toEqual([...closure].sort());
  });

  it("keeps the services import confined to the e2e tests that genuinely need it", () => {
    const users = tsFiles(TEST)
      .filter((f) => !f.endsWith("deps.test.ts"))          // this file names it to assert on it
      .filter((f) => readFileSync(f, "utf8").includes("@trafficflow/services"))
      .map((f) => f.slice(TEST.length))
      .sort();
    // `sent-ingest.pg.test.ts` joined on 2026-08-02 with that change, and it is NAMED here rather than
    // the assertion being loosened: proving that a message ohmail SENT is one row and not two
    // when the server's own Sent copy is later ingested requires driving the real send path,
    // so `SendService` is the consumer under test, not a convenience import. The import boundary still holds —
    // this is devDependencies-only and no `apps/worker/src` file may import services.
    //
    // `uidvalidity-reset.e2e.test.ts` joined on 2026-08-04 with that change, NAMED for the same
    // reason: `MailboxService.requestResync` nulling `mailbox_folders.highestmodseq` is the one
    // user-triggerable way back into the cursor state that disables the inbound read-state mirror,
    // and re-typing that UPDATE in the test would assert on a copy of the SQL rather than on the
    // service. The call is a read-path service method — no key provider, no transaction.
    //
    // `send-multipart.e2e.test.ts` joined with DRAFT-HTML, NAMED for the same reason as
    // `send.e2e.test.ts`: proving an ohmail draft leaves as a real `multipart/alternative` off a
    // live IMAP means driving `SendService` end to end, so services is the consumer under test.
    // The import boundary still holds — devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `bubble-up-now.race.pg.test.ts` joined with the Resurface "Now" slice, NAMED for the same
    // reason and found by this guard going red rather than by the diff that added it. Its whole
    // subject is the RACE between two writers of one `message_states` row — `TriageService`'s
    // press and the worker's own `bubbleUpPass` — on separate physical connections, and the press
    // half is only a real writer if it is the service. Re-typing that UPDATE in the test would
    // race a copy of the SQL against the pass and prove nothing about the code that ships.
    // still holds: devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `screener-auto-act.pg.test.ts` joined with the "Act on suggestions for me" fix, NAMED on the
    // same argument: its whole subject is whether the pass files a sender EXACTLY as the button
    // files them, so the control has to be `ScreenerService`'s own `decide` — the function behind
    // the button, validate step included. A re-typed `applyScreenerDecision` beside the pass would
    // compare this code with itself and could not see a divergence at the service's own door.
    // still holds: devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `screener-cron-press.race.pg.test.ts` joined with SEC3-MONEY-1, NAMED on the same argument
    // as `bubble-up-now.race.pg.test.ts` and reached from the money side. Its subject is the race
    // between THIS app's auto-suggest pass and a person pressing Suggest, on separate physical
    // connections, over the one held sender both select by construction — before the exclusive
    // spend claim they each made a paid model call and the ledger charged for one. The press half
    // is only a real second buyer if it is `ScreenerService`: a re-typed copy of that loop would
    // race an imitation of the request path and certify nothing about the one that ships.
    // still holds — devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `known-set-cache.pg.test.ts` joined with the known-set memo, NAMED for a reason that is the
    // strongest of the lot: the guard's SUBJECT is whether the API tier — a different process,
    // outside every lease and every fence — can move what `listKnownLocators` projects. The memo's
    // whole soundness argument rests on the answer being no, and that answer is a property of
    // `MessageService.markSeen` and the `ON CONFLICT` clause it calls, not of anything in this app.
    // A re-typed copy of those two statements would assert that MY copy preserves the projection
    // while the shipped service quietly stopped. The import boundary still holds — devDependencies-only, and no
    // `apps/worker/src` file imports services.
    //
    // `thread-erasure-backfill-lock.pg.test.ts` joined with the lock-order fix for account
    // erasure vs the thread backfill, NAMED for the same reason `sent-ingest.pg.test.ts` is:
    // proving the two production entry points never deadlock when run concurrently requires
    // driving the real `deleteAccount`, and a re-typed copy of its DELETE order would prove the
    // copy's ordering, not the shipped service's. The import boundary still holds — devDependencies-only, and no
    // `apps/worker/src` file imports services.
    //
    // `push-wake.e2e.pg.test.ts` joined with the UnifiedPush wake, NAMED on the standing argument.
    // Its subject is a pipeline that STARTS in the services tier: a phone registers an endpoint
    // through `PushService.subscribe`, whose SSRF gate is half of what the test exists to prove,
    // and the wake this app then sends is only about a real registration if a real registration
    // made it. Writing the row by hand would assert that MY INSERT satisfies the gate — which is
    // the one thing an SSRF test may not assume — and would leave the registration-time refusals
    // (a private literal, a name that resolves into link-local) proven nowhere against the code
    // that answers the route. The import boundary still holds: devDependencies-only, and no `apps/worker/src` file
    // imports services — `push-wake.ts` reaches the shared gate through `@trafficflow/core/net`,
    // which is exactly why that gate lives in `core` rather than beside the registration.
    //
    // `two-world-reader-decides.test.ts` joined with the symmetric-takeover request path (mail
    // 0088), NAMED for the reason `screener-cron-press.race.pg.test.ts` already states one
    // row up: its subject is whether a READER's decision, made through `ScreenerService.decide`'s
    // own validate + role branch, is the thing `apps/worker/src/request-drain.ts`'s
    // `applyMetaRequests` actually applies — and a hand-typed `organizer_requests` INSERT would
    // prove that the DRAIN honours a row shaped like the service's, not that the service's own
    // validation, idempotency claim and 202 response are what a real reader press produces.
    // still holds: devDependencies-only, and neither `apps/worker/src` file this test drives
    // (`index.ts`, `request-drain.ts`) imports services.
    //
    // `request-capability-gate.test.ts` walks the chain from the request key to the door (mail 0090),
    // NAMED on the narrowest argument of the set: its whole subject is a CHAIN that starts at
    // `apps/worker/src/lease.ts#organizerCapabilitiesFor` and ends at `ScreenerService.decide`,
    // and a test that stopped at the worker end would prove only what a function returns — which
    // is not the property. What has to hold is that an account holding no request key REACHES the
    // door as a 409 with no row written, and that one holding a key reaches it as a queued
    // request, and only the real service can answer either. The import boundary still holds:
    // devDependencies-only, and the `apps/worker/src` file it reads (`lease.ts`) imports nothing
    // from services.
    // `release-stranded-claim.test.ts` joined 2026-09-05 with the hand-back slice, NAMED on the
    // set's own argument and found by this guard rather than by the diff that added it — it had
    // been red on the branch for several rounds because the file that added it never ran this
    // census. Its subject is what `MailboxService.release` DECIDES: the first version of that
    // test mocked `release`, which proved the pane calls an endpoint and nothing about what the
    // endpoint does, and the defect it was written for lived entirely inside the real method.
    // Re-typing that decision in the test would assert on a copy of it. The import boundary still holds:
    // devDependencies-only, and no `apps/worker/src` file imports services.
    // `trash-restore.e2e.test.ts` joined with the Trash slice, NAMED on the set's own argument:
    // it drives delete and restore as a ROUND TRIP against a real mail server, so the message has
    // to leave and come back through `MessageService` itself — a hand-written row would prove the
    // drain honours a shape, not that the service's own move and its folder bookkeeping produce
    // it. The import boundary still holds: devDependencies-only, and the `apps/worker/src` file it drives
    // (`sync.ts`) imports nothing from services.
    //
    // `held-release.pg.test.ts` joined with mail 0104, NAMED on `bubble-up-now.race.pg.test.ts`'s
    // argument. Its subject is that the number a person is SHOWN and the number a press RELEASES
    // are one number, and the two halves live on opposite sides of this boundary: the count and
    // the press are `heldReleaseGroups`/`releaseHeld` in services, the filing is `ruleRetroPass`
    // here. A re-typed copy of the press would assert that MY copy agrees with the pass while the
    // shipped service drifted, which is the one thing the case exists to refuse. The import boundary still holds —
    // devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `seed-release.test.ts` joined with 0.19.0's seed release, NAMED on `held-release.pg.test.ts`'s
    // argument turned round: its subject is that the pair `confirmSeed` WRITES is the pair
    // `rule-retro.ts#isReleaseRun` READS, and the defect it was written for was that the service
    // wrote neither. A hand-typed `rules` INSERT would assert that MY copy of the release shape is
    // what the pass honours while the shipped seed went on writing NULL — which is the whole
    // defect. The import boundary still holds: devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `gate-release.pg.test.ts` joined with the same slice, NAMED because the boundary IS its
    // subject. `gateReleasePass` must act on exactly the mail `heldReleaseSummary` offers a press
    // for, and the two predicates are on opposite sides of this rule, so they cannot share a
    // spelling — the tie has to be behavioural, which means running both over one fixture.
    // still holds: devDependencies-only, and `apps/worker/src/gate-release.ts` imports only the db
    // and core packages.
    //
    // `ohbox-unscreened-press.pg.test.ts` joined with the data half, NAMED on
    // `held-release.pg.test.ts`'s argument: its subject is that the mail `screenUnscreened` moves
    // is exactly the mail the ORGANIZER's own filing queue then owes, and the two halves are on
    // opposite sides of this rule — the press is in services, the queue is `listPendingFolderStates`
    // and the reconciler here. A hand-written `folder_state` UPDATE would assert that MY copy of
    // the intent is what the queue honours while the shipped press drifted, which is the one thing
    // the case exists to refuse. The import boundary still holds: devDependencies-only, and no `apps/worker/src`
    // file imports services.
    //
    // `gate-release-erasure-fence.pg.test.ts` joined with 0.19.1's erasure-fence slice, NAMED on
    // the same file's argument: its subject is that the completion stamp refuses once the Art. 17
    // sweep has committed, and the fence's whole contract is stated against `deleteAccount`'s own
    // first statement and lock order. A hand-written `update accounts set erased_at` would be MY
    // copy of what erasure does — it would still pass if the shipped sweep stopped stamping, which
    // is the one thing the case exists to refuse. The import boundary still holds: devDependencies-only, and
    // `apps/worker/src/gate-release.ts` imports only the db and core packages.
    // `send-warm-connection.e2e.test.ts` joined with SEND-023, NAMED on `send.e2e.test.ts`'s
    // argument: its subject is that three consecutive presses cost one LOGIN on the wire, and a
    // press is only a real press if it is `SendService.send` — reserve, submit, finalize, project —
    // over the kept connection. A loop of bare `adapter.send` calls would count the LOGINs of an
    // imitation. The import boundary still holds: devDependencies-only, and no `apps/worker/src` file imports services.
    //
    // `mailbox-erase-leaves-the-mail-server.imap.pg.test.ts` joined with the per-mailbox erase,
    // NAMED on the same argument: its subject is the whole erase as the product runs it — the
    // removal door with the typed address, then `mailboxErasurePass` — against a real mail server
    // counted before and after. A hand-written stamp would be MY copy of what the door does and
    // would pass if the shipped confirmation stopped comparing. The import boundary still holds.
    //
    // `reader-decision-two-stores.test.ts` joined on `two-world-reader-decides.test.ts`'s argument,
    // with two stores in place of one: the reader's press must be the service's own, so the id it
    // signs is the one a real reading install signs. The import boundary still holds.
    //
    // The profile round trip joined with the screening fan-out fix: its subject is that the
    // payload the reader's settings doors BUILD is the one this drain applies, so the doors are
    // the services' own. The import boundary still holds.
    // `rule-create-wire.test.ts`, `rule-removed-on-the-other-computer.test.ts` and
    // `reader-rule-rows-settle-on-the-ack.test.ts` joined with
    // NAMED on `two-world-reader-decides.test.ts`'s argument: the defect
    // was a `rule.create` the door composed and the organizer refused, invisible to every case
    // that hand-wrote the payload. Only `RulesService` composes what a reader sends. The import boundary still
    // holds: devDependencies-only, and `request-drain.ts` imports nothing from services.
    // `move-before-the-walk.imap.test.ts` joined with that change, on
    // `api-move-handoff.e2e.test.ts`'s argument: the pending row is the one `MessageService.move`
    // writes, so the pass before the walk files what a press records. The import boundary still holds.
    // `rule-press-settles-on-every-leg.test.ts` and `rule-key-converges.pg.test.ts` joined with
    // the rule-key fix on the same argument: the press whose legs settle, and the create
    // racing behind the account's rule-key lock, are the ones `RulesService` makes.
    expect(users).toEqual([
      "_profile-round-trip.ts",
      // The self-sent suite reads the Ohbox through `/sync` into a client mirror, the sent-expunge
      // twins' argument: the claim is what a client shows. The import boundary still holds.
      "_self-sent-suite.ts",
      // A letter expunged out of Answer Later, read where a person reads the pile: `listByState`
      // and `/sync` into a client mirror. The pile is the service's own read. The import boundary still holds.
      "answer-later-expunge.imap.pg.test.ts",
      "api-move-handoff.e2e.test.ts", "attachments.e2e.test.ts",
      "bubble-up-now.race.pg.test.ts",
      // A letter deleted while the app was closed, read through the same three surfaces as the
      // sent-expunge twins below and for their reason. The import boundary still holds.
      "deleted-while-closed.e2e.test.ts",
      // A folder deleted elsewhere, read through the same surfaces and the thread service, for the
      // same reason. The import boundary still holds.
      "empty-folder-deleted-elsewhere.e2e.test.ts",
      "folder-deleted-elsewhere.e2e.test.ts",
      "forward-round-trip.e2e.test.ts",
      // The rule is `ScreenerService.decide`'s and the revoke `RulesService.remove`'s: the 500 lived
      // in the service's delete over the rows the gap pass writes. A hand-written delete tests a copy.
      "gap-file-then-revoke.pg.test.ts",
      "gate-release-erasure-fence.pg.test.ts", "gate-release.pg.test.ts",
      // Its press is `MessageService.delete` and its reading `MailboxService.list`: the intent the
      // pass must void and the count the strip reads. A hand-written row would test a copy.
      "gone-letter-filing.imap.pg.test.ts",
      // The press is `MailboxService.release` itself: the doorbell it rings beside the release
      // stamp is the subject, as `organizeHere`'s twin below. The import boundary still holds.
      "hand-back-rings-the-pass.pg.test.ts",
      "held-release.pg.test.ts",
      "known-set-cache.pg.test.ts",
      // The person's next move and delete on a refused filing are `MessageService`'s own: the desire
      // they write keeps the refusal's schedule, which is the subject. The import boundary still holds.
      "legacy-news-filing.test.ts",
      // Every letter of a pre-0.22 store is read where a person reads it, `MessageService.list` and
      // `SearchService.search`: the claim is that no view, History or Search loses one. The import boundary still holds.
      "legacy-news-folder.e2e.test.ts",
      // The held-release press over a list address is `releaseHeld` itself: its bag is the offer's
      // own query, and a hand-built `within` would test a copy of the bag the defect lived in. The import boundary still holds.
      "list-address-is-not-a-person.test.ts",
      "mailbox-erase-leaves-the-mail-server.imap.pg.test.ts",
      "move-before-the-walk.imap.test.ts",
      "ohbox-unscreened-press.pg.test.ts",
      // The press is `MailboxService.organizeHere` itself: the doorbell it rings beside the takeover
      // stamp is the subject, and a hand-written stamp would test a copy. The import boundary still holds.
      "organize-here-wakes-the-pass.pg.test.ts",
      // A part read while the organizer moves its message goes through `AttachmentsService` itself:
      // the re-read where it went is the door's, so a copy would miss it. The import boundary still holds.
      "part-cut-by-move.e2e.test.ts",
      "profile-fan-out-round-trip.pg.test.ts", "profile-fan-out-round-trip.test.ts",
      "push-wake.e2e.pg.test.ts",
      "reader-decision-two-stores.test.ts",
      "reader-rule-rows-settle-on-the-ack.test.ts",
      "release-stranded-claim.test.ts",
      "request-capability-gate.test.ts",
      // The press past the record window is the Screener's own door, on the two-world rig's
      // argument: the id it signs is the one a reading install signs. The import boundary still holds.
      "request-drain-past-meta-window.test.ts",
      // A reader's press through `MessageService.move`, so the record's two instants are the door's own.
      "request-drain.test.ts",
      // The cancel lives in `MessageService.restore`, composed with this app's reconcile: a
      // hand-written restore UPDATE would test a copy of the fix. The import boundary still holds.
      "restore-before-the-delete-lands.test.ts",
      "rule-create-wire.test.ts", "rule-key-converges.pg.test.ts",
      // The erasure the auto-act pass races is `deleteAccount` itself: a hand-written stamp would
      // be a copy of the erasure's lock order, which is the subject. The import boundary still holds.
      "rule-lock-order.pg.test.ts",
      "rule-press-settles-on-every-leg.test.ts",
      "rule-removed-on-the-other-computer.test.ts",
      // The PATCH racing a create behind the account's rule-key lock is `RulesService`'s own door,
      // on `rule-key-converges.pg.test.ts`'s argument. The import boundary still holds.
      "rule-twins-converge.pg.test.ts",
      // The screen-out is `ScreenerService.decide` and the request its unsubscribe door's own: the claim
      // is what that press sends, and a hand-written trigger would test a copy. The import boundary still holds.
      "screen-out-unsubscribes-once.e2e.test.ts",
      "screener-auto-act.pg.test.ts",
      // The act's filing with no rule is listed and put back through the services' own Filed
      // automatically doors, on `screener-auto-put-back.test.ts`'s argument. The import boundary still holds.
      "screener-auto-act.test.ts",
      // Put back is the services' own move door, and the claim is that this pass then leaves the
      // row: a hand-written undo would test a copy. The import boundary still holds.
      "screener-auto-put-back.test.ts",
      "screener-cron-press.race.pg.test.ts",
      "seed-release.test.ts",
      "send-multipart.e2e.test.ts", "send-warm-connection.e2e.test.ts", "send.e2e.test.ts",
      // Its press is `RulesService.update`, whose provenance write the ingest here then honours: a
      // hand-written rules UPDATE would be MY copy of that write, the defect itself. The import boundary still holds.
      "sender-press-outranks-the-posture.imap.pg.test.ts",
      // The two sent-expunge twins read History, Search and `/sync` through the services that
      // serve them: the claim is that a deleted message leaves those three surfaces, and a
      // re-typed query would test a copy. The import boundary still holds: no `apps/worker/src` file imports it.
      "sent-expunge.pg.test.ts", "sent-expunge.test.ts",
      "sent-ingest.pg.test.ts", "thread-erasure-backfill-lock.pg.test.ts",
      // A message over the download ceiling is listed, found and opened through the services that
      // serve them, and moved and deleted by their own doors: a re-typed query would test a copy.
      "too-large-message-is-listed.e2e.test.ts",
      "trash-restore.e2e.test.ts",
      "two-world-reader-decides.test.ts",
      "uidvalidity-reset.e2e.test.ts",
    ]);
  });
});
