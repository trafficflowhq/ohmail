import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskSource } from "./_mask.js";

/**
 * ═══ NO MAILBOX WRITE RUNS ON A CONNECTION ITS PASS DID NOT GATE ═══════════════════════════
 *
 * The organizer lease is read ONCE per pass, on ONE connection, and everything the pass does
 * afterwards rests on that read. If the connection is replaced mid-pass — the socket died and a
 * re-dial opened another — every later write is happening on a connection whose lease this pass
 * never read. On a mailbox that changed hands during the outage that is two installs writing,
 * which is the invariant the whole door rests on.
 *
 * ── WHY A SOURCE CENSUS AND NOT ONLY BEHAVIOURAL TESTS ────────────────────────────────────
 *
 * Because the first round of this fix guarded the CYCLES and missed everything after them, and
 * every behavioural test still passed. The moves and `ensureFolders` were pinned and checked; the
 * scheduled send, the away responder, the request-channel append/acknowledge/expunge and the
 * portable-profile append/expunge were not — they went on reading the mutable binding after the
 * drain, so a stale pass wrote to the replacement through four separate surfaces. A review found
 * it by reading; no test could, because the double exposed none of those methods.
 *
 * A behavioural test proves the surfaces it reaches. This proves the ones nobody remembered,
 * which is the class the defect actually came from — and it fails the moment somebody adds a
 * fifth surface and forgets, which is the same mistake one more time.
 *
 * ── WHAT IT ASSERTS, MECHANICALLY ─────────────────────────────────────────────────────────
 *
 * Inside the region that runs UNDER A GATE (`drain` and the post-drain block of `drainPass`),
 * every call that can write to the mailbox must:
 *
 *   · take the PINNED connection `conn`, never the mutable `adapter` binding; and
 *   · be preceded by `assertSameConnection(gen, conn)` within a few lines.
 *
 * The pin decides where a write lands. The assertion decides whether it happens at all. Both are
 * needed and the reason is in `reconnect-after-close.test.ts`: with the assertion gone the pin
 * still kept the writes off the new connection, and with both gone two of a stranger's messages
 * were filed.
 */

const SRC = new URL("../src/engine.ts", import.meta.url);

/** Every call that can WRITE to the user's mailbox, by the name it is made under. */
const WRITE_SURFACES = [
  "ensureFolders(",            // creates somebody's ohmail/* tree
  "applyMetaRequests(",        // appends + expunges decisions in ohmail/_meta
  "driveOutstandingRequests(", // the reader's half of the same channel
  "profileSync.onOrganize(",   // appends + expunges the portable profile
  "sendScheduled(",            // delivers mail on the mailbox's behalf
  "answerAway(",               // ditto
] as const;

function source(): string {
  return readFileSync(SRC, "utf8");
}

/**
 * The stretch that runs under a lease answer: from `drain`'s signature to the end of the
 * post-drain block. Bounded by markers rather than by line numbers, so the census follows the
 * code when it moves instead of silently reading the wrong region.
 */
function gatedRegion(src: string): string {
  /* TWO SPANS, NOT ONE, and the reason is a measurement rather than a preference.
   *
   * The gated code is in two places: the drain (and the post-drain block that follows it), and
   * `dialAndGate` — the launch and re-dial sequence, which reads the lease on the way in and is
   * where the first dial happens. A single span between them looked right and was not: the end
   * marker matched an earlier `throw err;` and the region stopped at line ~4545, leaving
   * `dialAndGate` entirely outside the scan. It held an unpinned `ensureFolders` and a late-bound
   * `close` — the two shapes this census forbids — in the one function it could not see, and the
   * census reported green throughout.
   *
   * Each span is now bounded by markers of its OWN, and every marker is asserted, so a boundary
   * that slips announces itself instead of quietly shrinking the region. `slice` on a missing
   * marker returns something plausible; that is exactly how the first version failed. */
  /* The signature wraps since the drain took the gate's ROLE as a fourth value (and #359's loop-delay reader as a fifth), so the marker is
     the wrapped form verbatim — an exact string still, which is what makes a moved boundary loud. */
  const drainFrom = src.indexOf(
    "const drain = async (\n"
    + "        maxCycles: number, gen: number, conn: MailboxAdapter, organizing: boolean, turns: LoopDelayReader | null,\n"
    + "      ): Promise<number> => {");
  expect(drainFrom, "the drain's opening marker moved — this census is reading nothing")
    .toBeGreaterThan(-1);
  /* The CALL, not the line: the guard in front of it is the half that changes when somebody
     narrows who may publish, and a marker that includes it makes this census read nothing the day
     that happens (measured: it did, when the publish gained the permit's verdict). */
  const drainTo = src.indexOf("await profileSync.onOrganize(conn);", drainFrom);
  expect(drainTo, "the post-drain profile publish moved — this census is reading nothing")
    .toBeGreaterThan(drainFrom);

  const dialFrom = src.indexOf("const dialAndGate = async (): Promise<{ leaseRead: boolean; drainError?: unknown }> => {");
  expect(dialFrom, "`dialAndGate`'s opening marker moved — this census is reading nothing")
    .toBeGreaterThan(-1);
  const dialTo = src.indexOf("\n      };", src.indexOf("throw err;", dialFrom));
  expect(dialTo, "`dialAndGate`'s closing marker moved — this census is reading nothing")
    .toBeGreaterThan(dialFrom);

  return `${src.slice(drainFrom, drainTo + 80)}\n${src.slice(dialFrom, dialTo)}`;
}

describe("no mailbox write escapes the connection it was gated on", () => {
  it("every write surface takes the PINNED connection, never the mutable binding", () => {
    const region = gatedRegion(source());
    /* `adapter,` or `adapter)` as an ARGUMENT is the shape that caused this: a helper handed the
       live binding writes wherever the binding points by the time it runs. `adapter:` as a
       property is the same thing wearing an object literal. */
    const leaked = [...region.matchAll(/\badapter\s*[,)]|\badapter:\s*adapter\b/g)].map((m) => m[0]);
    expect(
      leaked,
      "a gated pass hands the MUTABLE adapter to something that writes — after a re-dial that "
      + "write lands on a connection this pass never read the lease on",
    ).toEqual([]);
  });

  it("every write surface is preceded by the connection assertion", () => {
    const region = gatedRegion(source());
    const lines = region.split("\n");
    const missing: string[] = [];
    for (const surface of WRITE_SURFACES) {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes(surface)) continue;
        // Its own definition is not a call site.
        if (/^\s*(const|function)\s/.test(lines[i]!)) continue;
        const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        if (!window.includes("assertSameConnection(gen, conn)")) {
          missing.push(`${surface} at region line ${i + 1}`);
        }
      }
    }
    expect(
      missing,
      "a mailbox write runs without re-checking that the connection is still the one this pass "
      + "gated. Add `assertSameConnection(gen, conn);` immediately above it — or, if the call "
      + "genuinely cannot write to the mailbox, take it off WRITE_SURFACES with the reason.",
    ).toEqual([]);
  });

  it("no write surface is called ON the mutable binding", () => {
    /* ── THE HOLE THE OTHER FOUR CASES LEFT ────────────────────────────────────────────────
     *
     * They watch the ARGUMENT position — `adapter` handed to something that writes. A write can
     * also be made ON the binding, in the RECEIVER position: `adapter.ensureFolders()` rather
     * than `conn.ensureFolders()`. Replaying the other four assertions against exactly that
     * mutation left every one of them green, which was measured rather than supposed. Two of
     * `dialAndGate`'s calls were in precisely that shape.
     *
     * `close(` is included deliberately: it is not a mailbox write, but closing the LIVE binding
     * after a re-dial retires the healthy replacement, which is the same class of harm and the
     * fault `noteConnectionDead` was fixed for. */
    /* COMMENTS MASKED FIRST. The prose in this file and in `engine.ts` discusses
       `adapter.close()` by name, and a raw scan reads those sentences as calls — the census
       failed on its own documentation before this. `maskSource` is the package's existing
       masker (`log-census.test.ts`), reused rather than re-implemented: a second stripper is a
       second thing that can disagree about what code is. */
    const region = maskSource(gatedRegion(source())).code;
    const receivers = [...region.matchAll(
      /\badapter\.(ensureFolders|move|setFlags|send|close|profileIo|leaseIo|requestOrganizerIo|requestReaderIo)\s*\(/g,
    )].map((m) => m[0]);
    expect(
      receivers,
      "a call is made ON the mutable adapter inside the gated region — after a re-dial it acts on "
      + "a connection this pass never gated. Use `conn`, the instance the pass read its lease on.",
    ).toEqual([]);
  });

  it("the assertion checks the INSTANCE and not only the generation", () => {
    /* A number alone answers "has a re-dial happened", which is not the same question as "is the
       object I am about to write through the one whose lease I read". A helper holding a captured
       adapter can outlive the binding; only the instance comparison sees that. */
    const src = source();
    expect(
      /const assertSameConnection = \(gen: number, conn: MailboxAdapter\): void => \{[\s\S]{0,600}?conn !== adapter/
        .test(src),
      "assertSameConnection stopped comparing the adapter instance",
    ).toBe(true);
  });

  it("the census is reading a region that actually contains the surfaces", () => {
    // A scanner that finds nothing is green, and green for the worst possible reason. Pin the
    // shape it must have found before any absence above is believed.
    const region = gatedRegion(source());
    for (const surface of WRITE_SURFACES) {
      expect(region, `the gated region no longer contains ${surface}`).toContain(surface);
    }
    expect(region.split("\n").length).toBeGreaterThan(200);
  });
});
