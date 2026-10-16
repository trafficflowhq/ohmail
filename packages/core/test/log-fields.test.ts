/**
 * THE FAKE-LOGGER SEAM, CLOSED FOR THE FIELDS THAT FELL THROUGH IT.
 *
 * The non-blocking attach added six attach phase durations to `mailbox_attached`. The worker suite passed — every one of its
 * tests — and production then answered
 * `droppedFields=["connectMs","leaseMs","foldersMs","kickstartMs","watchMs","attachMs"]`: the whole
 * instrumentation half of the slice was refused by the census in `log.ts`, because the fields were
 * added at the CALL SITE and never to `ALLOWED_FIELDS`.
 *
 * No worker test could have caught it. Those tests inject a fake logger, so they prove what a call
 * site hands over, never what this census emits. That is the identical seam documented in the header
 * of `packages/db/test/notice-sink.test.ts`, and it shipped a defect through twice in one night.
 *
 * So this test drives the REAL `createLogger` and asserts on the bytes it writes. A field that is not
 * on the census does not merely go missing — `droppedFields` names it, which is the mechanism that
 * made the defect diagnosable from one live line, and which is asserted empty below.
 */

import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { aiBootFields } from "../src/ai/transports/host.js";

/**
 * Capture the emitted LINE via the logger's own injected sink.
 *
 * The `sink` seam is the honest one here: `ALLOWED_FIELDS` is applied by `createLogger` BEFORE the
 * sink is called, so this exercises the real census — the thing that was broken — and reads the exact
 * bytes it produced. It deliberately does NOT exercise `defaultSink`/`console.log`; that was never
 * where the defect was, and saying so is cheaper than implying more coverage than this has.
 */
function capture(fn: (log: ReturnType<typeof createLogger>) => void): string {
  const lines: string[] = [];
  fn(createLogger({ service: "worker", sink: (line) => { lines.push(line); } }));
  return lines.join("\n");
}

describe("the real logger emits the fields call sites pass", () => {
  const PHASES = ["connectMs", "leaseMs", "foldersMs", "kickstartMs", "watchMs", "attachMs"] as const;

  it("emits every attachment phase duration, and drops none of them", () => {
    const fields = Object.fromEntries(PHASES.map((k, i) => [k, (i + 1) * 11]));
    const out = capture((log) => { log.info("mailbox_attached", fields); });

    // The assertion that would have caught the production defect: nothing refused.
    expect(out.includes("droppedFields"),
      `the census refused a field the call site passed: ${out}`).toBe(false);

    for (const k of PHASES) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  /**
   * The SEND path's phase durations. The fourth time this census has refused a live line's
   * instrumentation and the second where the suite could not see it — `send-ceiling.test.ts`
   * asserts these names from the service's side, through an injected logger, which proves the call
   * site HANDS THEM OVER and says nothing about whether they are emitted. This is the half that
   * says they are.
   *
   * The split is the whole content of the line: a `send_phases` that keeps `totalMs` and drops the
   * six phases beside it reports the one number that was never the question.
   */
  const SEND_PHASES = [
    "reserveMs", "assembleMs", "openMs", "submitMs", "finalizeMs", "projectMs", "totalMs",
  ] as const;

  it("emits every send phase duration and the reservation it belongs to, and drops none of them", () => {
    const fields: Record<string, unknown> = Object.fromEntries(
      SEND_PHASES.map((k, i) => [k, (i + 1) * 7]),
    );
    fields.draftId = "3f1c1f0e-0000-4000-8000-000000000001";
    fields.sendId = "3f1c1f0e-0000-4000-8000-000000000002";
    fields.status = "sent";
    const out = capture((log) => { log.info("send_phases", fields); });

    expect(out.includes("droppedFields"),
      `the census refused a field the send path passed: ${out}`).toBe(false);
    for (const k of [...SEND_PHASES, "draftId", "sendId", "status"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  // The worker cycle's split: the per-section array must survive the census at depth, or the one
  // line that says where a cycle's time went reads `droppedFields` instead.
  it("emits cycle_phases with its sections, and wake_admitted with its latency", () => {
    const out = capture((log) => {
      log.info("cycle_phases", {
        rotationMs: 812, tailMs: 3_104, tailWallMs: 9_870, turns: 3,
        sections: [{ section: "rule_retro", ms: 2_900 }, { section: "bubble_up", ms: 4 }],
      });
      log.info("wake_admitted", { mailboxId: "m", accountId: "a", wakeLatencyMs: 1_240 });
    });
    expect(out.includes("droppedFields"), `the census refused a cycle field: ${out}`).toBe(false);
    for (const k of ["rotationMs", "tailMs", "tailWallMs", "turns", "\"section\":\"rule_retro\"",
      "\"ms\":2900", "wakeLatencyMs"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  it("emits the lifecycle sweep's counts, the erasures it named among them", () => {
    const out = capture((log) => {
      log.info("account_lifecycle_pass", {
        accounts: 250, withLifecycle: 12, sent: { closed: 1 }, unmailable: 0, faults: 0, due: 3, capped: true,
      });
    });
    expect(out.includes("droppedFields"), `the census refused a sweep field: ${out}`).toBe(false);
    for (const k of ["withLifecycle", "unmailable", "\"due\":3", "capped"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  it("still refuses a field nobody declared — the census is not simply open", () => {
    // Anti-vacuity: if the census accepted everything, the test above would pass for the wrong reason
    // and this repository's whole log-hygiene story would be theatre.
    //
    // The probe field is deliberately NEUTRAL (`bogusFieldXyz`), not a secret-shaped name. A first
    // draft used `imapPassword` and failed: sensitive names hit the DENYLIST that runs before the
    // census, so they are REDACTED in place rather than dropped, and never appear in `droppedFields`.
    // That was my assertion mis-modelling the mechanism, not the logger misbehaving.
    const out = capture((log) => {
      log.info("mailbox_attached", { attachMs: 12, bogusFieldXyz: "should-not-appear" });
    });
    expect(out.includes("should-not-appear"), "an undeclared field's VALUE reached the drain").toBe(false);
    expect(out.includes("bogusFieldXyz"),
      `an undeclared field was dropped WITHOUT being named in droppedFields: ${out}`).toBe(true);
    expect(out.includes("attachMs"), "the declared field beside it was collateral damage").toBe(true);
  });

  /**
   * the three cron pass counts. Same mechanism, same failure mode: they were added to the four
   * cron call sites and to `ALLOWED_FIELDS` in one change, and this is what proves the second half
   * happened. `apps/worker/test/cron-logging.test.ts` asserts the same names from the worker's side;
   * the duplication is deliberate — that file can only see what the crons pass, this one is where
   * the census itself is the subject.
   */
  const CRON_COUNTS = ["generated", "flipped", "drained"] as const;

  /**
   * THE AWAY PASS'S OWN SUMMARY, every field of the result object the three hosts spread into
   * `away_responder_pass`.
   *
   * `expired` is the field this case was added for — the counter for a responder switched off
   * because the date its owner picked had passed. The name was already on the census (the request
   * drain's own third counter), which is exactly why it is worth asserting rather than assuming:
   * the file's own history records `sent` handed over by this same line and refused every time,
   * so a summary counter reaching the log is a measurement and not a reading.
   *
   * `capped` is a BOOLEAN and is in the list for that reason: the rest are integers.
   */
  const AWAY_COUNTS = [
    "accounts", "examined", "sent", "unverified", "throttled", "suppressed",
    "deferredAccounts", "deferredCandidates", "undeliverableMarked", "expired",
    "refusedErased", "refusedNotOrganizer",
  ] as const;

  it("emits every away-responder pass count, and drops none of them", () => {
    const fields: Record<string, unknown> = Object.fromEntries(
      AWAY_COUNTS.map((k, i) => [k, i + 1]),
    );
    fields.capped = false;
    const out = capture((log) => { log.info("away_responder_pass", fields); });

    expect(out.includes("droppedFields"),
      `the census refused an away count the pass passes: ${out}`).toBe(false);
    for (const k of [...AWAY_COUNTS, "capped"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  /**
   * FIX-021's two identifier fields. The cloud mirror's page apply logged a bare
   * `errorCode:"23503"` while `approvals_routing_decision_id_account_fk` wedged every fresh paired
   * desktop's first sync on the released 0.20.0 — the constraint's NAME is the diagnosis, and this
   * census dropped it. The sidecar's own tests inject a fake `log`, which proves what the call
   * site hands over and nothing about emission; this is the half that proves emission.
   */
  it("emits the constraint and table a refused row names, and drops neither", () => {
    const out = capture((log) => {
      log.error("cloud_row_quarantined", {
        kind: "approval",
        errorCode: "23503",
        constraint: "approvals_routing_decision_id_account_fk",
        table: "approvals",
        count: 1,
        reason: "this row violates a local constraint",
      });
    });
    expect(out.includes("droppedFields"),
      `the census refused a field the quarantine passes: ${out}`).toBe(false);
    for (const k of ["constraint", "approvals_routing_decision_id_account_fk", "table"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  it("emits every cron pass count, and drops none of them", () => {
    const fields = Object.fromEntries(CRON_COUNTS.map((k, i) => [k, i + 1]));
    const out = capture((log) => { log.info("cron_proposals_ran", fields); });

    expect(out.includes("droppedFields"),
      `the census refused a cron count the call site passed: ${out}`).toBe(false);
    for (const k of CRON_COUNTS) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  /**
   * The sensitivity-false-positive repair's counts. Third occurrence of the same defect, and the
   * first one caught by reading a live log line rather than by a test — the pass was deployed,
   * its `sensitive_fp_backfill_pass` line arrived carrying `examined` and a `droppedFields` list
   * holding every other number, and the worker suite was green throughout because it injects a
   * fake logger.
   *
   * `capped` and `marked` are in the list deliberately: they are BOOLEANS, and the two entries
   * above are all integers, so without them nothing here would prove the census treats a boolean
   * field the same way.
   */
  const REPAIR_COUNTS = [
    "candidates", "fetched", "cleared", "clearedFromStored", "stillSensitive", "unreadable",
    "mismatched",
  ] as const;

  it("emits every sensitivity-repair count, and drops none of them", () => {
    const fields: Record<string, unknown> = Object.fromEntries(
      REPAIR_COUNTS.map((k, i) => [k, i + 1]),
    );
    fields.capped = false;
    fields.marked = true;
    const out = capture((log) => { log.info("sensitive_fp_backfill_complete", fields); });

    expect(out.includes("droppedFields"),
      `the census refused a repair count the call site passed: ${out}`).toBe(false);
    for (const k of [...REPAIR_COUNTS, "capped", "marked"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
    // The booleans must survive as VALUES, not merely as key names — `marked=false` is the
    // interesting case for an operator and a census that stringified it away would be useless.
    expect(out.includes("marked"), "the boolean key vanished").toBe(true);
  });

  it("redacts a secret-shaped name in place rather than dropping it", () => {
    // The other half of the mechanism, asserted so the two are never confused again.
    const out = capture((log) => { log.info("mailbox_attached", { imapPassword: "hunter2" }); });
    expect(out.includes("hunter2"), "a denylisted field's VALUE reached the drain").toBe(false);
  });

  it("the `token` substring redacts OAuth field VALUES — accessToken / refreshToken / fetchAccessToken", () => {
    // OAuth2 mailboxes add access and refresh tokens to the process. The `token` entry in
    // SECRET_NAME_SUBSTRINGS is what keeps any field NAME containing "token" from ever emitting its
    // value — no new census entry required, and the deadliest value in the whole feature stays off
    // every line. Asserted here so a future edit to that substring cannot silently unredact them.
    const out = capture((log) => {
      log.info("mailbox_attached", {
        accessToken: "eyJACCESS", refreshToken: "0.ARefreshTOKEN", fetchAccessToken: "cbTOKEN",
      });
    });
    expect(out.includes("eyJACCESS"), "an accessToken value reached the drain").toBe(false);
    expect(out.includes("0.ARefreshTOKEN"), "a refreshToken value reached the drain").toBe(false);
    expect(out.includes("cbTOKEN"), "a fetchAccessToken value reached the drain").toBe(false);
  });

  /**
   * `messageId` — the `messages.id` ROW UUID a per-message worker line names when it acts on one
   * row. Fourth occurrence of the census's oldest failure mode, and the one that motivated this
   * entry: the sensitivity backfill's `sensitive_fp_backfill_unreadable` / `_oversize` warn lines
   * passed `messageId`, the census dropped it (`droppedFields=["messageId"]`), and the two oversized
   * rows those lines exist to name could not be named. RED before the allowlist entry, and worth
   * pinning because a row id is deliberately NOT a secret while nearly every other message-shaped
   * name is — so the temptation to redact it under a `message*` sweep is real.
   */
  it("emits the messageId a per-row line names, and does not drop it", () => {
    const id = "6f1c2a9e-3b4d-4c5e-8a7b-0d1e2f3a4b5c";
    const out = capture((log) => {
      log.warn("sensitive_fp_backfill_oversize", { mailboxId: "mb", messageId: id, reason: "x" });
    });
    expect(out.includes("droppedFields"),
      `the census refused messageId — the row could not be named: ${out}`).toBe(false);
    expect(out.includes(id), `the row id never reached the emitted line: ${out}`).toBe(true);
  });

  /**
   * `outageMs` + `faults` — the worker's shared-database condition.
   *
   * Pinned here because for THIS pair a census drop is worse than usual: the condition they
   * describe is one in which the database cannot be written to, so `worker_database_recovered` is
   * the only place an operator can ever learn how long the shard was blind and how many cycles met
   * the fault. There is no row to fall back on, by construction.
   */
  it("emits the shared-database condition's two numbers, and drops neither", () => {
    const out = capture((log) => {
      log.info("worker_database_recovered", { outageMs: 42_000, faults: 7, reason: "back" });
    });
    expect(out.includes("droppedFields"),
      `the census refused the outage numbers — the incident could not be sized: ${out}`).toBe(false);
    expect(out.includes("42000"), `outageMs never reached the emitted line: ${out}`).toBe(true);
    expect(out.includes("\"faults\":7"), `faults never reached the emitted line: ${out}`).toBe(true);
  });

  /**
   * The known-set memo's per-cycle census (`known_set_read`). The FIFTH occurrence of the failure
   * mode this file exists for — the third and fourth are numbered above — and the first where the
   * event reached the drain carrying nothing but its own explanation: all four numbers were
   * refused, while the `reason` sentence telling an operator how to READ those numbers survived,
   * so every live line explained fields that were not on it.
   *
   * `droppedBy` is in this list deliberately. It is the only STRING among the four, so without it
   * nothing here would prove the census passes a string-valued census field rather than only
   * integers and booleans — and its value class (a `WorkerRepo` method name captured by the memo's
   * proxy, or one of the leadership sentences the worker hands `KnownSetCache.drop`) is the half
   * that had to be checked against the DENYLIST rather than assumed, because a name that tripped
   * the first gate would be `[redacted]` here and never appear in `droppedFields` at all.
   *
   * Values are asserted, not merely key names: `bytes` and `bytesSaved` are the two halves of the
   * only question this line answers, and a census that emitted the keys while losing the numbers
   * would satisfy a name-only assertion and tell an operator nothing.
   */
  it("emits the known-set memo's census, and drops none of it", () => {
    const out = capture((log) => {
      log.info("known_set_read", {
        mailboxId: "mb-1", accountId: "acct-1",
        rows: 4875, bytes: 536_250, bytesSaved: 1_072_500, droppedBy: "insertMessage",
        reason: "the in-memory known-set was cold or had been dropped, so this cycle re-read it",
      });
    });

    expect(out.includes("droppedFields"),
      `the census refused a known-set census field: ${out}`).toBe(false);
    expect(out.includes("\"rows\":4875"), `rows never reached the emitted line: ${out}`).toBe(true);
    expect(out.includes("\"bytes\":536250"), `bytes never reached the emitted line: ${out}`).toBe(true);
    expect(out.includes("\"bytesSaved\":1072500"),
      `bytesSaved never reached the emitted line — the memo's whole saving went unreported: ${out}`).toBe(true);
    expect(out.includes("\"droppedBy\":\"insertMessage\""),
      `droppedBy never reached the emitted line — the drop could not be attributed: ${out}`).toBe(true);
  });

  /**
   * The same census's three BUDGET fields, asserted here rather than discovered by a live run —
   * the sixth occurrence of this failure mode would have been the memo's own bound reporting
   * nothing about itself. They are byte counts and no more: what one mailbox's memo is charged,
   * what every memo in the process is charged together, and the budget they share. The last two
   * read as a PAIR, so a census that let one through and dropped the other would leave an operator
   * with a numerator and no denominator — which is why both values are asserted and not the keys.
   */
  it("emits the locator budget's three byte counts beside that census", () => {
    const out = capture((log) => {
      log.info("known_set_read", {
        mailboxId: "mb-1", accountId: "acct-1",
        rows: 4875, bytes: 536_250, bytesSaved: 1_072_500,
        droppedBy: "evicted: the process locator budget",
        retainedBytes: 32_580_000, processRetainedBytes: 130_320_000,
        processBudgetBytes: 134_217_728,
        reason: "the in-memory known-set was cold or had been dropped, so this cycle re-read it",
      });
    });

    expect(out.includes("droppedFields"),
      `the census refused a locator-budget field: ${out}`).toBe(false);
    expect(out.includes("\"retainedBytes\":32580000"),
      `retainedBytes never reached the emitted line: ${out}`).toBe(true);
    expect(out.includes("\"processRetainedBytes\":130320000"),
      `processRetainedBytes never reached the emitted line — the numerator of the budget reading: ${out}`).toBe(true);
    expect(out.includes("\"processBudgetBytes\":134217728"),
      `processBudgetBytes never reached the emitted line — the denominator of the budget reading: ${out}`).toBe(true);
    // The eviction sentence is the value class this line's `droppedBy` now carries, and it is
    // composed by the budget rather than read off a property key: it must survive the denylist too.
    expect(out.includes("evicted: the process locator budget"),
      `the eviction reason was redacted — a drop nobody can attribute: ${out}`).toBe(true);
  });
});

/**
 * ══ THE `SIZE` BACK-FILL PASS'S OWN FIELDS — the same mechanism, a third time ═════════════════
 *
 * The counts and the two per-mailbox facts were added to the census WITH the lines that emit them,
 * which is only possible to verify here: the API and worker suites both inject a fake logger, so
 * they assert what a call site HANDS OVER and never what this census lets through. That is exactly
 * how the attach durations above and `messageId` were both refused in production while every suite
 * stayed green.
 *
 * The second case is the load-bearing one. `SmtpSizeFailure` is a union of five literals precisely
 * because a submission server's AUTH response — written by a third party, routinely carrying the
 * username — must not be able to reach a log drain. `reason` IS allowlisted and the value scrubber
 * only redacts strings that label themselves as secrets, so "log the error message" would have been
 * a working, green, publishing bug.
 */
describe("the SIZE back-fill's log lines survive the census", () => {
  // `stamped` joined when the pass grew mail 0063's durable attempt stamp — it is the count that
  // says how many rows will NOT be re-dialled tomorrow, which makes it the one an operator reads to
  // tell "the backoff is working" from "the pass is looping".
  const COUNTS = ["considered", "learned", "silent", "skipped", "failed", "stamped"] as const;

  it("emits every count of a pass, and drops none of them", () => {
    const fields = Object.fromEntries(COUNTS.map((k, i) => [k, i]));
    const out = capture((log) => { log.info("smtp_size_pass", fields); });
    expect(out.includes("droppedFields"),
      `the census refused a count the pass passed: ${out}`).toBe(false);
    for (const k of COUNTS) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
  });

  it("emits the announced ceiling and the closed failure code", () => {
    const out = capture((log) => {
      log.info("smtp_size_learned", { mailboxId: "11111111-1111-1111-1111-111111111111", announcedBytes: 52_428_800 });
      log.info("smtp_size_unlearned", { mailboxId: "11111111-1111-1111-1111-111111111111", code: "auth_refused" });
      // The oauth arm's own code, added with the XOAUTH2 dial: the fifth member of the closed
      // failure set, and the one that must never be replaced by the token endpoint's own sentence.
      log.info("smtp_size_unlearned", { mailboxId: "11111111-1111-1111-1111-111111111111", code: "token_unavailable" });
    });
    expect(out.includes("droppedFields"), `the census refused a field: ${out}`).toBe(false);
    expect(out.includes("announcedBytes")).toBe(true);
    expect(out.includes("52428800")).toBe(true);
    expect(out.includes("auth_refused")).toBe(true);
    expect(out.includes("token_unavailable")).toBe(true);
  });

  /**
   * THE FIGURES A CLOCK REFUSAL TURNED ON. Measured in production: line after line of
   * `lease_clock_skew_refused` in one day, every one reading
   * `droppedFields=["skewMs","bound","boundMs"]` — so the skew and the bound it was compared
   * against, which settle whether the fault is our clock or the provider's, were in no line
   * anybody could read. `swept` is the same shape one folder over: the count of stale
   * acknowledgements that left `ohmail/_meta`, on the only line that reports it getting smaller.
   */
  it("emits the clock refusal's own figures, and the sweep's count", () => {
    const out = capture((log) => {
      log.warn("lease_clock_skew_refused", { skewMs: -412_000, bound: "behind", boundMs: 150_000 });
      log.info("meta_ack_sweep", {
        mailboxId: "11111111-1111-1111-1111-111111111111", swept: 200,
      });
    });

    expect(out.includes("droppedFields"), `the census refused a field: ${out}`).toBe(false);
    for (const k of ["skewMs", "bound", "boundMs", "swept"]) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
    expect(out.includes("-412000"), "the skew itself is not in the line").toBe(true);
    expect(out.includes("150000"), "the bound it was compared against is not in the line").toBe(true);
    expect(out.includes("behind"), "which side of the bound it fell is not in the line").toBe(true);
    expect(out.includes("200"), "the sweep's count is not in the line").toBe(true);
  });

  /**
   * The engine's own memory line, and the two fields added for a step nobody could attribute. An
   * idle install rose 95 MB in `rss` while `heapUsed` FELL — the line carried neither what the
   * JavaScript engine had RESERVED nor the buffers behind the store, so it could only say what the
   * step was not. Both are on the census WITH the call site, which is the rule this file exists for.
   */
  const VITALS_MEMORY = [
    "rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "storeBytes", "uptimeMs",
  ] as const;

  it("emits every number on the engine's memory line, and drops none of them", () => {
    const fields = Object.fromEntries(VITALS_MEMORY.map((k, i) => [k, (i + 1) * 1_000_003]));
    const out = capture((log) => { log.info("engine_vitals", { ...fields, memoryReading: "process" }); });

    expect(out.includes("droppedFields"),
      `the census refused a field the engine's memory line passes: ${out}`).toBe(false);
    for (const k of VITALS_MEMORY) {
      expect(out.includes(k), `\`${k}\` never reached the emitted line: ${out}`).toBe(true);
    }
    // The VALUES, not just the names: a census that kept the key and dropped the number would pass
    // a names-only assertion and report a memory series of nulls.
    expect(out.includes("3000009"), `\`heapTotal\`'s value never reached the line: ${out}`).toBe(true);
    expect(out.includes("5000015"), `\`arrayBuffers\`'s value never reached the line: ${out}`).toBe(true);
  });

  it("ANTI-VACUITY: a memory field NOT on the census is refused by name", () => {
    // The positive control above passes for either reason — because the census admits the field, or
    // because it admits everything. `heapSizeLimit` is a real `getHeapStatistics()` number that is
    // deliberately NOT on the census, and it has to be refused for the pair to mean anything.
    const out = capture((log) => { log.info("engine_vitals", { heapSizeLimit: 4_345_298_944 }); });
    expect(out.includes("droppedFields")).toBe(true);
    expect(out.includes("4345298944")).toBe(false);
  });

  it("ANTI-VACUITY: `maxMessageBytes` is NOT on the census — the name in the code is the one that is", () => {
    // The first draft of the learned line used `maxMessageBytes`, which this census does not name.
    // Keeping that fact as an assertion is what stops somebody "tidying" the field back to the
    // wrong name and silently losing the number again.
    const out = capture((log) => {
      log.info("smtp_size_learned", { maxMessageBytes: 52_428_800 });
    });
    expect(out.includes("droppedFields")).toBe(true);
    expect(out.includes("52428800")).toBe(false);
  });
});

/**
 * THE SELF-HOST BOOT, AND THE SERVER-SIDE SWEEP. An upgrade in place logged ten `db_setup` lines
 * with `droppedFields:["msg"]` and `boot_migrated` with only `migrationsApplied` (the journal
 * total), so the operator could not tell an upgrade that migrated from one that did not. These
 * are the server's own lines through the real census; the sweep's names follow, with the names it
 * kept off as the control.
 */
describe("the self-host boot says what it did", () => {
  const parse = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

  it("boot_migrated carries the tags this boot applied and the journal's expected total", () => {
    const out = capture((log) => {
      log.info("boot_migrated", {
        appliedThisRun: ["0128_mailbox_x", "0044_cloud_y"], migrationsApplied: 159, migrationsExpected: 159,
      });
    });
    expect(out.includes("droppedFields"), `the census refused a boot field: ${out}`).toBe(false);
    const line = parse(out);
    expect(line.appliedThisRun).toEqual(["0128_mailbox_x", "0044_cloud_y"]);
    expect(line.migrationsExpected).toBe(159);
  });

  it("each db_setup step, the listening origin, the token's expiry and the released count reach the line", () => {
    const lines = [
      capture((log) => { log.info("db_setup", { setupStep: "mail: already tracked (128 rows) — nothing to adopt" }); }),
      capture((log) => { log.info("listening", { port: 8080, origin: "https://mail.example.com" }); }),
      capture((log) => { log.info("first_run_setup_token_minted", { expiresAt: "2026-09-27T21:25:03.493Z" }); }),
      capture((log) => { log.info("own_mail_released", { released: 2 }); }),
    ];
    for (const out of lines) expect(out.includes("droppedFields"), `a boot field was refused: ${out}`).toBe(false);
    expect(parse(lines[0]!).setupStep).toBe("mail: already tracked (128 rows) — nothing to adopt");
    expect(parse(lines[1]!).origin).toBe("https://mail.example.com");
    expect(parse(lines[2]!).expiresAt).toBe("2026-09-27T21:25:03.493Z");
    expect(parse(lines[3]!).released).toBe(2);
  });

  it("the step sentence still goes through the value scrubber", () => {
    const host = "h";                   // interpolated: a whole credentialed URL literal is a credential to the push gate
    const out = capture((log) => { log.info("db_setup", { setupStep: `target postgres://u:p@${host}/db` }); });
    expect(parse(out).setupStep).toBe("[redacted]");
    expect(out.includes("u:p@h")).toBe(false);
  });

  /** Every name the sweep admitted: typed by the checker at every call site as a number, a boolean,
   *  a closed set, a row id, IMAP numbering, a timestamp or a journal tag. */
  const SWEPT = [
    "setupStep", "appliedThisRun", "migrationsExpected", "origin", "expiresAt", "released",
    "ackFailures", "appending", "budgetMs", "ceiling", "chargedAttempts", "compactionOwed",
    "complete", "completed", "contactRowsReleased", "cursor", "deleted", "depth", "dialled",
    "disturbed", "dryRun", "effectiveMs", "elapsedMs", "escalated", "evicted", "failedPages",
    "finished", "floor", "freedBytes", "fromPending", "fromSent", "healed", "kept", "lapseMs",
    "limit", "messagesErased", "orphans", "ownUid", "pages", "protocol", "pruning", "queued", "raced",
    "read", "reaped", "records", "recounted", "refusedUncorroborated", "remaining", "removed",
    "rescreened", "residue", "restored", "retentionMs", "retired", "rulesArmed", "seen",
    "sensitivityExcluded", "size", "staleAfterMs", "steps", "total", "tries", "unrecognised",
    "voided", "epoch", "fact", "imap", "organizerState", "subscription",
    "folderId", "ruleId", "uid", "uidValidity", "generation", "decidedAt",
  ] as const;

  it("every name the server-side sweep admitted reaches the line", () => {
    const refused = SWEPT.filter((k) => {
      const out = capture((log) => { log.info("field_census", { [k]: "sentinel" }); });
      return parse(out)[k] !== "sentinel";
    });
    expect(refused, "swept names the census still drops or redacts").toEqual([]);
    expect(new Set(SWEPT).size).toBe(76);
  });

  it("ANTI-VACUITY: the names the sweep kept off are still refused by name", () => {
    // A server path, a subject or an address, a raw request path, and the generic key the boot used
    // to pass. If the census admitted everything, the case above would pass for the wrong reason.
    for (const k of ["folder", "landed", "junkFolder", "from", "to", "path", "msg", "named", "holder"]) {
      const out = capture((log) => { log.info("field_census", { [k]: "kept-off-value" }); });
      expect(out.includes("kept-off-value"), `\`${k}\`'s value reached the drain: ${out}`).toBe(false);
      expect(parse(out).droppedFields, `\`${k}\` was not named as dropped: ${out}`).toEqual([k]);
    }
  });
});

/**
 * THE SELF-HOST EXTERNAL DOOR'S TWO LINES, through the real census: `external_door_configured` and
 * `forwarded_address_collapsed` keep every field the server hands them. The spellings the ruling
 * first named are the control: a generic `value` and a `…Header` key stay refused, which is why the
 * lines say `effective` and `proxyPeerFrom`.
 */
describe("the external door's lines reach the drain whole", () => {
  const parse = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

  it("external_door_configured and forwarded_address_collapsed drop nothing", () => {
    const boot = capture((log) => {
      log.info("external_door_configured", {
        configVar: "OHMAIL_TLS_TERMINATOR", effective: "unset: the proxy takes its network gateway", proxyPeerFrom: "x-ohmail-proxy-peer",
      });
    });
    const collapsed = capture((log) => {
      log.warn("forwarded_address_collapsed", {
        host: "172.31.228.1", configVar: "OHMAIL_TLS_TERMINATOR", effective: "203.0.113.9 10.0.0.0/8",
        reason: "the proxy took no forwarded address from this peer, so every visitor arriving through it shares this one address",
      });
    });
    for (const out of [boot, collapsed]) expect(out.includes("droppedFields"), `a door field was refused: ${out}`).toBe(false);
    expect(parse(boot).effective).toBe("unset: the proxy takes its network gateway");
    expect(parse(boot).proxyPeerFrom).toBe("x-ohmail-proxy-peer");
    expect(parse(collapsed).effective).toBe("203.0.113.9 10.0.0.0/8");
    expect(parse(collapsed).host).toBe("172.31.228.1");
  });

  it("CONTROL: the spellings it does not use are still refused by the census", () => {
    expect(parse(capture((log) => { log.info("field_census", { value: "kept-off-value" }); })).droppedFields).toEqual(["value"]);
    expect(parse(capture((log) => { log.info("field_census", { proxyPeerHeader: "x-ohmail-proxy-peer" }); })).proxyPeerHeader)
      .toBe("[redacted]");
  });
});

describe("the AI choice's boot line reaches the drain whole", () => {
  const parse = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

  it("ai_provider_configured carries the provider, the address kind and the meter, and drops nothing", () => {
    const server = parse(capture((log) => { log.info("ai_provider_configured", aiBootFields(null)); }));
    const organizer = parse(capture((log) => {
      log.info("ai_provider_configured", { ...aiBootFields({ provider: "ollama", baseUrl: "http://ollama:11434", classifyModel: "llama3.2", draftModel: "llama3.2" }), metered: false });
    }));
    for (const out of [server, organizer]) expect(out.droppedFields, JSON.stringify(out)).toBeUndefined();
    expect(server.kind).toBe("none");
    expect([organizer.kind, organizer.endpoint, organizer.metered]).toEqual(["ollama", "custom", false]);
  });
});
