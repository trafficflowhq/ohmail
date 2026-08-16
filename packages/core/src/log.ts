/**
 * STRUCTURED LOGS — one JSON object per line, on the paths where a silent failure costs
 * money or mail.
 *
 * The arch doc's "Observability required before beta" note asks for exactly two things
 * first: JSON logs carrying the `requestId` the API already mints, and alerts. This file is
 * the first half. It is deliberately dependency-free code rather than pino or winston, for the
 * same reason `templates.ts` renders four emails without React Email: a log line is
 * `JSON.stringify` plus a newline, and the parts that are actually hard here — redaction,
 * never throwing, and error serialisation that cannot leak a connection string — are decisions
 * no logging library would make for us.
 *
 * ── IT LIVES IN `core` BECAUSE OF THE DEPENDENCY GRAPH ────────────────────────────────────
 * `packages/core` depends on `packages/db`; everything else depends on `core`. The worker may
 * import core + db and nothing else — a guard walks the worker's sources and fails on an import
 * of any other workspace package — and the API imports all of them. `core` is therefore the
 * highest package that BOTH the worker and the API can reach, which is what lets one logger
 * serve both hosts.
 *
 * ── WHY THIS FILE IS AN ALLOWLIST AND NOT A DENYLIST ─────────────────────────────────────
 * It used to be a denylist of EXACT normalised names, and an exact-name denylist is a list of
 * the spellings someone thought of. Every composite survived it: `imapPassword`,
 * `smtp_password`, `TF_KEK_V1`, `authToken`, `requestCookie` all reached stdout verbatim,
 * because the set held the bare words `password`, `kek`, `token`, `cookie`. `{config:
 * {password}}` redacted; `{config: {smtpPassword}}` did not.
 *
 * That is High and not cosmetic in this product's specific terms. Credentials are envelope
 * encrypted under a KEK that is held in the host environment and is absent from the database,
 * which is the entire reason a plaintext dump of `mailbox_credentials` is survivable. A KEK on
 * one log line, combined with any retained dump's wrapped DEK, retroactively decrypts every
 * password ever written under that KEK version — and `crypto.ts` does not re-wrap on rotation,
 * so "every" has no end date. This file is the channel that would do it.
 *
 * So: {@link ALLOWED_FIELDS} is the primary control. A key not on it never has its VALUE
 * emitted, at any depth, under any spelling. The alternative — hardening the denylist to
 * substring matching — was rejected on evidence, not on effort:
 *
 *   · A substring denylist cannot see the non-key string channels. `event`, `service`,
 *     `Error.name` and `Error.code` never reach a key filter at all, so hardening the key
 *     filter does nothing for them. They are handled here by GRAMMAR instead.
 *   · Substring matching over-redacts destructively on this repo's real vocabulary. A `token`
 *     rule eats `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` and
 *     `thinkingTokens` — the five numbers cost accounting requires ("measure against real measured
 *     per-action cost"). A `key` rule eats `alertKey` and `keyVersion`. An allowlist keeps
 *     them by naming them; a denylist can only keep them by being weakened.
 *   · The field vocabulary is small and closed: 79 names across every call site in
 *     `packages/**` and `apps/**` when that extraction was made (86 logger calls, 82 with a
 *     literal fields object, ZERO with a computed one). Enumerable means allowlistable — and it
 *     has stayed enumerable: {@link ALLOWED_FIELDS} holds 127 names today, grown one reviewed
 *     diff at a time, which is the shape this design predicted rather than a drift away from it.
 *
 * The honest cost of an allowlist is that a field an operator needs at 3am can go missing. It
 * is paid down two ways rather than denied: a dropped key's NAME (never its value) is reported
 * on the line in `droppedFields`, so the log says what it refused and the fix is one entry in
 * {@link ALLOWED_FIELDS}; and the denylist survives as a SECOND gate that runs FIRST, so the
 * dangerous edit — adding `imapPassword` to the allowlist — fails closed to `[redacted]`
 * instead of open. The six names that legitimately trip the second gate are enumerated in
 * {@link SUBSTRING_EXEMPT_FIELDS} with the reason each is a count and not a secret.
 *
 * ── FOUR PROPERTIES ARE LOAD-BEARING ─────────────────────────────────────────────────────
 *
 * **1. It never throws.** `console.error` raises `EPIPE` when stdout is closed — a real
 * container condition on shutdown, already documented in `db/src/ai-gate.ts`. A logger that
 * can throw turns "we logged the failure" into "the failure handler crashed", so every write
 * is wrapped and a failed write is dropped in silence. There is nowhere better for it to go.
 * The cost is that a redaction bug ALSO fails silently, which is exactly why the guard for
 * this file asserts the bytes handed to the sink and not `sanitize()`'s return value.
 *
 * **2. It gates by KEY at every depth, and the gate is an allowlist.** The console-privacy
 * invariant says subjects, senders, snippets and bodies never leave the mail
 * path; the api-vercel host already learned the credential half the hard way (its `internal()`
 * comment records a driver error message carrying `host=…&user=…` going to a log drain). One
 * gate here beats fifty call sites remembering.
 *
 * **3. Every string channel is a GRAMMAR, not free text.** `event`, `service`, `errorClass`
 * and `errorCode` are identifiers, so they are validated as identifiers. `logger.error(
 * err.message)` is a natural call and it used to publish the message verbatim: `event` was
 * written into the line without ever passing through the filter. It now becomes
 * `invalid_event` plus the refused length. `describeError` no longer trusts `name`/`code`
 * either — both are mutable and library-supplied, and a driver puts a connection string
 * wherever it likes.
 *
 * **4. `err` is CLASS + CODE, never message + stack.** Same reasoning as the serverless API
 * host's top-level error handler: class and code are enumerable and safe; a driver message
 * carries the connection string and a `postgres` error carries the failing query.
 *
 * That fourth rule used to end "pass `errorDetail` explicitly when a message genuinely is safe
 * and needed — a decision a human makes per call site". It is gone, and `errordetail` is a
 * redacted name instead, because an escape hatch named after the thing the rule forbids is not
 * a decision point, it is a signpost. Its only three call sites in this repository were the
 * hosted sync worker's process-level crash handlers, and all three passed `err.message` — the
 * exact string reduced away one line above, into an operator-visible drain, from the one code
 * path that runs only when something has already gone wrong. That was a leak that had shipped,
 * not a hypothetical one. For the same reason there is no `allowFields` option: a
 * per-caller widening of {@link ALLOWED_FIELDS} would be `errorDetail` again, wearing a
 * different name.
 *
 * A caller who genuinely holds a safe fact still logs it — under a key that NAMES the fact
 * (`configVar`, `errorCode`, `statusCode`), which is a claim a reviewer can check, and which
 * is then added to {@link ALLOWED_FIELDS} in a diff a reviewer can see. "Detail" is not.
 */

/** Ordered least → most severe. A logger emits an event when its level is at or above `level`. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Arbitrary structured context attached to a line. Values must be JSON-representable. */
export type LogFields = Record<string, unknown>;

/**
 * THE CENSUS. Every field name any caller in this repository passes to a logger, and nothing
 * else. A key not here has its value dropped at every depth and its NAME reported in
 * `droppedFields`.
 *
 * Frozen literal on purpose, in the same spirit as the API's route-cost census — a frozen list of
 * every route by cost class: the list is the claim, and a diff to it is the review. It was
 * extracted mechanically rather than recalled — every `*Log`/`*Logger`
 * `.debug|info|warn|error(` call in `packages/**` and `apps/**` including optional-chained
 * receivers, plus `child()` bindings, plus `LoggerOptions.fields`, plus the funnels that
 * forward a caller's own object: the sync worker's organizer-lease callback (hence `verdict`),
 * the AI client's `ai_call` line, which spreads a whole call report (hence the whole of
 * `AnthropicCallReport`), and `apps/sidecar/src/log.ts` (`createSidecarLog`, the
 * `(event, detail) => void` seam the local engine, the stdio host and `readMailboxLease` all
 * write through — hence `inFlight`).
 *
 * That last one was missing from the mechanical extraction because there was nothing to extract:
 * the sidecar hand-rolled a `JSON.stringify` sink whose comment claimed this logger's shape, so
 * the same two field leaks stood unfixed in a second implementation. The guard against a third is
 * a census test scoped to the sidecar package, which fails when a call site there passes a field
 * name absent from this list; its header says why it covers one package for now.
 *
 * THE COST OF THAT SCOPE IS NOW MEASURED RATHER THAN ASSUMED, which is the one thing worth adding
 * here — the decision itself lives in that test's header and is not repeated. Since it was written
 * this census has refused a live line's fields three more times, all of them in `apps/worker`, the
 * package the scanner does not cover: the sensitivity repair's counts, `messageId`, and every
 * number on `known_set_read`. A sweep of `apps/worker/src` taken while adding the last of those
 * found the condition is not exhausted — the message-retry and reconcile lines pass `folder`,
 * `uid` and `uidValidity`, none of which is on this list, so those lines drop the two facts they
 * exist to name. Widening the scanner is what closes the class; adding entries one live line at a
 * time is what this file has been doing instead.
 *
 * `err`, `errorClass` and `errorCode` are deliberately absent: they are logger-owned slots
 * handled in {@link createLogger}'s `emit`, before this gate runs.
 */
export const ALLOWED_FIELDS: readonly string[] = [
  // ── identity and correlation (what makes a line greppable at all) ──
  "accountId", "mailboxId", "requestId", "instanceId", "environment", "version",
  "shard", "shards", "route", "method", "status", "code", "host",
  // `messageId` is the `messages.id` ROW UUID a per-message worker line names when it acts on one
  // row — NOT the `Message-ID` HEADER, which carries a domain and reads like an address and is not
  // logged anywhere. A row id is the same shape and the same non-secret as `accountId` and
  // `mailboxId` one line up: it correlates a line to a database row and contains no mail content.
  // Added AFTER the fact, the same way the attach-phase and repair-count entries below were: the
  // sensitivity backfill's per-row `sensitive_fp_backfill_unreadable` / `_oversize` warn lines
  // passed it and the census dropped it (`droppedFields=["messageId"]`), so the two oversized rows
  // those lines exist to name could not be named. A row-scoped test drives the REAL logger for this
  // name, so it cannot silently go missing again.
  "messageId",
  // ── The attach-phase durations, added AFTER the first live run refused them ──
  //
  // The six landed in `mailbox_attached` without landing here, so the first live line read
  // `droppedFields=["connectMs","leaseMs","foldersMs","kickstartMs","watchMs","attachMs"]` and the
  // whole instrumentation half of that change was refused. The worker suite could not see it: those
  // tests inject a fake logger, so they assert what the call site HANDS OVER, never what this census
  // lets through. The same fake-logger seam has shipped a second defect elsewhere in this repository
  // for the same reason. A test now drives the REAL logger for exactly these names, so a future
  // field cannot be added without being emitted.
  // ── the sentence a human reads, and the config name a human checks ──
  "connectMs", "leaseMs", "foldersMs", "kickstartMs", "watchMs", "attachMs",
  "reason", "detail", "kind", "severity", "phase", "state", "verdict", "configVar",
  "disabledReason", "stoppedBy", "heldBy",
  // `syncBlockedReason` is mail 0029's `MAILBOX_SYNC_BLOCK_REASONS` member — one of three literals
  // this repository wrote, beside `disabledReason` for the same reason.
  //
  // `op` is WHICH OPERATION FAILED, and it is on the census rather than being a logger-owned slot
  // deliberately: it is a fact the CALL SITE holds (`LeaseOp` in `organizer-lease.ts`, a
  // compile-time literal from a closed union), not a fact about the thrown value, so the honest
  // control is the one this file's header prescribes — name the fact, add the name here, and let
  // the diff be the review. Contrast `causeClass`/`causeCode` below, which are derived from a
  // thrown value and therefore must NOT be spoofable by a payload.
  "syncBlockedReason", "op",
  // ── counts and roster arithmetic (the worker's roster pass, kickstart, thread backfill) ──
  "accounts", "accountsAffected", "mailboxes", "maxMailboxes", "selected", "serving",
  "dropped", "unexplained", "examined", "resolved", "rerouted", "pruned", "count", "more",
  "sample", "claims", "threadsCreated", "contactsImported", "sentRecipients", "truncated",
  "maxPages", "healthPort", "signal",
  // ── The local engine's per-drain timing (`sync_drain`), added WITH the call site ──
  //
  // `cycles` is the inner-cycle count of one drain; `totalMs` and `slowestMs` are wall-clock
  // milliseconds from `Date.now()` deltas (`summarizeDrain`). All three are integers derived from a
  // counter and a clock — structurally content-free, naming no mailbox and no message — and they are
  // the read that attributes desktop CPU and quit lag to the pipeline. NAMED rather than folded into
  // `count`, on this file's own rule: `totalMs` and `slowestMs` are different quantities and one
  // `count` meaning either is not a claim a reviewer can check. (`drained` is already above.)
  "cycles", "totalMs", "slowestMs",
  // ── The three cron-pass counts, added WITH the call sites and not after them ──
  //
  // `generated` (proposals stored), `flipped` (bubble-ups resurfaced) and `drained` (workflow runs
  // executed) are the return values of the four cron passes, accumulated by `+=` from a `.length`
  // or a local counter and assigned by nothing else — structurally integers, so they cannot carry
  // content. They are NAMED rather than folded into the existing `count` because this file's own
  // header prescribes it: a key that names the fact is a claim a reviewer can check, and one
  // `count` meaning three different quantities depending on the event is not.
  //
  // Deliberately absent, and this is the half worth reading: `pass`, `ran` and `skipped`. WHICH
  // pass ran is encoded in the event NAME (`cron_proposals_ran`), because `event` is already a
  // validated grammar with no allowlist behind it, so it costs nothing — while every entry added
  // here is another chance to repeat the attach-phase mistake four lines up.
  "generated", "flipped", "drained",
  // `rescued` rides the same bubble-up log line as `flipped` and is the same kind of quantity —
  // the reconciliation's own counter (resurfaced rows whose due event never re-unread them,
  // healed), an integer accumulated by `++` and assigned by nothing else. Added WITH its call
  // sites (`bubbleUpPass` → worker cycle + sidecar drain), per the paragraph above: the first
  // live line must not read `droppedFields=["rescued"]` on the event that exists to report it.
  "rescued",
  // ── The sender-name / recipients backfill's three counters, added WITH the call sites ──
  //
  // `scanned` (candidate rows read), `fillable` (rows whose stored headers can supply a value) and
  // `written` (rows the guarded UPDATE actually took) are integers accumulated by `++`/`+=` from
  // that pass's own local counters and assigned by nothing else, so
  // they are structurally content-free. Added here in the SAME change as the call sites rather
  // than after a live run refused them — which is what the attach-phase and sensitivity-repair
  // paragraphs above are both records of, and this pass logs progress across a walk of tens of
  // thousands of rows, so a line reading only `droppedFields` would leave an operator with no way
  // to tell a slow run from a stalled one.
  //
  // NAMED rather than folded into `count`, on this file's rule: three quantities behind one key is
  // not a claim a reviewer can check. The pass's other numbers are deliberately NOT here — they
  // reach the operator through the runner's console summary, and `skipped` in particular stays off
  // the census exactly as the cron paragraph above decided. The cursor is logged as `messageId`,
  // the row-uuid entry that already exists, not as a new `lastId`.
  //
  // What must never appear on this list is a key named for the VALUES this pass moves —
  // `fromName`, `toAddresses`, `ccAddresses` are display names and recipient addresses, i.e.
  // somebody's mail, and the pass logs counts of them and never one of them.
  "scanned", "fillable", "written",
  // ── The sensitivity-false-positive repair's counts, added AFTER the first live run refused them ──
  //
  // The attach-phase paragraph four entries up, reproduced exactly, by somebody who had read it. The
  // pass shipped, and its first live line read
  // `droppedFields=["candidates","fetched","cleared","stillSensitive","unreadable","mismatched",
  // "capped","marked"]` — every number the line existed to report, refused, leaving `examined`
  // alone on a line about a correction to somebody's mail. The worker's own tests could not see
  // it for the reason the attach-phase paragraph names: they inject a fake logger, so they assert what the call
  // site HANDS OVER and never what this census lets through.
  //
  // All eight are structurally content-free. Six are integers accumulated by `++` and `+=` from
  // local counters in the worker's sensitivity backfill pass, and `capped`/`marked` are booleans
  // — one from a budget comparison, one from `RETURNING`'s row count. None is derived from a
  // message, a sender or a subject, which is the question this list exists to ask.
  //
  // NAMED rather than folded into `count`, on this file's own rule: `cleared` and
  // `stillSensitive` are the two halves of the only question an operator asks about this pass —
  // how much mail became readable, and how much was correctly left alone — and one `count` that
  // means either depending on the event is not a claim anybody can check.
  //
  // `clearedFromStored` is the ninth, added with the oversized-original ruling: a candidate whose
  // ORIGINAL is over the re-read ceiling cannot be re-read, so its sensitivity is cleared from the
  // STORED text instead — a repair that un-withholds the row but cannot restore the html the false
  // positive deleted. It is counted APART from `cleared` because the two are not the same outcome
  // (one restores the body, one only the metadata), which is the distinction an operator asks
  // about. Structurally an integer accumulated by `++`, so it carries no content, same as the eight.
  "candidates", "fetched", "cleared", "clearedFromStored", "stillSensitive", "unreadable",
  "mismatched", "capped", "marked",
  // ── The Cloud mirror's one-time tag repair, added WITH its call site ──
  //
  // `tags` is how many tag ROWS the repair restored and `messages` how many mirrored messages
  // regained their assignments; both are `++` counters over a snapshot page in
  // `apps/sidecar/src/cloud-mirror.ts` and neither is derived from a tag's NAME or a message's
  // content. Named rather than folded into `count` on this file's own rule: the two answer
  // different questions — whether the rail came back, and whether any chip did — and an operator
  // reading `count` alone could not tell a repair that restored the tags and lit nothing from one
  // that worked.
  "tags", "messages",
  // `changed` is the ONE non-identifying fact the Cloud mirror's owner-change reset
  // (`apps/sidecar/src/cloud-engine.ts`) puts on its line: a literal `true` meaning a foreign
  // mirror was discarded because the served address changed. The addresses themselves — whose
  // mailbox was served before and whose is served now — are exactly what this census keeps OFF the
  // line, so the emit site logs neither; the event NAME carries the WHAT, and this carries only
  // that it happened. Structurally a boolean literal, so it can never carry content.
  "changed",
  // `inFlight` is `StdioHost.inFlight` (`apps/sidecar/src/host.ts`), the only field the sidecar
  // needed that the Cloud census did not contain. It is a private counter that `dispatch` moves
  // with `inFlight++` / `inFlight--` and nothing else assigns, so it is structurally an integer
  // and cannot carry content. It is on the census because a `shutdown` line that cannot say
  // whether requests were still in flight cannot say whether the shutdown dropped work.
  "inFlight",
  // `mirrorDraining` is the OTHER half of the same `shutdown` line, and it is here because
  // `inFlight` alone was misleading rather than merely incomplete: the Cloud mirror's pull is not a
  // stdio request, so `inFlight` reads 0 in exactly the case where the mirror is what the quit is
  // waiting for. A literal boolean read off `CloudMirror.draining()` (`inflight !== null`), so it
  // is structurally content-free — the same shape and the same argument as `changed` above.
  "mirrorDraining",
  // ── The desktop engine's BOOT phases (`boot_phases`), added WITH the call sites ──
  //
  // The attach-phase paragraph above, applied before the fact rather than after it. Both sidecar
  // doors serve the bridge only once their constructor returns, so the window's "Opening your
  // mailbox" screen lasts exactly as long as that constructor — and, as with the attach phases, a
  // single start-to-finish number could not say WHICH phase owned it. These five can: `pgliteOpenMs` is
  // the WASM instantiation plus Postgres' own startup on the local mirror, `adoptBaselineMs` and
  // `migrateMs` the two schema passes, `worldMs` the mailbox row and the launch session, and
  // `totalReadyMs` the whole constructor — so the four subtracted from the total are the unnamed
  // remainder, which is a reading rather than a guess.
  //
  // All five are `Date.now()` deltas, the same clock `cycles`/`totalMs`/`slowestMs` above use.
  // Structurally integers from a clock: they name no mailbox, no address and no path, and the
  // data directory deliberately stays off the line for the reason `serving` dropped `dataDir`.
  // NAMED rather than folded into `totalMs`, on this file's own rule — five durations under one
  // key is not a claim a reviewer can check.
  "pgliteOpenMs", "adoptBaselineMs", "migrateMs", "worldMs", "totalReadyMs",
  // ── retry, failure and circuit accounting ──
  "attempt", "attempts", "consecutiveFailures", "maxSyncFailures", "consecutiveFaults",
  "opens", "open", "threshold", "circuit", "cooldownMs", "retryAt", "retryInMs",
  // ── the worker's shared-DATABASE condition, added WITH its call sites ──
  //
  // `outageMs` is a `Date.now()` delta and `faults` is a `++` counter, so both are structurally
  // integers naming no mailbox, no address and no statement. They are the whole content of
  // `worker_database_recovered`, which is the line an operator reads to size an incident that by
  // construction wrote nothing to the database — so a census drop here would silently delete the
  // only durable record of it. NAMED rather than folded into `count`/`totalMs`, on this file's own
  // rule: "how long was the database gone" and "how many mailboxes met it" are different
  // quantities, and one key meaning either is not a claim a reviewer can check.
  "outageMs", "faults",
  // ── a crash the contract deliberately did NOT exit on, added WITH its call site ──
  //
  // `survived` is a `++` counter on `uncaught_exception_survived` — the running number of times a
  // process's crash handlers have met an uncaught throw its host named as survivable, rather than
  // exiting on it. (Today there is one such shape: a database driver that throws from a timer when
  // a connection dies with a write still buffered, which is not evidence about the process at all
  // and whose only effect on `exit(1)` is a restart loop through the outage.) Structurally an
  // integer naming no mailbox, no address and no path.
  //
  // It is on this list because it is the ESCALATION SIGNAL and there is no other: one of these is
  // a known driver defect riding out an outage, and a thousand is a process that should have died
  // an hour ago. The line is emitted from the one code path that only runs when something has
  // already gone wrong, so a census drop would leave `droppedFields=["survived"]` exactly where an
  // operator is trying to size a suppression — the same failure the `rescued` note above records.
  "survived",
  // ── the auto-suggest pass's own count, added WITH its call site ──
  //
  // `bought` is the number of held senders a pass stored an advisory suggestion for — a `++`
  // counter on a loop with a fixed page above it, so structurally an integer naming no sender, no
  // subject and no verdict. It rides beside `examined` and `capped`, which are already here.
  //
  // NAMED rather than folded into `count`, on this file's own rule: "how many were eligible" and
  // "how many were answered for" are different quantities and the gap between them IS the reading
  // — a pass that examined ten and bought three stopped early, which is the one thing this line
  // exists to make visible. It matters most on the desktop, where the pass runs against a model
  // the person in front of it is paying for directly and a line saying `droppedFields=["bought"]`
  // would leave them with no record of what was done on their key.
  "bought",
  // ── The known-set memo's per-cycle census (`known_set_read`), added AFTER the first live run
  //    refused ALL FOUR of them ──
  //
  // The fifth time the attach-phase paragraph above has been reproduced as a defect
  // (`log-fields.test.ts` numbers the third and the fourth), and the first where the line reached
  // the drain carrying nothing but its own explanation: every live `known_set_read` read
  // `droppedFields=["rows","bytes","bytesSaved","droppedBy"]` while the `reason` sentence telling an
  // operator how to READ those four numbers survived, because `reason` was already here. The worker
  // suite could not see it for the reason that paragraph gives — those tests inject a fake logger,
  // so they assert what the call site HANDS OVER and never what this census lets through.
  //
  // All four are structurally content-free, which is the question this list exists to ask.
  // `rows` is `rows.length` of the last `listKnownLocators` read. `bytes` and `bytesSaved` are sums
  // of column WIDTHS (`estimateWireBytes` adds `Buffer.byteLength` of each field to a fixed
  // per-field overhead) — arithmetic over lengths and never over the values, so no folder name, no
  // `Message-ID` and no address can survive the addition.
  //
  // `droppedBy` is the only string and the only one that needed checking rather than arguing. Its
  // value set is closed and author-written: either a `WorkerRepo` METHOD NAME, captured by the
  // memo's proxy from a property key of a class in this repository, or one of the leadership
  // sentences the worker hands `KnownSetCache.drop` (`"lease-lost"`, `"fenced"`, `"cycle-threw"`,
  // `"leader lock lost"`, `` `detached: ${reason}` ``) — the same static English a human wrote that
  // `reason` carries, which is why `reason` is on neither denylist. Nothing runtime-composed and
  // nothing mailbox-derived reaches it.
  //
  // NAMED rather than folded into `count`/`totalMs`, on this file's own rule: `rows` is the SIZE of
  // the read, `bytes` its cost once, and `bytesSaved` the cost the memo has avoided since the
  // attachment began — three quantities, and the reading IS the ratio between the last two. One
  // `count` meaning any of them is not a claim a reviewer can check. `droppedBy` is what makes the
  // line actionable rather than merely informative: a memo re-reading every cycle is a
  // classification bug in `KNOWN_SET_NEUTRAL`, and this names the method to classify.
  //
  // `dbReads` and `hits` are deliberately absent, on the cron paragraph's rule. The call site emits
  // only when `dbReads > 0`, so the event's EXISTENCE already says what `dbReads` would, and `hits`
  // is per-cycle bookkeeping the operator has no question about — and every entry added here is
  // another chance to repeat the mistake this paragraph records.
  "rows", "bytes", "bytesSaved", "droppedBy",
  // ── alerting (the worker's alert loop and the API's internal alert route) ──
  "alertKey", "alertKeys", "alertSinks", "alertIntervalMs", "rosterIntervalMs",
  "pollIntervalMs", "firing", "delivered", "failedSinks", "oldestSeconds",
  // WHY a sink refused, and how long it has been refusing. `failedSinks` above names the sink
  // and nothing else, which is what let a configured-and-permanently-broken webhook read as
  // routine noise. `sinkErrors` is a flat ARRAY of `"<sink>: <reason>"` strings and not a
  // record keyed by sink name ON PURPOSE: this census gates keys at EVERY depth, so a sink
  // called `webhook` would have had its reason dropped for not being on this list — the
  // diagnostic would have been added, deployed, and still said nothing.
  "sinks", "sinkErrors", "sinkFailureStreak",
  // ── AI cost accounting: AnthropicCallReport, spread wholesale as `ai_call`. Per-action cost is
  //    measured from these five token counts, which is why they are named rather than eaten
  //    by a `token` substring rule. See SUBSTRING_EXEMPT_FIELDS.
  "model", "ok", "latencyMs", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "thinkingTokens", "costMicroUsd",
] as const;

/**
 * Name FRAGMENTS that mean "never write this value". Matched as a SUBSTRING of the normalised
 * key, which is what catches `imapPassword`, `smtp_password`, `TF_KEK_V1` and `Set-Cookie`
 * under one entry each.
 *
 * Short, ambiguous words are deliberately NOT here — they are in {@link SECRET_EXACT_NAMES}
 * instead. `pass` as a substring eats `passed` and `bypass`; `text` eats `context`; `key` eats
 * `alertKey` and `keyVersion`. Precision matters less than it used to (an unmatched key is
 * dropped by the allowlist rather than emitted), but a false positive here would silently
 * blank a field the allowlist deliberately keeps, so it still matters.
 */
export const SECRET_NAME_SUBSTRINGS: readonly string[] = [
  // ── credentials, keys, tokens ──
  "password", "passwd", "passphrase", "secret", "token", "cookie", "authorization",
  "credential", "apikey", "privatekey", "bearer", "kek", "dsn", "connectionstring",
  "databaseurl", "sessionid", "url",
  // ── mail content and the people in it (never logged) ──
  "subject", "snippet", "body", "html", "envelope", "header", "attachment", "filename",
  "preview", "excerpt", "messagecontent", "address", "email", "recipient", "sender",
  // ── the message, under the names people reach for ──
  "stack", "errordetail", "errormessage",
] as const;

/**
 * Names that redact on an EXACT normalised match only, because as substrings they would eat
 * ordinary words: `pass` eats `passed` and `bypass`, `text` eats `context`, `key` eats
 * `alertKey`, `tag` eats `tagId`. The last five are `crypto.ts`'s envelope components.
 *
 * `reason` is deliberately absent from both lists: ~40 call sites pass it a static English
 * sentence the author wrote, which is the opposite of a value the runtime composed. `keyVersion`
 * is absent too, and on purpose — a KEK VERSION is an integer that the health endpoint already
 * publishes; redacting it would be the same over-reach that makes a `key` substring rule wrong.
 * It simply is not on {@link ALLOWED_FIELDS}, so it is dropped rather than redacted.
 *
 * Nothing here duplicates a fragment above. `secretEnc`, `stackTrace`, `bodyText`, `bodyHtml`
 * and `rawBody` were all explicit entries under the old exact-match design and are now covered
 * by `secret`, `stack` and `body` — which is the point of the change.
 */
export const SECRET_EXACT_NAMES: readonly string[] = [
  "pass", "key", "text", "auth", "sig", "signature", "iv", "tag", "wdek", "dtag", "div",
] as const;

/**
 * Every name that redacts, as one list. Kept exported because the worker's crash-handler path and
 * the test that pins it both rest on "`errordetail` is on `REDACTED_KEYS`" as the reason that
 * escape hatch cannot be reopened — two rings around one property, and this export is the second.
 */
export const REDACTED_KEYS: readonly string[] = [
  ...SECRET_NAME_SUBSTRINGS, ...SECRET_EXACT_NAMES,
] as const;

/**
 * The six {@link ALLOWED_FIELDS} entries that trip {@link SECRET_NAME_SUBSTRINGS} and are
 * nevertheless emitted. Each is a COUNT, never the thing it counts. This list is the whole
 * reason the second gate can run first without destroying observability, and it is small
 * enough to read: anything larger than this is a sign the denylist term is wrong.
 *
 * A guard asserts this set is EXACTLY the set of collisions — a stale
 * exemption fails the suite, and so does a new allowlist entry that quietly needs one.
 */
export const SUBSTRING_EXEMPT_FIELDS: readonly string[] = [
  "inputTokens",       // a token COUNT from the Anthropic usage block. Not a credential.
  "outputTokens",      // idem.
  "cacheReadTokens",   // idem.
  "cacheWriteTokens",  // idem.
  "thinkingTokens",    // idem.
  "sentRecipients",    // `recipients.length` from the worker's kickstart pass. A COUNT of
                       // addresses, never an address — the addresses themselves are redacted
                       // by the `address`/`recipient` fragments.
] as const;

/**
 * Value shapes that are secrets whatever key they arrive under — the residual risk once the
 * key gate holds. Every one of these is SELF-LABELLING: it says what it is. That is the whole
 * selection rule, and the reason there is no entropy or length heuristic here.
 *
 * An entropy rule was considered and rejected on a concrete failure: `[A-Za-z0-9_-]{32,}`
 * matches a UUID, so it would redact every `accountId` and `mailboxId` on every line, which
 * breaks the one thing an operator needs at 3am and would take the end-to-end observability
 * test with it. A 43-character base64 KEK under an allowlisted key is therefore still emittable in
 * principle — and that is the stated residual: it takes a deliberate edit adding a
 * KEK-carrying value under a reviewed name, which is a diff, not an accident. The five
 * patterns below cover the accidents that have actually happened in this codebase (a driver
 * message with `host=…&user=…`, an `Authorization` header echoed into a failure line).
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[ A-Z]*(?:PRIVATE KEY|CERTIFICATE|OPENSSH)/,        // a PEM block
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.-]{8,}/i,                 // an Authorization value
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/,              // scheme://user:pass@host
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|kek)\s*[=:]\s*\S/i, // key=value in prose
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // a JWT
  /\b(?:sk-ant-|sk_live_|sk_test_|rk_live_|whsec_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/, // vendor keys
];

const REDACTION = "[redacted]";
/** What a channel becomes when its value fails its grammar. Never the value. */
const INVALID = "[invalid]";

const ALLOWED_SET = new Set(ALLOWED_FIELDS.map(normalizeKey));
const EXACT_SET = new Set(SECRET_EXACT_NAMES.map(normalizeKey));
const EXEMPT_SET = new Set(SUBSTRING_EXEMPT_FIELDS.map(normalizeKey));

/**
 * Collapse a key to its comparison form. Case, `-`, `_`, `.` and whitespace all disappear, so
 * `body_text`, `bodyText`, `Body-Text` and `BODY TEXT` are one name — and `TF_KEK_V1` becomes
 * `tfkekv1`, which contains `kek`. camelCase needs no special handling: lowercasing collapses
 * it into the same string a SCREAMING_SNAKE spelling collapses into.
 *
 * The separator stripping earns its keep on the names a fragment does NOT already span:
 * `e.mail`, `to-ken` and `sub ject` contain no secret fragment as written and would merely be
 * DROPPED by the allowlist, which hides the value but tells the operator nothing about why.
 * Collapsed, they are `email`, `token` and `subject`, and the line says `[redacted]`.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/** Identifiers. Each grammar was checked against every value this repo actually emits. */
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;                 // 97 real event names pass
const SERVICE_RE = /^[a-z][a-z0-9_-]{0,31}$/;              // api · worker · alerts · silent
const ERROR_CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;  // Error · LockLostError · String
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;            // ECONNREFUSED · 28P01 · EPIPE
/**
 * A dropped key's own PATH, which is the one thing about a dropped field that is reported.
 * A key name is authored by the code, not by a mailbox — but `{[subject]: …}` is legal
 * JavaScript, so the grammar bars whitespace, `@`, `:` and `/`, which is what a subject or an
 * address would carry, and caps the length below a base64 secret's. Anything else reports as
 * `[unnamed]`.
 */
const FIELD_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.[\]-]{0,39}$/;

/** How deep `sanitize` will walk before it stops. A log line is not a data dump. */
const MAX_DEPTH = 4;
/** Array elements kept; the last slot becomes a count when there were more. */
const MAX_ARRAY = 20;
/**
 * A single string's character bound. This is a SIZE bound and NOT a redaction — truncating a
 * secret in half leaves half a secret — so nothing here relies on it for secrecy. Its job is to
 * stop one runaway value from becoming the whole log line. No value this repo emits is close:
 * the longest is a 150-character `reason` sentence.
 */
const MAX_STRING = 1024;
/** Names reported in `droppedFields` before it stops naming them. */
const MAX_DROPPED = 12;

/**
 * Keys the logger itself authors. A payload may not supply them: `...payload` used to be spread
 * LAST, so a field named `event` or `service` silently replaced the value constructed above it.
 * They are now REMOVED from the payload before it is sanitised.
 *
 * The removal, not the spread order, is the control — and mutation testing is how that was
 * established rather than assumed. Reverting the spread to payload-last leaves every test of
 * this module green, because by then the payload no longer holds those keys; so does deleting
 * the removal, because none of these names is on {@link ALLOWED_FIELDS} and the allowlist drops
 * them anyway. Two redundant controls and no test can tell them apart. What keeps the
 * redundancy honest is the disjointness of these two lists, which a test asserts
 * directly: the day a reserved name is added to the census, the removal below stops being
 * belt-and-braces and starts being the only thing holding, and that guard says so.
 *
 * `errorClass`/`errorCode` are NOT here, and that is a deliberate departure from what was
 * recommended. Two call sites in the worker's mailbox-failure path pass `errorCode: code` (the
 * mailbox-failure taxonomy code) TOGETHER WITH `err`, and in one of them `err` is a plain string,
 * so making the logger's copy win would replace a real operator signal with `null`. They are
 * instead taken from the payload as first-class candidates and put through
 * {@link ERROR_CODE_RE}/{@link ERROR_CLASS_RE} — which closes the actual hole (an unvalidated
 * string channel) without deleting the field that hole was next to.
 */
export const RESERVED_KEYS: readonly string[] = [
  "ts", "level", "service", "event", "eventLength", "droppedFields",
  // `causeClass`/`causeCode` ARE here, and that is the opposite of the `errorClass`/`errorCode`
  // decision two paragraphs down — for a reason, not by inconsistency. Those two are reserved-but-
  // overridable because real call sites pass a MEANINGFUL `errorCode` of their own beside `err`
  // (the mailbox failure taxonomy), so letting the logger's copy win would replace an operator
  // signal with `null`. Nothing passes a `cause*` field: these exist only as a derivation from
  // `err.cause`, so a payload supplying one could only ever be overwriting a fact with a claim.
  // Reserved ⇒ removed before the census runs ⇒ unspoofable, and unforgettable at the call site.
  "causeClass", "causeCode",
] as const;

/** Collects what a single line refused, so the line can say so. */
interface Scrub { dropped: string[]; overflow: boolean }

function noteDropped(scrub: Scrub, path: string): void {
  if (scrub.dropped.length >= MAX_DROPPED) { scrub.overflow = true; return; }
  scrub.dropped.push(FIELD_NAME_RE.test(path) ? path : "[unnamed]");
}

/** `redact` — the name says secret. `keep` — the name is on the census. `drop` — unknown. */
function fieldVerdict(key: string): "redact" | "keep" | "drop" {
  const n = normalizeKey(key);
  if (!EXEMPT_SET.has(n)) {
    if (EXACT_SET.has(n)) return "redact";
    for (const fragment of SECRET_NAME_SUBSTRINGS) if (n.includes(fragment)) return "redact";
  }
  return ALLOWED_SET.has(n) ? "keep" : "drop";
}

/** A string that announces itself as a secret is not emitted whatever key carried it. */
function scrubString(value: string): string {
  for (const pattern of SECRET_VALUE_PATTERNS) if (pattern.test(value)) return REDACTION;
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
}

/**
 * Make an arbitrary value safe and JSON-representable: gate by key at every depth, pattern
 * the string values, summarise binary and collections rather than enumerating their bytes,
 * drop functions and symbols, stringify BigInt, bound depth, array length and string length.
 *
 * `Error` is handled by {@link describeError} at the call site (`err` is special-cased in
 * {@link createLogger}); a stray Error reaching here still serialises to its class name only,
 * now through the same grammar as the `err` channel.
 */
function sanitize(value: unknown, scrub: Scrub, path = "", depth = 0): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string") return scrubString(value as string);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return describeError(value).errorClass;
  // BEFORE the object branch: a Buffer is a Uint8Array, and `Object.entries` on one yields
  // index→byte pairs, so an un-summarised Buffer serialises every byte it holds as JSON.
  if (value instanceof ArrayBuffer) return `[bytes:${value.byteLength}]`;
  if (ArrayBuffer.isView(value)) return `[bytes:${value.byteLength}]`;
  if (value instanceof Map) return `[Map(${value.size})]`;
  if (value instanceof Set) return `[Set(${value.size})]`;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) {
    // Elements inherit their parent key's verdict — the parent was on the census, so its
    // contents are the operator's declared intent. Objects INSIDE the array are gated again.
    if (value.length > MAX_ARRAY) {
      const head = value.slice(0, MAX_ARRAY - 1).map((v, i) => sanitize(v, scrub, `${path}[${i}]`, depth + 1));
      return [...head, `[+${value.length - (MAX_ARRAY - 1)} more]`];
    }
    return value.map((v, i) => sanitize(v, scrub, `${path}[${i}]`, depth + 1));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path === "" ? k : `${path}.${k}`;
      const verdict = fieldVerdict(k);
      if (verdict === "redact") { out[k] = REDACTION; continue; }
      if (verdict === "drop") { noteDropped(scrub, p); continue; }
      const s = sanitize(v, scrub, p, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return String(value);
}

/**
 * The safe shape of a thrown value: class name and `code`, both put through an identifier
 * grammar. Never the message, never the stack — see the file header.
 *
 * The grammar is the string-channel half. `name` and `code` are mutable and library-supplied; neither
 * is inherently an identifier just because it usually is one. A connection string fails
 * {@link ERROR_CODE_RE} on its `://`, which is precisely the string the api-vercel host lost
 * to a log drain. It is a grammar rather than an enumerated taxonomy on purpose: an enumerated
 * list in `core` would have to know every error class in sixteen packages, and the failure mode
 * of forgetting one is blanking a real class name at the moment it matters most.
 */
export function describeError(err: unknown): { errorClass: string; errorCode: string | null } {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  const rawClass = typeof e?.name === "string" && e.name.length > 0
    ? e.name
    : e?.constructor?.name ?? "unknown";
  const rawCode = typeof e?.code === "string" ? e.code : null;
  return {
    errorClass: ERROR_CLASS_RE.test(rawClass) ? rawClass : INVALID,
    errorCode: rawCode === null ? null : ERROR_CODE_RE.test(rawCode) ? rawCode : INVALID,
  };
}

/**
 * How far down an `err.cause` chain {@link describeCause} will walk.
 *
 * Bounded, and the bound is not decoration: `cause` is a mutable property on an arbitrary object,
 * so a chain can be arbitrarily long and can be CYCLIC (`a.cause = b; b.cause = a`), and a logger
 * that can loop is a logger that hangs the process reporting the failure. The `seen` set below
 * catches the cycle and this catches the length.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * The safe shape of a thrown value's CAUSE — the same two grammars, one layer in.
 *
 * ── WHY THE CAUSE IS WORTH ANY BYTES AT ALL ────────────────────────────────────────────────
 *
 * A wrapper class is often the least informative thing about a failure. `LeaseUnavailableError`
 * exists precisely so callers can exempt an infrastructure fault BY CLASS — which means every one
 * of them logs `errorClass: "LeaseUnavailableError"` and, before this function, nothing else. On
 * 2026-08-03 that was the entire record of a mailbox that did not sync for 32 minutes: the class of
 * our own wrapper, and no trace of the imapflow error underneath it that said what the server
 * refused.
 *
 * ── AND WHY IT IS EXACTLY `name` + `code`, THROUGH THE SAME GRAMMARS ───────────────────────
 *
 * This is {@link describeError} applied one level in, deliberately reusing it rather than
 * paraphrasing it: `name` and `code` are mutable and library-supplied, a driver puts a connection
 * string wherever it likes, and the grammar is what catches that (`ERROR_CODE_RE` rejects a `://`).
 * Nothing else travels. In particular imapflow's `serverResponseCode` may NOT — it is built by
 * uppercasing the SERVER's own bracket atom, so `* NO [SECRETPASSWORD123]` is a server-chosen
 * string wearing an identifier's clothes and it passes any grammar you can write. Its only safe
 * destination is `mailboxes.error_detail`, where MEMBERSHIP of a closed set is tested; membership
 * cannot be forged, a grammar can. And `responseText` never: harmless on a FETCH, and on a LOGIN
 * refusal it echoes the login argument, which is the same string-channel leak exactly.
 *
 * ── THE WALK STOPS AT THE FIRST `code` ────────────────────────────────────────────────────
 *
 * A code is the operationally useful half, and it is the wrapper that lacks one — so the loop keeps
 * descending only while it has found no code, and reports the deepest layer it reached. That yields
 * `ETIMEOUT` from under a `LeaseUnavailableError`, rather than the shrug the immediate layer gives.
 */
function describeCause(err: unknown): { causeClass: string; causeCode: string | null } | null {
  let cur: unknown = (err as { cause?: unknown } | null)?.cause;
  const seen = new Set<unknown>();
  let out: { causeClass: string; causeCode: string | null } | null = null;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || cur === undefined || seen.has(cur)) break;
    seen.add(cur);
    const d = describeError(cur);
    out = { causeClass: d.errorClass, causeCode: d.errorCode };
    if (d.errorCode !== null) break;
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** Where a rendered line goes. Injected so a test can read what was written. */
export type LogSink = (line: string) => void;

export interface Logger {
  readonly level: LogLevel;
  /** A logger with `fields` merged into every line it and its children emit. */
  child(fields: LogFields): Logger;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** `api` / `worker` / `alerts` — the first thing an operator filters on. Validated once. */
  service: string;
  /** Minimum level emitted. Defaults to `TF_LOG_LEVEL`, else `info`. */
  level?: LogLevel;
  /** Bindings merged into every line (`requestId`, `accountId`, `mailboxId`, …). */
  fields?: LogFields;
  /** Injected sink; defaults to stdout via `console.log`. */
  sink?: LogSink;
  now?: () => Date;
}

/** `TF_LOG_LEVEL` if it names a level, else `info`. An unknown value is not a reason to be silent. */
export function levelFromEnv(env: Record<string, string | undefined> = {}): LogLevel {
  const raw = (env.TF_LOG_LEVEL ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

/**
 * The default sink. Everything goes to stdout — including `error` — because both hosts
 * (serverless functions, worker containers) capture stdout and stderr into the same drain, and
 * splitting them only makes a log stream interleave unpredictably.
 *
 * Wrapped: a closed stdout raises `EPIPE`, and a logger that throws is worse than no logger.
 */
const defaultSink: LogSink = (line) => {
  try { console.log(line); } catch { /* EPIPE on a closed stdout — dropping the line is correct */ }
};

/**
 * The event name, or the fact that it was refused.
 *
 * `logger.error(err.message)` is the shape this exists for: `event` used to go into the line
 * without passing through anything. A refused event reports its LENGTH and nothing else — no
 * hash, deliberately. A short hash of a low-entropy secret (a six-digit OTP is the case that
 * matters) is reversible by brute force in microseconds, so a "fingerprint" of a
 * refused value would reintroduce the leak it was meant to summarise.
 */
function describeEvent(event: unknown): { event: string; eventLength?: number } {
  if (typeof event === "string" && EVENT_RE.test(event)) return { event };
  return { event: "invalid_event", eventLength: typeof event === "string" ? event.length : 0 };
}

/** Read a logger-owned identifier out of the payload, removing it, and hold it to its grammar. */
function takeIdentifier(fields: LogFields, key: string, re: RegExp): string | undefined {
  if (!(key in fields)) return undefined;
  const raw = fields[key];
  delete fields[key];
  if (typeof raw !== "string") return INVALID;
  return re.test(raw) ? raw : INVALID;
}

/**
 * Build a logger. Cheap enough to construct per request (it is three closures and an object),
 * so `child()` per request/mailbox is the intended usage rather than a global singleton.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  const level = opts.level ?? levelFromEnv(globalThis.process?.env ?? {});
  const bound: LogFields = { ...opts.fields };
  // Construction-time and validated: `service` is the third direct string channel, and it is
  // written into every line this logger will ever emit.
  const service = typeof opts.service === "string" && SERVICE_RE.test(opts.service)
    ? opts.service
    : "invalid_service";

  function emit(lvl: LogLevel, event: string, fields?: LogFields): void {
    if (RANK[lvl] < RANK[level]) return;
    try {
      const merged: LogFields = { ...bound, ...fields };
      // `err` is the one key with a special contract: it is a THROWN value, and it becomes
      // `errorClass` + `errorCode`. Doing it here rather than at the call site is what makes
      // "we never log a driver message" a property of the logger instead of a convention.
      const thrown = "err" in merged ? merged.err : undefined;
      delete merged.err;
      const fromErr = thrown === undefined ? null : describeError(thrown);
      // The CAUSE, one wrapper in. Derived HERE and not at the call site for the reason `err`
      // itself is: a fact a call site has to remember to extract is a fact that is missing from the
      // one line that mattered. It goes into the line below the `RESERVED_KEYS` sweep, so a payload
      // field of the same name is dropped rather than able to overwrite it.
      const fromCause = thrown === undefined ? null : describeCause(thrown);
      // The payload's own error taxonomy WINS over the thrown value's — see RESERVED_KEYS.
      const payloadClass = takeIdentifier(merged, "errorClass", ERROR_CLASS_RE);
      const payloadCode = takeIdentifier(merged, "errorCode", ERROR_CODE_RE);
      const errorClass = payloadClass ?? fromErr?.errorClass;
      const errorCode = payloadCode !== undefined ? payloadCode : fromErr ? fromErr.errorCode : undefined;

      const scrub: Scrub = { dropped: [], overflow: false };
      for (const key of RESERVED_KEYS) {
        if (key in merged) { noteDropped(scrub, key); delete merged[key]; }
      }
      const payload = sanitize(merged, scrub) as Record<string, unknown>;
      const dropped = scrub.overflow ? [...scrub.dropped, "[+more]"] : scrub.dropped;
      const line = {
        ts: now().toISOString(),
        level: lvl,
        service,
        ...describeEvent(event),
        ...(errorClass === undefined ? {} : { errorClass }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(fromCause === null ? {} : { causeClass: fromCause.causeClass }),
        ...(fromCause?.causeCode == null ? {} : { causeCode: fromCause.causeCode }),
        ...payload,
        ...(dropped.length === 0 ? {} : { droppedFields: dropped }),
      };
      sink(JSON.stringify(line));
    } catch {
      // A logger must not be able to break the code that is reporting a failure. If even
      // JSON.stringify failed (a cyclic object slipped past `sanitize`'s depth bound), the
      // line is lost — which is strictly better than the caller's catch block throwing.
      // The cost is that a redaction bug is silent too, which is why the guard asserts the
      // bytes handed to `sink` and not what `sanitize` returned.
    }
  }

  const logger: Logger = {
    level,
    child(fields: LogFields): Logger {
      return createLogger({ ...opts, level, fields: { ...bound, ...fields }, sink, now });
    },
    debug: (event, fields) => { emit("debug", event, fields); },
    info: (event, fields) => { emit("info", event, fields); },
    warn: (event, fields) => { emit("warn", event, fields); },
    error: (event, fields) => { emit("error", event, fields); },
  };
  return logger;
}

/**
 * A logger that emits nothing.
 *
 * The default for every optional `logger` seam in this repo: a library must not print to a
 * host's stdout because the host forgot to inject one, and a test must not have to mute a
 * global. Hosts inject a real logger; everything else stays quiet.
 */
export const silentLogger: Logger = createLogger({ service: "silent", level: "error", sink: () => {} });
