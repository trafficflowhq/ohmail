import { describe, expect, it } from "vitest";

import {
  DEFAULT_STALE_AFTER_MS,
  decideLease,
  formatClaim,
  parseClaim,
  resumesOwnClaim,
  runLeaseGate,
  type ClaimRecord,
  type LeaseIo,
  type LeaseSelf,
  type LeaseVerdict,
  type RawClaimMessage,
} from "../../src/adapters/organizer-lease.js";

/**
 * TWO ORGANIZERS MUST NEVER BOTH BE TOLD `organize`. Reproduced, then closed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS SHAPED AS "BOTH SIDES' VIEW OF ONE FOLDER"
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every case below builds ONE folder and then asks the decision function twice — once as each
 * install, with each install's own clock. That framing is the whole point, because the bug family
 * this file exists for is not "the table returns the wrong verdict". Each verdict was defensible on
 * its own. The defect was that **two readers of the same folder disagreed about who won**, and a
 * test that only ever asks one side cannot see that.
 *
 * Three split-brains were found this way and all three were confirmed by execution against the
 * compiled function before anything was changed:
 *
 *  · a laptop that SLEPT past the window and woke beside an active install — no clock skew needed,
 *    and by far the most reachable;
 *  · five minutes of CLOCK SKEW, where the fast-clocked side is even offered a takeover;
 *  · two CLOUD organizers, where the kind was computed and then never consulted.
 *
 * The fix was to make the arbitration a pure function of the folder's contents. A reader's clock
 * can no longer decide who organizes a mailbox, so two readers cannot disagree — the agreement is
 * structural rather than probable. `both()` below is what holds that down.
 */

const STALE = DEFAULT_STALE_AFTER_MS;
const at = (iso: string): Date => new Date(iso);

function claim(o: {
  installId: string;
  kind: "local" | "cloud";
  heartbeat: string;
  claimedAt?: string;
  nonce?: string;
  displayName?: string;
  protocol?: number;
  /** 0.14.1 — the instant of the press this tenure rests on. Absent is the steady state. */
  authorizedAt?: string;
  capabilities?: readonly string[];
}): ClaimRecord {
  const parsed = parseClaim(formatClaim({
    installId: o.installId,
    kind: o.kind,
    displayName: o.displayName ?? o.installId,
    heartbeat: at(o.heartbeat),
    claimedAt: at(o.claimedAt ?? o.heartbeat),
    nonce: o.nonce ?? `n-${o.installId}`,
    ...(o.protocol !== undefined ? { protocol: o.protocol } : {}),
    /* ROUND-TRIPPED THROUGH THE FORMAT, deliberately — this helper writes a real claim message and
       parses it back, so every row in this file is a fact about what is actually in the folder
       rather than about an object a test constructed. That is what makes the cross-version rows
       below meaningful: a claim with no `X-Ohmail-Authorized-At` header IS what an older install
       writes. */
    authorizedAt: o.authorizedAt ? at(o.authorizedAt) : null,
    capabilities: o.capabilities ?? [],
  }));
  if (!parsed) throw new Error("fixture is not a claim");
  return parsed;
}

const self = (installId: string, kind: "local" | "cloud", lastNonce: string | null = `n-${installId}`): LeaseSelf =>
  ({ installId, kind, displayName: installId, lastNonce });

/**
 * 0.14.1 — the press is an INSTANT. `"authorized"` means "pressed at this reader's own now", which
 * is what every row written before this release meant by it; an ISO string says exactly when, for
 * the rows that rank one press against another.
 */
const decide = (
  who: LeaseSelf, claims: readonly ClaimRecord[], now: string,
  takeover: "authorized" | "none" | string = "none",
): LeaseVerdict => decideLease({
  self: who, claims, now: at(now), staleAfterMs: STALE,
  /* Every row in this file is a DESKTOP press: `takeover`, which is what the whole file measured
     before the verb existed. The join arm is exercised where it belongs, in the decision table. */
  takeover: takeover === "none" ? null
    : { authorizedAt: takeover === "authorized" ? at(now) : at(takeover), intent: "takeover" },
});

/**
 * Ask both installs, from their OWN clocks, and return the pair.
 *
 * The assertion every caller then makes is that `organize` appears at most once. Not "exactly
 * once": a folder can legitimately leave both sides standing down for a cycle, and stopping is
 * always the safe direction. Two organizers never is.
 */
function both(
  a: { who: LeaseSelf; now: string; takeover?: "authorized" | "none" | string },
  b: { who: LeaseSelf; now: string; takeover?: "authorized" | "none" | string },
  folder: readonly ClaimRecord[],
): { a: LeaseVerdict; b: LeaseVerdict; organizers: number } {
  const va = decide(a.who, folder, a.now, a.takeover ?? "none");
  const vb = decide(b.who, folder, b.now, b.takeover ?? "none");
  return {
    a: va, b: vb,
    organizers: [va, vb].filter((v) => v.verdict === "organize").length,
  };
}

describe("the arbitration is a function of the FOLDER, not of anybody's clock", () => {
  it("A LAPTOP THAT SLEPT does not resume beside an active install — no clock skew required", () => {
    // The most reachable of the three, and it needs nothing exotic: one clock, one sleeping
    // machine. A's heartbeat is two hours old and its `claimedAt` is older than B's, so under the
    // previous table A won the incumbency election while B — which correctly saw A as stale —
    // continued on its own claim. Both organized, for ever.
    const folder = [
      claim({ installId: "A", kind: "local", heartbeat: "2026-08-05T10:00:00.000Z", claimedAt: "2026-08-05T09:00:00.000Z" }),
      claim({ installId: "B", kind: "local", heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-05T11:30:00.000Z" }),
    ];
    const NOW = "2026-08-05T12:01:00.000Z";
    const r = both({ who: self("A"), now: NOW }, { who: self("B"), now: NOW }, folder);
    expect(r.organizers, "two organizers were told to organize one mailbox").toBe(1);
    // And it is the ACTIVE one that continues. A's claim has lapsed relative to the newest
    // heartbeat in the folder, so it is not a candidate — incumbency cannot resurrect it.
    expect(r.b.verdict).toBe("organize");
    expect(r.a.verdict).toBe("stand_down");
  });

  it("FIVE MINUTES OF CLOCK SKEW cannot produce two organizers", () => {
    // B's clock runs five minutes ahead. It therefore wrote a claim dated in A's future, and under
    // the previous table A read that claim as fresh (deliberately — a skewed peer is alive) but
    // still beat it on incumbency, while B read A as stale and continued. No convergence: A stayed
    // stale to B for ever.
    const folder = [
      claim({ installId: "A", kind: "local", heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-05T10:00:00.000Z" }),
      claim({ installId: "B", kind: "local", heartbeat: "2026-08-05T12:11:00.000Z", claimedAt: "2026-08-05T12:11:00.000Z" }),
    ];
    const r = both(
      { who: self("A"), now: "2026-08-05T12:00:05.000Z" },
      { who: self("B"), now: "2026-08-05T12:11:05.000Z" },
      folder,
    );
    expect(r.organizers, "clock skew produced a permanent split brain").toBe(1);
  });

  it("SKEW IN THE OTHER DIRECTION, and at the exact window boundary, is the same answer", () => {
    // The boundary was named as a place a `<`/`<=` change might appear to help. It does not, and
    // this is why: the comparison is now between two claims in one folder, so shifting the operator
    // moves the same line for both readers at once. Both orderings of the pair are checked.
    for (const skewMs of [STALE, STALE + 1, STALE * 2]) {
      const base = at("2026-08-05T12:00:00.000Z").getTime();
      const folder = [
        claim({ installId: "A", kind: "local", heartbeat: new Date(base).toISOString(), claimedAt: "2026-08-05T09:00:00.000Z" }),
        claim({ installId: "B", kind: "local", heartbeat: new Date(base + skewMs).toISOString(), claimedAt: "2026-08-05T11:00:00.000Z" }),
      ];
      const r = both(
        { who: self("A"), now: new Date(base + 1000).toISOString() },
        { who: self("B"), now: new Date(base + skewMs + 1000).toISOString() },
        folder,
      );
      expect(r.organizers, `skew ${skewMs}ms produced ${r.organizers} organizers`).toBe(1);
    }
  });

  it("TWO CLOUD ORGANIZERS arbitrate, and the incumbent keeps the mailbox", () => {
    // `freshCloud` was computed and then consulted only when `self.kind === "local"`, so two cloud
    // workers each fell through to "I hold a fresh claim, therefore organize" indefinitely. A
    // leader lock masks this in one deployment; it means the lease gave no protection at all in
    // this direction, and the leader lock is not the lease. Two deployments sharing one mailbox is
    // an anticipated case — the install id is scoped by environment precisely so staging pointed at
    // a production mailbox is a different organizer.
    const folder = [
      claim({ installId: "cloud-a", kind: "cloud", heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-01T00:00:00.000Z" }),
      claim({ installId: "cloud-b", kind: "cloud", heartbeat: "2026-08-05T12:00:30.000Z", claimedAt: "2026-08-05T12:00:30.000Z" }),
    ];
    const NOW = "2026-08-05T12:01:00.000Z";
    const r = both({ who: self("cloud-a", "cloud"), now: NOW }, { who: self("cloud-b", "cloud"), now: NOW }, folder);
    expect(r.organizers, "two cloud workers were both told to organize").toBe(1);
    expect(r.a.verdict, "the newcomer preempted the incumbent").toBe("organize");
  });

  it("TWO RESTORED CLONES sharing an install id AND a claimedAt still elect one winner", () => {
    // `compareIncumbency` returned 0 for this pair and `Array.sort` is not required to be stable
    // across differing input orders, so each clone selected whichever record arrived first and
    // recognised it as its own. IMAP promises no order, so both orderings are checked here — which
    // is exactly how the defect was demonstrated.
    const c1 = claim({ installId: "shared", kind: "local", heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-01T00:00:00.000Z", nonce: "n-a" });
    const c2 = claim({ installId: "shared", kind: "local", heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-01T00:00:00.000Z", nonce: "n-b" });
    const NOW = "2026-08-05T12:00:10.000Z";
    const va = decide(self("shared", "local", "n-a"), [c1, c2], NOW);
    const vb = decide(self("shared", "local", "n-b"), [c2, c1], NOW);
    expect(
      [va, vb].filter((v) => v.verdict === "organize").length,
      "two clones of one install both organized",
    ).toBe(1);
  });

  it("A DEAD MACHINE'S CLAIM DATED 2099 does not hold the mailbox against a human", () => {
    // An unbounded future heartbeat was permanently "fresh", so a cloud claim from a machine that
    // stopped for ever refused every authorized local takeover — for seventy-three years, with no
    // cure short of somebody finding and deleting the bookkeeping message by hand.
    const folder = [claim({ installId: "cloud-dead", kind: "cloud", heartbeat: "2099-01-01T00:00:00.000Z" })];
    const NOW = "2026-08-05T12:00:00.000Z";
    // Unauthorized it is still refused — becoming an organizer always needs an explicit action.
    expect(decide(self("B", "local", null), folder, NOW).verdict).not.toBe("organize");
    // Authorized, it is recoverable without an operator.
    expect(decide(self("B", "local", null), folder, NOW, "authorized").verdict).toBe("organize");
  });

  it("A DUPLICATED DISCRIMINATOR HEADER cannot make an incumbent invisible", () => {
    // Header parsing was last-value-wins, so `X-Ohmail-Lease: 1` … `X-Ohmail-Lease: 0` parsed as
    // NOT A CLAIM — `null`, which the gate drops entirely. The incumbent then vanished from every
    // reader's view and the next install to look saw an empty folder and started organizing.
    const raw = [
      "X-Ohmail-Lease: 1", "X-Ohmail-Organizer-Kind: local", "X-Ohmail-Install-Id: A",
      "X-Ohmail-Protocol: 1", "X-Ohmail-Heartbeat: 2026-08-05T12:00:00.000Z",
      "X-Ohmail-Claimed-At: 2026-08-05T10:00:00.000Z", "X-Ohmail-Display-Name: Mac A",
      "X-Ohmail-Nonce: n-a", "X-Ohmail-Lease: 0", "", "",
    ].join("\r\n");
    const parsed = parseClaim(raw);
    expect(parsed, "a record carrying `X-Ohmail-Lease: 1` became invisible").not.toBeNull();
    // Malformed and not a readable claim: it is evidence somebody claimed, and evidence produces
    // `available` at worst. A newcomer must not read it as an empty mailbox.
    expect(parsed && "malformed" in parsed).toBe(true);
    expect(decide(self("B", "local", null), [parsed!], "2026-08-05T12:00:01.000Z").verdict)
      .not.toBe("organize");
  });

  it("A LIVE CLAIM IN A NEWER PROTOCOL is refused, authorization or not", () => {
    // A future format that older installs skipped would silently re-enable dual organizing against
    // every one of them, so this arm has no escape: we cannot rank what we cannot read.
    const folder = [claim({ installId: "future", kind: "local", heartbeat: "2026-08-05T12:00:00.000Z", protocol: 99 })];
    const NOW = "2026-08-05T12:00:30.000Z";
    expect(decide(self("B", "local", null), folder, NOW).verdict).toBe("stand_down");
    expect(
      decide(self("B", "local", null), folder, NOW, "authorized").verdict,
      "an authorization overrode a protocol we cannot read",
    ).toBe("stand_down");
  });
});

describe("an authorized takeover converges, because it changes the FOLDER", () => {
  it("displaces the claim it beat, and the loser then stands down", () => {
    // ── THE HALF THAT MAKES THE ARBITRATION SAFE TO HAVE ────────────────────────────────────
    //
    // With a folder-based election and nothing else, an authorized takeover UNDOES ITSELF: the
    // winner appends, and on the next cycle both sides elect the old incumbent again on
    // incumbency. So the win has to be recorded where both sides can see it, and the only medium
    // they share is the folder.
    const incumbent = claim({
      installId: "laptop", kind: "local", heartbeat: "2026-08-05T11:40:00.000Z",
      claimedAt: "2026-08-01T00:00:00.000Z",
    });
    // A ref is what the IO layer expunges by. Fixtures elsewhere omit it; here it is the subject.
    const withRef: ClaimRecord = { ...(incumbent as Exclude<ClaimRecord, { malformed: true }>), ref: 41 };
    const NOW = "2026-08-05T12:00:00.000Z";

    const v = decide(self("cloud-x", "cloud", null), [withRef], NOW, "authorized");
    expect(v.verdict).toBe("organize");
    expect(
      v.verdict === "organize" ? v.displace : null,
      "the takeover left the beaten claim in the folder, so it will reverse itself next cycle",
    ).toEqual([41]);
  });

  it("does NOT displace anything on an ordinary renew or an own-role resumption", () => {
    // The expunge is a real side effect on somebody else's bookkeeping, and it is narrow on
    // purpose: only a human's explicit request may remove another install's claim.
    const ours: ClaimRecord = {
      ...(claim({ installId: "us", kind: "cloud", heartbeat: "2026-08-05T12:00:00.000Z" }) as Exclude<ClaimRecord, { malformed: true }>),
      ref: 7,
    };
    const renew = decide(self("us", "cloud"), [ours], "2026-08-05T12:00:30.000Z");
    expect(renew.verdict).toBe("organize");
    expect(renew.verdict === "organize" ? renew.displace : null).toEqual([]);

    // Own-role resumption after a crash: our claim is old, nobody else's is present.
    const stale: ClaimRecord = {
      ...(claim({ installId: "us", kind: "cloud", heartbeat: "2026-08-04T00:00:00.000Z" }) as Exclude<ClaimRecord, { malformed: true }>),
      ref: 8,
    };
    const resume = decide(self("us", "cloud", null), [stale], "2026-08-05T12:00:00.000Z");
    expect(resume.verdict).toBe("organize");
    expect(resume.verdict === "organize" ? resume.displace : null).toEqual([]);
  });

  /**
   * ══ THE RULE THIS FILE USED TO PIN, INVERTED BY THE 0.14.1 RULING ══════════════════════════
   *
   * It read *"A LOCAL INSTALL MAY NOT TAKE A LIVE CLOUD, even with an authorization in hand"*, and
   * its comment argued: *"the asymmetry is deliberate and is not a missing feature: the honest
   * action on a mailbox a live Cloud is organizing is to give it up in Cloud."*
   *
   * The remedy that comment names requires the side the person has just lost access to. A VPS
   * nobody can reach any more, a hosted organizer on an address its owner cannot sign into — under
   * the old rule those people had no path to their own mailbox at all, and the machine in front of
   * them could only watch. That is a lockout, and it is the reason 0.14.1 exists.
   *
   * The replacement is not "local wins": kind stops ranking in either direction, and what wins is
   * the press. A local install with no press still loses to a live cloud claim — the row below —
   * so nothing self-promotes. The disclosure boundary the old comment was protecting is unchanged
   * too: taking a mailbox still requires a human, on a door they are signed into, and the losing
   * side becomes a reader that keeps its mail rather than losing anything.
   */
  it("A LOCAL INSTALL TAKES A LIVE CLOUD when a human pressed for it", () => {
    const liveCloud = [claim({ installId: "cloud-a", kind: "cloud", heartbeat: "2026-08-05T12:00:00.000Z" })];
    const v = decide(self("laptop", "local", null), liveCloud, "2026-08-05T12:00:30.000Z", "authorized");
    expect(v.verdict).toBe("organize");
    /* IT IS RULE 6 AND NOT CONTINUATION, which is the assertion that matters: `authorized` is what
       makes the gate stamp the renewed claim with this press, and without the stamp the cloud
       side's own next election would hand the mailbox straight back on incumbency. (The claims in
       this file are round-tripped through the format and carry no IO `ref`, so `displace` is
       necessarily empty here — the displacement itself is pinned in `organizer-lease.test.ts`,
       where the fixtures come off a fake IO that mints refs.) */
    expect(v.verdict === "organize" ? v.authorized : false).toBe(true);
  });

  it("…and WITHOUT a press it does not: liveness still beats an arrival", () => {
    // The half that keeps "nobody self-promotes" true. Kind no longer ranks, so this is decided by
    // incumbency alone — the cloud claim is in the folder and ours is not — and it is what makes
    // the row above a statement about the PRESS rather than about the platform.
    const liveCloud = [claim({ installId: "cloud-a", kind: "cloud", heartbeat: "2026-08-05T12:00:00.000Z" })];
    const v = decide(self("laptop", "local", null), liveCloud, "2026-08-05T12:00:30.000Z");
    expect(v.verdict).toBe("stand_down");
    expect(v.verdict === "stand_down" ? v.reason : null).toBe("organized_elsewhere:cloud");
  });

  /**
   * TWO PRESSES WITHIN ONE HEARTBEAT, read from the folder by both sides.
   *
   * The ruling's own convergence case: both doors appended, both re-run the election, and the
   * LATER press wins on every reader because `authorizedAt` is in the messages rather than in
   * either machine's opinion. `both()` is what makes this a statement about agreement rather than
   * about one side's answer.
   */
  it("TWO PRESSES converge on the later one, from both sides, in one cycle", () => {
    const earlier = "2026-08-05T12:00:00.000Z";
    const later = "2026-08-05T12:00:08.000Z";
    const folder = [
      claim({ installId: "laptop", kind: "local", heartbeat: later, claimedAt: later, authorizedAt: earlier }),
      claim({ installId: "cloud-a", kind: "cloud", heartbeat: later, claimedAt: earlier, authorizedAt: later }),
    ];
    const r = both(
      { who: self("laptop", "local"), now: "2026-08-05T12:00:20.000Z" },
      { who: self("cloud-a", "cloud"), now: "2026-08-05T12:00:20.000Z" },
      folder,
    );
    expect(r.organizers).toBe(1);
    expect(r.b.verdict).toBe("organize");
    expect(r.a.verdict).toBe("stand_down");
  });

  /**
   * A CLONE WITH A STALE STAMP LOSES; A CLONE WITH A FRESH PRESS WINS. The ruling states both, and
   * they are the same row read twice: what separates a restored backup that should quietly stand
   * down from a machine somebody deliberately sat down at is whether a human pressed on it.
   */
  it("a stale press loses to a live claim carrying a newer one", () => {
    const folder = [
      claim({
        installId: "cloud-a", kind: "cloud",
        heartbeat: "2026-08-05T12:00:00.000Z", claimedAt: "2026-08-05T11:00:00.000Z",
        authorizedAt: "2026-08-05T11:00:00.000Z",
      }),
    ];
    // Our press is an HOUR older than theirs — a stamp left on a row nobody spent.
    const stale = decide(self("laptop", "local", null), folder, "2026-08-05T12:00:30.000Z",
      "2026-08-05T10:00:00.000Z");
    expect(stale.verdict).toBe("stand_down");
    // The same folder, with a press made a minute ago.
    const fresh = decide(self("laptop", "local", null), folder, "2026-08-05T12:00:30.000Z",
      "2026-08-05T12:00:25.000Z");
    expect(fresh.verdict).toBe("organize");
  });

  /**
   * EQUAL PRESSES ARE NOT A WIN — the strict `>` in rule 6.
   *
   * Two doors pressed in the same millisecond is not a hypothetical when a person double-taps or
   * two scripts fire together, and `>=` here would let BOTH installs displace each other's claim
   * in the same cycle, leaving the folder with no claim at all and the mailbox unleased. Strict,
   * so the tie falls through to `compareStrength`'s total order, which every reader computes the
   * same way.
   */
  it("an EQUAL press does not displace — the tie breaks in the election, not in rule 6", () => {
    const t = "2026-08-05T12:00:00.000Z";
    const folder = [claim({
      installId: "cloud-a", kind: "cloud", heartbeat: t, claimedAt: t, authorizedAt: t,
    })];
    const v = decide(self("laptop", "local", null), folder, "2026-08-05T12:00:30.000Z", t);
    expect(v.verdict).toBe("stand_down");
  });

  it("…but a CLOUD THAT LAPSED is recoverable from the machine, with one authorization", () => {
    // §4's stated transition, and the one the previous table blocked once the kind-rank check was
    // added: a lapsed Cloud must not keep outranking a local install for ever. `available` first —
    // nothing auto-resumes — then `organize` once a human asks.
    const lapsed = [claim({ installId: "cloud-a", kind: "cloud", heartbeat: "2026-08-05T10:00:00.000Z" })];
    const NOW = "2026-08-05T12:00:00.000Z";
    expect(decide(self("laptop", "local", null), lapsed, NOW).verdict).toBe("available");
    expect(decide(self("laptop", "local", null), lapsed, NOW, "authorized").verdict).toBe("organize");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRESS AS THE FIRST TERM OF THE ORDER — the rows the 0.14.1 election turns on
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `both()` is used wherever two installs read one folder, because the property is AGREEMENT and
 * that is not visible from either side's answer alone. The rows that ask one question of one
 * install use `decide` directly and say so.
 */
describe("the election ranks the press, and both sides compute it the same way", () => {
  const T = "2026-08-05T12:00:00.000Z";
  const later = (ms: number): string => new Date(at(T).getTime() + ms).toISOString();

  /**
   * THE INCUMBENT WITH NO PRESS. The steady state of every mailbox in the field before this
   * release: a claim descended from an arm-4 win, renewed for months, carrying no stamp. It loses
   * to any press at all — which is exactly what makes "Organize here" work against a healthy
   * organizer, and is the row that goes red if `authorizedAt` is dropped from `compareStrength`.
   */
  it("a claim carrying a press outranks a long-standing incumbent that carries none", () => {
    const folder = [
      claim({
        installId: "cloud-a", kind: "cloud",
        heartbeat: T, claimedAt: "2026-05-01T00:00:00.000Z",
      }),
      claim({
        installId: "laptop", kind: "local",
        heartbeat: T, claimedAt: later(1_000), authorizedAt: later(1_000),
      }),
    ];
    const r = both(
      { who: self("cloud-a", "cloud"), now: later(5_000) },
      { who: self("laptop", "local"), now: later(5_000) },
      folder,
    );
    expect(r.organizers).toBe(1);
    expect(r.b.verdict).toBe("organize");
    expect(r.a.verdict).toBe("stand_down");
  });

  /**
   * NULL IS LOWEST, AND `-Infinity − -Infinity` IS `NaN`.
   *
   * Two unpressed claims is the common case, and a subtraction-based first term returns NaN for it
   * — which `Array.sort` reads as "leave these where they are", i.e. INPUT ORDER, which is the
   * order-dependent tie this whole file exists to make impossible. The two calls below are the SAME
   * folder in two orders and must agree.
   */
  it("two UNPRESSED claims are ordered by incumbency, identically in either input order", () => {
    const older = claim({ installId: "aaa", kind: "local", heartbeat: T, claimedAt: "2026-08-01T00:00:00.000Z" });
    const newer = claim({ installId: "bbb", kind: "local", heartbeat: T, claimedAt: "2026-08-04T00:00:00.000Z" });
    const forward = decide(self("aaa", "local"), [older, newer], later(1_000));
    const reversed = decide(self("aaa", "local"), [newer, older], later(1_000));
    expect(forward.verdict).toBe("organize");
    expect(reversed.verdict).toBe("organize");
    // …and the OTHER install reaches the mirror-image answer from the same two orders.
    expect(decide(self("bbb", "local"), [older, newer], later(1_000)).verdict).toBe("stand_down");
    expect(decide(self("bbb", "local"), [newer, older], later(1_000)).verdict).toBe("stand_down");
  });

  /**
   * A DEAD CLOCK BATTERY CANNOT MINT AN UNBEATABLE PRESS.
   *
   * The heartbeat ceiling has existed since a claim dated 2099 held a mailbox for seventy-three
   * years. Moving the ranking onto `authorizedAt` moves that hazard onto a new field, so the clamp
   * moves with it: a press dated 2099 is clamped to `now + MAX_FUTURE_SKEW_MS` and an honest press
   * made a second ago beats it. Without the clamp this row is a permanent lockout with no remedy
   * short of a person deleting the bookkeeping message by hand.
   */
  it("a press dated 2099 cannot refuse a human's takeover", () => {
    const folder = [claim({
      installId: "broken-clock", kind: "cloud",
      heartbeat: T, claimedAt: "2026-08-01T00:00:00.000Z",
      authorizedAt: "2099-01-01T00:00:00.000Z",
    })];
    // An ordinary press, made at this reader's own now, takes the mailbox.
    const v = decide(self("laptop", "local", null), folder, later(1_000), later(1_000));
    expect(v.verdict).toBe("organize");
    expect(v.verdict === "organize" ? v.authorized : false).toBe(true);
    // WITHOUT the press it is still refused — the implausible stamp loses its VETO, not the claim's
    // standing. Nothing self-promotes past a live claim just because its clock is wrong.
    expect(decide(self("laptop", "local", null), folder, later(1_000)).verdict).toBe("stand_down");
  });

  /**
   * THE CLAMP ITSELF, which is a different property from the row above and is what keeps two
   * readers agreeing: an implausible press is still RANKED, at the ceiling, so every reader of the
   * folder elects the same winner. Only rule 6's veto is withheld from it.
   */
  it("an implausible press still RANKS — it is clamped, not discarded", () => {
    const folder = [
      claim({
        installId: "broken-clock", kind: "cloud", heartbeat: T,
        claimedAt: "2026-08-01T00:00:00.000Z", authorizedAt: "2099-01-01T00:00:00.000Z",
      }),
      claim({
        installId: "honest", kind: "local", heartbeat: T,
        claimedAt: "2026-08-02T00:00:00.000Z", authorizedAt: later(-1_000),
      }),
    ];
    // Both installs read the same folder and reach the same answer: the clamped 2099 stamp is still
    // the highest press present, so the broken machine is the winner and the honest one stands down.
    const r = both(
      { who: self("broken-clock", "cloud"), now: later(1_000) },
      { who: self("honest", "local"), now: later(1_000) },
      folder,
    );
    expect(r.organizers).toBe(1);
    expect(r.a.verdict).toBe("organize");
    expect(r.b.verdict).toBe("stand_down");
  });

  /**
   * A RESTORED CLONE SHARING OUR INSTALL ID, with a press on the row of the machine somebody is
   * actually sitting at. The ruling states both halves as one sentence: *"clone with a stale stamp
   * loses; clone with a fresh press wins (a human pressed on it)."*
   *
   * The clone defence is unchanged — a same-id claim with a foreign nonce, live, is not ours — so
   * what decides is the press, exactly as it does between two strangers.
   */
  it("a clone with a FRESH press takes the mailbox; the same clone with a stale one does not", () => {
    const theirs = claim({
      installId: "shared-id", kind: "local", nonce: "n-theirs",
      heartbeat: T, claimedAt: "2026-08-01T00:00:00.000Z",
    });
    // Our process wrote `n-ours` and is looking at a claim with a different nonce: a clone.
    const us = self("shared-id", "local", "n-ours");
    expect(decide(us, [theirs], later(1_000)).verdict).toBe("stand_down");
    expect(decide(us, [theirs], later(1_000), later(500)).verdict).toBe("organize");
    // A stamp older than the clone's own tenure is stale in the sense that matters: it loses to
    // nothing here (the clone carries no press), so it still wins — the press is ranked against
    // the LIVE MAXIMUM, not against anybody's `claimedAt`. That is deliberate; see rule 6.
    expect(decide(us, [theirs], later(1_000), "2026-07-01T00:00:00.000Z").verdict).toBe("organize");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * CROSS-VERSION CONVERGENCE — a 0.14 install and a 0.14.1 install reading one folder
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The claim format is additive at protocol 1, so an older install parses every field it knows and
 * IGNORES the press. That is the right compatibility choice and it has a consequence worth pinning
 * rather than discovering: for one cycle the two builds can rank the same folder differently.
 *
 * A 0.14 reader is modelled by what it can SEE — a claim with no `X-Ohmail-Authorized-At` header —
 * and by the two rules it still has: kind ranks, and rule 5 refuses a local install a live cloud
 * claim. There is no way to run the old function from here, so each row asserts the outcome the
 * ruling names and states which side's rules produce it.
 */
describe("a 0.14 install and a 0.14.1 install converge on one organizer", () => {
  const T = "2026-08-05T12:00:00.000Z";
  const later = (ms: number): string => new Date(at(T).getTime() + ms).toISOString();

  /**
   * 0.14 CLOUD ORGANIZING, 0.14.1 LOCAL PRESSING. The ruling: *"local displaces, old cloud stands
   * down on its next gate."*
   *
   * The local side is this build and its answer is asserted directly. The cloud side is 0.14: its
   * claim has been DISPLACED — expunged from the folder — so its next gate sees a folder holding
   * one foreign claim and none of its own, which is arm 7 in every version of this table. It does
   * not need to understand the press to stand down; it needs only to find its own claim gone,
   * which is precisely why an authorized takeover changes the FOLDER rather than only our mind.
   */
  it("0.14 cloud vs a 0.14.1 local press — the local displaces, and the old cloud's own arm 7 ends it", () => {
    const oldCloud = claim({
      installId: "cloud-a", kind: "cloud", heartbeat: T, claimedAt: "2026-05-01T00:00:00.000Z",
    });
    const v = decide(self("laptop", "local", null), [oldCloud], later(1_000), later(500));
    expect(v.verdict).toBe("organize");
    expect(v.verdict === "organize" ? v.authorized : false).toBe(true);
    // What the old cloud reads on its next gate: its claim gone, ours standing. Modelled with THIS
    // build's function because arm 7 is identical in both — a live foreign winner, no claim of ours.
    const afterHandover = [claim({
      installId: "laptop", kind: "local",
      heartbeat: later(1_000), claimedAt: later(1_000), authorizedAt: later(500),
    })];
    expect(decide(self("cloud-a", "cloud", null), afterHandover, later(30_000)).verdict)
      .toBe("stand_down");
  });

  /**
   * 0.14 LOCAL PRESSING OVER A 0.14.1 LOCAL. The ruling: *"old rule 6 displaces, the new local
   * stands down."*
   *
   * Two locals, so the old build's kind term and its rule 5 are both inert — its rule 6 is "a human
   * authorized this install, so take it", with no comparison of presses, and it displaces. The row
   * asserted here is the NEW install's side of the aftermath, which is the half this build owns:
   * its claim is gone, a live foreign claim stands, and it stands down. It does NOT re-take the
   * mailbox on the strength of a press it might still hold — the stamp is one-shot and the caller
   * voids it on a stand-down, which is what stops the two builds trading the mailbox for ever.
   */
  it("a 0.14 local press over a 0.14.1 local — the new install stands down and does not re-take", () => {
    const oldLocal = claim({
      installId: "old-laptop", kind: "local", heartbeat: later(1_000), claimedAt: later(1_000),
    });
    // Our claim was displaced; theirs stands. No press of ours outstanding — the gate that lost
    // voided it.
    expect(decide(self("new-laptop", "local", null), [oldLocal], later(2_000)).verdict)
      .toBe("stand_down");
  });

  /**
   * 0.14 LOCAL ORGANIZING, 0.14.1 CLOUD PRESSING. The ruling calls this *"today's path"* — and it
   * is worth a row precisely because it is unchanged: under the old rules a cloud install could
   * always take a live local with an authorization, and under the new ones it takes it because the
   * press outranks a claim nobody pressed for. Same outcome, different reason, and the row is what
   * proves the release did not quietly cost a transition that already worked.
   */
  it("0.14 local vs a 0.14.1 cloud press — unchanged: the press takes it", () => {
    const oldLocal = claim({
      installId: "laptop", kind: "local", heartbeat: T, claimedAt: "2026-07-01T00:00:00.000Z",
    });
    const v = decide(self("cloud-a", "cloud", null), [oldLocal], later(1_000), later(500));
    expect(v.verdict).toBe("organize");
  });

  /**
   * A 0.14 ORGANIZER ADVERTISES NO CAPABILITIES, and the reader has to be able to SEE that rather
   * than wait for ever on a machine that is never going to answer.
   *
   * The parse is the whole of this file's stake in it — an absent `X-Ohmail-Capabilities` header is
   * an empty set, not an unknown — and the door that turns the empty set into a sentence is built
   * beside the request channel. Pinned here because the claim format is where the two releases
   * meet, and because "absent means none" is exactly the kind of default that gets read as
   * "unspecified, so assume yes".
   */
  it("a claim written by an older install advertises no capabilities, and parses as none", () => {
    const old = claim({ installId: "cloud-a", kind: "cloud", heartbeat: T });
    expect((old as Exclude<ClaimRecord, { malformed: true }>).capabilities).toEqual([]);
    const fresh = claim({
      installId: "cloud-b", kind: "cloud", heartbeat: T, capabilities: ["requests"],
    });
    expect((fresh as Exclude<ClaimRecord, { malformed: true }>).capabilities).toEqual(["requests"]);
  });
});

/**
 * A CLAIM THIS INSTALL WROTE IS ITS OWN, UNDER EVERY NONCE IT MINTED. A phone on a bad network
 * renewed, the APPEND committed and the answer was lost, a retry minted another nonce; the next gate
 * read the committed claim as a copy of itself and stood the only install down, for good.
 */
describe("a claim this install wrote is its own under every nonce it minted", () => {
  const NOW = "2026-10-24T00:15:24.000Z";
  const ago = (min: number): string => new Date(at(NOW).getTime() - min * 60_000).toISOString();
  const own = (nonce: string, heartbeat: string): ClaimRecord =>
    claim({ installId: "phone", kind: "local", heartbeat, claimedAt: ago(60), nonce });
  const me = (lastNonce: string | null, mintedNonces?: readonly string[]): LeaseSelf =>
    ({ installId: "phone", kind: "local", displayName: "phone", lastNonce, ...(mintedNonces ? { mintedNonces } : {}) });

  it("a renewal whose answer was lost, then a retry under a newer nonce, leave it organizing", () => {
    const folder = [own("acked", ago(2)), own("answer-lost", ago(1))];
    expect(decide(me("acked", ["answer-lost", "retried"]), folder, NOW).verdict).toBe("organize");
  });

  it("GUARD: the same folder with nothing minted is still a live copy of this install", () => {
    const folder = [own("acked", ago(2)), own("answer-lost", ago(1))];
    expect(decide(me("acked", []), folder, NOW).verdict).toBe("stand_down");
  });

  it("a lone own claim nothing renews any more is taken back at its lapse, with no press", () => {
    expect(decide(me("acked"), [own("answer-lost", ago(18))], NOW).verdict).toBe("organize");
  });

  it("GUARD: a stronger live foreign claim stands it down; a stale one waits for a person", () => {
    const laptop = (heartbeat: string): ClaimRecord =>
      claim({ installId: "laptop", kind: "local", heartbeat, claimedAt: ago(120), nonce: "laptop-nonce" });
    expect(decide(me("acked", ["answer-lost"]), [own("acked", ago(2)), laptop(ago(0.5))], NOW).verdict).toBe("stand_down");
    expect(decide(me("acked", ["answer-lost"]), [laptop(ago(18))], NOW).verdict).toBe("available");
  });

  it("the confirm keeps the claim it just wrote when the ring already names its nonce", async () => {
    const kept = formatClaim({
      installId: "phone", kind: "local", displayName: "phone", heartbeat: at(ago(1)), claimedAt: at(ago(60)),
      nonce: "P", authorizedAt: null, capabilities: [],
    });
    const folder: RawClaimMessage[] = [{ ref: 1, raw: kept, internalDate: null }];
    let uid = 1;
    const io: LeaseIo = {
      ensureMetaFolder: async () => undefined,
      listClaims: async () => folder.map((m) => ({ ...m })),
      appendClaim: async (raw: string) => { folder.push({ ref: ++uid, raw, internalDate: null }); },
      removeClaims: async (refs: readonly unknown[]) => {
        const gone = new Set(refs);
        for (let i = folder.length - 1; i >= 0; i--) if (gone.has(folder[i]!.ref)) folder.splice(i, 1);
      },
      uidValidity: () => 1,
    };
    const gate = await runLeaseGate({
      io, self: me(null, ["N"]), now: at(NOW), capabilities: [], newNonce: () => "N",
    });
    expect(gate.verdict.verdict).toBe("organize");
    expect(folder.map((m) => parseClaim(m.raw) as { nonce: string }).map((c) => c.nonce)).toEqual(["N"]);
  });

  it("the row resumes its own lapsed claim only while every term holds", () => {
    const row = {
      organizerRole: "reader", organizeConsentedAt: at(ago(60)), organizedByInstallId: "phone",
      organizerState: "stopped", organizerReleasedAt: null as Date | null, releaseRequestedAt: null as Date | null,
    };
    expect(resumesOwnClaim(row, "phone")).toBe(true);
    const broken: Array<Partial<typeof row>> = [
      { organizerRole: "organizer" }, { organizeConsentedAt: null as unknown as Date },
      { organizedByInstallId: "laptop" }, { organizedByInstallId: null as unknown as string },
      { organizerState: "held" }, { organizerState: null as unknown as string },
      { organizerReleasedAt: at(ago(5)) }, { releaseRequestedAt: at(ago(5)) },
    ];
    for (const over of broken) {
      expect(resumesOwnClaim({ ...row, ...over }, "phone"), JSON.stringify(over)).toBe(false);
    }
  });
});
