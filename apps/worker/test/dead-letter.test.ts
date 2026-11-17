import { describe, it, expect } from "vitest";
import { MimeParseError, MimeTooLargeError, normalizeMime } from "@trafficflow/core";
import { EpochUnknownError } from "@trafficflow/core/adapters/imap";
import {
  DeadLetterLedger, classifyIngestFault, isDatabaseFault, isSharedDatabaseFault, nextAttemptAfter,
  DatabaseFaultError, DEFAULT_MAX_MESSAGE_ATTEMPTS, MAX_DEAD_LETTERS_PER_CYCLE,
} from "@ohmail/organizer/dead-letter";
import { markDatabaseFaults, asDatabaseFault } from "../src/db-fault.js";
import { BindLimitError } from "@trafficflow/db/cloud";

const loc = (folder: string, uidValidity: string, uid: number) =>
  ({ folder, ref: `${uidValidity}:${uid}` });

/**
 * The ledger's own arithmetic — the half of that change that `poison-batch.e2e.test.ts` cannot reach
 * with one poison message. A mutation run proved that: deleting the per-cycle cap left the e2e
 * file entirely green, which is precisely the shape of "a guard nobody has watched fail".
 */
describe("classifyIngestFault — whose fault is this throw", () => {
  it("names the two mime errors as deterministic message faults", () => {
    expect(classifyIngestFault(new MimeTooLargeError(1, 0)))
      .toEqual({ domain: "message", code: "mime_too_large", deterministic: true });
    expect(classifyIngestFault(new MimeParseError(new TypeError("x"))))
      .toEqual({ domain: "message", code: "mime_unparseable", deterministic: true });
  });

  /**
   * The direction that matters most. A shared-storage incident written off as message-local
   * silently discards everybody's mail — a review finding is the mailbox-level version of the same
   * mistake, and 53100 is the SQLSTATE of the 2026-08-01 outage.
   */
  it("keeps database and transport failures on the infrastructure side", () => {
    for (const code of ["53100", "53200", "08006", "08003", "40001", "40P01", "57014", "58030", "XX000", "25P02"]) {
      expect(classifyIngestFault(Object.assign(new Error("db"), { code })), code)
        .toEqual({ domain: "infrastructure" });
    }
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "CONNECTION_CLOSED", "CONNECT_TIMEOUT"]) {
      expect(classifyIngestFault(Object.assign(new Error("net"), { code })), code)
        .toEqual({ domain: "infrastructure" });
    }
  });

  it("keeps an UNKNOWN UIDVALIDITY on the infrastructure side, by the bound's own argument", () => {
    // The adapter refuses a locator-addressed command when the server named no UIDVALIDITY for the
    // selected folder, or named zero. No message has been read and none is at fault: the mailbox's
    // own host cannot answer the one question that makes a UID mean anything. Left to the
    // catch-all it is retried twice and then written off as a durable failure of mail that is
    // still on the server — the lie this module exists to prevent.
    //
    // The class is constructed rather than a bare `{ code }` object, so the ARM and the class's
    // own literal are asserted together: the classifier duck-types the code (it may not import
    // the adapter's class for its own predicate), and a second spelling on either side is a
    // predicate that quietly stops matching.
    expect(classifyIngestFault(new EpochUnknownError({ folder: "INBOX", ref: "7:2" })))
      .toEqual({ domain: "infrastructure" });
  });

  it("treats a data exception as deterministic and a constraint as not", () => {
    // 22021 is the decoded-NUL case: a value the message carried that Postgres cannot store.
    expect(classifyIngestFault(Object.assign(new Error("nul"), { code: "22021" })))
      .toEqual({ domain: "message", code: "data_exception", deterministic: true });
    // 23505 can be a concurrent second ingest of the same mail rather than a defect in it.
    expect(classifyIngestFault(Object.assign(new Error("dup"), { code: "23505" })))
      .toEqual({ domain: "message", code: "constraint_violation", deterministic: false });
  });

  it("retries anything it cannot name before writing it off", () => {
    expect(classifyIngestFault(new TypeError("a bug in our own pipeline")))
      .toEqual({ domain: "message", code: "unclassified", deterministic: false });
  });
});

/**
 * `attach()` asks a NARROWER question than the ingest loop, and the narrowness is load-bearing.
 *
 * On the ingest path the only socket is the database's, so a raw errno is ours. At `attach()` the
 * socket is the CUSTOMER'S PROVIDER: an `ECONNREFUSED` there is the most ordinary per-mailbox
 * failure there is, and `classifyMailboxError` has always called it `connect`. Sharing one predicate
 * between the two seams stopped four worker tests from quarantining an unreachable mailbox at all —
 * which is how this distinction was found.
 */
describe("isDatabaseFault — the attach seam's question", () => {
  it("claims SQLSTATEs and postgres.js's own code names", () => {
    for (const code of ["53100", "08006", "40001", "57014", "XX000", "CONNECTION_CLOSED", "CONNECTION_ENDED"]) {
      expect(isDatabaseFault(Object.assign(new Error("db"), { code })), code).toBe(true);
    }
  });

  it("does NOT claim a raw socket errno, because a provider host produces the same one", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "CONNECT_TIMEOUT"]) {
      expect(isDatabaseFault(Object.assign(new Error("provider"), { code })), code).toBe(false);
    }
    expect(isDatabaseFault(new Error("no code at all"))).toBe(false);
    // A data exception is the message's, never the database's, at either seam.
    expect(isDatabaseFault(Object.assign(new Error("nul"), { code: "22021" }))).toBe(false);
  });
});

/**
 * ══ THE CYCLE LOOP'S QUESTION, AND THE ORIGIN TAG THAT MAKES IT ANSWERABLE ═══════════
 *
 * `isDatabaseFault` above is the ATTACH seam's narrow, code-only question, and its own header
 * records the residual it cannot close: postgres.js throws `code: "ECONNREFUSED"` when Postgres is
 * not listening, which is byte-identical to a dead IMAP host. Measured on the real :5433 — see the
 * table in `db-fault.ts` — three of the six database faults this worker can suffer are
 * indistinguishable from a provider fault by `name` and `code` together.
 *
 * So the cycle loop asks about ORIGIN instead, and these are the four claims that holds:
 *
 *  1. a tagged fault is shared HOWEVER it is coded, including the codes a provider produces;
 *  2. an UNTAGGED provider fault is still not shared — the boundary that keeps mailbox isolation
 *    intact, and the direction a wrong widening breaks first;
 *  3. `classifyIngestFault` sees THROUGH the tag, so wrapping the repo did not turn an outage
 *     into mail written off as unclassified;
 *  4. Postgres answering about the VALUE (SQLSTATE 22/23) is not shared, tag or no tag.
 */
describe("isSharedDatabaseFault — the cycle loop's question", () => {
  const tagged = (code: string): DatabaseFaultError =>
    new DatabaseFaultError("repo.commitChange", Object.assign(new Error("x"), { code }));

  it("claims a tagged fault whose code a provider produces identically", () => {
    // Every one of these is `false` under `isDatabaseFault`, and must be: untagged, they are far
    // more likely to be the customer's IMAP host. Tagged, the origin settles it.
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "CONNECT_TIMEOUT"]) {
      expect(isDatabaseFault(Object.assign(new Error("bare"), { code })), `bare ${code}`).toBe(false);
      expect(isSharedDatabaseFault(tagged(code)), `tagged ${code}`).toBe(true);
    }
    // The shape a dead Postgres actually throws: an AggregateError with no SQLSTATE at all.
    const dead = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(isSharedDatabaseFault(new DatabaseFaultError("repo.hydrate", dead))).toBe(true);
    // …and one with no code whatsoever, which is what a wrapped bug in our own query builder is.
    expect(isSharedDatabaseFault(new DatabaseFaultError("repo.hydrate", new TypeError("x")))).toBe(true);
  });

  it("does NOT claim an untagged provider fault — this is the isolation boundary", () => {
    // THE INVERSE DEFECT. Widening this to `classifyIngestFault(...).domain === "infrastructure"`
    // makes every one of these `true`, and a mailbox whose provider is refusing connections is
    // then never quarantined — the ground, undone.
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"]) {
      expect(isSharedDatabaseFault(Object.assign(new Error("imap"), { code })), code).toBe(false);
    }
    expect(isSharedDatabaseFault(new Error("fake sync failed"))).toBe(false);
    // An untagged SQLSTATE is still unambiguous, so the narrow question still answers it.
    expect(isSharedDatabaseFault(Object.assign(new Error("db"), { code: "53100" }))).toBe(true);
  });

  it("subtracts the two classes in which Postgres is answering about the VALUE", () => {
    // The database told us this mailbox's mail cannot be stored. That is per-message evidence and
    // keeps its per-message cadence — the origin tag names where it came from, not who is at fault.
    expect(isSharedDatabaseFault(tagged("22021"))).toBe(false);
    expect(isSharedDatabaseFault(tagged("23505"))).toBe(false);
    // …and the domain verdict survives the wrapper, which is what keeps the dead-letter ledger
    // from writing an outage off as `unclassified`.
    expect(classifyIngestFault(tagged("22021")))
      .toEqual({ domain: "message", code: "data_exception", deterministic: true });
    expect(classifyIngestFault(tagged("23505")))
      .toEqual({ domain: "message", code: "constraint_violation", deterministic: false });
  });

  it("classifies a tagged infrastructure fault as infrastructure, not as unclassified mail", () => {
    // WITHOUT the unwrap in `classifyIngestFault`, every line here is
    // `{ domain: "message", code: "unclassified" }` — two attempts and then the mail is declared
    // consumed. Tagging the origin would have converted a database blip into mail loss.
    for (const code of ["08006", "53100", "CONNECTION_ENDED", "ECONNREFUSED"]) {
      expect(classifyIngestFault(tagged(code)), code).toEqual({ domain: "infrastructure" });
    }
  });
});

/**
 * A STORE LIMIT IS ONE MESSAGE'S ONLY WHERE THE ATTRIBUTION IS EXACT: a class-54 error from a routine
 * measured raising for a message's own value, or our client's refusal of an over-limit statement in
 * the caller's own call. Every other 54xxx (a full NOTIFY queue at COMMIT, ID wraparound, a routine
 * nobody has seen) and the driver's MAX_PARAMETERS_EXCEEDED, which can land on another caller's query,
 * stay shared: the pass stops and nothing is written off. Class 55 (lock contention) is never the message's.
 */
describe("data_too_large — a limit of the store, exceeded by one message", () => {
  const limit = (code: string, routine?: string): Error =>
    Object.assign(new Error("limit"), { code }, routine === undefined ? {} : { routine });
  const tagged = (e: Error): DatabaseFaultError => new DatabaseFaultError("repo.transaction", e);
  const nameOf = (e: Error): string => [(e as { code?: string }).code, (e as { routine?: string }).routine].filter(Boolean).join(" ");
  const tooLarge = { domain: "message", code: "data_too_large", deterministic: true };

  it("names a measured value routine and our own bind-limit refusal as the message's, deterministic", () => {
    const own = [
      ...["make_tsvector", "tsvector_concat", "_bt_check_third_page", "index_form_tuple_context"].map((r) => limit("54000", r)),
      new BindLimitError(70_000),
    ];
    for (const e of own) {
      expect(classifyIngestFault(e), nameOf(e)).toEqual(tooLarge);
      expect(classifyIngestFault(tagged(e)), `tagged ${nameOf(e)}`).toEqual(tooLarge);
      expect(isSharedDatabaseFault(tagged(e)), `tagged ${nameOf(e)}`).toBe(false);
    }
    expect(nextAttemptAfter("data_too_large", 1, new Date()), "the next look is a new build").toBeNull();
  });

  it("keeps every other class-54 error and the driver's parameter ceiling on the shared side", () => {
    const shared = [
      ...["PreCommit_Notify", "GetNewTransactionId", "GetNewMultiXactId", "exec_stmt_raise"].map((r) => limit("54000", r)),
      limit("54000"), limit("54001", "check_stack_depth"), limit("54011"), limit("54023"),
      limit("54000", "MAKE_TSVECTOR"), limit("MAX_PARAMETERS_EXCEEDED"),
    ];
    for (const e of shared) {
      expect(classifyIngestFault(e), nameOf(e)).toEqual({ domain: "infrastructure" });
      expect(classifyIngestFault(tagged(e)), `tagged ${nameOf(e)}`).toEqual({ domain: "infrastructure" });
      expect(isSharedDatabaseFault(tagged(e)), `tagged ${nameOf(e)}`).toBe(true);
    }
  });

  it("keeps lock contention and every outage code on the shared side", () => {
    for (const code of ["55P03", "55006", "53100", "08006", "57014", "40001"]) {
      expect(classifyIngestFault(tagged(limit(code))), code).toEqual({ domain: "infrastructure" });
      expect(isSharedDatabaseFault(tagged(limit(code))), code).toBe(true);
    }
  });

  it("answers the attach seam from the same lists: a measured limit is the mailbox's, the rest the database's", () => {
    expect(isDatabaseFault(limit("54000", "_bt_check_third_page"))).toBe(false);
    expect(isDatabaseFault(new BindLimitError(70_000))).toBe(false);
    expect(isDatabaseFault(limit("54000", "PreCommit_Notify"))).toBe(true);
    expect(isDatabaseFault(limit("54000"))).toBe(true);
    expect(isDatabaseFault(limit("MAX_PARAMETERS_EXCEEDED"))).toBe(true);
    expect(isDatabaseFault(limit("55P03"))).toBe(true);
  });

  it("keeps the code when a durable row is read back", () => {
    const l = new DeadLetterLedger();
    l.hydrate([{ folder: "INBOX", uidValidity: "1", uid: 7, code: "data_too_large", attempts: 1 }]);
    expect(l.entries().map((e) => e.code)).toEqual(["data_too_large"]);
  });
});

describe("markDatabaseFaults / asDatabaseFault", () => {
  it("tags a rejection from any method, preserving the original as `cause`", async () => {
    const boom = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    const repo = markDatabaseFaults({
      async commitChange(): Promise<never> { throw boom; },
      async hydrate(): Promise<number> { return 7; },
      notAFunction: 3,
    }, "repo");

    await expect(repo.commitChange()).rejects.toBeInstanceOf(DatabaseFaultError);
    await expect(repo.commitChange()).rejects.toMatchObject({ op: "repo.commitChange", cause: boom });
    // A method that succeeds is untouched, and a non-function property passes straight through.
    expect(await repo.hydrate()).toBe(7);
    expect(repo.notAFunction).toBe(3);
  });

  it("is idempotent, so a nested wrap cannot bury the cause chain", async () => {
    const boom = Object.assign(new Error("down"), { code: "08006" });
    const inner = markDatabaseFaults({ async go(): Promise<never> { throw boom; } }, "repo");
    const err = await asDatabaseFault("fence.transaction", () => inner.go()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseFaultError);
    // The INNER op survives — the outer wrapper recognised the tag and did not re-wrap.
    expect((err as DatabaseFaultError).op).toBe("repo.go");
    expect((err as DatabaseFaultError).cause).toBe(boom);
  });

  it("tags a synchronous throw too", async () => {
    const repo = markDatabaseFaults({ go(): never { throw new Error("sync"); } }, "repo");
    expect(() => repo.go()).toThrow(DatabaseFaultError);
  });
});

describe("DeadLetterLedger", () => {
  it("writes a deterministic fault off on its first failure", () => {
    const l = new DeadLetterLedger();
    expect(l.record(loc("INBOX", "9", 4), { code: "mime_too_large", deterministic: true })).toBe("skip");
    expect(l.has("INBOX", "9", 4)).toBe(true);
    expect(l.skipped).toBe(1);
  });

  it("TWO COORDINATES THAT CONCATENATE ALIKE DO NOT COLLIDE — a write-off is not contagious", () => {
    /**
     * The first arm. The identity used to be `${folder}${uidValidity}${uid}` with no
     * separator, and the three parts are all variable-length — so `("Notes1","2",34)` and
     * `("Notes","12",34)` were ONE key. The consequence is not a metric being wrong: `has()` gates
     * whether the sync cycle parses and commits a message at all, so a malformed message at the
     * first coordinate made a perfectly good message at the second look terminally skipped, with
     * the durable failure row describing the other one. On a UID-watermarked folder such as Sent
     * nothing enumerates the skipped message again.
     *
     * A mail server chooses folder names, so this needs no attacker — only a mailbox with folders
     * named such that two coordinates run together.
     *
     * Mutation watched red and restored (2026-08-31): put the concatenated key back and this case
     * fails on `has("Notes", "12", 34)` answering true for a message that never failed.
     */
    const l = new DeadLetterLedger();
    expect(l.record(loc("Notes1", "2", 34), { code: "mime_too_large", deterministic: true })).toBe("skip");
    expect(l.has("Notes1", "2", 34)).toBe(true);
    // The neighbour whose parts concatenate to the same string is untouched, in every reader.
    expect(l.has("Notes", "12", 34)).toBe(false);
    expect(l.knownFor("Notes", "12")).toEqual([]);
    // …and it can still be written off on its own account, independently.
    expect(l.record(loc("Notes", "12", 34), { code: "mime_unparseable", deterministic: true })).toBe("skip");
    expect(l.has("Notes", "12", 34)).toBe(true);
    expect(l.entries()).toHaveLength(2);
    // Forgetting one leaves the other — the delete path is keyed the same way.
    l.forget("Notes1", "2", 34);
    expect(l.has("Notes1", "2", 34)).toBe(false);
    expect(l.has("Notes", "12", 34)).toBe(true);
  });

  it("retries a non-deterministic fault first, then writes it off", () => {
    const l = new DeadLetterLedger();
    const fault = { code: "unclassified" as const, deterministic: false };
    for (let i = 1; i < DEFAULT_MAX_MESSAGE_ATTEMPTS; i++) {
      l.beginCycle();
      expect(l.record(loc("INBOX", "9", 4), fault)).toBe("retry");
      expect(l.has("INBOX", "9", 4)).toBe(false);
    }
    l.beginCycle();
    expect(l.record(loc("INBOX", "9", 4), fault)).toBe("skip");
    expect(l.entries()[0]).toMatchObject({ attempts: DEFAULT_MAX_MESSAGE_ATTEMPTS, terminal: true });
  });

  /**
   * THE SAFETY VALVE. A bug in our own pipeline throws for every message; without this cap the
   * cycle writes off the whole batch, advances the cursor and reports SUCCESS — a mailbox that is
   * green in Settings while dropping every message that arrives. Beyond the cap the surplus stays
   * unconsumed, so the cursor is held and `maxSyncFailures` quarantines the mailbox instead.
   */
  it("caps how many messages ONE cycle may write off", () => {
    const l = new DeadLetterLedger();
    const fault = { code: "mime_unparseable" as const, deterministic: true };
    l.beginCycle();
    for (let uid = 1; uid <= MAX_DEAD_LETTERS_PER_CYCLE; uid++) {
      expect(l.record(loc("INBOX", "9", uid), fault), `uid ${uid}`).toBe("skip");
    }
    expect(l.record(loc("INBOX", "9", MAX_DEAD_LETTERS_PER_CYCLE + 1), fault)).toBe("retry");
    expect(l.skipped).toBe(MAX_DEAD_LETTERS_PER_CYCLE);

    // …and the cap is PER CYCLE, so a mailbox with more poison than the cap still drains.
    l.beginCycle();
    expect(l.record(loc("INBOX", "9", MAX_DEAD_LETTERS_PER_CYCLE + 1), fault)).toBe("skip");
    expect(l.skipped).toBe(MAX_DEAD_LETTERS_PER_CYCLE + 1);
  });

  /**
   * The epoch is part of the identity. A UID number written off under one epoch must not silence a
   * different message of the next whose server reused it — the same reuse hazard as a review finding, on the
   * skip list instead of the known-set.
   */
  it("hands the known-set only the skips of the epoch it is asked about", () => {
    const l = new DeadLetterLedger();
    l.record(loc("INBOX", "10", 2), { code: "mime_too_large", deterministic: true });
    expect(l.knownFor("INBOX", "10")).toEqual([{ uid: 2, messageId: null }]);
    expect(l.knownFor("INBOX", "11")).toEqual([]);
    expect(l.knownFor("ohmail/Screener", "10")).toEqual([]);
    expect(l.has("INBOX", "11", 2)).toBe(false);
  });

  it("offers nothing to the known-set while an item is still being retried", () => {
    const l = new DeadLetterLedger();
    l.record(loc("INBOX", "10", 2), { code: "unclassified", deterministic: false });
    expect(l.knownFor("INBOX", "10")).toEqual([]);
  });
});

/**
 * The head mailparser 3.9.32 now refuses (over mailsplit's 1 MiB) reaches the ledger as a message
 * fault it writes off on the first failure, and the same bytes classify the same way every time.
 */
describe("a head over 1 MiB is a deterministic message fault", () => {
  it("classifies the real refusal as mime_unparseable, identically twice", async () => {
    const raw = Buffer.from([
      "From: a@example.com", `X-Filler: ${"x".repeat(1100 * 1024)}`, "To: b@example.org",
      "Subject: big head", "MIME-Version: 1.0", "Content-Type: text/plain", "", "hi", "",
    ].join("\r\n"));
    const verdicts = [];
    for (let i = 0; i < 2; i++) {
      const err = await normalizeMime(raw).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(MimeParseError);
      verdicts.push(classifyIngestFault(err));
    }
    expect(verdicts).toEqual([
      { domain: "message", code: "mime_unparseable", deterministic: true },
      { domain: "message", code: "mime_unparseable", deterministic: true },
    ]);
  });
});
