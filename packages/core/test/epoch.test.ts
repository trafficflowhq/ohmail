import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { epochOf, epochOfRef, epochVerdict, sameEpoch, UNKNOWN_EPOCH } from "../src/epoch.js";

/**
 * ═══ THE EPOCH REPRESENTATION, AND THE CENSUS THAT KEEPS IT THE ONLY ONE ════════════════════
 *
 * + which the ledger says are one
 * decision. A remembered UID is a fact only under the UIDVALIDITY that issued it, so a comparison
 * has three answers. Spelling the third as `0` gave it two — and `0` then matched the other `0`,
 * so the one case with nothing to prove was the case nothing was asked of.
 *
 * Two halves, because either alone is worth little:
 *
 *  1. **The door's own cases.** `0`, an absent field, `String(undefined)`, an out-of-range or
 *     oddly-spelled number are ONE state, and that state neither matches nor contradicts.
 *  2. **A parse census over three source roots.** Every `===`/`!==` whose operands mention a
 *     uidvalidity or an epoch is enumerated from the AST and must be in the table below. A new
 *     comparison is RED until an author says which of the four kinds it is. This is what stops
 *     the representation being re-invented one file over — the way it was in six files at once.
 *
 * MUTATIONS WATCHED RED AND RESTORED (2026-09-12, every restore verified by `cmp`):
 *  · `epochVerdict` → `return "usable"` when either side is unknown ⇒ 10 of 45 red here and in
 *    `imap.epoch-guard.test.ts` — the ref-side fail-open, in one line;
 *  · `epochOf` → admit zero (`v >= 0n`, `^[0-9]`) ⇒ 6 of 45 red;
 *  · `sameEpoch` → compare `.value` without the `known` guards ⇒ 1 red here, 2 more in
 *    `imap.folderpage.test.ts` (the cursor half);
 *  · a `v.uidValidity === "0"` added to `sync.ts` ⇒ 1 red, the census, naming file and text;
 *  · the lease's `epochs !== "usable"` → `epochs === "stale"` (2026-09-12) ⇒ 2 red in
 *    `organizer-lease-meta-window.test.ts` (the unnamed-epoch arm, which is what moved out of this
 *    table's `stated-exception` kind and into `door`) and 1 red HERE, on the stale pin — the
 *    census reading its own subject change.
 *
 * WHAT THIS DOES NOT CLAIM. The census sees BINARY COMPARISONS whose text mentions the word. A
 * comparison that reaches an epoch through a variable named something else is out of its domain,
 * and so is one performed in SQL. It proves that every comparison an author can read as an epoch
 * comparison HAS been read as one — not that no other path exists.
 */

describe("epochOf — one state for every way of not naming an epoch", () => {
  it("UNKNOWN: absent, null, zero, and the string a silent server's `String()` leaves behind", () => {
    for (const v of [undefined, null, 0, 0n, "0", "", "undefined", "null", "00", "007"]) {
      expect(epochOf(v as never), `epochOf(${JSON.stringify(String(v))})`).toEqual(UNKNOWN_EPOCH);
    }
  });

  it("UNKNOWN: spellings that a `Number()` test would have admitted", () => {
    // The API's own boundary learnt these one at a time; the door knows them once.
    for (const v of ["1e9", " 7 ", "0x7", "Infinity", "-1", "7.0", "+7"]) {
      expect(epochOf(v), v).toEqual(UNKNOWN_EPOCH);
    }
  });

  it("UNKNOWN: past RFC 3501's 32-bit ceiling, whatever the type", () => {
    expect(epochOf("4294967296")).toEqual(UNKNOWN_EPOCH);
    expect(epochOf(4294967296n)).toEqual(UNKNOWN_EPOCH);
    expect(epochOf("9".repeat(40))).toEqual(UNKNOWN_EPOCH);
  });

  it("POSITIVE CONTROL — a real epoch is known, and the three types agree on its spelling", () => {
    expect(epochOf("7")).toEqual({ known: true, value: "7" });
    expect(epochOf(7)).toEqual({ known: true, value: "7" });
    expect(epochOf(7n)).toEqual({ known: true, value: "7" });
    expect(epochOf("4294967295")).toEqual({ known: true, value: "4294967295" });
  });
});

describe("epochOfRef — the `${uidvalidity}:${uid}` half", () => {
  it("a `0:0` NULL-locator placeholder names no epoch", () => {
    expect(epochOfRef("0:0")).toEqual(UNKNOWN_EPOCH);
    expect(epochOfRef("0:41")).toEqual(UNKNOWN_EPOCH);
  });

  it("a ref minted against a silent server names none either", () => {
    expect(epochOfRef(`${String(undefined)}:41`)).toEqual(UNKNOWN_EPOCH);
  });

  it("a ref that is not `epoch:uid` at all names none — no half-read of a malformed value", () => {
    expect(epochOfRef("7")).toEqual(UNKNOWN_EPOCH);
    expect(epochOfRef("")).toEqual(UNKNOWN_EPOCH);
  });

  it("POSITIVE CONTROL — an ordinary ref names its epoch", () => {
    expect(epochOfRef("7:41")).toEqual({ known: true, value: "7" });
  });
});

describe("the comparison — unknown neither matches nor contradicts", () => {
  const known = (v: string) => epochOf(v);

  it("two unknowns are NOT the same epoch — the conflation, in one line", () => {
    expect(sameEpoch(UNKNOWN_EPOCH, UNKNOWN_EPOCH)).toBe(false);
    expect(sameEpoch(epochOf("0"), epochOf(null))).toBe(false);
  });

  it("an unknown on either side is `unknown`, never `stale`", () => {
    expect(epochVerdict(UNKNOWN_EPOCH, known("7"))).toBe("unknown");
    expect(epochVerdict(known("7"), UNKNOWN_EPOCH)).toBe("unknown");
    expect(epochVerdict(UNKNOWN_EPOCH, UNKNOWN_EPOCH)).toBe("unknown");
  });

  it("…and that distinction is the whole point: `stale` is terminal, `unknown` is retried", () => {
    // `gone.ts` licenses a terminal reading of a contradiction. An unnamed epoch reaching that
    // arm writes off mail that is still on the server, which is the `"undefined"` route.
    expect(epochVerdict(known("7"), known("9"))).toBe("stale");
    expect(epochVerdict(epochOf(`${String(undefined)}`), known("9"))).toBe("unknown");
  });

  it("POSITIVE CONTROL — two named, agreeing epochs are usable and the same", () => {
    expect(epochVerdict(known("7"), known("7"))).toBe("usable");
    expect(sameEpoch(known("7"), known("7"))).toBe(true);
  });
});

/* ── THE CENSUS ─────────────────────────────────────────────────────────────────────────────
 *
 * Scanned by ROOT, so a touched-package selection never decides whether it runs. Three roots:
 * the model and adapter layer, the API's doors, the worker's drain.
 */
const ROOTS = ["packages/core/src", "packages/api/src", "apps/worker/src"];
const REPO = resolve(__dirname, "../../..");

/** The four kinds a comparison mentioning an epoch can be. Only one of them may compare text. */
type Kind =
  | "presence"        // is there a value at all — `!= null`, `typeof`, `!== undefined`
  | "door"            // the door's own verdict, read as a string
  | "not-an-epoch"    // the word matched something else (`epochMs`, a key builder)
  | "stated-exception";

/**
 * Every epoch comparison in the three roots, by exact text. A new one is red until it is placed
 * — which is the only mechanism that has ever caught this defect class, because it was six
 * files wide and every one of them looked locally reasonable.
 */
const CENSUS: ReadonlyArray<readonly [string, string, Kind]> = [
  ["apps/worker/src/dead-letter.ts", "this.items.get(keyOf(folder, uidValidity, uid))?.terminal === true", "not-an-epoch"],
  /* THE KNOWN-SET MEMO'S TWO. The first compares two composite KEYS (folder, epoch and uid joined),
     not two epochs — the same shape as the dead-letter line above. The second asks whether a
     locator carries an epoch at all, on a value read off an `unknown` argument. The memo's one
     real epoch comparison goes through `sameEpoch`, which is why it is not here. */
  ["apps/worker/src/known-set.ts", "`${e.folder}\\u0000${e.uidValidity}:${e.uid}` === key", "not-an-epoch"],
  ["apps/worker/src/known-set.ts", 'typeof o.uidValidity === "string"', "presence"],
  ["packages/api/src/routes/screener.ts", 'typeof body.uidValidity === "string"', "presence"],
  /* THE MAILBOX SELF-CHECK. A recorded epoch the server now contradicts is its own class, through
     the door; an unnamed one compares by count, which is all a cold cursor holds. The presence
     test is on the raw column before it becomes an epoch. */
  ["packages/api/src/mailbox-self-check.ts", 'epochVerdict(epochOf(m.epoch), epochOf(a.uidValidity)) === "stale"', "door"],
  ["packages/api/src/mailbox-self-check.ts", "r.epoch == null", "presence"],
  ["packages/core/src/adapters/drizzle-repo.ts", "r.uidvalidity != null", "presence"],
  ["packages/core/src/adapters/imap.ts", "appended.uidValidity != null", "presence"],
  ["packages/core/src/adapters/imap.ts", "dstUidValidity == null", "presence"],
  ["packages/core/src/adapters/imap.ts", 'epochVerdict(epochOf(prev.uidValidity), epochOf(curUidValidity)) === "stale"', "door"],
  ["packages/core/src/adapters/imap.ts", "mb.uidValidity != null", "presence"],
  ["packages/core/src/adapters/imap.ts", "opts.expectUidValidity !== undefined", "presence"],
  ["packages/core/src/adapters/imap.ts", 'typeof c.uidValidity !== "string"', "presence"],
  /* THE PASSIVE FOLDER SKIP. Its three counters are all satisfiable by a folder that was deleted
     and recreated, so the epoch joins them — and here alone the door's `unknown` arm REFUSES: the
     fallback is one SELECT, while being wrong serves a recreated folder's old contents for ever. */
  ["packages/core/src/adapters/imap.ts", 'epochs !== "usable"', "door"],
  /* THE THREE `ohmail/_meta` CLEANUPS, WHICH ARE ONE RULE AND WERE THREE. Each compares the epoch
     of the read that named its refs against the one the server states now, through the same
     `uidRefsAtEpoch`. The claim half WAS THE ONE STATED EXCEPTION until 2026-09-12: an unnamed
     epoch there used to resolve to "no change detected" — a takeover confirmed over refs the read
     could not speak about — and `stated-exception` is deliberately left with no members.
     Here `unknown` PROCEEDS, the opposite arm to the passive skip's and for the opposite reason:
     refusing would strand every mailbox on a connection that states no UIDVALIDITY, and the
     custody read-back after each expunge is the backstop a proof cannot supply. */
  ["packages/core/src/adapters/organizer-lease.ts", 'uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), epochOf(gen)) === "stale"', "door"],
  ["packages/core/src/adapters/organizer-lease.ts", 'uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), nowEpoch) === "stale"', "door"],
  // The blocked gate's probe: the remembered uid against the generation it was read in.
  ["packages/core/src/adapters/organizer-lease.ts", 'uidRefsAtEpoch([{ epoch: epochOf(held.generation), uid }], epochOf(currentGeneration())) === "stale"', "door"],
  ["packages/core/src/adapters/organizer-profile.ts", 'uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), nowEpoch) === "stale"', "door"],
  /* The one enumeration of `_meta`: a renumbering between the generation read before its FETCH and
     the one after refuses the read, on the same arm as the cleanups. */
  ["packages/core/src/adapters/organizer-lease.ts", 'epochVerdict(epochOf(before), epochOf(generationOf(client))) === "stale"', "door"],
  /* FIX-026: the tidy's one \Seen flag on the current document, and the write's removal of the
     document it replaced, which a read-back listing stands between: the same door, the same arm. */
  ["packages/core/src/adapters/organizer-profile.ts", 'uidRefsAtEpoch([{ epoch: epochOf(generationAtLastRead), uid: ref }], epochOf(generationOf(client))) === "stale"', "door"],
  ["packages/core/src/adapters/organizer-profile.ts", 'uidRefsAtEpoch( [{ epoch: epochOf(C.msg.generation), uid: C.msg.ref }], epochOf(landed.generation), ) === "stale"', "door"],
  /* The permit's folder stamp, which compares two STATUS readings of one folder rather than a
     locator against a live one. Same door and the same arm: only a PROVEN renumbering is
     movement, and an unnamed generation leaves the counters — the terms a takeover moves — to
     answer, rather than reporting movement at every write boundary on a server that does not
     report UIDVALIDITY. */
  ["packages/core/src/adapters/organizer-lease.ts", 'epochVerdict(epochOf(a.uidValidity), epochOf(b.uidValidity)) === "stale"', "door"],
  /* THE COMPACTION'S TWO, and they are two because they are about two MOMENTS. The first is the
     generation `COPYUID` reports for the folder the copies landed in; the second is the folder's
     generation at the instant of the EXPUNGE, a command later. A renumbering between them takes
     the copies with it and leaves the uids in hand naming whatever now sits at them, so both go
     through the door and either one refusing leaves the folder untouched. `unknown` is NOT a
     refusal here, on the rule the two above state: only a PROVEN renumbering is movement, and a
     server that will not report UIDVALIDITY would otherwise make the compaction impossible on the
     only folders that need it. */
  ["packages/core/src/adapters/organizer-lease.ts", 'epochVerdict(epochOf(generation), epochOf(copiedUnder)) === "stale"', "door"],
  ["packages/core/src/adapters/organizer-lease.ts", 'epochVerdict(epochOf(generation), epochOf(atExpunge)) === "stale"', "door"],
  ["packages/core/src/adapters/organizer-lease.ts", 'epochs === "unknown"', "door"],
  ["packages/core/src/adapters/organizer-lease.ts", 'epochs === "stale"', "door"],
  ["packages/core/src/adapters/organizer-lease.ts", 'epochs !== "usable"', "door"],
  ["packages/core/src/ics.ts", "start.epochMs === null", "not-an-epoch"],
  ["packages/core/src/ics.ts", "t.epochMs !== null", "not-an-epoch"],
  ["packages/core/src/ics.ts", "end.epochMs !== null", "not-an-epoch"],
  ["packages/core/src/ics.ts", "start.epochMs !== null", "not-an-epoch"],
  ["packages/core/src/ics.ts", "(end.epochMs !== null) === (start.epochMs !== null)", "not-an-epoch"],
  /* THE THIRD WORD, which the needle above reads too. A folder GENERATION is a UIDVALIDITY under
     the name the `ohmail/_meta` memo uses for it, so the same rule applies and the same door
     answers. The request drain's comparison went with its cursor (FIX-026, one door); the rest are
     presence tests on a raw value before it becomes an epoch. */
  ["apps/worker/src/profile.ts", "generation === null", "presence"],
  ["apps/worker/src/profile.ts", 'typeof generation === "bigint"', "presence"],
  ["packages/core/src/adapters/organizer-lease.ts", "generation !== null", "presence"],
  ["packages/core/src/adapters/organizer-profile.ts", "generation !== null", "presence"],
  ["packages/core/src/adapters/organizer-profile.ts", 'typeof m.generation === "bigint"', "presence"],
  ["packages/core/src/adapters/organizer-profile.ts", 'typeof m.generation === "number"', "presence"],
  /* THE BUDGET STOP'S STORED EPOCH (mail 0115), a PRESENCE test on the raw column before it is
     an epoch at all: the read drops the pair unless BOTH columns are there, because a uid whose
     epoch did not survive the read names a different message. Nothing is COMPARED here — the one
     comparison this fact has is `sync.ts#sameStop`, and that one goes through `epoch.ts`. */
  ["packages/core/src/adapters/drizzle-repo.ts", "r.budgetStopUidvalidity == null", "presence"],
];

function comparisonsUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(resolve(REPO, root));

  const out: string[] = [];
  for (const file of files) {
    const src = ts.createSourceFile(
      file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true,
    );
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        const isCompare = k === ts.SyntaxKind.EqualsEqualsEqualsToken
          || k === ts.SyntaxKind.ExclamationEqualsEqualsToken
          || k === ts.SyntaxKind.EqualsEqualsToken
          || k === ts.SyntaxKind.ExclamationEqualsToken;
        if (isCompare) {
          const text = n.getText().replace(/\s+/g, " ");
          /* `generation` IS this vocabulary's third word, and leaving it out made the census
             blind exactly where the defect lived: the request drain compared two generations with
             a bare `BigInt(a) === BigInt(b)` and no needle here matched a character of it. */
          if (/uidvalid|\bepoch|\bgeneration/i.test(text)) {
            out.push(`${relative(REPO, file).replace(/\\/g, "/")} :: ${text}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

describe("the epoch-comparison census over three source roots", () => {
  const found = ROOTS.flatMap(comparisonsUnder);
  const pinned = new Set(CENSUS.map(([f, t]) => `${f} :: ${t}`));

  it("the census reaches all three roots — a scanner that found nothing proves nothing", () => {
    for (const root of ROOTS) expect(comparisonsUnder(root).length, root).toBeGreaterThan(0);
  });

  it("every epoch comparison in the three roots is dispositioned", () => {
    const unplaced = [...new Set(found)].filter((h) => !pinned.has(h)).sort();
    expect(unplaced, "a new epoch comparison — place it in CENSUS or route it through epoch.ts").toEqual([]);
  });

  it("…and every pinned one still exists — a stale pin is a census of nothing", () => {
    const live = new Set(found);
    expect([...pinned].filter((p) => !live.has(p)).sort()).toEqual([]);
  });

  it("NOT ONE of them compares an epoch's TEXT against a zero or an absence", () => {
    // The shape the lane closed: `x.uidValidity !== "0"`, `=== "0"`, `!== undefined`, `!== null`
    // on a value that IS an epoch. Presence tests are allowed only on the raw field before it
    // becomes one; every kind above that is not `presence` may not hold a zero literal.
    const offenders = CENSUS
      .filter(([, , kind]) => kind !== "presence" && kind !== "not-an-epoch")
      .filter(([, text]) => /["']0["']|(?<![\w.])0(?![\w.])/.test(text))
      .map(([f, t]) => `${f} :: ${t}`);
    expect(offenders).toEqual([]);
  });
});
