import { describe, it, expect } from "vitest";
import { ImapBoundExceeded, isImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { isDatabaseFault, isSharedDatabaseFault, classifyIngestFault } from "@ohmail/organizer/dead-letter";
import { readSource } from "./_start-function.js";

/**
 * ═══ A SERVER-CEILING BREACH IS THIS MAILBOX'S FAULT, AND THE WORKER MUST AGREE ════════════
 *
 * The adapter's ceilings on server-chosen counts, sizes and waits do not build their own
 * isolation — they INHERIT it. A throw out of `runSyncCycle` is already attributed to the mailbox
 * it came from: that folder's cursor is held, the cycle fails, the connection closes, and the
 * mailbox accumulates toward its ordinary quarantine cadence while every other mailbox on the
 * shard proceeds. That is the whole acceptance for this class of defect, and the adapter's only
 * job in it is to raise an error the worker classifies as MAILBOX-LOCAL.
 *
 * ## Why that is not a free property
 *
 * The worker deliberately EXEMPTS some failures from per-mailbox blame, because a shared-service
 * outage rendered as "your mailbox is broken" is a measured incident: one database blip would
 * otherwise quarantine every mailbox on the shard in turn and write `status='error'` on each. So
 * `isSharedDatabaseFault` decides, and a breach that fell inside it would invert the isolation —
 * silently, and in the direction where nothing looks wrong: the hostile mailbox would be treated
 * as a victim of a shared outage, never quarantined, and free to keep costing the shard.
 *
 * ## AND THE MARGIN IS THINNER THAN IT LOOKS
 *
 * That predicate reaches `sqlStateClass`, which is `/^[0-9A-Z]{5}$/` on the error's `code` and
 * returns the first two characters as a SQLSTATE class. So the question "is this a shared database
 * fault?" is answered, for any unrecognised error, **by the SHAPE OF ITS `code` STRING.** A
 * five-character uppercase code is read as a SQLSTATE; anything else is not.
 *
 * `EIMAPBOUND` is ten characters, so it is not — and that is the entire reason this works. It is
 * a real safeguard and a fragile-looking one, which is exactly why it is pinned here rather than
 * left to the next person who shortens a code string for tidiness. The file this guards is in
 * another package and its author will not be looking at this predicate.
 *
 * MUTATIONS WATCHED RED AND RESTORED (2026-09-01), scripted and re-run — all three:
 *  · the refusal's `code` → `"22P02"`, a five-character SQLSTATE ⇒ red. It stops being unreadable
 *    to `sqlStateClass` and starts being read as a data exception, which is a claim about a
 *    message's bytes;
 *  · the refusal's `code` → `"CONNECTION_CLOSED"`, a driver code ⇒ red. That set is the
 *    database's, so the breach becomes a SHARED fault and this mailbox is never quarantined for
 *    it — the isolation inverted, in the direction where nothing looks wrong;
 *  · the classifier's `EIMAPBOUND` arm removed ⇒ red. The breach falls to the catch-all and
 *    innocent messages start earning durable failure rows.
 *
 * The second of those is the one worth reading twice. Both wrong answers are reachable by
 * SHORTENING OR RENAMING A STRING in another package, and neither would fail a typecheck or look
 * wrong at the site of the change.
 */

const breach = (): ImapBoundExceeded =>
  new ImapBoundExceeded("enumerate_uids", 500_000, 500_001, "INBOX");

/** The worker's quarantine site, read as SOURCE — see the structural case for why. */
const WORKER_INDEX = readSource(
  new URL("../src/index.ts", import.meta.url),
);

describe("an IMAP ceiling breach is mailbox-local, not a shared-service fault", () => {
  it("is NOT a shared database fault — so it quarantines the mailbox it came from", () => {
    const err = breach();
    expect(isSharedDatabaseFault(err)).toBe(false);
    expect(isDatabaseFault(err)).toBe(false);
  });

  it("is recognisable by class and by duck-type, without importing the adapter", () => {
    const err = breach();
    expect(err).toBeInstanceOf(ImapBoundExceeded);
    expect(isImapBoundExceeded(err)).toBe(true);
    // The closed-set code an operator greps for, and the folder that caused it.
    expect(err.code).toBe("EIMAPBOUND");
    expect(err.bound).toBe("enumerate_uids");
    expect(err.folder).toBe("INBOX");
  });

  it("the code cannot be mistaken for a SQLSTATE — the property the isolation rests on", () => {
    /*
     * Stated as the rule rather than as a fact about today's string, because the fact is what
     * would change. Anything matching `/^[0-9A-Z]{5}$/` is read as a SQLSTATE class by the
     * worker's fault predicate, and a breach classified that way stops being this mailbox's
     * problem.
     */
    expect(/^[0-9A-Z]{5}$/.test(breach().code)).toBe(false);
  });

  it("is INFRASTRUCTURE, not a poison message — nothing is written off and the cycle fails", () => {
    /*
     * THE OTHER DIRECTION THE CLASSIFICATION CAN GO WRONG, and it was wrong.
     *
     * `classifyIngestFault` decides whether ONE message may be written off. Its catch-all is
     * `domain: "message"`, `"unclassified"`, `deterministic: false` — retried twice, then written
     * off — and a new error class lands there by default. So a server tripping a ceiling every
     * cycle earned durable failure rows against messages that were still on the server and still
     * perfectly readable: the durable lie that module's contract exists to prevent, arriving
     * through a new error rather than through a bug in the classifier.
     *
     * `infrastructure` is the right domain by that file's own definition — it "covers both sockets
     * in play here, the customer's IMAP host and our own database, because neither is the
     * message's fault" — and its consumers leave the row exactly as it was and fail the cycle.
     * The MAILBOX is the unit of this failure.
     *
     * Found by this test, which was written expecting the property and got `"message"`.
     */
    const verdict = classifyIngestFault(breach());
    expect(verdict.domain).toBe("infrastructure");
  });

  it("…but a CANDIDATE-PROBE breach is NOT transport — it must earn the reconciler's backoff", () => {
    /*
     * THE EXCLUSION, and it is not tidiness.
     *
     * `classifyIngestFault` also backs the reconciler's `isTransportFailure`, so the mapping
     * changes RECONCILIATION as well as ingest — and the transport arm leaves a `folder_state`
     * row immediately due with its attempt count unchanged. That is right for a host that is
     * down and wrong for a condition that does not clear on its own.
     *
     * `candidate_body_probes` is exactly such a condition: the destination holds more messages
     * sharing one Message-ID than the pre-check can tell apart, and `move` refuses BEFORE any
     * mutation. Routed to transport, the filing pass would re-run the same SEARCH every cycle for
     * ever — succeeding each time, entering no backoff, and never surfacing to an operator.
     *
     * Found by the review of the fix above: the first mapping was unconditional.
     */
    const probes = new ImapBoundExceeded("candidate_body_probes", 32, 33, "ohmail/News");
    expect(classifyIngestFault(probes).domain).not.toBe("infrastructure");
    // Still this mailbox's own problem, never a shared-service one.
    expect(isSharedDatabaseFault(probes)).toBe(false);
  });
});

describe("a ceiling breach blocks softly — it does not write `error`", () => {
  it("the CLASS is the discriminator, and it answers only for a breach", () => {
    // The behavioural half of that change is `mailbox-fence.pg.test.ts`, which drives
    // `markMailboxReadLimited` against a real catalog and asserts the four `markMailboxFailed`
    // columns are left as they were. What it cannot reach is the CHOICE between the two writers:
    // `quarantineMailbox` is a closure inside `startWorker`, so nothing can call it.
    //
    // So the choice is pinned here, and the predicate first: a bound breach is recognised and an
    // ordinary IMAP failure is not, which is what stops the soft path swallowing a real fault.
    expect(isImapBoundExceeded(breach())).toBe(true);
    const authFailure = Object.assign(new Error("Login failed."), { authenticationFailed: true });
    expect(isImapBoundExceeded(authFailure)).toBe(false);
    expect(isImapBoundExceeded(new Error("socket hang up"))).toBe(false);
  });

  it("…and the quarantine site CONSULTS it before choosing a writer — structural, by source", () => {
    /**
     * A STRUCTURAL case, and it is labelled as one: it reads the worker's source rather than its
     * behaviour, because the arm is unreachable from a test. What it can still refuse is the
     * shape that reintroduces the defect — a `markMailboxFailed` for a breach — and that is the
     * whole of what it claims.
     *
     * MUTATION WATCHED: replace `bounded` in the soft choice with `false` and this goes red on
     * the fourth assertion. Since mail 0130 the choice names a reason (`soft`), because a
     * provider's refusal takes the same writer shape with its own member.
     */
    expect(WORKER_INDEX, "the discriminator is not imported").toContain("isImapBoundExceeded");
    expect(WORKER_INDEX, "the narrow writer is not imported").toContain("markMailboxReadLimited");
    // The choice itself: the breach arm is selected BY THE CLASS, on the line that picks a writer.
    expect(
      /const\s+bounded\s*=\s*isImapBoundExceeded\(reason\)/.test(WORKER_INDEX),
      "the quarantine site no longer asks whether the failure is a ceiling of ours",
    ).toBe(true);
    expect(
      /const\s+soft\s*=\s*bounded\s*\?\s*"read_limited"/.test(WORKER_INDEX),
      "a bounded refusal no longer names the read_limited block",
    ).toBe(true);
    expect(
      /soft\s*===\s*"read_limited"\s*\n?\s*\?\s*await\s+markMailboxReadLimited/.test(WORKER_INDEX),
      "a bounded refusal no longer takes the soft-block writer",
    ).toBe(true);
  });
});
