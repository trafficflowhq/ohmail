import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// THE ONE SCANNER. Comments are blanked (never deleted) before anything is matched, so a
// docblock that QUOTES the call is not read as one and every offset below stays true. A census a
// comment can satisfy certifies a host by prose, which is worse than having no census: a file
// mentioning `runSyncCycle(` in a doc line was read as a fifth host the day one was written.
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readSource as readStartFunction } from "./_start-function.js";
import { isEnginePart, readingTheUnit } from "../../../test/support/engine-unit.js";

/** The worker's start function and the desktop's engine each read as one text. */
const readSource = readingTheUnit(readStartFunction);

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY ORGANIZER `runSyncCycle` HOST DRAINS `_meta` — AND DOES IT AFTERWARDS (mail 0090)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `applyMetaRequests` (`packages/organizer/src/request-drain.ts`) is only load-bearing if EVERY process
 * that runs `runSyncCycle` while organizing a mailbox calls it. A host that syncs as an organizer
 * and never drains is "built-tested-unreachable": the code compiles, `request-drain.test.ts`
 * proves the function itself is correct, and a reader's decision still sits in `ohmail/_meta` for
 * ever on that one host, silently, because nothing there ever calls it.
 *
 * `organizer-event-census.test.ts` is the precedent this mirrors — its own header states the
 * shape exactly: "a scanner that finds nothing is green, and a broken scanner finds nothing," so
 * the found set is asserted EXACTLY rather than as a lower bound, in both directions.
 *
 * ── AND THE ORDER IS PART OF THE CENSUS NOW ─────────────────────────────────────────────────
 *
 * The drain used to run BEFORE `runSyncCycle`, so a decision would govern mail arriving in the
 * same pass. That is inverted, and the inversion is a security property rather than a preference:
 * `ohmail/_meta` is a folder anyone with APPEND rights on the mailbox can write to, so a drain
 * that runs FIRST lets a flood of records delay — or with a slow enough database, indefinitely
 * postpone — the pass that reads somebody's mail. Reading mail is the product.
 *
 * A host could regress that by moving one call above another, in one file, with nothing failing.
 * So the ordering is asserted textually per host: the first `await runSyncCycle(` must appear
 * before the first `applyMetaRequests(`.
 *
 * ── WHY `await runSyncCycle(` AND NOT A BARER `runSyncCycle` ────────────────────────────────
 *
 * The bare identifier also matches `export async function runSyncCycle(...)` — the DEFINITION, in
 * `packages/organizer/src/sync.ts` — and a census that counted its own declaration as a caller would
 * either have to exempt that file by name (a birth-site-shaped hole) or silently expect `sync.ts`
 * to drain requests before calling itself.
 *
 * ── WHY `apps/worker/scripts` IS OUT OF SCOPE ───────────────────────────────────────────────
 *
 * A separate live-verification script calls `runSyncCycle` directly against a LIVE
 * mailbox for manual, human-run verification — it is not a process anything deploys. The
 * distinction the walk relies on is structural (`scripts/` vs `src/`), not a judgement call made
 * per file.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKER_SRC = join(HERE, "..", "src");
/** The organizer's package: the cycle and the drain moved there from the worker (ruling:organizer-cut). */
const ORGANIZER_SRC = join(HERE, "..", "..", "..", "packages", "organizer", "src");
const SIDECAR_SRC = join(HERE, "..", "..", "sidecar", "src");

/**
 * `restart.ts` calls `runSyncCycle` twice and has NO PRODUCTION CALLER — its own module header
 * says so verbatim: "NO PRODUCTION CALLER SINCE ATTACH STOPPED DRAINING. DO NOT RE-WIRE IT INTO
 * `attach()`." It survives only as `test/restart.e2e.test.ts`'s subject, proving a property of
 * `runSyncCycle` (adopt-then-reconcile converges in two passes) that has nothing to do with
 * requests. Exempted by name, as a deliberate decision recorded here rather than a blind spot.
 */
const NO_PRODUCTION_CALLER = new Set([join(WORKER_SRC, "restart.ts")]);

/**
 * THE CALL, NOT ONE SPELLING OF IT.
 *
 * This was the literal `await runSyncCycle(` until the sidecar's call moved inside a store lane —
 * `await inStoreLane("ingest", async () => runSyncCycle({ … }))`, where the `await` is on the lane
 * and the cycle is the lane's body. The literal then matched nothing on that host, and a matcher
 * that stops matching reports an ABSENCE, which this census reads as "not a host" and passes.
 * So the reader finds the call expression and excludes the DECLARATION by name.
 */
function syncCycleCalls(raw: string): number[] {
  const src: string = withoutComments(raw);
  const at: number[] = [];
  const re = /\brunSyncCycle\s*\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
    at.push(m.index);
  }
  return at;
}
const callsSyncCycle = (src: string): boolean => syncCycleCalls(src).length > 0;
const firstSyncCycleCall = (src: string): number => syncCycleCalls(src)[0] ?? -1;
const DRAIN_NEEDLE = /applyMetaRequests\(/;

/**
 * THE UNGUARDED TWINS ARE GONE, and this holds that they stay gone.
 *
 * 0.14.1's first cut shipped `applyMetaRequestsUnguarded` / `driveOutstandingRequestsUnguarded`
 * behind a `REQUEST_AUTHENTICITY_IMPLEMENTED` flag, because the authenticity work was owed. It is
 * done: the precondition is now "this account holds a request key", which is a FACT the drain
 * reads rather than a flag somebody sets. A stand-in for a real precondition is worse than the
 * precondition, because it can be true when the precondition is false — so neither the twins nor
 * the flag may come back under those names.
 */
const RETIRED_NEEDLE = /(?:applyMetaRequests|driveOutstandingRequests)Unguarded\b|REQUEST_AUTHENTICITY_IMPLEMENTED/;

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
    .map((name) => join(dir, name))
    .filter((p) => !isEnginePart(p));
}

function organizerCycleHosts(): string[] {
  const files = [...tsFilesIn(WORKER_SRC), ...tsFilesIn(ORGANIZER_SRC), ...tsFilesIn(SIDECAR_SRC)];
  return files.filter((f) => callsSyncCycle(readSource(f)));
}

describe("every organizer runSyncCycle host drains ohmail/_meta, after the cycle", () => {
  it("the walk found something — a scanner that stopped matching is red, not green", () => {
    expect(organizerCycleHosts().length).toBeGreaterThan(0);
  });

  /* AND THE READER ITSELF, DRIVEN. The test above asks whether the walk found ANY host, which a
     matcher that lost ONE host still passes — the sidecar's call moved into a store lane and only
     the exact-hosts case below caught it. These are the four shapes the reader has to tell apart. */
  it("reads a call in both spellings, and refuses the declaration and a file without one", () => {
    const bare = "const outcome = await runSyncCycle({ adapter: conn });";
    const lane = "const outcome = await inStoreLane(\"ingest\", async () => runSyncCycle({ adapter: conn }));";
    const decl = "export async function runSyncCycle(deps: SyncDeps): Promise<SyncOutcome> {";
    expect(callsSyncCycle(bare), "the pre-lane spelling stopped matching").toBe(true);
    expect(callsSyncCycle(lane), "a call inside a store lane is not read as a call").toBe(true);
    expect(callsSyncCycle(decl), "the declaration is read as a call").toBe(false);
    expect(callsSyncCycle("const x = 1;"), "a file with no call matched anyway").toBe(false);
    // A DOCBLOCK NAMING THE CALL IS NOT A HOST. `sync.ts` acquired one when the lease permit
    // became a required field and cited `runSyncCycle(` in the field's own docblock; the reader
    // counted the module that DEFINES the cycle as a host that must drain `ohmail/_meta`.
    expect(
      callsSyncCycle("/** the census reads a `runSyncCycle(` call's own argument list. */\nconst x = 1;"),
      "a comment quoting the call is read as a call",
    ).toBe(false);
    expect(
      callsSyncCycle("// runSyncCycle(deps)\nconst outcome = await runSyncCycle({ adapter: conn });"),
      "a real call beside a comment stopped matching",
    ).toBe(true);
    // the ordering case asks WHERE the call is, so the index is the call's, not the word's.
    expect(firstSyncCycleCall(lane)).toBe(lane.indexOf("runSyncCycle({ adapter: conn })"));
    expect(firstSyncCycleCall("const x = 1;")).toBe(-1);
  });

  it("the hosts calling runSyncCycle are exactly the known ones", () => {
    const found = organizerCycleHosts().map((f) => f.split(sep).slice(-3).join(sep)).sort();
    const expected = [
      join("worker", "src", "index.ts"),
      join("worker", "src", "restart.ts"),
      join("worker", "src", "reconcile-cron.ts"),
      join("sidecar", "src", "engine.ts"),
    ].sort();
    expect(found).toEqual(expected);
  });

  it("every host EXCEPT the one with no production caller also drains applyMetaRequests", () => {
    const hosts = organizerCycleHosts().filter((f) => !NO_PRODUCTION_CALLER.has(f));
    expect(hosts.length).toBeGreaterThan(0);
    for (const f of hosts) {
      const src = readSource(f);
      expect(DRAIN_NEEDLE.test(src), `${f} calls runSyncCycle but never applyMetaRequests — a reader's ` +
        "decision would sit in ohmail/_meta for ever on this host").toBe(true);
    }
  });

  /**
   * MUTATION WATCHED RED: move either host's `applyMetaRequests(` call back above its
   * `await runSyncCycle(` and this fails, naming the file.
   */
  it("and drains AFTER the cycle, never before it — a flooded folder must not delay mail", () => {
    const hosts = organizerCycleHosts().filter((f) => !NO_PRODUCTION_CALLER.has(f));
    expect(hosts.length).toBeGreaterThan(0);
    for (const f of hosts) {
      const src = readSource(f);
      const cycleAt = firstSyncCycleCall(src);
      const drainAt = src.search(DRAIN_NEEDLE);
      expect(cycleAt).toBeGreaterThanOrEqual(0);
      expect(drainAt).toBeGreaterThanOrEqual(0);
      expect(drainAt, `${f} drains ohmail/_meta BEFORE runSyncCycle — a folder anyone can append ` +
        "to would then be able to delay this mailbox's mail").toBeGreaterThan(cycleAt);
    }
  });

  it("neither the unguarded twins nor the authenticity flag exist anywhere in either host tree", () => {
    const files = [...tsFilesIn(WORKER_SRC), ...tsFilesIn(ORGANIZER_SRC), ...tsFilesIn(SIDECAR_SRC)];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((f) => RETIRED_NEEDLE.test(readSource(f)))
      .map((f) => f.split(sep).slice(-3).join(sep));
    expect(offenders, "the containment flag and its unguarded twins are retired — the gate is now " +
      "the account's request key, which is a fact rather than a switch").toEqual([]);
  });

  /**
   * THE GATE IS A READ OF THE KEY, and it is on the entry point every host reaches rather than
   * repeated at each call site — a fourth host added later inherits it by construction.
   */
  it("the drain gates on the mailbox's request key, in the one function each host calls", () => {
    const src = readSource(join(ORGANIZER_SRC, "request-drain.ts"));
    expect(src).toMatch(/export async function applyMetaRequests\(/);
    expect(src).toMatch(/export async function driveOutstandingRequests\(/);
    // BOTH halves stop without a key — the one that APPLIES records and the one that WRITES them.
    // Either alone would leave a hole: an organizer that applied unverifiable records, or a reader
    // that put unsignable ones in somebody's mailbox.
    expect(src.match(/const key = rt\.requestKey;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src.match(/if \(key === null\) return/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  /**
   * THE KEY IS NEVER READ FROM A DATABASE OR FETCHED, in either host tree.
   *
   * It is HKDF over the mailbox password, derived by whoever already decrypted that credential to
   * open IMAP. A stored key would need delivering, and there is no channel to deliver it on: a
   * local install talks only to the mail server. So a `request_key` COLUMN or an endpoint reappearing
   * anywhere here means somebody has rebuilt the design that could not work.
   */
  it("no host reads a stored request key or fetches one", () => {
    const files = [...tsFilesIn(WORKER_SRC), ...tsFilesIn(ORGANIZER_SRC), ...tsFilesIn(SIDECAR_SRC)];
    const offenders = files
      .filter((f) => /readRequestKey|readOrMintRequestKey|request_key|requestKeyRotatedAt/.test(readSource(f)))
      .map((f) => f.split(sep).slice(-3).join(sep));
    expect(offenders, "the request key is derived from the mailbox password, never stored or fetched")
      .toEqual([]);
  });

  it("the no-production-caller exemption is real — it still calls runSyncCycle and still lacks the drain", () => {
    for (const f of NO_PRODUCTION_CALLER) {
      const src = readSource(f);
      expect(callsSyncCycle(src), `${f} no longer calls runSyncCycle — the exemption has gone stale`).toBe(true);
      expect(DRAIN_NEEDLE.test(src),
        `${f} now calls applyMetaRequests — if it has gained a production caller, remove the exemption instead`)
        .toBe(false);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AND A CYCLE THAT THROWS MUST NOT SKIP THE DRAIN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The ordering above — drain AFTER the mail — has a cost, and it went unpaid on both hosts: a cycle
 * that THREW escaped straight past the drain to the per-mailbox catch. A mailbox with a PERSISTENT
 * sync fault therefore drained nothing for as long as the fault lasted, and a reader's decisions on
 * it expired reporting that NOBODY TOOK THEM while an organizer was live and connected throughout.
 * Of the three things that could happen to a decision — applied, refused, or never looked at — that
 * is the one the person acts on, by pressing again.
 *
 * Both hosts now HOLD the cycle's failure in `cycleError`, run the drain, and rethrow it before any
 * of the success bookkeeping. Nothing else about the failure changes.
 *
 * ── WHY THIS IS ASSERTED TEXTUALLY, LIKE THE ORDERING ABOVE ─────────────────────────────────
 *
 * It is a control-flow property of one long function per host, with no seam to inject at. The
 * sidecar's half is ALSO proven behaviourally, against the real engine, in
 * `apps/sidecar/test/drain-survives-cycle-fault.test.ts` — a faulted cycle there leaves the folder
 * read exactly once, and the shape this test pins is what makes that true. This census is what
 * keeps the same shape on the host that has no such harness, and what fails first if either loses
 * it.
 *
 * MUTATION WATCHED RED: replace either host's `cycleError = err` with a bare `throw err` and this
 * names the file.
 */
describe("a mail cycle that throws still reaches the drain, on every host", () => {
  const HOLD_NEEDLE = /catch \((?:err|e)\) \{\s*(?:\/\/[^\n]*\n\s*)*cycleError = (?:err|e);/;
  /* The point where the held failure is ANSWERED. Two shapes, one meaning: `index.ts` rethrows
   * it outright, and `reconcile-cron.ts` opens the arms that already existed for its two
   * handover classes and rethrows anything else. Matching the condition rather than the throw
   * is what covers both without asking either to be written the other one's way. */
  const RETHROW_NEEDLE = /if \(cycleError !== null\)/;

  it("each host holds the failure, drains, and rethrows — in that order", () => {
    const hosts = organizerCycleHosts().filter((f) => !NO_PRODUCTION_CALLER.has(f));
    expect(hosts.length).toBeGreaterThan(0);
    for (const f of hosts) {
      const src = readSource(f);

      expect(HOLD_NEEDLE.test(src),
        `${f} lets its sync cycle's throw escape instead of holding it — a mailbox with a `
        + "persistent sync fault would drain nothing for as long as the fault lasts").toBe(true);
      expect(RETHROW_NEEDLE.test(src),
        `${f} holds the cycle's failure and never rethrows it — a failed pass would be reported as `
        + "a successful one").toBe(true);

      const cycleAt = firstSyncCycleCall(src);
      const holdAt = src.search(HOLD_NEEDLE);
      const drainAt = src.search(DRAIN_NEEDLE);
      const rethrowAt = src.search(RETHROW_NEEDLE);

      // The hold is the cycle's own catch…
      expect(holdAt, `${f}: the failure is held somewhere other than around the cycle`)
        .toBeGreaterThan(cycleAt);
      // …the drain runs after it…
      expect(drainAt, `${f}: the drain does not run after the cycle's failure is held`)
        .toBeGreaterThan(holdAt);
      // …and the failure is rethrown only once the drain has had its turn. The other order is the
      // defect wearing a `try`.
      expect(rethrowAt, `${f} rethrows the cycle's failure BEFORE the drain — which skips it exactly `
        + "as the bare throw did").toBeGreaterThan(drainAt);
    }
  });

  /**
   * AND AN UNREADABLE LEASE STOPS THE DRAIN ON EVERY HOST.
   *
   * The block above exists so an ORDINARY fault still drains. `LeaseUnavailableError` is not one.
   * It does not say another organizer holds this mailbox — it says the pass could not find out, and
   * the drain APPENDS acknowledgements and EXPUNGES records on standing that comes from the lease
   * and nowhere else. A stand-down is a NO, a fence is a NO; this is a question with no answer, and
   * a write is precisely what must not proceed on one. Draining through it is how a process keeps
   * writing into a mailbox somebody else has already taken over.
   *
   * It does not contradict the gate one layer down, which ACTS on a partial read rather than
   * refusing: that is a read deciding what it knows, this is a write claiming standing it failed to
   * establish, and being wrong costs opposite things.
   *
   * Held as a census because the property belongs to every host at once, and the two spell the gate
   * differently (`cycleMayStillWrite` / `mayStillWrite`).
   *
   * MUTATION WATCHED RED: drop the clause from either host and that host is named here.
   */
  it("no host drains when the lease could not be READ — an unanswered question is not a licence", () => {
    const hosts = organizerCycleHosts().filter((f) => !NO_PRODUCTION_CALLER.has(f));
    expect(hosts.length).toBeGreaterThan(0);
    for (const f of hosts) {
      const src = readSource(f);
      // The gate's own expression, up to its terminating `;` — not merely the file mentioning the
      // class somewhere, which every one of these hosts does for unrelated reasons.
      const gate = /(?:cycleM|\bm)ayStillWrite = [^;]*;/.exec(src);
      expect(gate, `${f}: no drain write-gate found — the census can no longer see this property`)
        .not.toBeNull();
      expect(gate![0].includes("LeaseUnavailableError"),
        `${f} drains after a lease it could not read, appending acknowledgements and expunging `
        + "records without having established that it is still the organizer").toBe(true);
    }
  });

  /**
   * ONE call site per host. A second copy of the drain inside a catch would satisfy every ordering
   * assertion above and apply a decision twice — the idempotency key is a safety net, not a licence
   * to spend it.
   */
  it("each host drains from exactly one place", () => {
    const hosts = organizerCycleHosts().filter((f) => !NO_PRODUCTION_CALLER.has(f));
    expect(hosts.length).toBeGreaterThan(0);
    for (const f of hosts) {
      const src = readSource(f);
      expect(src.match(/applyMetaRequests\(/g)?.length ?? 0,
        `${f} applies records from more than one place — a second call inside a catch would satisfy `
        + "every ordering assertion above and apply a decision twice").toBe(1);
      // At most one, not exactly one: `reconcile-cron.ts` is an ORGANIZER-only path (it is reached
      // past the reader refusal and the lease permit), so it owes the organizer's half and has no
      // reader's half to owe. A second call is the defect either way.
      expect(src.match(/driveOutstandingRequests\(/g)?.length ?? 0,
        `${f} appends this install's own decisions from more than one place`).toBeLessThanOrEqual(1);
    }
  });
});
