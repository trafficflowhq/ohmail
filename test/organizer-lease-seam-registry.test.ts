import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as scan from "../scripts/lib/source-scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ═══ EVERY PLACE A CLAIM CHANGES HANDS, AND THE INVARIANT IT UPHOLDS ══════════════════════════
 *
 * Exactly one active organizer per mailbox is the product's central promise, and it is kept by a
 * handful of acts scattered over four files: a claim is GRANTED, RENEWED, VERIFIED, STAMPED,
 * HANDED BACK or RELEASED. Six sequences have reached a person through one of those acts, each one
 * a different file, each one found by a different reader — which is the shape of a rule nobody can
 * see whole. This is the whole of it in one place: every seam is classified with the invariant it
 * upholds, and a seam that is not classified REFUSES.
 *
 * WHY COUNTS AND NOT `file:line`: a pin keyed on a line shifts under the next edit to the file
 * above it, and this repository has measured that pin drifting silently. A count per (file, verb)
 * moves only when a call site is ADDED or REMOVED, which is exactly the event this wants an author
 * to have to think about — and the classification and its count are ONE edit.
 */

/**
 * THE INVARIANTS, CLOSED. Five keep two installs from writing at once; two keep a mailbox from
 * being organized by nobody, which is the other half of the same promise and the half the lease
 * theme round found still open.
 */
const INVARIANTS = {
  /** The counters a holder compares against are read in the act that admitted its claim. */
  "baseline-in-the-same-act": "both writing",
  /** The writer records what it wrote BEFORE it writes it, so a lost answer costs nothing. */
  "identity-recorded-before-the-write": "both writing",
  /** A start whose refusals are swallowed reports ok; every refusal on a start path is carried out. */
  "no-swallowed-start": "both writing",
  /** A one-shot is spent by the event that read it, never by a later one passing through. */
  "one-shot-by-compare-and-clear": "both writing",
  /** A pass carries its permit to every write boundary rather than one opening read. */
  "permit-threaded": "both writing",
  /** A read that could not cover the folder is "could not look", and never "nobody is there". */
  "bounded-read-fails-closed": "organized by nobody",
  /** A refusal is measured from evidence about the state this install is in NOW. */
  "measured-from-a-current-reading": "organized by nobody",
} as const;

type Invariant = keyof typeof INVARIANTS;

/** One seam: how many times this file performs this act, and which invariant holds there. */
interface Seam {
  readonly calls: number;
  readonly upholds: Invariant;
  readonly why: string;
}

/**
 * THE VERBS. Each one is an act on a claim, spelled as the identifier a call site uses.
 *
 * A verb counts where it is CALLED. Two things are not calls and both are present in these files:
 * a mention in a comment or a string, which the source scan removes before anything is matched;
 * and a DECLARATION — `appendClaim(raw: string): Promise<void>;` on the IO interface, `async
 * stampMeta(): Promise<…>` on the object that implements it. Those are told apart by what follows
 * the matching close paren: a `:` there is a RETURN TYPE, which only a signature has. `io.stampMeta()`
 * and `async stampMeta()` are identical up to that character, so no rule short of this one separates
 * them — and counting a declaration as a seam would have the registry classifying the door instead
 * of the acts that go through it.
 */
const VERBS = [
  "runLeaseGate",
  "decideLease",
  "acquireLeasePermit",
  "readMailboxLease",
  "appendClaim",
  "removeClaims",
  "releaseMailboxClaim",
  "releaseOwnClaim",
  "stampMeta",
  "assertMayWriteToMailbox",
] as const;

type Verb = (typeof VERBS)[number];

/** Which roots are scanned for an UNREGISTERED seam — the four files the lease is spread over. */
const SCANNED = [
  "packages/core/src/adapters/organizer-lease.ts",
  "apps/worker/src/lease.ts",
  "apps/worker/src/index.ts",
  "apps/sidecar/src/engine.ts",
] as const;

const REGISTRY: Record<string, Partial<Record<Verb, Seam>>> = {
  "packages/core/src/adapters/organizer-lease.ts": {
    decideLease: {
      calls: 6,
      upholds: "identity-recorded-before-the-write",
      why: "the election, the verify, the two vanished-claim arms, the handover's final election "
        + "and the baseline's custody proof all ask ours-ness through one resolver, so a claim "
        + "this install wrote and never heard back about is its own at every one of them",
    },
    appendClaim: {
      calls: 2,
      upholds: "identity-recorded-before-the-write",
      why: "the write of a claim, and a confirmed join's second write of it carrying its press, "
        + "each with its minted nonce handed to the caller just before it — nothing may come between",
    },
    removeClaims: {
      calls: 5,
      upholds: "no-swallowed-start",
      why: "every giving-up path releases what it holds: the stand-down, the two vanished-claim "
        + "arms, the confirm's loss, the renew's own residue, the handover's rollback and the "
        + "baseline's lost custody — a claim left behind costs somebody else their mailbox",
    },
    stampMeta: {
      calls: 1,
      upholds: "baseline-in-the-same-act",
      why: "the gate's own counters, read as its last act and proved against the claim it "
        + "admitted, so a takeover landing around them cannot be inside the baseline",
    },
  },
  "apps/worker/src/lease.ts": {
    runLeaseGate: {
      calls: 1,
      upholds: "permit-threaded",
      why: "one composition reaches the engine, so both hosts get the same verdict and the same "
        + "baseline",
    },
    readMailboxLease: {
      calls: 1,
      upholds: "permit-threaded",
      why: "the permit's own re-read, which renews the claim it rides — every write boundary asks "
        + "this receipt rather than the cycle's opening look",
    },
    removeClaims: {
      calls: 1,
      upholds: "identity-recorded-before-the-write",
      why: "the release's own expunge, over exactly the records the locate named as ours by a "
        + "nonce this install can prove — never widened to the install id, which would take a "
        + "live sibling lineage's claim with it",
    },
    stampMeta: {
      calls: 1,
      upholds: "baseline-in-the-same-act",
      why: "the write boundary's probe: it compares the folder against the baseline the gate took "
        + "in the act that admitted this claim, and answers movement, never a verdict",
    },
  },
  "apps/worker/src/index.ts": {
    readMailboxLease: {
      calls: 1,
      upholds: "permit-threaded",
      why: "the hosted gate, whose outcome the permit adopts rather than re-running — two gate "
        + "runs in one millisecond stand this install down against itself",
    },
    acquireLeasePermit: {
      calls: 1,
      upholds: "permit-threaded",
      why: "built once per cycle at the composition root and carried to every destructive write",
    },
    releaseMailboxClaim: {
      calls: 1,
      upholds: "identity-recorded-before-the-write",
      why: "the hosted release, naming both nonces for the reason the worker's own door does",
    },
  },
  "apps/sidecar/src/engine.ts": {
    readMailboxLease: {
      calls: 2,
      upholds: "permit-threaded",
      why: "the local gate, adopted by the permit exactly as the hosted one is; and a server "
        + "change's gate on the CANDIDATE server, read before the change is kept, whose minted "
        + "nonce becomes this runtime's pending one on the same folder and is held apart otherwise",
    },
    acquireLeasePermit: {
      calls: 1,
      upholds: "permit-threaded",
      why: "one receipt per cycle, and the renewals inside it write this runtime's nonce back",
    },
    releaseOwnClaim: {
      calls: 7,
      upholds: "no-swallowed-start",
      why: "the stop, the release route, the detach, the hand-back, the roster removal, a "
        + "refused server change's claim on the candidate server and a quit that cut the pass "
        + "(over a one-shot dial of its own, the cut socket being gone) — every "
        + "giving-up path this install has, and each names BOTH nonces, so a claim a lost answer "
        + "left cannot outlive the install that wrote it. A cycle that merely FAILED is not one "
        + "of them: the poll owns the retry and the claim stays",
    },
    releaseMailboxClaim: {
      calls: 1,
      upholds: "identity-recorded-before-the-write",
      why: "one door under the seven callers above, so the address cannot differ between them",
    },
  },
};

/** Where the parenthesis opened at `open` closes, or `-1` — over stripped source, so it balances. */
function closes(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * AND THE HALF THAT IS OWED SOMEWHERE ELSE. A registry that listed only what this lane closed
 * would read as a complete rule, which is how the second half of the promise stayed open through
 * six sequences. Each entry names an invariant from the closed set above and the lane that owns
 * it, so the gap is a thing somebody holds rather than a silence.
 */
const OWED: readonly { readonly upholds: Invariant; readonly lane: string; readonly what: string }[] = [
  {
    upholds: "bounded-read-fails-closed",
    lane: "the uid-span compaction fix",
    what: "a `_meta` whose uid span outgrows the claim walk refuses every gate and the mailbox "
      + "stalls with no way out. Bounding the walk at this install's own record would close it and "
      + "is unsound — a live foreign claim appended before our last append sits BELOW that uid and "
      + "would go unseen, which is a second organizer. The folder's live set has to be compacted "
      + "into the walk instead, and the gate has to refuse BY NAME while compaction is owed",
  },
];

/** Count CALL expressions of each verb in one file, comments and literals removed. */
function seamsIn(src: string): Partial<Record<Verb, number>> {
  const code = scan.withoutCommentsAndLiterals(src);
  const found: Partial<Record<Verb, number>> = {};
  for (const verb of VERBS) {
    /* The identifier as a whole word, called or declared — both forms, because the member call
       `io.appendClaim(` and the plain `releaseOwnClaim(` are the same ACT and only one of them
       carries a dot. A `function` in front is a declaration and never a call. */
    const re = new RegExp(`(^|[^\\w$])(\\.\\s*)?${verb}\\s*\\(`, "g");
    let n = 0;
    for (const m of code.matchAll(re)) {
      const at = code.indexOf("(", m.index + m[0].length - 1);
      if (/\b(?:function)\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index + m[1].length))) {
        continue;
      }
      const end = closes(code, at);
      /* A RETURN TYPE AFTER THE CLOSE PAREN IS A SIGNATURE. See {@link VERBS}. */
      if (end >= 0 && /^\s*:/.test(code.slice(end + 1, end + 8))) continue;
      n += 1;
    }
    if (n > 0) found[verb] = n;
  }
  return found;
}

describe("the organizer lease's seams are all classified", () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

  it("every seam in every scanned root is registered, and no registered seam has gone", () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const rel of SCANNED) {
      const found = seamsIn(read(rel));
      const registered = REGISTRY[rel] ?? {};
      for (const [verb, calls] of Object.entries(found) as [Verb, number][]) {
        const seam = registered[verb];
        if (seam === undefined) {
          missing.push(`${rel} performs ${verb}() ${calls}x and the registry does not classify it`);
          continue;
        }
        if (seam.calls !== calls) {
          wrong.push(`${rel} ${verb}(): registry says ${seam.calls}, source has ${calls}`);
        }
      }
      for (const verb of Object.keys(registered) as Verb[]) {
        if (found[verb] === undefined) {
          wrong.push(`${rel} ${verb}(): registry says ${registered[verb]!.calls}, source has none`);
        }
      }
    }
    expect(missing, "a claim changes hands somewhere nothing says which invariant holds there")
      .toEqual([]);
    expect(wrong, "a seam was added or removed without its classification moving with it")
      .toEqual([]);
  });

  it("every classification names a closed invariant and says why", () => {
    for (const [rel, seams] of Object.entries(REGISTRY)) {
      for (const [verb, seam] of Object.entries(seams) as [Verb, Seam][]) {
        expect(Object.keys(INVARIANTS), `${rel} ${verb}() names an invariant nothing defines`)
          .toContain(seam.upholds);
        expect(seam.why.length, `${rel} ${verb}() is classified with no reason`).toBeGreaterThan(40);
      }
    }
  });

  /**
   * BOTH HALVES OF THE PROMISE ARE REPRESENTED. Six sequences produced two installs writing at
   * once; the lease theme round then found the other half — a mailbox organized by NOBODY, through
   * a read that could not cover the folder and a refusal measured from evidence about a state the
   * install is no longer in. A registry holding only the first half would pass while the second
   * went unwatched, which is how the second half stayed open.
   */
  it("holds both classes of the invariant, not only the one that was looked for first", () => {
    const classes = new Set(Object.values(INVARIANTS));
    expect([...classes].sort()).toEqual(["both writing", "organized by nobody"]);
    const used = new Set([
      ...Object.values(REGISTRY).flatMap((seams) => Object.values(seams).map((x) => x.upholds)),
      ...OWED.map((o) => o.upholds),
    ]);
    expect([...used].length, "the registry classifies fewer kinds of seam than it has")
      .toBeGreaterThan(2);
    expect(new Set([...used].map((u) => INVARIANTS[u])), "one whole class of the promise is unheld")
      .toEqual(classes);
  });

  it("names an owner for every invariant nothing here upholds yet", () => {
    for (const owed of OWED) {
      expect(Object.keys(INVARIANTS), `${owed.lane} owes an invariant nothing defines`)
        .toContain(owed.upholds);
      expect(owed.lane.length, "an owed invariant with no lane is a silence").toBeGreaterThan(8);
      expect(owed.what.length, "an owed invariant with no sequence is a label").toBeGreaterThan(80);
    }
    const held = new Set(
      Object.values(REGISTRY).flatMap((seams) => Object.values(seams).map((x) => x.upholds)),
    );
    for (const owed of OWED) {
      expect(held.has(owed.upholds), `${owed.upholds} is both owed and held — say which`).toBe(false);
    }
  });

  /**
   * THE REFUSAL, WATCHED. A file that performs one of these acts and is not classified has to be
   * refused BY THE SAME FUNCTION the case above uses — a guard whose refusal has never been seen
   * fire is not evidence, and a scanner that silently found nothing would pass for ever.
   */
  it("refuses a seam it cannot classify, and admits the ordinary case", () => {
    const unregistered = seamsIn(`
      export async function somethingNew(io: LeaseIo): Promise<void> {
        await io.appendClaim("a claim nobody classified");
      }
    `);
    expect(unregistered.appendClaim, "the scanner cannot see a call it exists to find").toBe(1);

    const commentedOnly = seamsIn(`
      // this file only talks about appendClaim( and removeClaims(
      const note = "releaseOwnClaim(";
      export const nothing = 1;
    `);
    expect(commentedOnly, "a mention in a comment or a string was counted as a seam").toEqual({});
  });

  /**
   * ══ EVERY HOST THAT BUILDS A `LeaseSelf` FEEDS IT A CORRECTION COUNT ═══════════════════════
   *
   * The gate can only re-admit a record from before this process's memory if somebody TELLS it the
   * clock was set, and only a process can see that about itself. So the mechanism has two halves in
   * two files, and the half in the core is guarded by its own cases while the half in the hosts —
   * the wiring — is the kind that goes quietly dead: delete the watch's call and every case in
   * `organizer-lease-clock.test.ts` stays green, because they supply the field themselves.
   *
   * Both hosts are held to three things: they ASK the process-wide watch, they COMPARE its answer
   * against what this mailbox has acted on, and they SPEND it. A host that stops doing any of them
   * refuses here by name rather than shipping a clock fix that can never fire.
   */
  it("both hosts ask the clock watch, compare it per mailbox, and spend it", () => {
    const HOSTS = ["apps/sidecar/src/engine.ts", "apps/worker/src/index.ts"] as const;
    const missing: string[] = [];
    for (const rel of HOSTS) {
      const code = scan.withoutCommentsAndLiterals(read(rel));
      if (!code.includes("makeClockCorrectionWatch(")) {
        missing.push(`${rel} never builds the process's clock watch`);
      }
      if (!/clockCorrected/.test(code)) {
        missing.push(`${rel} builds a LeaseSelf that never carries a correction`);
      }
      /* THE COMPARISON, not merely the field: a host that passed `clockCorrected: true` outright
         would re-admit on every cycle, which is the bound gone rather than the fix. */
      if (!/seenClockCorrections/.test(code)) {
        missing.push(`${rel} does not latch the correction count per mailbox`);
      }
    }
    expect(missing, "a clock correction cannot reach the gate from one of the hosts").toEqual([]);
  });

  /**
   * AND THAT REFUSAL, WATCHED — the case above is run against a host with the wiring removed, so
   * its green is a reading rather than a scanner that finds nothing and passes.
   */
  it("refuses a host whose clock wiring has gone", () => {
    const code = scan.withoutCommentsAndLiterals(`
      const self = { installId, lastNonce, pendingNonce };
      export const nothing = 1;
    `);
    const missing: string[] = [];
    if (!code.includes("makeClockCorrectionWatch(")) missing.push("no watch");
    if (!/clockCorrected/.test(code)) missing.push("no field");
    if (!/seenClockCorrections/.test(code)) missing.push("no latch");
    expect(missing, "the scanner cannot see wiring it exists to find")
      .toEqual(["no watch", "no field", "no latch"]);
  });

  it("names the files it scans by a path that exists", () => {
    for (const rel of SCANNED) {
      expect(() => read(rel), `${rel} is registered and not there`).not.toThrow();
      expect(relative(ROOT, join(ROOT, rel))).toBe(rel);
    }
  });
});
