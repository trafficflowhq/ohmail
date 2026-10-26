import { describe, expect, it } from "vitest";

import {
  CLAIM_PROTOCOL,
  DEFAULT_STALE_AFTER_MS,
  JOIN_SETTLE_READS_MAX,
  LeaseUnavailableError,
  META_FOLDER,
  META_FOLDER_IS_UNWATCHED,
  MetaEnumRefusedError, META_ENUM_RECORDS_MAX,
  answerLeasePeek,
  decideLease,
  formatClaim,
  makeLeaseIo,
  parseClaim,
  runLeaseGate,
  sameMetaStamp,
  type ClaimRecord,
  type LeaseIo,
  type LeaseImapClient,
  type LeaseSelf,
  type OrganizerClaim,
  type OrganizerIntent,
  type RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { OHMAIL_FOLDERS, WATCHED_FOLDERS } from "@trafficflow/core/adapters/imap";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * THE DECISION TABLE, arm by arm — the project's design notes §3 and §4.
 *
 * `decideLease` is pure, so every row here is a fact about the rules rather than about a server.
 * The IMAP behaviour it composes onto is proven separately against GreenMail in
 * `organizer-lease.imap.test.ts`; this file is where the priority ORDER is pinned, because the
 * order is what a well-meaning refactor gets wrong.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function claim(over: Partial<OrganizerClaim> = {}): OrganizerClaim {
  return {
    installId: "them",
    kind: "local",
    protocol: CLAIM_PROTOCOL,
    heartbeat: ago(1_000),
    /* No server stamp, which is what a hand-built claim honestly is: `withServerClock` leaves such
       a record exactly as it is, so every row below still measures the writer-stamp rules it was
       written to measure. A row that wants the server's clock states one — and `writerStamp` is
       the heartbeat, which is what the parser writes for a record nothing has substituted. */
    serverStamp: null,
    writerStamp: ago(1_000),
    claimedAt: ago(60_000),
    displayName: "Their Mac",
    nonce: "n-them",
    /* 0.14.1 — a claim NOBODY PRESSED FOR is the default, because it is the steady state: an
       ordinary renewal descends from an arm-4 claim on an empty folder and carries no stamp. Every
       row below that means to test the press says so explicitly, which is what keeps "a press
       ranks above liveness" a claim about the rows rather than about the helper. */
    authorizedAt: null,
    /* A tenure nobody pressed for describes itself as a takeover, which is what every record
       written before the verb existed says and what those installs do. */
    intent: "takeover",
    capabilities: [],
    ...over,
  };
}

function self(over: Partial<LeaseSelf> = {}): LeaseSelf {
  return { installId: "us", kind: "local", displayName: "This Mac", lastNonce: null, ...over };
}

/**
 * 0.14.1 — the press is an INSTANT. `"authorized"` still reads as "pressed just now", which is
 * what every row written before this release meant by it, and a `Date` says exactly when for the
 * rows that rank two presses against each other.
 */
/* AND THE VERB THE PRESS WAS, defaulting to `takeover`, which is what every row in this file
   meant before the field existed — so the rows already here keep measuring what they measured and
   the join arm has to say so explicitly. */
const decide = (
  s: LeaseSelf,
  claims: ClaimRecord[],
  takeover?: "authorized" | "none" | Date,
  intent: OrganizerIntent = "takeover",
): ReturnType<typeof decideLease> =>
  decideLease({
    self: s, claims, now: NOW,
    ...(takeover === "authorized" ? { takeover: { authorizedAt: NOW, intent } }
      : takeover instanceof Date ? { takeover: { authorizedAt: takeover, intent } }
        : {}),
  });

const STALE = DEFAULT_STALE_AFTER_MS + 60_000;

describe("the meta folder stays out of the sync loop", () => {
  /**
   * `WATCHED_FOLDERS` is the input to `changesSince`, and `OHMAIL_FOLDERS` — what
   * `ensureFolders()` creates — is derived from it. A watched `_meta` would ingest the lease's
   * own claim messages as MAIL: classified, routed, filed, and shown to the user as a stranger
   * writing to them every fifteen seconds.
   *
   * This is an assertion and not a comment because the two constants live in a different file
   * from the lease and nothing else connects them.
   */
  it("is absent from WATCHED_FOLDERS and from the folders ensureFolders creates", () => {
    expect(META_FOLDER_IS_UNWATCHED).toBe(true);
    expect(WATCHED_FOLDERS as readonly string[]).not.toContain(META_FOLDER);
    expect(OHMAIL_FOLDERS as readonly string[]).not.toContain(META_FOLDER);
  });

  /** No leading dot — it has to survive being mapped through both `/` and `.` delimiters. */
  it("has no leading dot in any segment", () => {
    expect(META_FOLDER.split("/").some((seg) => seg.startsWith("."))).toBe(false);
  });
});

describe("the claim format", () => {
  it("round-trips every field", () => {
    const raw = formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "abc-123",
      kind: "cloud",
      displayName: "ohmail Cloud (eu-1)",
      heartbeat: NOW,
      claimedAt: ago(3_600_000),
      nonce: "nonce-1",
    });
    const parsed = parseClaim(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      installId: "abc-123",
      kind: "cloud",
      protocol: CLAIM_PROTOCOL,
      displayName: "ohmail Cloud (eu-1)",
      nonce: "nonce-1",
    });
    expect((parsed as OrganizerClaim).heartbeat.toISOString()).toBe(NOW.toISOString());
    expect((parsed as OrganizerClaim).claimedAt.toISOString()).toBe(ago(3_600_000).toISOString());
  });

  /**
   * The discriminator earns its place: a message WITHOUT `X-Ohmail-Lease` is not a claim at all,
   * so a stray message in `_meta` — or a future meta record type — cannot make a mailbox look
   * contended.
   */
  it("reads a message with no lease header as not-a-claim", () => {
    expect(parseClaim("Subject: hello\r\nFrom: a@b.c\r\n\r\nhi")).toBeNull();
  });

  /**
   * …and a message WITH the header whose fields are unreadable is MALFORMED, which is a
   * different thing. It is evidence that somebody claimed, and §3.4 says evidence must never
   * read as "no claim, so organize".
   */
  it("reads a lease-headed message with a broken heartbeat as malformed, not as absent", () => {
    const parsed = parseClaim("X-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: x\r\nX-Ohmail-Protocol: 1\r\nX-Ohmail-Heartbeat: nonsense\r\n\r\n");
    expect(parsed).toMatchObject({ malformed: true });
  });

  it("unfolds a header the server wrapped", () => {
    const raw = [
      "X-Ohmail-Lease: 1",
      "X-Ohmail-Install-Id: x",
      "X-Ohmail-Protocol: 1",
      `X-Ohmail-Heartbeat: ${NOW.toISOString()}`,
      "X-Ohmail-Display-Name: Mila's",
      "  MacBook Pro",
      "",
      "",
    ].join("\r\n");
    expect((parseClaim(raw) as OrganizerClaim).displayName).toBe("Mila's MacBook Pro");
  });

  /** A display name is user data. It must not be able to forge a second header. */
  it("cannot be header-injected through the display name", () => {
    const raw = formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "us",
      kind: "local",
      displayName: "Mac\r\nX-Ohmail-Organizer-Kind: cloud",
      heartbeat: NOW,
      claimedAt: NOW,
      nonce: "n",
    });
    expect((parseClaim(raw) as OrganizerClaim).kind).toBe("local");
  });
});

describe("decideLease — the priority order", () => {
  it("organizes a mailbox nobody has ever claimed", () => {
    expect(decide(self(), [])).toEqual({ verdict: "organize", renew: true, displace: [], authorized: false });
  });

  it("organizes when the only fresh claim is our own", () => {
    expect(decide(self(), [claim({ installId: "us", nonce: "n-us" })])).toEqual({ verdict: "organize", renew: true, displace: [], authorized: false });
  });

  /** §4: "Continuing is not becoming." A crash, a restore or a long sleep resumes by itself. */
  it("resumes its OWN stale claim without authorization", () => {
    expect(decide(self(), [claim({ installId: "us", heartbeat: ago(STALE) })])).toEqual({
      verdict: "organize",
      renew: true,
      displace: [],
      // Continuation, not a press: nothing here was taken over, so the renewed claim carries
      // whatever stamp our own prior claim held (none) rather than minting one.
      authorized: false,
    });
  });

  /**
   * THE ARM A TWO-VERDICT TABLE GETS WRONG. Cloud lapses; its claim goes stale. "No fresh
   * foreign claim ⇒ organize" would make a forgotten install on an office machine silently start
   * moving somebody's mail, triggered by a billing event, with a rules store frozen at
   * stand-down.
   */
  it("returns available — never organize — when a foreign claim has merely gone stale", () => {
    const v = decide(self(), [claim({ kind: "cloud", heartbeat: ago(STALE) })]);
    expect(v.verdict).toBe("available");
    expect(v).toMatchObject({ by: { kind: "cloud" } });
  });

  it("converts available to organize only with explicit authorization", () => {
    expect(decide(self(), [claim({ kind: "cloud", heartbeat: ago(STALE) })], "authorized")).toEqual({
      verdict: "organize",
      renew: true,
      displace: [],
      // Rule 6. The press outranks a claim nobody pressed for, so the gate stamps the renewed
      // claim with it — which is what stops the next election handing the mailbox straight back.
      authorized: true,
    });
  });

  /** A malformed foreign claim is evidence of a claimant, so it is `available` and not organize. */
  it("returns available for a malformed foreign claim", () => {
    expect(decide(self(), [{ malformed: true, reason: "unreadable heartbeat" }]).verdict).toBe("available");
  });

  it("stands a local install down for a fresh cloud claim", () => {
    expect(decide(self(), [claim({ kind: "cloud" })])).toMatchObject({
      verdict: "stand_down",
      reason: "organized_elsewhere:cloud",
    });
  });

  /**
   * A HIGHER PROTOCOL IS FOREIGN-AND-FRESH, never unparseable-so-ignored. The opposite reading
   * would let a future claim format silently re-enable dual organizing against every older
   * install in the field, and nothing would report it.
   */
  it("stands down for a fresh claim written in a protocol it does not understand", () => {
    expect(decide(self(), [claim({ protocol: CLAIM_PROTOCOL + 1 })])).toMatchObject({
      verdict: "stand_down",
      reason: "organized_elsewhere:unknown",
    });
  });

  it("stands down for a fresh claim of an unrecognised organizer kind", () => {
    expect(decide(self(), [claim({ kind: "unknown" })])).toMatchObject({
      verdict: "stand_down",
      reason: "organized_elsewhere:unknown",
    });
  });

  describe("local vs local — the incumbent wins, computed identically from both sides", () => {
    const older = claim({ installId: "aaa", claimedAt: ago(600_000) });
    const newer = claim({ installId: "bbb", claimedAt: ago(60_000) });

    it("stands the newcomer down", () => {
      const v = decide(self({ installId: "bbb" }), [older, { ...newer, installId: "bbb" }]);
      expect(v).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:local" });
    });

    it("keeps the incumbent organizing", () => {
      expect(decide(self({ installId: "aaa" }), [{ ...older, installId: "aaa" }, newer])).toEqual({
        verdict: "organize",
        renew: true,
        displace: [],
        authorized: false,
      });
    });

    /**
     * The two calls above are the SAME folder contents read by two different installs. Exactly
     * one of them organizes — which is the whole invariant, and it is not visible from either
     * call alone.
     */
    it("produces exactly one organizer across both sides", () => {
      const a = decide(self({ installId: "aaa" }), [{ ...older, installId: "aaa" }, newer]);
      const b = decide(self({ installId: "bbb" }), [older, { ...newer, installId: "bbb" }]);
      expect([a.verdict, b.verdict].filter((v) => v === "organize")).toHaveLength(1);
    });

    it("breaks a claimedAt tie lexicographically, and both sides agree", () => {
      const at = ago(300_000);
      const a = decide(self({ installId: "aaa" }), [claim({ installId: "aaa", claimedAt: at }), claim({ installId: "bbb", claimedAt: at })]);
      const b = decide(self({ installId: "bbb" }), [claim({ installId: "aaa", claimedAt: at }), claim({ installId: "bbb", claimedAt: at })]);
      expect(a.verdict).toBe("organize");
      expect(b.verdict).toBe("stand_down");
    });
  });

  describe("the cloud arms", () => {
    const cloudSelf = self({ installId: "cloud-eu-1", kind: "cloud", displayName: "ohmail Cloud" });

    /**
     * THE CONTINUATION ARM. Without it, a fresh local claim stands Cloud down while Cloud's
     * claim stands the local install down, and NOBODY organizes — the mailbox silently stops
     * being processed for a paying subscriber.
     */
    it("keeps organizing on its own fresh claim even against a fresh foreign local", () => {
      expect(
        decide(cloudSelf, [claim({ installId: "cloud-eu-1", kind: "cloud", nonce: "n" }), claim({ kind: "local" })]),
      ).toEqual({ verdict: "organize", renew: true, displace: [], authorized: false });
    });

    /** Adding a mailbox to Cloud IS the explicit action, so the connect flow informs and proceeds. */
    it("takes over a fresh local claim when a human authorized it", () => {
      expect(decide(cloudSelf, [claim({ kind: "local" })], "authorized"))
        .toEqual({ verdict: "organize", renew: true, displace: [], authorized: true });
    });

    /**
     * NO SEIZE-BACK. A lapse-then-resubscribe must not let the worker resume over a mailbox the
     * user deliberately moved local. Without the authorization flag those two are
     * indistinguishable to the gate, which is the entire reason the flag exists.
     */
    it("refuses to take over a fresh local claim without one", () => {
      expect(decide(cloudSelf, [claim({ kind: "local" })])).toMatchObject({
        verdict: "stand_down",
        reason: "organized_elsewhere:local",
      });
    });

    it("refuses to seize back a STALE local claim without one", () => {
      expect(decide(cloudSelf, [claim({ kind: "local", heartbeat: ago(STALE) })]).verdict).toBe("available");
    });
  });

  describe("clock skew is real, and the fail-safe direction is to believe the peer", () => {
    it("treats a heartbeat in the future as fresh", () => {
      expect(decide(self(), [claim({ kind: "cloud", heartbeat: new Date(NOW.getTime() + 60_000) })])).toMatchObject({
        verdict: "stand_down",
      });
    });
  });

  describe("append-then-expunge leaves two of our own claims, and a reader must cope", () => {
    /** §3.3: a crash between the append and the expunge is a state to handle, not to hope against. */
    it("coalesces duplicate claims per install to the newest heartbeat", () => {
      const v = decide(self(), [
        claim({ installId: "them", kind: "cloud", heartbeat: ago(STALE) }),
        claim({ installId: "them", kind: "cloud", heartbeat: ago(1_000) }),
      ]);
      expect(v.verdict).toBe("stand_down");
    });

    it("does not let a stale duplicate resurrect a released mailbox", () => {
      const v = decide(self(), [
        claim({ installId: "them", kind: "cloud", heartbeat: ago(1_000) }),
        claim({ installId: "them", kind: "cloud", heartbeat: ago(STALE) }),
      ]);
      expect(v.verdict).toBe("stand_down");
    });
  });

  describe("a renew's residue is not a stranger — AGE decides, and by the WRITER's clock", () => {
    /**
     * A claim carrying OUR install id with a nonce this process never armed is either a previous
     * run of this install (a crash, a kill, a restore on the same device) or a copy of us running
     * somewhere else. The nonce cannot tell them apart; AGE can, and the two rows below are the
     * whole rule: OLDER than the claim we hold is residue, which the next renew expunges; NEWER
     * is a clone, which stands us down.
     *
     * WHICH CLOCK, and this is the half that was wrong. Between two INSTALLS the server's
     * INTERNALDATE is the only honest clock — `withServerClock` exists for a laptop that reads
     * 2099. Between two records of ONE install it is the wrong question: INTERNALDATE records
     * ARRIVAL, and a residue re-appended after the claim that superseded it arrives LATER while
     * having been written EARLIER. It then won `coalesce`, reached the clone defence, and stood
     * the install down against its own previous run — on a mailbox nobody else had touched.
     */
    const OURS = { installId: "us", kind: "local" as const, displayName: "This Mac" };

    it("OLDER by the writer's clock and NEWER by the server's is our own residue", () => {
      /* What a real server reports for a plant, and for a residue re-appended after a
         compaction: our claim was received two minutes ago, the residue a moment ago, and the
         residue's own header says it was written a minute before ours. */
      const ours = claim({ ...OURS, nonce: "armed",
        writerStamp: ago(1_000), heartbeat: ago(1_000), serverStamp: ago(120_000) });
      const residue = claim({ ...OURS, nonce: "never-armed",
        writerStamp: ago(61_000), heartbeat: ago(61_000), serverStamp: ago(0) });
      /* BOTH ORDERS, because `coalesce` keeps one record per install and the answer must not
         depend on which the server hands over first. */
      expect(decide(self({ lastNonce: "armed" }), [ours, residue]).verdict).toBe("organize");
      expect(decide(self({ lastNonce: "armed" }), [residue, ours]).verdict).toBe("organize");
    });

    it("NEWER by the writer's clock is a clone, and it still stands us down", () => {
      /*
       * THE POSITIVE CONTROL FOR THE CLONE DEFENCE, and what it defends against by name: a
       * machine restored from a backup carries the same install id, believes every claim under
       * that id is its own, and organizes the same mailbox from the other side. It is LIVE, so
       * it renews — and a renewal is a fresh write, which is why its writer stamp passes ours
       * within one cycle whatever its clock said when the backup was taken.
       */
      const ours = claim({ ...OURS, nonce: "armed",
        writerStamp: ago(30_000), heartbeat: ago(30_000), serverStamp: ago(30_000) });
      const clone = claim({ ...OURS, nonce: "restored-copy",
        writerStamp: ago(1_000), heartbeat: ago(1_000), serverStamp: ago(1_000) });
      const v = decide(self({ lastNonce: "armed" }), [ours, clone]);
      expect(v.verdict).toBe("stand_down");
      expect(v.verdict === "stand_down" && v.by?.nonce).toBe("restored-copy");
    });

    it("with no server stamp on either record the writer's clock decides alone", () => {
      // A hand-built claim, and every install whose server does not report INTERNALDATE: the
      // rule is the same one, which is what keeps the two rows above a fact about the rule
      // rather than about the substitution.
      const ours = claim({ ...OURS, nonce: "armed", writerStamp: ago(1_000), heartbeat: ago(1_000) });
      const residue = claim({ ...OURS, nonce: "never-armed",
        writerStamp: ago(61_000), heartbeat: ago(61_000) });
      expect(decide(self({ lastNonce: "armed" }), [ours, residue]).verdict).toBe("organize");
    });
  });

  describe("the clone defence — restore-from-backup duplicates the install id", () => {
    /**
     * A restored machine and the original both believe every claim carrying that id is theirs,
     * so identity matching permits exactly the dual organizing it was written to prevent.
     */
    it("treats a claim bearing our id but not our nonce as foreign once we have written", () => {
      const v = decide(self({ lastNonce: "ours-7" }), [claim({ installId: "us", kind: "local", nonce: "someone-else", claimedAt: ago(600_000) })]);
      expect(v.verdict).toBe("stand_down");
    });

    /**
     * …and it must NOT arm before we have written, or a crash-restart would fail to recognise
     * its own claim and stand down from a mailbox nobody else wants. `lastNonce` is memory-only
     * for exactly this reason.
     */
    it("stays disarmed on a fresh start, so own-role resumption survives a restart", () => {
      expect(decide(self({ lastNonce: null }), [claim({ installId: "us", nonce: "written-before-the-crash" })])).toEqual({
        verdict: "organize",
        renew: true,
        displace: [],
        authorized: false,
      });
    });
  });
});

/**
 * ══ RULE 6 CONSULTS THE VERB, NOT THE MACHINE ═══════════════════════════════════════════════
 *
 * The defect these rows close: an install with no takeover verb could still take a live holder's
 * mailbox. Its product rule — "a live foreign holder is refused, always" — was enforced at a
 * PRECHECK over a local row up to one poll old, while the fence ranked presses by instant alone,
 * and a press made today is always the newest one. So the rule was true everywhere except where
 * the decision is made.
 *
 * `kind` does not come back into this table (the 0.14.1 owner ruling emptied it of kind). What
 * decides is the verb the person pressed, carried per claim: a `join` asks only for a mailbox
 * nobody is organizing. Every row below is the SAME folder and the SAME instants, twice, so the
 * only difference that can explain the two verdicts is the verb.
 */
describe("decideLease — a join never takes a live holder's mailbox", () => {
  /** A desktop that took the mailbox an hour ago and is still renewing. */
  const liveHolder = (): OrganizerClaim => claim({
    installId: "their-mac", kind: "local", displayName: "Their Mac",
    heartbeat: ago(1_000), claimedAt: ago(3_600_000), authorizedAt: ago(3_600_000),
    /* A ref, so DISPLACEMENT is observable: a rule-6 win that expunges nothing is undone by the
       next election, and without one this control could pass on a verdict that changes nothing. */
    ref: 7,
  });

  it("yields to a live foreign claim even though its press is newer, and names the holder", () => {
    const v = decide(self(), [liveHolder()], NOW, "join");
    expect(v.verdict, "a join took a mailbox another install is organizing").toBe("stand_down");
    expect(v).toMatchObject({ reason: "organized_elsewhere:local" });
    expect((v as { by: OrganizerClaim | null }).by?.displayName,
      "the verdict named no holder, so no surface can say whose mailbox it is").toBe("Their Mac");
  });

  it("the SAME folder and the SAME press, as a takeover, wins — the control", () => {
    const v = decide(self(), [liveHolder()], NOW, "takeover");
    expect(v.verdict, "the takeover verb stopped working").toBe("organize");
    expect(v).toMatchObject({ authorized: true });
    expect((v as { displace: readonly unknown[] }).displace.length,
      "a takeover that displaces nothing reverses itself next cycle").toBe(1);
  });

  it("a join still takes a mailbox whose holder has STOPPED renewing", () => {
    // Nothing in the folder is live, so there is nobody to yield to: a join is a press, and a
    // press on an unattended mailbox is exactly what this install's one verb is for.
    const v = decide(self(), [claim({ heartbeat: ago(STALE), claimedAt: ago(STALE) })], NOW, "join");
    expect(v.verdict, "a join was refused a mailbox nobody is organizing").toBe("organize");
    expect(v).toMatchObject({ authorized: true });
  });

  it("a join organizes an EMPTY folder — becoming still needs the press, and this is one", () => {
    const v = decide(self(), [], NOW, "join");
    expect(v).toMatchObject({ verdict: "organize", authorized: true });
  });

  it("a LIVE foreign claim that itself says `join` still blocks us, and still ranks", () => {
    /* The decision reads OUR verb and never theirs. A holder that joined is organizing the
       mailbox exactly as much as one that took it, so reading their claim's intent here would
       invent a class of holder that can be displaced without a takeover. */
    const theirs = parseClaim(formatClaim({
      installId: "their-phone", kind: "mobile", displayName: "Their Phone",
      heartbeat: ago(1_000), claimedAt: ago(3_600_000), nonce: "n-theirs",
      authorizedAt: ago(3_600_000), intent: "join", capabilities: [],
    })) as OrganizerClaim;
    expect(theirs.intent, "the fixture did not carry the header under test").toBe("join");
    expect(decide(self(), [theirs], NOW, "join").verdict).toBe("stand_down");
    expect(decide(self(), [theirs], NOW, "takeover").verdict).toBe("organize");
  });

  it("a claim with no intent header ranks and reads as a TAKEOVER — no record migrates", () => {
    const raw = formatClaim({
      installId: "old-mac", kind: "local", displayName: "Old Mac",
      heartbeat: ago(1_000), claimedAt: ago(3_600_000), nonce: "n-old",
      authorizedAt: null, capabilities: [],
    });
    expect(raw, "a takeover tenure wrote a header it must not write").not.toMatch(/X-Ohmail-Intent/i);
    expect((parseClaim(raw) as OrganizerClaim).intent).toBe("takeover");
    /* AND AN EXPLICIT `takeover` WRITES NOTHING EITHER, which is the half that keeps "no record
       migrates" true: absent is the only spelling of the verb every shipped build uses, so a
       0.17 reader sees byte-for-byte what it has always seen. Asserted separately because the
       fixture above omits the field, and an omitted field cannot tell a serializer that writes
       every stated value from one that writes only `join`. */
    const stated = formatClaim({
      installId: "old-mac", kind: "local", displayName: "Old Mac",
      heartbeat: ago(1_000), claimedAt: ago(3_600_000), nonce: "n-old",
      authorizedAt: null, intent: "takeover", capabilities: [],
    });
    expect(stated, "a stated takeover put a header on the wire").not.toMatch(/X-Ohmail-Intent/i);
    expect(stated).toBe(raw);
  });

  it("writes the header only for a join, and reads a duplicated or unknown one as takeover", () => {
    const join = formatClaim({
      installId: "us", kind: "mobile", displayName: "This Phone",
      heartbeat: NOW, claimedAt: NOW, nonce: "n1", authorizedAt: NOW,
      intent: "join", capabilities: [],
    });
    expect(join).toMatch(/^X-Ohmail-Intent: join$/m);
    expect((parseClaim(join) as OrganizerClaim).intent).toBe("join");
    // Unknown and DUPLICATED both fold to the verb that displaces, and neither is `malformed`:
    // nothing ranks a foreign claim's intent, so an unreadable one must not decide the election.
    const odd = join.replace("X-Ohmail-Intent: join", "X-Ohmail-Intent: sideways");
    expect((parseClaim(odd) as OrganizerClaim).intent).toBe("takeover");
    const twice = join.replace("X-Ohmail-Intent: join", "X-Ohmail-Intent: takeover\r\nX-Ohmail-Intent: join");
    const parsed = parseClaim(twice);
    expect(parsed, "a duplicated intent header made the whole claim unreadable").not.toMatchObject({ malformed: true });
    expect((parsed as OrganizerClaim).intent).toBe("takeover");
  });
});


// ── the IO layer ────────────────────────────────────────────────────────────────────────────

class FakeIo implements LeaseIo {
  messages: RawClaimMessage[] = [];
  appended: string[] = [];
  removed: unknown[][] = [];
  ensured = 0;
  failOn: "ensure" | "list" | "append" | "remove" | null = null;
  /**
   * THE FOLDER'S GENERATION, NAMED — because the one IO this product ships (`makeLeaseIo`) always
   * implements this accessor, and a double that leaves a capability out measures a shape
   * production does not have. Omitting it here made every takeover in this file run under an
   * unnamed epoch, which the confirm is now required to refuse. Settable, so the refusal itself
   * has a case below.
   */
  generation: number | bigint | null = 1_000;
  private nextRef = 1;

  uidValidity(): number | bigint | null {
    return this.generation;
  }

  async ensureMetaFolder(): Promise<void> {
    if (this.failOn === "ensure") throw new Error("NO");
    this.ensured++;
  }
  async listClaims(): Promise<RawClaimMessage[]> {
    if (this.failOn === "list") throw new Error("NO");
    return [...this.messages];
  }
  async appendClaim(raw: string): Promise<void> {
    if (this.failOn === "append") throw new Error("NO");
    this.appended.push(raw);
    this.messages.push({ ref: this.nextRef++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    if (this.failOn === "remove") throw new Error("NO");
    this.removed.push([...refs]);
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

describe("runLeaseGate — read, decide, then write", () => {
  it("renews by appending BEFORE expunging the old claim", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 1, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "This Mac", heartbeat: ago(5_000), claimedAt: ago(600_000), nonce: "old" }) });

    const order: string[] = [];
    const spy: LeaseIo = {
      ensureMetaFolder: () => io.ensureMetaFolder(),
      listClaims: () => io.listClaims(),
      appendClaim: async (r) => { order.push("append"); await io.appendClaim(r); },
      removeClaims: async (refs) => { order.push("remove"); await io.removeClaims(refs); },
      // Delegated like the rest: this spy measures the ORDER of the writes, and a double that
      // dropped the generation here would measure a different io than the one it wraps.
      uidValidity: () => io.uidValidity(),
    };

    const res = await runLeaseGate({ capabilities: [], io: spy, self: self(), now: NOW, newNonce: () => "new" });
    expect(res.verdict.verdict).toBe("organize");
    // Expunge-first would leave a crash window in which the mailbox carries NO claim of ours,
    // which reads to every other install as a mailbox that has become available.
    expect(order).toEqual(["append", "remove"]);
    expect(res.nonce).toBe("new");
  });

  /** Renewing must not restart the incumbency clock, or rule 5 never settles between two peers. */
  it("carries claimedAt forward across a renew", async () => {
    const io = new FakeIo();
    const originally = ago(3_600_000);
    io.messages.push({ ref: 1, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "This Mac", heartbeat: ago(5_000), claimedAt: originally, nonce: "old" }) });

    await runLeaseGate({ capabilities: [], io, self: self(), now: NOW, newNonce: () => "new" });
    const written = parseClaim(io.appended[0]!) as OrganizerClaim;
    expect(written.claimedAt.toISOString()).toBe(originally.toISOString());
    expect(written.heartbeat.toISOString()).toBe(NOW.toISOString());
  });

  /**
   * The VERB travels with the tenure exactly as the press does — a renewal that wrote nothing
   * would make a join tenure describe itself as a takeover one cycle later. Both arms: an
   * authorized win writes the verb it rested on, a continuation carries the prior claim's.
   */
  it("writes the verb a win rested on, and carries it forward across a renew", async () => {
    const won = new FakeIo();
    await runLeaseGate({
      capabilities: [], io: won, self: self(), now: NOW, newNonce: () => "n1",
      takeover: { authorizedAt: NOW, intent: "join" },
    });
    expect((parseClaim(won.appended[0]!) as OrganizerClaim).intent,
      "the tenure a join press took does not say so").toBe("join");

    /* AND THE RENEW, which is rule 3 and carries no press of its own: it reads the verb off this
       install's own newest claim, so the folder keeps saying what the tenure is. */
    const renew = new FakeIo();
    renew.messages.push({ ref: 1, raw: won.appended[0]! });
    await runLeaseGate({
      capabilities: [], io: renew, self: self({ lastNonce: "n1" }), now: NOW, newNonce: () => "n2",
    });
    expect((parseClaim(renew.appended[0]!) as OrganizerClaim).intent,
      "a renewal re-described a join tenure as a takeover").toBe("join");
  });

  /**
   * A stand-down RELEASES. Otherwise the winner waits out the whole staleness window before its
   * own gate is clean, and a released claim is what makes "Cloud lapsed" legible at all.
   */
  it("expunges our own claim when it stands down, and appends nothing", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 1, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "This Mac", heartbeat: ago(5_000), claimedAt: ago(600_000), nonce: "old" }) });
    io.messages.push({ ref: 2, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "cloud", kind: "cloud", displayName: "ohmail Cloud", heartbeat: ago(1_000), claimedAt: ago(900_000), nonce: "c" }) });

    const res = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW });
    expect(res.verdict).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:cloud" });
    expect(io.appended).toEqual([]);
    expect(io.removed).toEqual([[1]]);
  });

  /**
   * §3.4 — EXACTLY ONE PATH TO STAND-DOWN. A mailbox whose `_meta` cannot be read is a mailbox
   * we cannot safely organize; reading that as "no claim, so organize" is the dual-organizer bug
   * through the back door, and reading it as "stand down" would permanently disable a mailbox on
   * a transient network error, because stand-down is sticky caller-side.
   */
  it.each(["ensure", "list"] as const)("turns a %s failure into LeaseUnavailableError, never a verdict", async (failOn) => {
    const io = new FakeIo();
    io.failOn = failOn;
    await expect(runLeaseGate({ capabilities: [], io, self: self(), now: NOW })).rejects.toBeInstanceOf(LeaseUnavailableError);
  });

  /**
   * …AND IT NAMES WHICH OPERATION THREW (mail 0029).
   *
   * These two used to share one try that reported neither, and the parameterization above could not
   * see it: both arms produced the same class and the same sentence. The cost was 32 minutes on
   * 2026-08-03, because "the organizer lease could not be read" is one sentence for two completely
   * different faults — CREATE refused in a namespace we have no rights in, versus a FETCH the
   * server will not answer against an empty mailbox (which is what actually happened; Dovecot
   * refuses `FETCH 1:*` there and GreenMail tolerates it, so no adapter test could see it either).
   *
   * The general rule this pins: **a catch that wraps more than one operation must name which one
   * threw.** `op` is a compile-time literal from a closed union, so it carries zero privacy cost —
   * unlike everything else on an IMAP driver error, which is why nothing else travels.
   */
  it.each([
    ["ensure", "ensure_meta"],
    ["list", "list_claims"],
    ["append", "renew_claim"],
  ] as const)("a %s failure reports op=%s, so one sentence is not four faults", async (failOn, op) => {
    const io = new FakeIo();
    io.failOn = failOn;
    const err = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW })
      .then(() => null, (e: unknown) => e as LeaseUnavailableError);
    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect(err!.op).toBe(op);
    // The CAUSE is retained, which is what lets `log.ts` publish `causeClass`/`causeCode` — the
    // driver's own class and errno, through the same two grammars `describeError` applies. The
    // wrapper class on its own was the entire record before that.
    expect(err!.cause, "the driver's error was dropped, so nothing under the wrapper is knowable")
      .toBeDefined();
  });

  it("turns a failed renew into LeaseUnavailableError rather than a silent non-renewal", async () => {
    const io = new FakeIo();
    io.failOn = "append";
    await expect(runLeaseGate({ capabilities: [], io, self: self(), now: NOW })).rejects.toBeInstanceOf(LeaseUnavailableError);
  });

  /** Failing to RELEASE is not failing to stand down — we are already not organizing. */
  it("still stands down when the release cannot be written", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 1, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "M", heartbeat: ago(5_000), claimedAt: ago(600_000), nonce: "o" }) });
    io.messages.push({ ref: 2, raw: formatClaim({ authorizedAt: null, capabilities: [], installId: "cloud", kind: "cloud", displayName: "C", heartbeat: ago(1_000), claimedAt: ago(900_000), nonce: "c" }) });
    io.failOn = "remove";
    const res = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW });
    expect(res.verdict.verdict).toBe("stand_down");
  });

  /* ── A JOIN NEVER TAKES A LIVE HOLDER'S MAILBOX, EVEN OVER A READ THAT MISSED IT ──────────────
     Two Dovecot indexes over one maildir, or a provider whose sessions agree only eventually: the
     election's read can miss a live holder the confirm read shows. The join's claim carried its
     press, which ranks first, so it won its confirm and the holder stood down to it. */
  const selfHostClaim = (heartbeat: Date = ago(30_000)): RawClaimMessage => ({
    ref: 53,
    raw: formatClaim({
      installId: "cloud:selfhost", kind: "cloud", displayName: "localhost:6080",
      heartbeat, claimedAt: ago(20 * 60_000), nonce: "sh",
      authorizedAt: ago(20 * 60_000), capabilities: ["requests"],
    }),
  });
  /** The folder's FIRST read misses the records `hidden` picks; every later read shows them. */
  const missesFirst = (io: FakeIo, hidden: (m: RawClaimMessage) => boolean): FakeIo => {
    const plain = io.listClaims.bind(io);
    let reads = 0;
    io.listClaims = async (): Promise<RawClaimMessage[]> => {
      const all = await plain();
      reads += 1;
      return reads === 1 ? all.filter((m) => !hidden(m)) : all;
    };
    return io;
  };
  const claimsIn = (io: FakeIo): OrganizerClaim[] => io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
  const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 1); });
  const pressOn = (io: LeaseIo, installId: string, intent: OrganizerIntent, pressed: Date, now: Date = NOW) => runLeaseGate({
    capabilities: [], io, self: self({ installId, displayName: installId }), now, newNonce: () => `n-${installId}`,
    takeover: { authorizedAt: pressed, intent }, sleep: tick,
  });

  it("a join whose first read missed a live holder yields at the confirm, and the holder keeps organizing", async () => {
    const io = missesFirst(new FakeIo(), (m) => m.ref === 53);
    io.messages.push(selfHostClaim());
    const events: string[] = [];
    const res = await runLeaseGate({
      capabilities: [], io, self: self({ installId: "desktop", displayName: "zorin" }), now: NOW,
      newNonce: () => "j1", takeover: { authorizedAt: NOW, intent: "join" }, log: (event) => { events.push(event); },
    });
    expect(res.verdict, "a join took a live holder's mailbox").toMatchObject({
      verdict: "stand_down", reason: "organized_elsewhere:cloud", by: { installId: "cloud:selfhost" },
    });
    expect(res.nonce).toBeNull();
    expect(events).toContain("lease_lost_race");
    expect(claimsIn(io).map((c) => c.installId), "the join's claim stayed beside the holder's").toEqual(["cloud:selfhost"]);
    const holder = decideLease({
      self: { installId: "cloud:selfhost", kind: "cloud", displayName: "localhost:6080", lastNonce: "sh" },
      claims: claimsIn(io), now: new Date(NOW.getTime() + 30_000),
    });
    expect(holder.verdict, "the holder stood down on its next pass").toBe("organize");
  });

  it("CONTROL: the same missed read under \"Organize here instead\" still takes the mailbox", async () => {
    const io = missesFirst(new FakeIo(), (m) => m.ref === 53);
    io.messages.push(selfHostClaim());
    const res = await pressOn(io, "desktop", "takeover", NOW);
    expect(res.verdict.verdict).toBe("organize");
    expect(res.nonce).toBe("n-desktop");
  });

  it("CONTROL: a holder that stopped renewing does not make a join yield at the confirm", async () => {
    const io = missesFirst(new FakeIo(), (m) => m.ref === 53);
    io.messages.push(selfHostClaim(ago(DEFAULT_STALE_AFTER_MS + 60_000)));
    const res = await pressOn(io, "desktop", "join", NOW);
    expect(res.verdict.verdict).toBe("organize");
  });

  /* TWO JOINS, THE LATER ONE ON A READ THAT MISSED THE EARLIER ONE'S CLAIM: the earlier press keeps
     the mailbox, whichever install id it carries. */
  it.each([["a", "b"], ["b", "a"]] as const)(
    "two joins crossing: the earlier press (%s) keeps the mailbox and the later one (%s) yields",
    async (earlier, later) => {
      const folder = new FakeIo();
      expect((await pressOn(folder, earlier, "join", ago(5_000))).verdict.verdict).toBe("organize");
      const lagging = missesFirst(folder, (m) => (parseClaim(m.raw) as OrganizerClaim).installId === earlier);
      const res = await pressOn(lagging, later, "join", NOW, new Date(NOW.getTime() + 1_000));
      expect(res.verdict, "the later join took the earlier one's mailbox").toMatchObject({
        verdict: "stand_down", by: { installId: earlier },
      });
      expect(claimsIn(folder).map((c) => c.installId)).toEqual([earlier]);
      const next = decideLease({
        self: self({ installId: earlier, lastNonce: `n-${earlier}` }), claims: claimsIn(folder),
        now: new Date(NOW.getTime() + 30_000),
      });
      expect(next.verdict).toBe("organize");
    });

  /* AND TWO PRESSES OF ONE INSTANT, EACH MISSING THE OTHER UNTIL BOTH CONFIRM: the election's own
     tie-break keeps one of them, the lower install id, in either order. */
  it.each([["a", "b"], ["b", "a"]] as const)(
    "two joins of one instant crossing at once: exactly one organizes, the lower install id (%s runs first)",
    async (x, y) => {
      const folder = new FakeIo();
      const [rx, ry] = await Promise.all([pressOn(folder, x, "join", NOW), pressOn(folder, y, "join", NOW)]);
      expect({ [x]: rx.verdict.verdict, [y]: ry.verdict.verdict }).toEqual({ a: "organize", b: "stand_down" });
      expect(claimsIn(folder).map((c) => c.installId)).toEqual(["a"]);
    });

  /** Two gates over one folder: both first reads before either append, both confirm reads before either removal. */
  const lockstep = (folder: FakeIo): ((who: string) => LeaseIo) => {
    const barrier = (): (() => Promise<void>) => {
      let arrived = 0;
      let open!: () => void;
      const opened = new Promise<void>((r) => { open = r; });
      return async () => { arrived += 1; if (arrived === 2) open(); await opened; };
    };
    const [read, appended, confirmed] = [barrier(), barrier(), barrier()];
    return () => {
      let reads = 0;
      return {
        uidValidity: () => folder.uidValidity(),
        ensureMetaFolder: () => folder.ensureMetaFolder(),
        listClaims: async () => {
          reads += 1;
          const snapshot = await folder.listClaims();
          if (reads === 1) await read();
          if (reads === 2) await confirmed();
          return snapshot;
        },
        appendClaim: async (raw) => { await folder.appendClaim(raw); await appended(); },
        removeClaims: (refs) => folder.removeClaims(refs),
      };
    };
  };

  it.each([["a", "b"], ["b", "a"]] as const)(
    "two joins pressed seconds apart whose first reads both saw an empty folder: the earlier (%s) keeps it, %s yields",
    async (earlier, later) => {
      const folder = new FakeIo();
      const io = lockstep(folder);
      const [re, rl] = await Promise.all([
        pressOn(io(earlier), earlier, "join", ago(5_000), ago(4_900)),
        pressOn(io(later), later, "join", ago(2_000), ago(1_900)),
      ]);
      expect({ earlier: re.verdict.verdict, later: rl.verdict.verdict }, "both presses stood down, or both organize")
        .toEqual({ earlier: "organize", later: "stand_down" });
      expect(rl.verdict).toMatchObject({ by: { installId: earlier } });
      expect(claimsIn(folder).map((c) => c.installId)).toEqual([earlier]);
    });

  /* TWO JOINS, ONE CONFIRMING BEFORE THE OTHER'S CLAIM LANDS: the join whose claim lands second
     sees the first one's in its confirm read, so it waits for that join to press or withdraw. */
  const signal = () => { let fire!: () => void; const p = new Promise<void>((r) => { fire = r; }); return { fire, p }; };
  type Hooks = { [K in "beforeRead" | "afterRead" | "beforeAppend"]?: (n: number) => Promise<void> | void };
  const joinOn = (folder: FakeIo, installId: string, now: Date, hooks: Hooks = {}) => {
    const seen = { reads: 0, appends: 0, sleeps: 0, events: [] as string[] };
    const io: LeaseIo = {
      uidValidity: () => folder.uidValidity(),
      ensureMetaFolder: () => folder.ensureMetaFolder(),
      listClaims: async () => {
        seen.reads += 1;
        await hooks.beforeRead?.(seen.reads);
        const snapshot = await folder.listClaims();
        await hooks.afterRead?.(seen.reads);
        return snapshot;
      },
      appendClaim: async (raw) => { seen.appends += 1; await hooks.beforeAppend?.(seen.appends); await folder.appendClaim(raw); },
      removeClaims: (refs) => folder.removeClaims(refs),
    };
    let minted = 0;
    const run = runLeaseGate({
      capabilities: [], io, self: self({ installId, displayName: installId }), now, newNonce: () => `n-${installId}-${++minted}`,
      takeover: { authorizedAt: new Date(now.getTime() - 500), intent: "join" },
      sleep: async () => { seen.sleeps += 1; await tick(); }, log: (event) => { seen.events.push(event); },
    });
    return { run, seen };
  };

  it.each([["b", "a"], ["a", "b"]] as const)(
    "a join (%s) that confirmed before the other's claim landed keeps the mailbox; the later lander (%s) waits and names it",
    async (lander, waiter) => {
      const folder = new FakeIo();
      const waiterRead = signal(); const landerConfirmed = signal(); const waiterConfirmed = signal();
      /* The waiter starts first (the earlier tenure), reads the empty folder and stalls until the
         lander has confirmed over its own claim alone; the lander's press waits for the waiter's confirm. */
      const w = joinOn(folder, waiter, NOW, {
        afterRead: async (n) => { if (n === 1) { waiterRead.fire(); await landerConfirmed.p; } if (n === 2) waiterConfirmed.fire(); },
      });
      await waiterRead.p;
      const l = joinOn(folder, lander, new Date(NOW.getTime() + 1_000), {
        afterRead: (n) => { if (n === 2) landerConfirmed.fire(); },
        beforeAppend: async (n) => { if (n === 2) await waiterConfirmed.p; },
      });
      const [rw, rl] = await Promise.all([w.run, l.run]);
      expect({ [lander]: rl.verdict.verdict, [waiter]: rw.verdict.verdict }, "both joins organize")
        .toEqual({ [lander]: "organize", [waiter]: "stand_down" });
      expect(rw.verdict).toMatchObject({ by: { installId: lander } });
      expect(claimsIn(folder).map((c) => c.installId)).toEqual([lander]);
      expect(w.seen.sleeps, "the later lander did not wait for the other join").toBeGreaterThan(0);
      expect(w.seen.events).toContain("lease_join_waited");
    });

  it("a join whose press is refused organizes unpressed; the later lander yields to it at the bound", async () => {
    const folder = new FakeIo();
    const waiterRead = signal(); const landerConfirmed = signal(); const waiterConfirmed = signal();
    const w = joinOn(folder, "b", NOW, {
      afterRead: async (n) => { if (n === 1) { waiterRead.fire(); await landerConfirmed.p; } if (n === 2) waiterConfirmed.fire(); },
    });
    await waiterRead.p;
    const l = joinOn(folder, "a", new Date(NOW.getTime() + 1_000), {
      afterRead: (n) => { if (n === 2) landerConfirmed.fire(); },
      beforeAppend: async (n) => { if (n === 2) { await waiterConfirmed.p; throw new Error("NO"); } },
    });
    const [rw, rl] = await Promise.all([w.run, l.run]);
    expect({ a: rl.verdict.verdict, b: rw.verdict.verdict }).toEqual({ a: "organize", b: "stand_down" });
    expect(rw.verdict).toMatchObject({ by: { installId: "a" } });
    expect(w.seen.reads, "election, confirm, then every settle read").toBe(JOIN_SETTLE_READS_MAX + 2);
    expect(claimsIn(folder).map((c) => c.installId)).toEqual(["a"]);
  });

  /** Both read the empty folder; the first lander's claim lands, then the second's, then both confirm. */
  const landInOrder = (folder: FakeIo, first: [string, Date], second: [string, Date]) => {
    const secondRead = signal(); const firstLanded = signal(); const secondLanded = signal();
    const f = joinOn(folder, first[0], first[1], {
      afterRead: async (n) => { if (n === 1) await secondRead.p; },
      beforeRead: async (n) => { if (n === 2) { firstLanded.fire(); await secondLanded.p; } },
    });
    const s = joinOn(folder, second[0], second[1], {
      afterRead: (n) => { if (n === 1) secondRead.fire(); },
      beforeAppend: async (n) => { if (n === 1) await firstLanded.p; },
      beforeRead: (n) => { if (n === 2) secondLanded.fire(); },
    });
    return { f, s };
  };

  it("CONTROL: the earlier lander does not wait on a later join it outranks", async () => {
    const folder = new FakeIo();
    const { f, s } = landInOrder(folder, ["b", ago(1_000)], ["a", NOW]);
    const [rf, rs] = await Promise.all([f.run, s.run]);
    expect({ b: rf.verdict.verdict, a: rs.verdict.verdict }).toEqual({ b: "organize", a: "stand_down" });
    expect({ b: f.seen.sleeps, a: s.seen.sleeps }).toEqual({ b: 0, a: 0 });
    expect(claimsIn(folder).map((c) => c.installId)).toEqual(["b"]);
  });

  it("CONTROL: an earlier lander that is outranked stands down; the other waits once, then organizes", async () => {
    const folder = new FakeIo();
    const { f, s } = landInOrder(folder, ["a", NOW], ["b", ago(1_000)]);
    const [rf, rs] = await Promise.all([f.run, s.run]);
    expect({ a: rf.verdict.verdict, b: rs.verdict.verdict }).toEqual({ a: "stand_down", b: "organize" });
    expect({ a: f.seen.sleeps, b: s.seen.sleeps }).toEqual({ a: 0, b: 1 });
    expect(claimsIn(folder).map((c) => c.installId)).toEqual(["b"]);
  });

  it.each([["a", "b"], ["b", "a"]] as const)(
    "CONTROL: refs nobody can order: exactly one organizes and nothing waits for ever (%s the earlier press)",
    async (earlier, later) => {
      const folder = new FakeIo();
      let uid = 0;
      folder.appendClaim = async (raw: string): Promise<void> => { folder.messages.push({ ref: `uid-${++uid}`, raw }); };
      const io = lockstep(folder);
      const [re, rl] = await Promise.all([
        pressOn(io(earlier), earlier, "join", ago(5_000), ago(4_900)),
        pressOn(io(later), later, "join", ago(2_000), ago(1_900)),
      ]);
      expect({ earlier: re.verdict.verdict, later: rl.verdict.verdict }).toEqual({ earlier: "organize", later: "stand_down" });
      expect(claimsIn(folder).map((c) => c.installId)).toEqual([earlier]);
    });

  it("a holder whose pass lands between a lagging join's append and its confirm keeps organizing", async () => {
    const io = missesFirst(new FakeIo(), (m) => m.ref === 53);
    io.messages.push(selfHostClaim());
    const append = io.appendClaim.bind(io);
    let holder = "";
    io.appendClaim = async (raw: string): Promise<void> => {
      await append(raw);
      io.appendClaim = append;
      holder = (await runLeaseGate({
        capabilities: ["requests"], io, now: new Date(NOW.getTime() + 500), newNonce: () => "sh2",
        self: { installId: "cloud:selfhost", kind: "cloud", displayName: "localhost:6080", lastNonce: "sh" },
      })).verdict.verdict;
    };
    const res = await pressOn(io, "desktop", "join", NOW);
    expect(holder, "the holder stood down to a join that had not confirmed yet").toBe("organize");
    expect(res.verdict).toMatchObject({ verdict: "stand_down", by: { installId: "cloud:selfhost" } });
    expect(claimsIn(io).map((c) => c.installId)).toEqual(["cloud:selfhost"]);
  });

  it("a join yields to a renewing holder whose clock runs ahead of its own", async () => {
    const io = missesFirst(new FakeIo(), (m) => m.ref === 54);
    io.messages.push({
      ref: 54,
      raw: formatClaim({
        installId: "their-mac", kind: "local", displayName: "Their Mac",
        heartbeat: new Date(NOW.getTime() + 115_000), claimedAt: new Date(NOW.getTime() + 90_000),
        nonce: "tm", authorizedAt: null, intent: "join", capabilities: [],
      }),
    });
    const res = await pressOn(io, "desktop", "join", NOW);
    expect(res.verdict, "a join took a renewing holder's mailbox")
      .toMatchObject({ verdict: "stand_down", by: { installId: "their-mac" } });
    expect(claimsIn(io).map((c) => c.installId)).toEqual(["their-mac"]);
  });

  it("a join's first claim carries no press and starts its own tenure; the claim its confirm leaves carries the press", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 60, raw: formatClaim({
      installId: "desktop", kind: "local", displayName: "desktop", heartbeat: ago(30 * 60_000),
      claimedAt: ago(2 * 3_600_000), nonce: "old", authorizedAt: null, capabilities: [],
    }) });
    io.messages.push({ ref: 61, raw: formatClaim({
      installId: "gone", kind: "local", displayName: "Gone", heartbeat: ago(30 * 60_000),
      claimedAt: ago(3 * 3_600_000), nonce: "g", authorizedAt: null, capabilities: [],
    }) });
    expect((await pressOn(io, "desktop", "join", ago(1_000))).verdict).toMatchObject({ verdict: "organize", authorized: true });
    const [first, pressed] = io.appended.map((raw) => parseClaim(raw) as OrganizerClaim);
    expect({ press: first!.authorizedAt, since: first!.claimedAt.toISOString() })
      .toEqual({ press: null, since: NOW.toISOString() });
    const holder = claim({ installId: "their-mac", nonce: "tm", claimedAt: ago(3_600_000) });
    expect(decideLease({ self: self({ installId: "their-mac", lastNonce: "tm" }), claims: [holder, first!], now: NOW }).verdict,
      "a holder whose pass reads the join's first claim stands down to it").toBe("organize");
    expect({ press: pressed?.authorizedAt?.toISOString(), since: pressed?.claimedAt.toISOString() },
      "the confirmed join's claim carries no press").toEqual({ press: ago(1_000).toISOString(), since: NOW.toISOString() });
    expect(claimsIn(io).map((c) => c.authorizedAt?.toISOString() ?? null), "the first claim stayed beside the pressed one")
      .toEqual([ago(1_000).toISOString()]);
  });

  /* AN OLDER PRESS NEVER REVERSES A NEWER ONE (0.14.1): "Organize here instead" pressed an hour ago on
     a laptop whose server did not answer stays on its row, unspent; the person then agrees on the
     desktop over a free folder. */
  it("an older takeover press still unspent elsewhere stands down to a confirmed join, which keeps organizing", async () => {
    const folder = new FakeIo();
    expect((await pressOn(folder, "desktop-b", "join", ago(60_000))).verdict.verdict).toBe("organize");
    const stale = await pressOn(folder, "laptop-l", "takeover", ago(3_600_000), new Date(NOW.getTime() + 30_000));
    expect(stale.verdict, "the hour-old press took the mailbox from the newer Agree")
      .toMatchObject({ verdict: "stand_down", by: { installId: "desktop-b" } });
    const next = await runLeaseGate({
      capabilities: [], io: folder, now: new Date(NOW.getTime() + 60_000), newNonce: () => "n-desktop-b-2",
      self: self({ installId: "desktop-b", displayName: "desktop-b", lastNonce: "n-desktop-b" }),
    });
    expect(next.verdict.verdict).toBe("organize");
    expect(claimsIn(folder).map((c) => c.installId)).toEqual(["desktop-b"]);
  });

  it("CONTROL: a takeover press newer than the join's Agree still takes the mailbox", async () => {
    const folder = new FakeIo();
    expect((await pressOn(folder, "desktop-b", "join", ago(60_000))).verdict.verdict).toBe("organize");
    const newer = await pressOn(folder, "laptop-l", "takeover", ago(10_000), new Date(NOW.getTime() + 30_000));
    expect(newer.verdict.verdict).toBe("organize");
    expect(claimsIn(folder).map((c) => c.installId)).toEqual(["laptop-l"]);
  });

  /* A server that refuses the cleanup leaves both claims; the renewal must read the pressed one. */
  it("a join's renewal carries the press even when its first claim could not be removed", async () => {
    const io = new FakeIo();
    const remove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => { await remove(refs.filter((r) => r !== 1)); };
    let minted = 0;
    const won = await runLeaseGate({
      capabilities: [], io, self: self({ installId: "desktop", displayName: "desktop" }), now: NOW,
      newNonce: () => `n-${++minted}`, takeover: { authorizedAt: ago(1_000), intent: "join" },
    });
    expect(won.verdict.verdict).toBe("organize");
    const renewed = await runLeaseGate({
      capabilities: [], io, now: new Date(NOW.getTime() + 60_000), newNonce: () => "n-renew",
      self: self({ installId: "desktop", displayName: "desktop", lastNonce: won.nonce, mintedNonces: ["n-1", "n-2"] }),
    });
    expect(renewed.verdict.verdict).toBe("organize");
    expect(claimsIn(io).find((c) => c.nonce === "n-renew")?.authorizedAt?.toISOString(),
      "the renewal read the unpressed first claim").toBe(ago(1_000).toISOString());
  });

  it("a confirmed join whose pressed write is refused still organizes on its first claim, and says so", async () => {
    const io = new FakeIo();
    const append = io.appendClaim.bind(io);
    let appends = 0;
    io.appendClaim = async (raw: string): Promise<void> => {
      appends += 1;
      if (appends === 2) throw new Error("NO");
      await append(raw);
    };
    let minted = 0;
    const events: string[] = [];
    const res = await runLeaseGate({
      capabilities: [], io, self: self({ installId: "desktop", displayName: "desktop" }), now: NOW,
      newNonce: () => `n-${++minted}`, takeover: { authorizedAt: ago(1_000), intent: "join" },
      log: (event) => { events.push(event); },
    });
    expect(res.verdict.verdict).toBe("organize");
    expect(res.nonce).toBe("n-1");
    expect(claimsIn(io).map((c) => c.nonce)).toEqual(["n-1"]);
    expect(events).toContain("lease_join_press_failed");
  });

  /* A GATE STOPPED BETWEEN THE TWO WRITES (the process ended, the connection dropped) leaves the
     first claim and the press, unspent, on the row: the next pass finishes the join. */
  it("a join tenure an interrupted gate left unpressed takes its press on the next pass that offers it", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 70, raw: formatClaim({
      installId: "desktop", kind: "local", displayName: "desktop", heartbeat: ago(30_000), claimedAt: ago(30_000),
      nonce: "first", authorizedAt: null, intent: "join", capabilities: [],
    }) });
    let minted = 0;
    const res = await runLeaseGate({
      capabilities: [], io, self: self({ installId: "desktop", displayName: "desktop" }), now: NOW,
      newNonce: () => `n-${++minted}`, takeover: { authorizedAt: ago(40_000), intent: "join" },
    });
    expect(res.verdict).toMatchObject({ verdict: "organize", authorized: false });
    expect(claimsIn(io).map((c) => ({ press: c.authorizedAt?.toISOString() ?? null, since: c.claimedAt.toISOString() })),
      "the tenure stayed unpressed").toEqual([{ press: ago(40_000).toISOString(), since: ago(30_000).toISOString() }]);
    expect(res.nonce).toBe(claimsIn(io)[0]!.nonce);
  });

  it("CONTROL: a renewal with no press outstanding writes once and carries what its tenure holds", async () => {
    const io = new FakeIo();
    io.messages.push({ ref: 70, raw: formatClaim({
      installId: "desktop", kind: "local", displayName: "desktop", heartbeat: ago(30_000), claimedAt: ago(30_000),
      nonce: "first", authorizedAt: null, intent: "join", capabilities: [],
    }) });
    await runLeaseGate({
      capabilities: [], io, self: self({ installId: "desktop", displayName: "desktop", lastNonce: "first" }), now: NOW,
      newNonce: () => "n-1",
    });
    expect(io.appended).toHaveLength(1);
    expect(claimsIn(io).map((c) => c.authorizedAt)).toEqual([null]);
  });
});

/**
 * ── THE AUTHORIZED TAKEOVER MUST SURVIVE ITS OWN CONFIRM ────────────────────────────────────
 *
 * The gate's append-then-verify re-runs the election over what the folder actually holds, and
 * it deliberately does NOT re-offer the authorization ("one click must not win an unbounded
 * number of contests"). What the verify must ALSO not do is re-count the claims the authorized
 * decision already beat: those refs are slated for displacement, and an election that still
 * ranks them re-elects the incumbent on incumbency — so an authorized takeover of a LIVE
 * equal-kind organizer (a self-hosted server taking a mailbox over from the hosted service, or
 * handing it back) loses its own confirm, releases, and re-disables the mailbox it was just
 * authorized to organize. Measured live on 2026-08-28: the self-host "organize here" verb spent
 * its authorization, lost the race to the managed claim it had itself displaced, and the mailbox
 * went straight back to `organized_elsewhere:cloud` — an action that appears to do nothing, at
 * exactly the moment somebody chose to leave.
 *
 * The confirm's job is narrower than "did anything change": it exists to catch a CONCURRENT
 * newcomer — a claim that was NOT in the read the decision ranked. The tests below pin both
 * halves: the displaced incumbent cannot veto the win, and a genuinely new claim still can.
 */
describe("runLeaseGate — authorized takeover of a live equal-kind incumbent", () => {
  const incumbent = (): RawClaimMessage => ({
    // A ref the FakeIo's own append counter (which starts at 1) can never mint again — a
    // colliding ref would make the win's expunge of the displaced ref take our claim with it.
    ref: 101,
    raw: formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: ago(30_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed",
    }),
  });
  const selfHosted = (): LeaseSelf =>
    self({ installId: "ohmail-selfhost:box", kind: "cloud", displayName: "ohmail Cloud" });

  it("wins the gate and the folder records the handover", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("organize");
    expect(res.nonce).toBe("n-us");
    // The handover is recorded in the shared medium: the incumbent's claim is gone and exactly
    // our claim remains — which is what makes the incumbent's own next read a stand-down.
    const left = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(left).toHaveLength(1);
    expect(left[0]!.installId).toBe("ohmail-selfhost:box");
  });

  /**
   * —— AND NOT WHEN THE SERVER WILL NOT NAME THE FOLDER'S GENERATION —————————————————
   *
   * `ORGANIZER-LEASE-READS-AN-UNNAMED-EPOCH-AS-NO-CHANGE`. The confirm proves a handover by
   * comparing REFS between two reads, and a ref is a uid — which means something only inside one
   * UIDVALIDITY. With no generation named, "the displaced claim is absent" and "I am reading a
   * folder that may have been renumbered under me" are the same observation, and the gate used to
   * take the first reading. It is could-not-look now: no confirmation, no stand-down, our own
   * claim withdrawn, and the press survives for the next pass.
   *
   * The contrast with the row above is the whole control: same folder, same incumbent, same
   * press — one field on the connection decides.
   */
  it("does not confirm the handover when the connection names no generation", async () => {
    const io = new FakeIo();
    io.generation = null;
    io.messages.push(incumbent());

    const err = await runLeaseGate({
      capabilities: [], io, self: selfHosted(), now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us",
    }).catch((e: unknown) => e);

    expect(err, "a handover confirmed on a folder whose numbering nobody vouched for")
      .toBeInstanceOf(LeaseUnavailableError);
    expect((err as LeaseUnavailableError).op).toBe("remove_claims");
    // Our claim is withdrawn, so the retry does not find a claim of ours standing under a
    // takeover that was refused — and nothing here is a stand-down.
    const left = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(left.filter((c) => c.installId === "ohmail-selfhost:box")).toHaveLength(0);
  });

  /**
   * The ceiling stays: a claim that landed AFTER the decision's read — so never ranked, never
   * displaced — still refuses the win. Only the already-beaten are excluded from the confirm.
   *
   * ── WHAT MAKES A NEWCOMER STRONGER CHANGED IN 0.14.1, AND THE GUARD DID NOT ────────────────
   *
   * This row used to hand the newcomer an older `claimedAt` and rely on incumbency. Incumbency is
   * now the SECOND term: a newcomer nobody pressed for cannot outrank a claim somebody did, and
   * the row below pins that half. So the veto is exercised with the thing that actually outranks
   * a press — a NEWER press, which is a second human on a second machine, eight seconds later.
   * The mechanism under test is unchanged: a claim the decision never ranked is not excluded from
   * the confirm, and it still takes the mailbox away from us.
   */
  it("still loses to a concurrent newcomer the decision never ranked", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainAppend = io.appendClaim.bind(io);
    let raced = false;
    io.appendClaim = async (raw: string): Promise<void> => {
      await plainAppend(raw);
      if (!raced) {
        raced = true;
        // A third organizer's claim lands between our append and our verify read, carrying a press
        // EIGHT SECONDS NEWER than ours — the two-press race, arriving inside one gate.
        await plainAppend(formatClaim({
          authorizedAt: new Date(NOW.getTime() + 8_000), capabilities: [],
          installId: "ohmail-selfhost:other", kind: "cloud", displayName: "ohmail Cloud",
          heartbeat: NOW, claimedAt: ago(3_600_000), nonce: "n-other",
        }));
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("stand_down");
    expect(res.nonce).toBeNull();
    // We released our own claim; the newcomer's stands. (The incumbent's original claim also
    // still stands — the displacement belongs to the win that did not happen.)
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).not.toContain("ohmail-selfhost:box");
    expect(ids).toContain("ohmail-selfhost:other");
  });

  /**
   * THE OTHER HALF, AND IT IS THE RELEASE ITSELF (0.14.1).
   *
   * The same race with an UNPRESSED newcomer — an ordinary organizer arriving, however old its
   * tenure — and the press wins. Before 0.14.1 this was a stand-down: the newcomer's older
   * `claimedAt` beat us on incumbency, so a press could be vetoed by a machine nobody had asked
   * for anything. That is the shape the whole release exists to remove, and it is the shape a
   * well-meaning "restore the incumbency check" would put back.
   *
   * The convergence is symmetric and needs no retry: the newcomer's own next gate reads the same
   * folder, ranks our press above its unpressed claim by the same function, and stands down.
   */
  it("wins over a concurrent newcomer that carries no press", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainAppend = io.appendClaim.bind(io);
    let raced = false;
    io.appendClaim = async (raw: string): Promise<void> => {
      await plainAppend(raw);
      if (!raced) {
        raced = true;
        await plainAppend(formatClaim({
          authorizedAt: null, capabilities: [],
          installId: "ohmail-selfhost:other", kind: "cloud", displayName: "ohmail Cloud",
          heartbeat: NOW, claimedAt: ago(3_600_000), nonce: "n-other",
        }));
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("organize");
    expect(res.nonce).toBe("n-us");
    // OUR claim carries the press forward, which is what makes the newcomer's next election agree.
    const ours = io.messages
      .map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim)
      .find((c) => c.installId === "ohmail-selfhost:box");
    expect(ours?.authorizedAt?.toISOString()).toBe(NOW.toISOString());
  });

  /**
   * The incumbent's append-then-expunge CRASH RESIDUE — two claims, one install — is displaced
   * whole. The displacement is built from the RAW read, not the coalesced election: a
   * displacement that takes only the coalesced winner leaves the older residue copy in the
   * folder, and the verify then loses to a message the incumbent itself was going to clean up.
   * (Found by review probing, 2026-08-28 — the drill's live incumbent happened to be clean.)
   */
  it("wins over an incumbent whose crash residue left TWO claims, and displaces both", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    io.messages.push({
      ref: 102,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(20_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed-renewed",
      }),
    });

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("organize");
    const left = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(left).toHaveLength(1);
    expect(left[0]!.installId).toBe("ohmail-selfhost:box");
  });

  /**
   * The gate's verify must find the claim it just wrote. A folder that no longer holds it means
   * something with delete rights acted between the append and the read — a restored clone
   * releasing every claim under our id, a takeover racing ours — and without this guard the
   * displaced-ref exclusion could hand the election an EMPTY set, whose verdict is `organize`:
   * the gate would expunge the incumbent and proceed with NO standing claim, which is unleased
   * organizing. (Review finding, round 2.)
   */
  it("does not confirm a win when its own just-appended claim has vanished", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainList = io.listClaims.bind(io);
    let reads = 0;
    io.listClaims = async (): Promise<RawClaimMessage[]> => {
      const out = await plainList();
      reads += 1;
      // The verify read: our own claim is already gone — somebody expunged it under us.
      if (reads === 2) return out.filter((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim | null)?.nonce !== "n-us");
      return out;
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).not.toBe("organize");
    expect(res.nonce).toBeNull();
    // The verdict still names WHO stands — the surviving incumbent, not an anonymous
    // `available` — so the row the worker writes says "held by ohmail Cloud", truthfully.
    expect(res.verdict).toMatchObject({ verdict: "stand_down", by: { installId: "ohmail-cloud:production" } });
    // The incumbent's claim was NOT expunged — a loss must not displace anything.
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).toContain("ohmail-cloud:production");
  });

  /**
   * …and when the folder came back EMPTY — or holding nothing but our own claims — the write
   * was LOST, which is an IO fault to retry, never a win and never a durable stand-down. The
   * renew shape is the one that bit in review: the folder still holds our PRIOR claim (its
   * nonce IS `self.lastNonce`), and a survivors election armed with the VANISHED nonce would
   * read that prior claim as a live clone of ourselves — a self-stand-down, written durably,
   * while our own claim keeps every peer out. (Review finding, round 6.)
   */
  it("treats a vanished append as a retryable lost write when nothing foreign stands", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainList = io.listClaims.bind(io);
    let reads = 0;
    io.listClaims = async (): Promise<RawClaimMessage[]> => {
      await plainList();
      reads += 1;
      return reads === 2 ? [] : plainList();
    };

    await expect(
      runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
  });

  it("a renew whose append vanished retries — it does not stand itself down over its own prior claim", async () => {
    const io = new FakeIo();
    io.messages.push({
      ref: 101,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-selfhost:box", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(30_000), claimedAt: ago(3_600_000), nonce: "n-prev",
      }),
    });
    const plainList = io.listClaims.bind(io);
    let reads = 0;
    io.listClaims = async (): Promise<RawClaimMessage[]> => {
      const out = await plainList();
      reads += 1;
      // The verify read: the just-appended claim is gone; the prior own claim remains.
      if (reads === 2) return out.filter((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim | null)?.nonce !== "n-new");
      return out;
    };

    await expect(
      runLeaseGate({
      capabilities: [],
        io, self: { ...selfHosted(), lastNonce: "n-prev" }, now: NOW, newNonce: () => "n-new",
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    // The prior claim was NOT released — this is a retry, not a stand-down.
    const nonces = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).nonce);
    expect(nonces).toContain("n-prev");
  });

  /**
   * A verify READ that fails after the displacement may follow a handover that fully landed:
   * rolling our claim back on it could leave the folder with NO claim after a successful
   * displacement, handing the mailbox to whoever returns first. So the read fault throws as a
   * read fault, and rolls nothing back. (Review finding, round 6.)
   */
  it("a failed post-handover re-read throws without rolling the new claim back", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainList = io.listClaims.bind(io);
    let reads = 0;
    io.listClaims = async (): Promise<RawClaimMessage[]> => {
      reads += 1;
      if (reads === 3) throw new Error("NO");
      return plainList();
    };

    await expect(
      runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    // Displacement landed and our claim STANDS — the read fault must not undo the handover.
    const left = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(left).toHaveLength(1);
    expect(left[0]!.installId).toBe("ohmail-selfhost:box");
  });

  /**
   * A handover that did not land is not a win: when the DISPLACED claim cannot be expunged, the
   * beaten incumbent still stands and the next ordinary election reverses the takeover on
   * incumbency — so the gate throws the retryable lease fault instead of confirming, and the
   * caller's one-shot authorization is not spent on a verdict that never held. An ordinary
   * renew's failed cleanup stays harmless (readers coalesce own duplicates); only the takeover's
   * displacement is load-bearing. (Review finding, round 2.)
   */
  it("throws rather than confirming a takeover whose displacement could not be written", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      if (refs.includes(101)) throw new Error("NO");
      await plainRemove(refs);
    };

    await expect(
      runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);

    // The gate rolled its OWN appended claim back before throwing, so the retry re-enters the
    // folder as it found it. Left standing, our fresh claim would win the NEXT gate outright
    // against a weaker incumbent — continuation, empty displace — and the displacement this
    // cycle still owes would never be attempted again.
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).toEqual(["ohmail-cloud:production"]);
  });

  /**
   * A removal that RESOLVES without removing — imapflow's `messageDelete` is STORE-then-EXPUNGE
   * and returns the EXPUNGE's verdict, so a refused STORE under a no-op EXPUNGE reads as done —
   * must not confirm the takeover either: the win path re-reads the folder and requires every
   * displaced ref to actually be gone. (Review finding, round 5.)
   */
  it("throws when the displaced claim survived a removal that claimed success", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      // Silently keep the incumbent's message: acknowledge, remove everything else.
      await plainRemove(refs.filter((r) => r !== 101));
    };

    await expect(
      runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    // The incumbent's claim stands (the fake kept it); the win was refused, not declared.
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).toContain("ohmail-cloud:production");
  });

  /**
   * The removal's outcome is judged by CUSTODY, not by what the driver reported: a rejected
   * expunge can follow a STORE that already landed (the incumbent is in fact gone), and a
   * resolved one can have removed nothing. The gate re-reads and believes the folder — so a
   * throw whose effect actually landed still confirms the win. (Review finding, round 7.)
   */
  it("confirms the win when the removal THREW but the re-read shows the handover landed", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      // The partial: the displaced message actually goes, then the driver reports failure.
      await plainRemove(refs);
      throw new Error("EXPUNGE grumbled after the fact");
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });
    expect(res.verdict.verdict).toBe("organize");
    const left = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(left).toHaveLength(1);
    expect(left[0]!.installId).toBe("ohmail-selfhost:box");
  });

  /**
   * The post-handover re-read must also find OUR claim standing — a shared EXPUNGE on a
   * non-UIDPLUS server, or a racing release under our id, can take the claim this gate just
   * wrote along with the displaced ones. An empty folder then must not read as a win: the gate
   * holds nothing. (Review finding, round 7.)
   */
  it("does not confirm when the handover cleanup took its own claim with it", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      // The shared-expunge overreach: everything flagged goes, ours included.
      await plainRemove(refs);
      io.messages = [];
    };

    await expect(
      runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
  });

  /**
   * The displaced refs being gone is necessary, not sufficient: an incumbent that RENEWED
   * between the verify and the cleanup wrote a message the displace list never named. The final
   * election over what actually stands catches it — our claim is released, and the loss is
   * reported as held-by-them. (Review finding, round 8.)
   *
   * ── 0.14.1: THE RENEWAL HAS TO CARRY A PRESS TO VETO ──────────────────────────────────────
   *
   * This row used to give the renewal a bare fresh heartbeat and expect a stand-down, on the old
   * reading that "the renewal is proof of an actively live peer, so it wins". Liveness is no
   * longer authority — that sentence WAS rule 5, in the final election rather than in the decision
   * table — so a renewal nobody pressed for now loses to a press, which is the release. The
   * mechanism this row exists for is untouched and still tested here: a claim the displace list
   * never named is included in the final election and can still take the mailbox away, and what it
   * needs in order to do so is a NEWER PRESS. The unpressed case is the row below.
   */
  it("does not confirm over an incumbent that renewed during the cleanup", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    let renewed = false;
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      await plainRemove(refs);
      if (!renewed && refs.includes(101)) {
        renewed = true;
        // The incumbent's renewal lands mid-cleanup: a NEW message, fresh heartbeat, its
        // incumbency carried forward.
        io.messages.push({
          ref: 202,
          raw: formatClaim({
            // A press of their own, four seconds after ours — somebody pressed on the managed side
            // while our gate was mid-cleanup. That is what outranks a press.
            authorizedAt: new Date(NOW.getTime() + 4_000), capabilities: [],
            installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
            heartbeat: NOW, claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed-3",
          }),
        });
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });
    expect(res.verdict).toMatchObject({ verdict: "stand_down", by: { installId: "ohmail-cloud:production" } });
    expect(res.nonce).toBeNull();
    // Ours released; the renewed incumbent stands alone.
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).toEqual(["ohmail-cloud:production"]);
  });

  /**
   * Rules 1/2 hold over the RAW list too: a LIVE record the election cannot rank — here a
   * higher-protocol duplicate that coalesce dropped for its newer, rankable sibling — is never
   * displaced by an authorization, and the gate's verify then refuses the win on rule 1. "No
   * authorization overrides what we cannot read" must not be reachable around via a duplicate.
   * (Review finding, round 9.)
   */
  it("never expunges a live higher-protocol record, and the takeover self-defeats on it", async () => {
    const io = new FakeIo();
    // The same foreign install left two records: the OLDER one speaks a protocol above ours...
    io.messages.push({
      ref: 101,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(60_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-old",
        protocol: CLAIM_PROTOCOL + 1,
      }),
    });
    // …and the newer one is rankable, so the coalesced election never trips rule 1.
    io.messages.push({
      ref: 102,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(30_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-new",
      }),
    });

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).not.toBe("organize");
    expect(res.nonce).toBeNull();
    // The record we cannot rank is still there — an authorization never expunged it.
    const kept = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(kept.some((c) => c.protocol === CLAIM_PROTOCOL + 1)).toBe(true);
  });

  /**
   * The same protection at the FINAL read: a new install's two records land during the cleanup
   * — a higher-protocol record behind a rankable sibling whose `claimedAt` loses to ours. An
   * election that only saw the coalesced sibling would confirm the win over a live claim in a
   * format we cannot read; rule 1's raw scan inside `decideLease` refuses it at every read,
   * this one included. (Review finding, round 10.)
   */
  it("does not confirm while a live higher-protocol record hides behind a losing sibling", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainRemove = io.removeClaims.bind(io);
    let raced = false;
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      await plainRemove(refs);
      if (!raced && refs.includes(101)) {
        raced = true;
        await io.appendClaim(formatClaim({
          authorizedAt: null, capabilities: [],
          installId: "ohmail-next:box", kind: "cloud", displayName: "ohmail",
          heartbeat: ago(10_000), claimedAt: new Date(NOW.getTime() + 1_000), nonce: "n-x1",
          protocol: CLAIM_PROTOCOL + 1,
        }));
        await io.appendClaim(formatClaim({
          authorizedAt: null, capabilities: [],
          installId: "ohmail-next:box", kind: "cloud", displayName: "ohmail",
          heartbeat: NOW, claimedAt: new Date(NOW.getTime() + 2_000), nonce: "n-x2",
        }));
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).not.toBe("organize");
    const kept = io.messages.map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim);
    expect(kept.some((c) => c.protocol === CLAIM_PROTOCOL + 1)).toBe(true);
  });

  it("still treats an ordinary renew's failed cleanup as harmless", async () => {
    const io = new FakeIo();
    io.messages.push({
      ref: 101,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-selfhost:box", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(30_000), claimedAt: ago(3_600_000), nonce: "n-old",
      }),
    });
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      if (refs.includes(101)) throw new Error("NO");
      await plainRemove(refs);
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, newNonce: () => "n-new" });
    expect(res.verdict.verdict).toBe("organize");
  });

  /**
   * The exclusion is BY REF, not by install id: an incumbent that RENEWED mid-gate wrote a claim
   * the decision never ranked, so it is in the verify's election even though its predecessor was
   * displaced. What that claim then needs in order to WIN is the 0.14.1 question — and the answer
   * is a press of its own, newer than ours. Here the person pressed on the managed side five
   * seconds after pressing on the self-hosted one, and the later decision is the one that holds.
   */
  it("still loses to an incumbent whose renewal carries a newer press", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainAppend = io.appendClaim.bind(io);
    let raced = false;
    io.appendClaim = async (raw: string): Promise<void> => {
      await plainAppend(raw);
      if (!raced) {
        raced = true;
        // The incumbent's renew: same install, NEW message (new ref), fresh heartbeat, its
        // incumbency carried forward — and a press five seconds after ours.
        await plainAppend(formatClaim({
          authorizedAt: new Date(NOW.getTime() + 5_000), capabilities: [],
          installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
          heartbeat: NOW, claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed-2",
        }));
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("stand_down");
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).not.toContain("ohmail-selfhost:box");
    expect(ids).toContain("ohmail-cloud:production");
  });

  /**
   * AND THE SAME RACE WITH A BARE RENEWAL IS A WIN (0.14.1) — the release, at the gate.
   *
   * This is the sentence the release deletes, stated as a row so that restoring it fails here:
   * *"the renewal is proof of an actively live peer, so the press retries rather than steamrolling
   * a live renewal."* A live renewal is proof the peer is alive and proof of nothing else. The
   * person losing access to the machine that renewal comes from is the whole reason 0.14.1 exists,
   * and under the old rule their press could be refused by it for ever — the incumbent renews
   * every cycle by construction, so the retry never ended.
   *
   * Convergence is still one cycle each side and still needs no coordination: the incumbent's own
   * next gate reads our pressed claim beside its unpressed one and stands down.
   */
  /**
   * ── THE PRESS SURVIVES A PARTIAL EXPUNGE (review finding, 0.14.1) ────────────────────────
   *
   * The stamp a renewal carries forward comes from the NEWEST of our own claims, not from
   * `priorOwn` — which is the OLDEST by `claimedAt` and is right only for the incumbency clock.
   * Because `claimedAt` is itself carried forward, a pre-press claim and the post-press claim share
   * one, the sort is a tie, and IMAP uid order decides: the older residue wins and the renewal
   * writes no stamp at all.
   *
   * The residue is reachable exactly where this module already refuses to trust a driver's answer:
   * `removeClaims` is STORE-then-EXPUNGE, so it can apply for one ref and be refused for another,
   * and the handover verification asks only whether the DISPLACED refs are gone and our new nonce
   * survived — never whether our own older refs went with them. Here the fake keeps our old claim
   * and takes the incumbent's, which is the half that makes the takeover succeed.
   *
   * One cycle later the tenure a person authorized would rank as unpressed and lose to any rival
   * with any stamp: the self-reversal `OrganizeVerdict.displace` exists to prevent, reached through
   * the field added to prevent it.
   */
  it("carries the press forward from the NEWEST own claim, not the oldest", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    // Our own OLDER claim, from before the press: same install, same carried `claimedAt`, no stamp.
    io.messages.push({
      ref: 55,
      raw: formatClaim({
        authorizedAt: null, capabilities: [],
        installId: "ohmail-selfhost:box", kind: "cloud", displayName: "ohmail Cloud",
        heartbeat: ago(30_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-before-the-press",
      }),
    });
    // The cleanup takes the incumbent and is refused for our own residue — the partial this
    // module's own comments say a driver's verdict cannot distinguish.
    const plainRemove = io.removeClaims.bind(io);
    io.removeClaims = async (refs: readonly unknown[]): Promise<void> => {
      await plainRemove(refs.filter((r) => r !== 55));
    };

    const won = await runLeaseGate({
      capabilities: [], io, self: selfHosted(), now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us",
    });
    expect(won.verdict.verdict).toBe("organize");
    expect(io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).nonce))
      .toContain("n-before-the-press");

    // THE NEXT CYCLE — an ordinary renew, no press outstanding. It must still carry the stamp.
    const later = new Date(NOW.getTime() + 60_000);
    const renewed = await runLeaseGate({
      capabilities: [], io, self: { ...selfHosted(), lastNonce: "n-us" }, now: later,
      newNonce: () => "n-renew",
    });
    expect(renewed.verdict.verdict).toBe("organize");
    const fresh = io.messages
      .map((m) => parseClaim(m.raw, m.ref) as OrganizerClaim)
      .find((c) => c.nonce === "n-renew");
    expect(fresh?.authorizedAt?.toISOString(),
      "the renewal read the pre-press residue and dropped the authorization — the takeover reverses "
      + "itself on the next election").toBe(NOW.toISOString());
  });

  /**
   * ── AN EMPTY FOLDER STAMPS THE PRESS IT ACTED ON (review finding, 0.14.1) ────────────────
   *
   * Arm 4 has nothing to displace, so `authorized` looked like it should be false — and the caller
   * spends the row's stamp on the win regardless. That pair inverts the order the release is built
   * on: an older press, made on a machine that was asleep and never ran a gate, later beats the
   * newer press whose arm-4 tenure was recorded as unpressed. The decide-table row states the
   * sequence; this is the same property at the gate, against the bytes in the folder.
   */
  it.each(["takeover", "join"] as const)("an EMPTY folder stamps the %s press, so a staler one cannot beat it afterwards", async (intent) => {
    const io = new FakeIo();
    const pressedAt = new Date(NOW.getTime() - 5_000);
    let minted = 0;
    const res = await runLeaseGate({
      capabilities: [], io, self: selfHosted(), now: NOW,
      takeover: { authorizedAt: pressedAt, intent }, newNonce: () => `n-us-${++minted}`,
    });
    expect(res.verdict.verdict).toBe("organize");
    expect(io.messages, "the folder holds more than the one claim of ours").toHaveLength(1);
    const written = parseClaim(io.messages[0]!.raw, io.messages[0]!.ref) as OrganizerClaim;
    expect(written.authorizedAt?.toISOString(),
      "an arm-4 win recorded no press, so an OLDER decision can reverse this one")
      .toBe(pressedAt.toISOString());
    expect(res.nonce, "the gate handed back another claim's nonce").toBe(written.nonce);

    // And the older press really does lose against it, from the other install's side.
    const older = decideLease({
      self: self({ installId: "somebody-else" }),
      claims: [written],
      now: NOW,
      takeover: { authorizedAt: new Date(NOW.getTime() - 3_600_000), intent: "takeover" },
    });
    expect(older.verdict).toBe("stand_down");
  });

  /** An arm-4 win with NO press outstanding still writes no stamp — the common case. */
  it("an empty folder with nobody pressing writes an unstamped claim", async () => {
    const io = new FakeIo();
    const res = await runLeaseGate({
      capabilities: [], io, self: selfHosted(), now: NOW, newNonce: () => "n-us",
    });
    expect(res.verdict.verdict).toBe("organize");
    expect((parseClaim(io.messages[0]!.raw, io.messages[0]!.ref) as OrganizerClaim).authorizedAt)
      .toBeNull();
  });

  it("wins over an incumbent whose renewal carries no press", async () => {
    const io = new FakeIo();
    io.messages.push(incumbent());
    const plainAppend = io.appendClaim.bind(io);
    let raced = false;
    io.appendClaim = async (raw: string): Promise<void> => {
      await plainAppend(raw);
      if (!raced) {
        raced = true;
        await plainAppend(formatClaim({
          authorizedAt: null, capabilities: [],
          installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
          heartbeat: NOW, claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed-2",
        }));
      }
    };

    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" }, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("organize");
    const ids = io.messages.map((m) => (parseClaim(m.raw, m.ref) as OrganizerClaim).installId);
    expect(ids).toContain("ohmail-selfhost:box");
  });
});

// ── makeLeaseIo, against a structural fake client ───────────────────────────────────────────

function fakeClient(over: Partial<LeaseImapClient> = {}): LeaseImapClient & { created: string[]; unsubscribed: string[] } {
  const created: string[] = [];
  const unsubscribed: string[] = [];
  const base: LeaseImapClient = {
    async list() { return []; },
    async mailboxCreate(p) { created.push(p); return {}; },
    async mailboxUnsubscribe(p) { unsubscribed.push(p); return true; },
    async getMailboxLock() { return { release() { /* no-op */ } }; },
    fetch(): AsyncIterableIterator<{ uid: number; headers?: Buffer }> {
      return (async function* () { /* empty */ })();
    },
    async append() { return {}; },
    async messageDelete() { return true; },
    ...over,
  };
  return Object.assign(base, { created, unsubscribed });
}

describe("makeLeaseIo — the delimiter and the subscription", () => {
  /**
   * `.` is what GreenMail uses and `/` is what Dovecot uses, so the folder name must be mapped
   * through the adapter's own `toServerPath` rather than spelled a second time here. A lease
   * written to a literally-named `ohmail/_meta` on a dot-delimited server creates a TOP-LEVEL
   * folder with a slash in its name, which the other install never finds — two organizers, and
   * a folder tree with a stray entry in it.
   */
  it("maps the folder through toServerPath for a dot-delimited server", async () => {
    const client = fakeClient();
    const io = makeLeaseIo(client, (c) => c.split("/").join("."), TEST_META_ID);
    await io.ensureMetaFolder();
    expect(client.created).toEqual(["ohmail._meta"]);
  });

  /**
   * THE PRODUCTION BUG THIS SUITE COULD NOT SEE — a fresh mailbox was unorganizable.
   *
   * `ensureMetaFolder()` creates `_meta` one line before `listClaims()` reads it, so on a first
   * attach the FETCH always runs against ZERO messages. `1:*` is not a valid messageset for an
   * empty mailbox: GreenMail answers an empty set, and **Dovecot refuses the command** —
   * measured against `copernicus.sui-inter.net`:
   *
   *     Error in IMAP command FETCH: Invalid messageset
   *
   * `runLeaseGate` turns that into `LeaseUnavailableError`, which the worker exempts BY CLASS
   * from `maxSyncFailures`, so a real account retried every thirty seconds for ever while the UI
   * said "waiting for first sync". Every layer behaved correctly and the composition could never
   * adopt a mailbox.
   *
   * The fake below is DOVECOT-SHAPED on purpose: it throws exactly where the real server threw.
   * The GreenMail suite in `organizer-lease.imap.test.ts` cannot host this test, because the
   * tolerant server is the reason the bug survived.
   */
  it("does NOT fetch an empty _meta — a server may refuse `1:*` there", async () => {
    let fetched = 0;
    const client = fakeClient({
      mailbox: { exists: 0 },
      fetch() {
        fetched += 1;
        throw new Error("Error in IMAP command FETCH: Invalid messageset");
      },
    });
    const io = makeLeaseIo(client, (c) => c.split("/").join("."), TEST_META_ID);
    await expect(io.listClaims()).resolves.toEqual([]);
    expect(fetched, "an empty _meta must not be fetched at all").toBe(0);
  });

  /**
   * The other half, and it is what stops the guard above from being a blanket "never fetch".
   * A non-empty folder must still be read, or the gate stops seeing foreign claims and two
   * organizers can hold one mailbox — the invariant this whole module exists for.
   */
  it("DOES fetch when _meta holds claims", async () => {
    const client = fakeClient({
      mailbox: { exists: 1 },
      fetch() {
        return (async function* () {
          yield { uid: 7, headers: Buffer.from("X-Ohmail-Lease: 1\r\n", "utf8") };
        })();
      },
    });
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    expect(await io.listClaims()).toHaveLength(1);
  });

  /**
   * `mailbox` is a client-library convenience, not a command, so a client that does not expose it
   * must behave EXACTLY as before: absence means "unknown", never "empty". Without this, every
   * existing fake in this file would silently start returning no claims.
   */
  it("fetches when the message count is UNKNOWN — absent is not empty", async () => {
    let fetched = 0;
    const ranges: string[] = [];
    const client = fakeClient({
      fetch(range: string) {
        fetched += 1;
        ranges.push(range);
        return (async function* () {
          yield { uid: 3, headers: Buffer.from("X-Ohmail-Lease: 1\r\n", "utf8") };
        })();
      },
    });
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    expect(await io.listClaims()).toHaveLength(1);
    /* ONE fetch. A count this connection will not report cannot be counted back from, and a window
     * computed from a missing or stale-low count walks toward the START of the folder — the
     * oldest-first read the whole bound exists to replace. So the server is asked outright, and the
     * ask is a SEARCH rather than a fetch: a bare `*` never reaches a server, because ImapFlow
     * rewrites it from its own cached count before issuing the command.
     *
     * This fake offers no `search`, so the probe cannot be made at all and the read falls back to
     * `1:*` with a sliding window — bounded, and correct about WHICH records it keeps. What is
     * asserted here is that the fallback still READS: one fetch, not zero. */
    expect(fetched, "an unknown count must still be read").toBe(1);
    // No `*` any more: the count probe is a SEARCH, and this fake offers none, so the read goes
    // straight to the whole-folder fallback.
    expect(ranges).toEqual(["1:*"]);
  });

  it("maps it unchanged for a slash-delimited server", async () => {
    const client = fakeClient();
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    await io.ensureMetaFolder();
    expect(client.created).toEqual(["ohmail/_meta"]);
  });

  /** A subscribed `_meta` shows machine bookkeeping in every other mail client the user owns. */
  /**
   * imapflow's `messageDelete` RESOLVES `false` on a refused STORE/EXPUNGE — it does not
   * reject. The gate's takeover path is load-bearing on removal failures being failures (a
   * handover whose displacement silently did not land would confirm, spend the one-shot
   * authorization, and leave the beaten claim standing), so the IO turns the refusal into a
   * rejection. (Review finding, round 4.)
   */
  it("treats a server that RESOLVES false from messageDelete as a failed removal", async () => {
    const client = fakeClient({ async messageDelete() { return false; } });
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    await expect(io.removeClaims([7])).rejects.toThrow(/refused to expunge/);
  });

  it("unsubscribes a meta folder that exists and is subscribed", async () => {
    const client = fakeClient({ async list() { return [{ path: "ohmail/_meta", subscribed: true }]; } });
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    await io.ensureMetaFolder();
    expect(client.created).toEqual([]);
    expect(client.unsubscribed).toEqual(["ohmail/_meta"]);
  });

  it("leaves an already-unsubscribed meta folder alone", async () => {
    const client = fakeClient({ async list() { return [{ path: "ohmail/_meta", subscribed: false }]; } });
    const io = makeLeaseIo(client, (c) => c, TEST_META_ID);
    await io.ensureMetaFolder();
    expect(client.created).toEqual([]);
    expect(client.unsubscribed).toEqual([]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE FOLDER STAMP — the cheap question a permit asks between reads
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A permit holder writes for up to a minute on the strength of one read, and a takeover DELETES
 * the claim that read admitted. `stampMeta` is what closes that window without paying for a read
 * per write: one STATUS, no SELECT, no FETCH. It answers counters or `null`, and `null` is every
 * way of not knowing — a connection with no STATUS, a refusal, a reply short of a counter. It
 * decides nothing; the gate still decides who organizes.
 */
describe("makeLeaseIo — the folder stamp a permit rides between reads", () => {
  const answering = (over: Partial<LeaseImapClient> = {}): ReturnType<typeof fakeClient> =>
    fakeClient({
      async status(_path, query) {
        return {
          ...(query.messages ? { messages: 3 } : {}),
          ...(query.uidNext ? { uidNext: 9 } : {}),
          ...(query.uidValidity ? { uidValidity: 4_100 } : {}),
        };
      },
      ...over,
    });

  it("asks the server for all three counters, by folder name, in ONE command", async () => {
    const asked: Array<[string, unknown]> = [];
    const client = answering({
      async status(path, query) {
        asked.push([path, query]);
        return { messages: 3, uidNext: 9, uidValidity: 4_100 };
      },
    });
    const io = makeLeaseIo(client, (c) => c.split("/").join("."), TEST_META_ID);
    await expect(io.stampMeta!()).resolves.toEqual({ messages: 3, uidNext: 9, uidValidity: 4_100 });
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe("ohmail._meta");
    expect(asked[0]![1]).toEqual({ messages: true, uidNext: true, uidValidity: true });
  });

  it("answers null when the connection cannot ask at all", async () => {
    const io = makeLeaseIo(fakeClient(), (c) => c, TEST_META_ID);
    await expect(io.stampMeta!()).resolves.toBeNull();
  });

  /**
   * HALF A STAMP IS NOT A STAMP. Compared as a whole one it would read an APPEND — the takeover's
   * first move — as a folder that had not moved, which is the defect this exists to close.
   */
  it("answers null when the reply is short of a counter", async () => {
    for (const short of [{ messages: 3 }, { uidNext: 9 }, {}]) {
      const io = makeLeaseIo(
        answering({ async status() { return short; } }), (c) => c, TEST_META_ID,
      );
      await expect(io.stampMeta!(), JSON.stringify(short)).resolves.toBeNull();
    }
  });

  /** The library resolves `false` where a server declines the command; it is not an answer. */
  it("answers null when the server declines the command", async () => {
    const io = makeLeaseIo(answering({ async status() { return false; } }), (c) => c, TEST_META_ID);
    await expect(io.stampMeta!()).resolves.toBeNull();
  });

  /**
   * AND IT NEVER THROWS. The caller is a write boundary, where a throw is classified as THIS
   * message's failure — so a STATUS the server refused would be recorded against a person's mail.
   */
  it("answers null rather than throwing when the command fails", async () => {
    const io = makeLeaseIo(
      answering({ async status() { throw new Error("STATUS refused"); } }), (c) => c, TEST_META_ID,
    );
    await expect(io.stampMeta!()).resolves.toBeNull();
  });

  /** A server that does not report the generation leaves it unknown, never "the same". */
  it("carries a null generation when the server does not report one", async () => {
    const io = makeLeaseIo(
      answering({ async status() { return { messages: 3, uidNext: 9 }; } }), (c) => c, TEST_META_ID,
    );
    await expect(io.stampMeta!()).resolves.toEqual({ messages: 3, uidNext: 9, uidValidity: null });
  });

  it("sameMetaStamp: a moved counter or a PROVEN renumbering is movement", () => {
    const at = { messages: 3, uidNext: 9, uidValidity: 4_100 };
    expect(sameMetaStamp(at, { ...at })).toBe(true);
    // An APPEND: the count may come back by an expunge, the uid space never does.
    expect(sameMetaStamp(at, { ...at, uidNext: 10 })).toBe(false);
    // An EXPUNGE with no append.
    expect(sameMetaStamp(at, { ...at, messages: 2 })).toBe(false);
    // A renumbering: the counters can agree across it and mean different messages.
    expect(sameMetaStamp(at, { ...at, uidValidity: 4_101 })).toBe(false);
  });

  /**
   * AN UNNAMED GENERATION PROVES NOTHING EITHER WAY — `epochVerdict`'s third answer, and the
   * reason it is not read as movement: a server that answers MESSAGES and UIDNEXT and not
   * UIDVALIDITY would otherwise put a gate run in front of every write. The counters still answer,
   * and they are the terms a takeover moves.
   */
  it("sameMetaStamp: an unnamed generation leaves the counters to answer", () => {
    const at = { messages: 3, uidNext: 9, uidValidity: 4_100 };
    expect(sameMetaStamp({ ...at, uidValidity: null }, { ...at })).toBe(true);
    expect(sameMetaStamp({ ...at, uidValidity: null }, { ...at, uidValidity: null })).toBe(true);
    // And it weakens nothing: the counters refuse on their own.
    expect(sameMetaStamp({ ...at, uidValidity: null }, { ...at, uidNext: 10 })).toBe(false);
    // Zero is not an epoch, so it is unknown rather than a generation that differs from 4100.
    expect(sameMetaStamp({ ...at, uidValidity: 0 }, { ...at })).toBe(true);
  });
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  `answerLeasePeek` — THREE ANSWERS, AND THE THIRD IS WHY IT EXISTS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `readLeasePeek` reads and THROWS on a fault, which is the truthful shape for a caller that will
 * render an apology and the wrong one for a door with a press in its hand: a `try` around a
 * decision is where "could not look" turns back into "nobody is there", once per call site. Two of
 * them did exactly that, measured — the engine's own poll and a phone's consent door — and a third
 * never even reached the read, because the read-only accessor is probed structurally and a failed
 * probe was answered with a bare `return`.
 *
 * So this layer answers in a VALUE and never throws for a lease fault. Only `free` admits a claim.
 */
describe("answerLeasePeek — free, held-by, unreadable", () => {
  const NOW = new Date("2026-09-12T12:00:00.000Z");
  const claim = (over: Partial<Parameters<typeof formatClaim>[0]> = {}): string => formatClaim({
    installId: "them", kind: "local", displayName: "a laptop",
    heartbeat: new Date(NOW.getTime() - 30_000), claimedAt: new Date(NOW.getTime() - 600_000),
    nonce: "n1", authorizedAt: null, capabilities: [],
    ...over,
  });
  const io = (records: RawClaimMessage[]) => ({ listClaims: async () => records });

  it("answers `free` for a folder that was READ and holds no live claim", async () => {
    const answered = await answerLeasePeek({ io: io([]), now: NOW });
    expect(answered.answer).toBe("free");
  });

  it("answers `free` for a folder whose only claims have STOPPED renewing", async () => {
    /* `stopped` is the gate's `available` — somebody was organizing and nothing has renewed since,
       which is a mailbox a press may take. Folding it into `held` would leave a person unable to
       claim a mailbox their own dead laptop last touched. */
    const answered = await answerLeasePeek({
      io: io([{ ref: 1, raw: claim({ heartbeat: new Date(NOW.getTime() - 60 * 60_000) }) }]),
      now: NOW,
    });
    expect(answered.answer).toBe("free");
    if (answered.answer !== "free") throw new Error("unreachable");
    expect(answered.peek.state, "a stopped folder was reported as never organized").toBe("stopped");
  });

  it("answers `held` and NAMES the holder while a claim is being renewed", async () => {
    const answered = await answerLeasePeek({ io: io([{ ref: 1, raw: claim() }]), now: NOW });
    expect(answered.answer).toBe("held");
    if (answered.answer !== "held") throw new Error("unreachable");
    expect(answered.holder.displayName).toBe("a laptop");
    expect(answered.holder.kind).toBe("local");
    expect(answered.holder.fresh).toBe(true);
  });

  it("answers `unreadable` — NOT `free` — where the adapter has no read-only accessor", async () => {
    /* The arm every call site used to answer with a bare `return`. `undefined` is admitted here
       deliberately, so the missing capability becomes an answer instead of a silent skip: measured,
       the phone's consent door then admitted a press, wrote the consent and the authorization, and
       reported the mailbox claimed. */
    const answered = await answerLeasePeek({ io: undefined, now: NOW });
    expect(answered.answer).toBe("unreadable");
    if (answered.answer !== "unreadable") throw new Error("unreachable");
    /* THE OP NAMES WHICH MISSING THING, because that is what sends an operator to the right place —
       `no_lease_io` here would be the telemetry lying about which capability is absent. */
    expect(answered.op).toBe("no_lease_peek_io");
  });

  it("answers `unreadable` — NOT `free` — where the folder could not be read", async () => {
    const answered = await answerLeasePeek({
      io: { listClaims: async (): Promise<RawClaimMessage[]> => { throw new Error("FETCH refused"); } },
      now: NOW,
    });
    expect(answered.answer).toBe("unreadable");
    if (answered.answer !== "unreadable") throw new Error("unreachable");
    expect(answered.op).toBe("list_claims");
  });

  it("answers `unreadable` for a folder TOO FULL to read, and says so on the log", async () => {
    /* A folder over the ceiling is the one fault here that does not clear on its own, and the
       direction it used to fail in is the whole reason the peek refuses rather than truncates: the
       records that fall off are the NEWEST, so a live renewal is omitted while old residue
       survives and the answer renders as "nobody organizes this mailbox".
       The LINE carries the counts, and the answer's error carries the person's sentence. Both are
       asserted, so neither the refusal nor the report can go missing on its own. */
    const said: { event: string; detail: Record<string, unknown> }[] = [];
    const answered = await answerLeasePeek({
      io: {
        listClaims: async (): Promise<RawClaimMessage[]> => {
          throw new MetaEnumRefusedError("over_ceiling", { rows: 0, total: 712, ceiling: META_ENUM_RECORDS_MAX });
        },
      },
      now: NOW,
      log: (event, detail) => { said.push({ event, detail }); },
    });
    expect(answered.answer, "a folder too full to read was reported as free").toBe("unreadable");
    expect(said.map((l) => l.event)).toContain("lease_enum_refused");
    expect(said.find((l) => l.event === "lease_enum_refused")?.detail.total).toBe(712);
  });

  it("RETHROWS a fault that is not the lease's, rather than calling it unreadable", async () => {
    /* `unreadable` for a programming error is safe in DIRECTION and indistinguishable from a folder
       fault in a report, which is how one gets diagnosed for a week as the other. By CLASS, exactly
       as the worker exempts `ClassifierFaultError`.
       Reaching it needs a throw from OUTSIDE `readLeasePeek`'s own try, which wraps everything
       `listClaims` throws into a `LeaseUnavailableError`: the parse below it does not. A record
       whose `raw` throws when read is that shape — and it is what makes this arm reachable at all
       rather than a guard nobody can watch fire. */
    class NotALeaseFault extends Error {}
    const hostile = {
      ref: 1,
      get raw(): string { throw new NotALeaseFault("a bug in the layer above"); },
    } as unknown as RawClaimMessage;
    await expect(answerLeasePeek({
      io: { listClaims: async (): Promise<RawClaimMessage[]> => [hostile] },
      now: NOW,
    })).rejects.toBeInstanceOf(NotALeaseFault);
  });

  it("answers `held` for the FRESHEST holder when several are in the folder", async () => {
    /* `holders[0]` is what every caller reads as "the organizer", and `peekLease` sorts by
       believable recency. This asks for the fresh one explicitly, so a folder where the newest
       record belongs to a machine that stopped cannot name the wrong one. */
    const answered = await answerLeasePeek({
      io: io([
        { ref: 1, raw: claim({ installId: "gone", displayName: "an old mac",
          heartbeat: new Date(NOW.getTime() - 60 * 60_000) }) },
        { ref: 2, raw: claim({ installId: "them", displayName: "a laptop" }) },
      ]),
      now: NOW,
    });
    expect(answered.answer).toBe("held");
    if (answered.answer !== "held") throw new Error("unreachable");
    expect(answered.holder.displayName).toBe("a laptop");
  });
});

/**
 * The confirm re-runs the election with the clone defence armed on the nonce just appended, and
 * this install's superseded claim no longer bears it. Coalesce keeps the newest record per
 * install by the writer's stamp, so two gate runs inside one instant, or a wall clock stepped
 * back between them, leave the superseded record "newest" — and the defence then read the
 * install's own claim as a live clone: every claim expunged, the mailbox left with no organizer
 * (measured 13 of 30 on the standalone lapse case).
 */
describe("runLeaseGate — a record this gate wrote earlier is not a rival at the confirm", () => {
  const ours = (nonce: string, heartbeat: Date): string => formatClaim({
    authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "This Mac",
    heartbeat, claimedAt: ago(600_000), nonce,
  });
  const nonces = (io: FakeIo): string[] =>
    io.messages.map((m) => (parseClaim(m.raw) as OrganizerClaim).nonce).sort();

  it("renews inside the instant its prior claim was stamped, whichever nonce sorts first", async () => {
    const io = new FakeIo();
    // "aa-prior" sorts before "zz-new": the tie-break keeps the PRIOR as the install's newest.
    await io.appendClaim(ours("aa-prior", NOW)); // seeded through the io: refs stay distinct
    const events: string[] = [];
    const res = await runLeaseGate({
      capabilities: [], io, self: self({ lastNonce: "aa-prior" }), now: NOW,
      newNonce: () => "zz-new", log: (event) => { events.push(event); },
    });
    expect(res.verdict.verdict, "the gate stood itself down against its own superseded claim").toBe("organize");
    expect(res.nonce).toBe("zz-new");
    expect(nonces(io), "the folder does not hold exactly the renewed claim").toEqual(["zz-new"]);
    expect(events).not.toContain("lease_lost_race");
  });

  it("renews after the wall clock stepped back, with the prior claim stamped later than now", async () => {
    const io = new FakeIo();
    // The prior would lose a nonce tie; only its later stamp makes it the "newest".
    await io.appendClaim(ours("zz-prior", new Date(NOW.getTime() + 1)));
    const res = await runLeaseGate({
      capabilities: [], io, self: self({ lastNonce: "zz-prior" }), now: NOW, newNonce: () => "aa-new",
    });
    expect(res.verdict.verdict, "a 1 ms step back demoted the organizer against itself").toBe("organize");
    expect(nonces(io)).toEqual(["aa-new"]);
  });

  /** The confirm's clone defence still holds: a live record under our id with a nonce we never wrote. */
  it("CONTROL: still stands down to a clone that appears between the election and the verify", async () => {
    const io = new FakeIo();
    await io.appendClaim(ours("zz-prior", NOW));
    let lists = 0;
    const racing: LeaseIo = {
      ensureMetaFolder: () => io.ensureMetaFolder(),
      listClaims: async () => {
        lists++;
        if (lists === 2) io.messages.push({ ref: 99, raw: ours("aa-clone", NOW) });
        return io.listClaims();
      },
      appendClaim: (r) => io.appendClaim(r),
      removeClaims: (refs) => io.removeClaims(refs),
      uidValidity: () => io.uidValidity(),
    };
    const res = await runLeaseGate({
      capabilities: [], io: racing, self: self({ lastNonce: "zz-prior" }), now: NOW, newNonce: () => "yy-new",
    });
    expect(res.verdict).toMatchObject({ verdict: "stand_down", by: { installId: "us", nonce: "aa-clone" } });
    expect(nonces(io), "the loser left its own claims beside the clone's").toEqual(["aa-clone"]);
  });

  /** And to a foreign holder that appears there and outranks us on incumbency. */
  it("CONTROL: still stands down to another install's live claim that appears at the verify", async () => {
    const io = new FakeIo();
    await io.appendClaim(ours("zz-prior", NOW));
    let lists = 0;
    const racing: LeaseIo = {
      ensureMetaFolder: () => io.ensureMetaFolder(),
      listClaims: async () => {
        lists++;
        if (lists === 2) {
          io.messages.push({ ref: 99, raw: formatClaim({
            authorizedAt: null, capabilities: [], installId: "them", kind: "local", displayName: "A laptop",
            heartbeat: NOW, claimedAt: ago(900_000), nonce: "t1",
          }) });
        }
        return io.listClaims();
      },
      appendClaim: (r) => io.appendClaim(r),
      removeClaims: (refs) => io.removeClaims(refs),
      uidValidity: () => io.uidValidity(),
    };
    const res = await runLeaseGate({
      capabilities: [], io: racing, self: self({ lastNonce: "zz-prior" }), now: NOW, newNonce: () => "aa-new",
    });
    expect(res.verdict).toMatchObject({ verdict: "stand_down", by: { installId: "them" } });
    expect(nonces(io)).toEqual(["t1"]);
  });
});
