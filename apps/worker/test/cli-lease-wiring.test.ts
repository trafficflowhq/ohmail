import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acquireLeasePermit, assertNoLiveTwin } from "../src/lease.js";
import { FakeMetaFolder } from "./_fakeadapter.js";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { PermitClock } from "./_permit-clock.js";

/**
 * THE TWO OPERATOR CLIs' LEASE WIRING — the seam the pg suite could not see.
 *
 * @reads: apps/worker/src/run-junk-sweep.ts apps/worker/src/run-redacted-restore.ts apps/worker/src/run-blank-repair.ts
 *
 * This file builds its read path at runtime, so no landing pass can pair it with the sources
 * it reads: K55 moved their literals and the tier read it RED with every gate green. The line
 * above is what the landing selects on (`reads-list.mjs`), and it moves with the file it names.
 *
 * ── WHY A SOURCE-SHAPED TEST, WHICH IS NORMALLY THE WEAK KIND ────────────────────────────────
 *
 * `run-junk-sweep.ts` and `run-redacted-restore.ts` are top-level scripts: they read `process.argv`,
 * open a Postgres pool, dial IMAP and call `process.exit`. Importing one executes it. So the
 * behavioural route into them is an end-to-end fixture with a real database, a real mailbox and an
 * operator's argv — which is worth building and is not what this file is.
 *
 * This exists because of what a review round found in the commit that shipped the permit
 * (2026-09-01). `junk-sweep-lease.pg.test.ts` advertised a mutation — *"drop
 * `guard: () => permit.check()` from `run-junk-sweep.ts`'s `junkSweepPass` call"* — as its evidence
 * that the CLI spends the permit before moving mail. **That file never loads `run-junk-sweep.ts`.**
 * It imports `junkSweepPass` and wires a permit of its own, so the stated mutation could not have
 * reddened it, and the production wiring had no guard at all: an edit removing it would have passed
 * the entire suite while the CLI moved mail on nobody's authority.
 *
 * A source assertion is a weak instrument and is chosen deliberately over a decorative strong one.
 * It cannot tell you the wiring WORKS — `junk-sweep-lease.pg.test.ts` proves that against real
 * Postgres, for a permit passed the way this file proves the CLI passes one. What it can do is fail
 * when the line goes away, which is the failure that was undetectable. The two together are the
 * claim; neither is on its own.
 *
 * ── THE TWIN-CHECK ASSERTIONS ARE THE LOAD-BEARING ONES ──────────────────────────────────────
 *
 * The same round found the CLIs claiming with the LIVE WORKER'S install id at `lastNonce: null`,
 * which makes `decideLease` treat a running worker's fresh claim as this process's own — two
 * organizers on one mailbox, then a self-stand-down that empties `ohmail/_meta`. The whole sequence,
 * and the sentinel-nonce repair that was tried and rejected, is on `assertNoLiveTwin`.
 *
 * The repair is one call placed BEFORE the gate, and `lastNonce: null` deliberately stays. A repair
 * that small with no test is one careless edit from being undone, so the source assertions below
 * pin the call and its ORDER, and the behavioural block after them drives the real `runLeaseGate`
 * through all four cases the check has to get right: a live twin refuses; a stale own claim passes
 * (this is the one that killed the sentinel); a foreign install is not a twin; a virgin mailbox with
 * no `_meta` at all passes rather than throwing.
 *
 * ── THE PAIR MOVED INTO ONE DOOR, AND THE PIN FOLLOWED IT ────────────────────────────────────
 *
 * Both runners once spelled the pair themselves and the order was pinned twice. They now reach it
 * through `run-cli.ts#takeRunnerLease`, and after that move no test anywhere guarded the order
 * inside the door: a reorder of those two calls was caught by nothing. The order is pinned here,
 * at the door. `run-cli.test.ts` holds the other half — that neither runner names either primitive
 * again — with its own base-copy control, so the two files are one claim and neither repeats it.
 */

const CLI_SOURCES = ["run-junk-sweep.ts", "run-redacted-restore.ts", "run-blank-repair.ts"] as const;
const LEASE_DOOR = "run-cli.ts";

function sourceOf(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
}

/**
 * Comments state invariants in this tree, so a claim in one must not satisfy a code assertion —
 * every assertion below runs against the stripped text, and the docblocks in these CLIs quote the
 * very spellings being refused.
 *
 * ── LINE COMMENTS FIRST, AND THAT ORDER IS THE WHOLE OF IT ──────────────────────────────────
 *
 * Written the other way round first, and it produced a test that passed for the wrong reason and
 * then failed for a bewildering one. `run-redacted-restore.ts` says, in a LINE comment, that it
 * "CREATES the ohmail-slash-star tree" — and a slash followed by a star is an opening block
 * delimiter. A block-comment pass run FIRST reads that as the start of a comment and deletes
 * everything up to the next closing delimiter, which is most of the file, including the code the
 * assertions were looking for. What it reported was "expected -1 to be greater than -1".
 *
 * Stripping line comments first removes the fake delimiter along with the line carrying it.
 *
 * Written out in words rather than in symbols on purpose: the first draft of THIS docblock spelled
 * the delimiters literally, which closed the docblock four lines early and turned its own remaining
 * prose into syntax errors. The hazard being described is available to the description of it.
 *
 * A small state machine rather than a regex for the block pass, because a non-greedy regex has the
 * same failure available to it inside any block whose prose happens to contain a close delimiter.
 */
function codeOf(name: string): string {
  const noLineComments = sourceOf(name)
    .split("\n")
    // `://` is spared so a url in a string literal survives; nothing here relies on it, but a
    // stripper that silently truncates code is the wrong tool to leave lying around.
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  let out = "";
  let inBlock = false;
  for (let i = 0; i < noLineComments.length; i++) {
    if (!inBlock && noLineComments.startsWith("/*", i)) { inBlock = true; i++; continue; }
    if (inBlock && noLineComments.startsWith("*/", i)) { inBlock = false; i++; continue; }
    if (!inBlock) out += noLineComments[i];
  }
  return out;
}

describe("the operator CLIs' organizer-lease wiring", () => {
  it(`${LEASE_DOOR} asks whether a live twin holds the mailbox BEFORE it takes the lease`, () => {
    const code = codeOf(LEASE_DOOR);
    const check = code.indexOf("assertNoLiveTwin(");
    const acquire = code.indexOf("acquireLeasePermit(");
    expect(check).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(-1);
    // ORDER IS THE ASSERTION. `acquireLeasePermit` renews — it appends our claim and expunges the
    // one it decided was ours — so a twin check that ran afterwards would be measuring a folder
    // this process had already overwritten, and would find the twin gone because it had just
    // deleted it.
    expect(check).toBeLessThan(acquire);
  });

  for (const name of CLI_SOURCES) {
    it(`${name} takes the lease through that door`, () => {
      // The positive half. `run-cli.test.ts` refuses the two primitives being named here again;
      // this one is what makes that refusal mean the lease is taken rather than skipped.
      expect(codeOf(name)).toContain("takeRunnerLease(");
    });
  }

  it("run-junk-sweep.ts spends the permit at the sweep's write boundary", () => {
    const code = codeOf("run-junk-sweep.ts");
    // `writeAuthority` is what every one of `junkSweepPass`'s write sites asks through
    // `assertMayWriteToMailbox`. Without the permit in it the permit is acquired and never
    // consulted, so the sweep enforces "one organizer at the instant this command started" —
    // which is the defect the permit exists to close.
    expect(code).toMatch(/writeAuthority\s*:\s*\{\s*lease\s*:\s*permit\b/);
  });

  it("run-junk-sweep.ts acquires the lease ONLY under --execute", () => {
    const code = codeOf("run-junk-sweep.ts");
    // A dry run promises to write nothing anywhere, and `runLeaseGate` APPENDS our claim to
    // `ohmail/_meta`. The pg suite's dry-run case skips acquisition by not passing a permit, so it
    // stays green against a CLI that acquired one unconditionally; this is the assertion that does
    // not.
    const guarded = /if\s*\(\s*execute\s*\)\s*\{[\s\S]*?takeRunnerLease\(/;
    expect(code).toMatch(guarded);
  });

  it("run-redacted-restore.ts takes the lease before `ensureFolders()`, which is a write", () => {
    const code = codeOf("run-redacted-restore.ts");
    const acquire = code.indexOf("takeRunnerLease(");
    const ensure = code.indexOf("adapter.ensureFolders(");
    expect(acquire).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(-1);
    // `ensureFolders()` CREATEs the `ohmail/*` tree in somebody else's mailbox. It is this runner's
    // only server mutation, so ordering is the whole of the requirement here — and the door it is
    // handed is the permit this runner took, so every CREATE asks that same claim.
    expect(acquire).toBeLessThan(ensure);
    expect(code).toContain("adapter.ensureFolders(writeDoorOf({ lease: permit }))");
  });

  it("run-blank-repair.ts reads nothing from the server and takes no lease unless --apply, then takes it before any write", () => {
    const code = codeOf("run-blank-repair.ts");
    const dry = code.indexOf("if (!apply)");
    const acquire = code.indexOf("takeRunnerLease(");
    const ensure = code.indexOf("adapter.ensureFolders(");
    const pass = code.indexOf("blankRepairPass(");
    expect(Math.min(dry, acquire, ensure, pass)).toBeGreaterThan(-1);
    // A dry run promises nothing read from the mail server and nothing written; the lease gate APPENDS.
    expect(dry).toBeLessThan(code.indexOf("adapter.connect("));
    expect(acquire).toBeLessThan(ensure);
    expect(acquire).toBeLessThan(pass);
    // The permit is the authority the pass's one server write, the move back to INBOX, asks.
    expect(code).toMatch(/writeAuthority\s*:\s*\{\s*lease\s*:\s*permit\s*\}/);
    expect(code).toContain("adapter.ensureFolders(writeDoorOf({ lease: permit }))");
  });
});

describe("what the twin check actually changes, driven against the real gate", () => {
  /**
   * A live claim from a process sharing our install id — i.e. the running worker's.
   *
   * Written through the production gate rather than hand-rolled, so the claim's format and its
   * freshness are whatever `runLeaseGate` itself produces. Hand-writing the incumbent is how a test
   * of a decision table comes to disagree with the table.
   */
  async function withLiveIncumbent(): Promise<{ meta: FakeMetaFolder; adapter: MailboxAdapter }> {
    const meta = new FakeMetaFolder();
    const adapter = { leaseIo: () => meta, leasePeekIo: () => meta } as unknown as MailboxAdapter;
    const permit = await acquireLeasePermit({
      adapter,
      self: {
        installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null,
      },
      ...new PermitClock(Date.parse("2026-09-01T10:00:00Z")).pair,
    });
    expect(permit.reads).toBe(1);
    return { meta, adapter };
  }

  it("the GATE ALONE adopts a live worker's claim — the defect, held here so it cannot come back quietly", async () => {
    const { adapter, meta } = await withLiveIncumbent();
    const appendsAfterIncumbent = meta.appends;

    // Same install id, no armed nonce, twin check skipped: `isOurs` short-circuits its clone defence
    // and the gate hands this second process the mailbox — and RENEWS, which appends our claim and
    // expunges the incumbent's. This documents the ENGINE's behaviour, which is correct for its own
    // purpose (a crashed worker must resume its own role with no nonce memory). It is the CALLER
    // that must not rely on it alone.
    const adopted = await acquireLeasePermit({
      adapter,
      self: {
        installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null,
      },
      ...new PermitClock(Date.parse("2026-09-01T10:00:05Z")).pair,
    });
    expect(adopted.reads).toBe(1);
    // The expunge is the sharp end and is asserted rather than described: the worker's claim is gone
    // from a folder it was renewing five seconds ago.
    expect(meta.appends).toBeGreaterThan(appendsAfterIncumbent);
    expect(meta.removals).toBeGreaterThan(0);
  });

  it("the twin check REFUSES against that same live claim, and writes nothing", async () => {
    const { adapter, meta } = await withLiveIncumbent();
    const before = { appends: meta.appends, removals: meta.removals };

    await expect(assertNoLiveTwin({
      adapter,
      installId: "ohmail-cloud:test",
      // Five seconds later: the incumbent was renewed just now in ABSOLUTE terms, which is the
      // question this asks and the one the gate does not.
      now: new Date("2026-09-01T10:00:05Z"),
    })).rejects.toThrow(/no longer holds the mailbox/);

    // A refusal that had appended or expunged anything would have done the damage it exists to
    // prevent on its way to reporting it.
    expect(meta.appends).toBe(before.appends);
    expect(meta.removals).toBe(before.removals);
  });

  it("the twin check does NOT block own-role resumption — a STALE same-id claim passes", async () => {
    const { adapter } = await withLiveIncumbent();

    // Twenty minutes on, past `DEFAULT_STALE_AFTER_MS`. Nobody is renewing, so this is the repair
    // case an operator actually runs these tools in, and the check must be silent here. THIS IS THE
    // ASSERTION THAT KILLED THE FIRST FIX: a sentinel `lastNonce` made the gate refuse this, because
    // engine liveness is folder-relative and a lone claim is never stale by that measure. The tool
    // would have been safe and useless.
    await expect(assertNoLiveTwin({
      adapter, installId: "ohmail-cloud:test", now: new Date("2026-09-01T10:20:00Z"),
    })).resolves.toBeUndefined();

    // And the gate then continues, which is the property the `lastNonce: null` exists for.
    const resumed = await acquireLeasePermit({
      adapter,
      self: {
        installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null,
      },
      ...new PermitClock(Date.parse("2026-09-01T10:20:00Z")).pair,
      takeover: null,
    });
    expect(resumed.reads).toBe(1);
  });

  it("a claim from a DIFFERENT install is not a twin — the gate owns that decision", async () => {
    const { adapter } = await withLiveIncumbent();

    // The desktop case. This check is deliberately narrow: it answers "is another copy of ME live",
    // and a foreign organizer is the decision table's business (arm 5/7). A twin check that also
    // refused foreign claims would be a second, dimmer copy of `decideLease` — two readings of one
    // folder, which is how LOCAL and CLOUD come to disagree about who is organizing a mailbox.
    await expect(assertNoLiveTwin({
      adapter, installId: "ohmail-cloud:some-other-deployment",
      now: new Date("2026-09-01T10:00:05Z"),
    })).resolves.toBeUndefined();
  });

  it("a mailbox with NO `_meta` at all passes — the repair case, and it used to throw", async () => {
    // ── THE READ SIDE, AND WHY IT IS NOT THE WRITE SIDE ────────────────────────────────────
    //
    // This check first used `leaseIo()`. `makeLeaseIo.listClaims()` goes straight to
    // `getMailboxLock(_meta)` with no ensure — the folder is created by `ensureMetaFolder`, which
    // the GATE calls and this does not — so on a mailbox nobody has ever organized it rejected
    // before `acquireLeasePermit` could create anything, and the raw IMAP error matched neither
    // CLI's `LeaseUnavailableError` arm. **A legitimately unclaimed mailbox could not be repaired
    // by either command, which is the situation an operator reaches for them in.** Found by the
    // review round over the commit that introduced the check.
    //
    // `leasePeekIo()` is the read side: it does not create the folder and reports an absent one as
    // zero claims. Zero claims means no twin, which is the true answer.
    const absent = {
      leasePeekIo: () => ({ listClaims: async () => [] }),
      leaseIo: () => { throw new Error("the write side must not be reached by a look"); },
    } as unknown as MailboxAdapter;

    await expect(assertNoLiveTwin({
      adapter: absent, installId: "ohmail-cloud:test", now: new Date("2026-09-01T10:00:00Z"),
    })).resolves.toBeUndefined();
  });

  it("a lease read that FAILS is reported as unavailable, never as a stand-down", async () => {
    // §3.4's rule, at this seam: "somebody else holds this" and "I could not look" must not be
    // reachable from one another. Unwrapped, a dropped connection surfaced as a raw IMAP error
    // through a `catch` that classifies neither, so the CLI printed no known refusal at all.
    const broken = {
      leasePeekIo: () => ({ listClaims: async () => { throw new Error("connection dropped"); } }),
    } as unknown as MailboxAdapter;

    await expect(assertNoLiveTwin({
      adapter: broken, installId: "ohmail-cloud:test", now: new Date("2026-09-01T10:00:00Z"),
    })).rejects.toThrow(/could not be read/);
  });

  it("a FAR-FUTURE claim with no server stamp is no evidence of a twin — the tool is not jammed", async () => {
    const meta = new FakeMetaFolder();
    const adapter = { leaseIo: () => meta, leasePeekIo: () => meta } as unknown as MailboxAdapter;
    await acquireLeasePermit({
      adapter,
      self: {
        installId: "ohmail-cloud:test", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null,
      },
      // The claim is written with a heartbeat four months ahead — one machine with a broken clock.
      ...new PermitClock(Date.parse("2027-01-01T00:00:00Z")).pair,
    });
    // This pinned the jam until LEASE-TWIN-CHECK-OFF-PREDICATE: the twin check had its own
    // absolute test, so the stamp read live for ever. It now asks the peek's `fresh`, where a stamp
    // beyond the skew tolerance is no renewal evidence; with no INTERNALDATE (this fake sets none)
    // the believability cap decides. The server-clock cases are `twin-check-one-predicate.test.ts`.
    await expect(assertNoLiveTwin({
      adapter, installId: "ohmail-cloud:test", now: new Date("2026-09-01T10:00:00Z"),
    })).resolves.toBeUndefined();
  });
});
