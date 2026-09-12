/**
 * Structured logs — one JSON object per line, on the paths where a silent failure costs money or
 * mail. Dependency-free: a log line is `JSON.stringify` plus a newline, and the hard parts —
 * redaction, never throwing, error serialisation — are ours to decide. In `core`, the highest
 * package both the worker and the API can reach. An ALLOWLIST, not a denylist: a denylist is a
 * list of spellings someone thought of, and every composite (`imapPassword`, `TF_KEK_V1`)
 * survived it. A dropped key's NAME is reported in `droppedFields`; the denylist runs FIRST, so
 * adding `imapPassword` to the allowlist fails closed. Never throws; gates by KEY at every depth;
 * string channels are GRAMMARS; `err` is CLASS + CODE, never message + stack.
 */

/** Ordered least → most severe. A logger emits an event when its level is at or above `level`. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Arbitrary structured context attached to a line. Values must be JSON-representable. */
export type LogFields = Record<string, unknown>;

/**
 * The census: every field name any caller passes to a logger, and nothing else — a key not here
 * has its value dropped at every depth and its NAME reported in `droppedFields`. A frozen
 * literal: the list is the claim, a diff to it is the review. Extracted mechanically from every
 * logger call in `packages/**` and `apps/**`, funnels included (the lease callback, the `ai_call`
 * spread, the sidecar's log seam). The sidecar-only census scope has a measured cost: this list
 * has refused live lines several times, all in `apps/worker`, the package the scanner does not
 * cover. `err`, `errorClass` and `errorCode` are deliberately absent: logger-owned slots handled
 * before this gate runs.
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
  /**
   * Three folder-shaped names, and the values they may carry are NOT folder names:
   * `fromFolder`/`toFolder`/`folderLabel` are written only through `sync.ts#folderLabel`, which
   * answers one of the six organized folders or the literal `"other"`. That is why they are new
   * names rather than the `folder` the reconcile lines already pass: `folder` carries a RAW
   * server path — a folder a person made is their own words — so admitting THAT name would leak
   * ten existing call sites' values in one edit. `ref` is a `uidvalidity:uid` pair — digits and a
   * colon, minted by the server's numbering.
   */
  "fromFolder", "toFolder", "folderLabel", "ref",
  // `threadId`/`candidateThreadId` are `threads.id` ROW UUIDs, the same non-secret shape and the
  // same justification as `messageId` one entry up: the thread-join heal's verdict line names
  // WHICH two threads it judged (survivor, examined sibling) or the fix cannot be audited —
  // its first prod dry run read `droppedFields=["target","candidate",…]` and said nothing.
  // What that line deliberately does NOT carry: the threads' subject (deny-listed content) and
  // the counterparty overlap (mail addresses); both stay in the database the ids point into.
  // `merged` is the heal's `++` counter of absorbed threads — the `flipped`/`drained` class.
  // `moved` is its messages-moved counter, and was ALREADY being handed over and refused by two
  // standing worker lines (`rule_retro_pass`, `ohbox_tidy_pass`) — this entry lets all three say
  // the number they exist to report.
  "threadId", "candidateThreadId", "merged", "moved",
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
  // The SEND path's phase durations and `sendId`, added WITH the line that emits them.
  // `send_phases` decomposes one attempt: reservation, attachment assembly, the cold dial
  // (`openMs`, on some providers the largest and most variable phase), the SMTP session and Sent
  // APPEND, the finalize, the sent-copy projection. The point of the line is the SPLIT — a total
  // nobody can decompose made "sending is slow" an investigation — so a census keeping `totalMs`
  // and dropping the six keeps the one number that was never the question. Added after this list
  // refused them on the first real run; the suite could not see it because it asserts a FAKE
  // logger. Every value is a millisecond delta; `sendId` is the `outbound_sends` row UUID — never
  // the recipient, the subject, or the minted `Message-ID`, which reads like an address and is
  // logged nowhere.
  "reserveMs", "assembleMs", "openMs", "submitMs", "finalizeMs", "projectMs", "sendId",
  "reason", "detail", "kind", "severity", "phase", "state", "verdict", "configVar",
  // The `SIZE` back-fill pass's counts and its two per-mailbox facts, added WITH the lines that
  // emit them — this census has silently swallowed instrumentation before, and suites cannot see
  // it: a test that injects a fake logger asserts what a call site HANDS OVER, never what this
  // list lets through. `announcedBytes` is the RFC 1870 `SIZE` a submission server published — a
  // fact about a server's configuration. `code` is a member of the closed `SmtpSizeFailure` set
  // and never the server's own words: `reason` is allowlisted and the value scrubber only redacts
  // strings that label themselves, so a remote AUTH response must not be able to arrive under
  // either name. `stamped` is the durable half (mail 0063): rows that now remember they were
  // dialled — deliberately not `considered`, since a mailbox whose credentials rotated mid-dial
  // stays unstamped and due.
  "considered", "learned", "silent", "skipped", "failed", "announcedBytes", "stamped",
  "disabledReason", "stoppedBy", "heldBy",
  // ── `ownClaimTerm`: HOW A MAILBOX'S HOLDER RELATES TO THE INSTALL THAT STOOD DOWN ─────────
  //
  // A closed five-member literal the call site holds, `op`'s reason one shelf down: install id,
  // then the nonce that install last armed. A stand-down says `organized_elsewhere:*` and nothing
  // about whether the holder is a stranger, a restored copy, or a claim the install wrote itself —
  // and those want opposite answers. The comparison, never its operands: no install id and no
  // nonce reaches the line.
  "ownClaimTerm",
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
  // `detectedBy` is HOW a dead connection was noticed, and it is on the census for `op`'s reason
  // one line up: a compile-time literal from a two-member union the CALL SITE holds, not a fact
  // derived from a thrown value. Its two members are `"event"` (the adapter's own `close`/`error`
  // listener, which fires in seconds) and `"bound"` (the duration bound over failing cycles, the
  // arm that works for a connection whose death produced no event at all — every injected double
  // with no event surface takes it). Telling them apart is the whole diagnostic value of the
  // line: the same silent stop reached two ways means two different things about the socket, and
  // without the name both read as one sentence.
  "detectedBy",
  // `closed`: how many appointments a stand-down ended, added WITH the lines that emit it. A
  // mailbox changing organizer ends every pending send-later appointment — the pass that would
  // have kept them is behind the gate that just said no, and the appointment does not travel. All
  // three stand-down sites report the count, and the count is the ONLY thing reported about those
  // messages: which message, to whom and for when are facts about somebody's mail and stay in the
  // database. Added in the same change as the call sites — the sidecar's census guard read
  // `scheduled_sends_stood_down passes 'closed'` on its first run, so without this entry the one
  // line recording a person's send not happening would have been emitted with the number stripped
  // out.
  "closed",
  // ── counts and roster arithmetic (the worker's roster pass, kickstart, thread backfill) ──
  "accounts", "accountsAffected", "mailboxes", "maxMailboxes", "selected", "serving",
  "dropped", "unexplained", "examined", "resolved", "rerouted", "pruned", "count", "more",
  // ── THE STAND-DOWN'S HANDOVER, three counts of OUR OWN bookkeeping ──
  //
  // `organizer_stand_down_moves_handed_over` (both hosts) reports how many pending local moves
  // left for the install that holds the mailbox now, how many were already travelling, and how
  // many named a folder no destination word covers. `more` is one shelf up already. Without these
  // the one line that makes a handover countable was emitted with three of its four numbers
  // stripped — the sidecar's census read `exported: expected 'dropped' to be 'keep'`, which is
  // the same shape that caught `closed` above.
  "exported", "already", "unmappable",
  // ── the organizer's request drain, added WITH its call sites (0.14.1) ──
  //
  // Three integers counting RECORDS a drain handled: how many decisions it applied, how many it
  // refused as malformed or unhandled, how many outstanding ones aged out. Same class as
  // `examined` / `pruned` / `dropped` above and kept for the same reason — a line that says a
  // drain ran and strips the numbers says nothing about whether it did anything. None of the
  // three can carry mail: each is produced by `apps/worker/src/request-drain.ts` as a counter it
  // incremented itself, never read off a record.
  "applied", "refused", "expired",
  "sample", "claims", "threadsCreated", "contactsImported", "sentRecipients", "truncated",
  "maxPages", "healthPort", "signal",
  // ── The desktop host door's loopback listener (`host_listening`), added WITH the call site ──
  //
  // The port the engine bound on 127.0.0.1 — an integer the shell itself configured and passes
  // at spawn, so the line tells it nothing it does not already know; it exists to correlate a
  // bind with the `tailscale serve` target. Never an address, never an origin: the served
  // MagicDNS name carries the machine and tailnet names, which is exactly the identifying
  // signal this census keeps off a log line.
  "port",
  // ── The local engine's per-drain timing (`sync_drain`), added WITH the call site ──
  //
  // `cycles` is the inner-cycle count of one drain; `totalMs` and `slowestMs` are wall-clock
  // milliseconds from `Date.now()` deltas (`summarizeDrain`). All three are integers derived from a
  // counter and a clock — structurally content-free, naming no mailbox and no message — and they are
  // the read that attributes desktop CPU and quit lag to the pipeline. NAMED rather than folded into
  // `count`, on this file's own rule: `totalMs` and `slowestMs` are different quantities and one
  // `count` meaning either is not a claim a reviewer can check. (`drained` is already above.)
  "cycles", "totalMs", "slowestMs",
  // The three cron-pass counts, added WITH the call sites: `generated` (proposals stored),
  // `flipped` (bubble-ups resurfaced) and `drained` (workflow runs executed) are return values
  // accumulated by `+=` from a `.length` or a local counter — structurally integers, no content.
  // NAMED rather than folded into `count`, per this file's header: one `count` meaning three
  // quantities is not a claim a reviewer can check. Deliberately absent: `pass`, `ran` and
  // `skipped` — WHICH pass ran is encoded in the event NAME (`cron_proposals_ran`), a validated
  // grammar with no allowlist behind it, so it costs nothing, while every entry added here is
  // another chance to repeat the attach-phase mistake.
  "generated", "flipped", "drained",
  // `rescued` is GONE with its call sites: it was the bubble-up reconciliation's counter, and
  // that pass was removed when resurfacing stopped forcing read state — an entry with no emitter
  // is exactly the standing exception this file's header forbids. The local store's
  // bloat-compaction line: `beforeBytes`/`afterBytes` are `pg_total_relation_size()` reads and
  // `liveEstimateBytes` is arithmetic over catalog statistics — integers naming no mailbox and no
  // message. They are the whole evidence for a once-per-install table rewrite (measured: 21 GB on
  // disk over ~1.6 GB of data), so a line reading only `droppedFields` would hide exactly the
  // numbers the event exists to report. NAMED rather than folded into `count`, per this file's
  // rule.
  "beforeBytes", "afterBytes", "liveEstimateBytes",
  // …and `compactMs` rides `boot_phases` beside the other phase timings — a `Date.now()` delta
  // over the same pass, named for the same reason the attach-phase timings are.
  "compactMs",
  // The sender-name/recipients backfill's three counters, added WITH the call sites: `scanned`
  // (candidate rows read), `fillable` (rows whose stored headers can supply a value) and
  // `written` (rows the guarded UPDATE took) — integers accumulated from local counters,
  // structurally content-free. Added in the SAME change as the call sites rather than after a
  // live run refused them; the pass logs progress across tens of thousands of rows, and a line
  // reading only `droppedFields` cannot distinguish a slow run from a stalled one. The pass's
  // other numbers reach the operator through the runner's console summary; the cursor is logged
  // as `messageId`, not a new `lastId`. What must never appear here is a key named for the VALUES
  // the pass moves — `fromName`, `toAddresses`, `ccAddresses` are somebody's mail; the pass logs
  // counts of them and never one of them.
  "scanned", "fillable", "written",
  // The sensitivity-false-positive repair's counts, added AFTER the first live run refused them —
  // the pass shipped and its first live line read `droppedFields=[…]` with every number the line
  // existed to report, leaving `examined` alone on a line about a correction to somebody's mail;
  // the worker's tests inject a fake logger and assert what the call site hands over, never what
  // this census lets through. All are structurally content-free: integers from local counters,
  // plus two booleans from a budget comparison and a RETURNING row count. NAMED rather than
  // folded into `count`: `cleared` and `stillSensitive` are the two halves of the only question
  // an operator asks — how much mail became readable, and how much was correctly left alone.
  // `clearedFromStored` is counted APART from `cleared` because the outcomes differ: one restores
  // the body, one only the metadata.
  "candidates", "fetched", "cleared", "clearedFromStored", "stillSensitive", "unreadable",
  "mismatched", "capped", "marked",
  // `undecided`, `walk` and `maxWalks`, added WITH the marker-honesty ruling. They exist because
  // the completion marker used to certify over messages the pass could not READ: a dropped
  // connection refused a message for the life of the process, the walk finished, the durable
  // marker landed, and that message stayed redacted for ever with nothing recording that a
  // decision was owed. `undecided` is the `Set.size` of those, `walk` which re-attempt this was,
  // `maxWalks` the bound — integers from counters and a module constant. The message IDS
  // deliberately do NOT appear on a log line and live on the pass's jsonb audit row instead:
  // `messageId` (singular) is allowlisted for a row-scoped line; a `messageIds` entry would
  // license an unbounded list of uuids on one line.
  "undecided", "walk", "maxWalks",
  // `tripped` is the inbound-quiet pass's half of a pair whose other half (`cleared`) is already
  // above: how many mailboxes ENTERED a quiet episode this pass (`apps/worker/src/inbound-quiet.ts`,
  // mail 0078) versus how many episodes ended because genuine inbound resumed. A `+= 1` counter
  // over the account's own mailbox rows, never derived from an address, a subject or a sender —
  // the pass's log lines carry ids and these two counters and nothing else. Named rather than
  // folded into `count` on this file's own rule: entering and leaving an episode are the two
  // different questions an operator asks, and one `count` meaning either is not checkable.
  "tripped",
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
  // `folders` is the tag repair's twin for the folder rail: how many `folder` entity rows the
  // one-time folder backfill (`apps/sidecar/src/cloud-mirror.ts`) restored on a mirror whose
  // cursor had advanced past them before the apply loop stored that type. A `++` counter over a
  // snapshot page, never a folder's NAME — a folder name is the user's own filing vocabulary,
  // which is exactly the signal this census keeps off the line. Named rather than folded into
  // `count` for the reason `tags` was: the event says the repair ran, this says whether the
  // Folders rail came back.
  "folders",
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
  // SEND LATER's pass (mail 0077), added WITH the call sites. `draftId` is the `drafts.id` row
  // UUID the pass names when it acts on one appointment — the same non-secret shape as
  // `messageId`; what the pass deliberately does NOT log: the draft's subject, recipients, body.
  // `claimed`/`sent`/`unverified`/`deferred` are the summary's `++` counters, named rather than
  // folded into `count`: an operator asks which appointments DELIVERED, which ended ambiguous,
  // and which are merely waiting out a blip — three different 3am questions. `sent` also repairs
  // a standing drop: the `away_responder_pass` line has handed it over since that pass shipped
  // and the census refused it every time, leaving a line about outbound mail unable to say how
  // much mail went out.
  "draftId", "claimed", "sent", "unverified", "deferred",
  // ── The REQUEST DRAIN's own counter, added WITH its call sites ──
  //
  // `applied` / `refused` / `deferred` are already here; `standing` is the fourth outcome and it
  // is separated on this file's own "three different 3am questions" rule. It counts records the
  // organizer deliberately left alone — a future protocol version, or a kind this build has no
  // applier for — which is the one outcome where a NONZERO value is unremarkable: it means a
  // newer install is talking to an older one, and the records become applicable when that one
  // updates. Folding it into `refused` would make an ordinary version skew read as a run of
  // rejected decisions; folding it into `deferred` would promise a retry that changes nothing.
  "standing",
  // The SEND RECONCILER's two counters, added WITH the call sites. `resolvedElsewhere` is how
  // often this pass raced another resolver and lost the compare-and-swap — healthy in ones, a
  // sign of a second clock if it dominates — and `gaveUp` is the strictly worse number: rows
  // closed as ambiguous because a whole day of cycles could not decide them. Folding either into
  // `deferred` would hide the one outcome where somebody's draft was settled by a clock rather
  // than by evidence. Both are `++` counters, structurally integers. `decidedBy` is a member of
  // the closed `ResolveStaleBy` union — five literals this repository wrote — and never a
  // server's words; spelled out rather than `by`, because a two-letter generic name on a GLOBAL
  // allowlist is an open door for the next call site.
  "resolvedElsewhere", "gaveUp", "decidedBy",
  // The AWAY RESPONDER's pass (mail 0087), added WITH the call sites. An operator reading
  // `away_responder_pass` asks how many correspondents were ANSWERED, how many were held back
  // because answered recently (`throttled`), and how many a guard refused outright (`suppressed`)
  // — three situations with three fixes; folding them into `count` would make the line unable to
  // distinguish "working" from "refusing everybody". All three are `++` integers. `throttle` is
  // the SETTING's name — one of four closed literals, never a value anybody typed. The sharpest
  // omission on this file: the CORRESPONDENT'S ADDRESS. `away_replies.sender` is somebody else's
  // personal data, and a log line naming who wrote to a person while they were away is a
  // disclosure about both of them; the lines carry ids that point into rows the deletion sweep
  // erases, and the responder's own text is never logged.
  "throttled", "suppressed", "throttle", "deferredAccounts", "deferredCandidates",
  // `undeliverableMarked` is the same pass's fifth number and it was NOT on this census, so the
  // one line that reports a correspondent's address going dead has been dropping it since the
  // bounce slice shipped — the `sent` failure this entry's own paragraph records, one field over,
  // found by `log-fields.test.ts`'s away case rather than by a live log. A `++` counter over rows
  // the pass itself stamped: structurally an integer, and it can carry no mail.
  // (`expired`, the sixth, is already on this list as the request drain's own counter.)
  "undeliverableMarked",
  // `mirrorDraining` is the OTHER half of the same `shutdown` line, and it is here because
  // `inFlight` alone was misleading rather than merely incomplete: the Cloud mirror's pull is not a
  // stdio request, so `inFlight` reads 0 in exactly the case where the mirror is what the quit is
  // waiting for. A literal boolean read off `CloudMirror.draining()` (`inflight !== null`), so it
  // is structurally content-free — the same shape and the same argument as `changed` above.
  "mirrorDraining",
  // The desktop engine's BOOT phases (`boot_phases`), added WITH the call sites — the
  // attach-phase lesson applied before the fact. Both sidecar doors serve the bridge only once
  // their constructor returns, so the window's "Opening your mailbox" screen lasts exactly as
  // long as that constructor — and a single start-to-finish number could not say WHICH phase
  // owned it. These five can: `pgliteOpenMs` (WASM instantiation plus Postgres startup),
  // `adoptBaselineMs` and `migrateMs` (the two schema passes), `worldMs` (the mailbox row and
  // launch session), `totalReadyMs` (the whole constructor) — the four subtracted from the total
  // are the unnamed remainder, a reading rather than a guess. All five are `Date.now()` deltas
  // naming no mailbox, no address and no path.
  "pgliteOpenMs", "adoptBaselineMs", "migrateMs", "worldMs", "totalReadyMs",
  // The engine's own memory — `process.memoryUsage()`'s three numbers, as `engine_vitals` reports
  // them on a timer beside `boot_phases`. Integers from the runtime, naming nothing a person
  // wrote. `external` matters most on this door and is why all three are named rather than
  // folded: a WASM database keeps its heap OUTSIDE the JavaScript heap, so `heapUsed` alone
  // describes a fraction of the process and `rss` alone cannot say which half is growing. Added
  // because nothing in this repository had ever called `memoryUsage`. Deliberately NO threshold
  // attached — a bar set before the first measurement would be a number somebody invented.
  // `storeBytes` is the WASM heap the local store runs Postgres inside — a FLOOR, so the reading
  // worth acting on is one that grows with the mailbox.
  "rss", "heapUsed", "external", "uptimeMs", "storeBytes",
  // WHERE THAT READING CAME FROM, added WITH the line that emits it. `engine_vitals` runs on every
  // door, and one of them — the engine running inside a phone app rather than in a Node process —
  // has no memory reading at all. The three numbers above are then null, and a run of nulls is
  // indistinguishable from a sampler that is broken unless the line says which it is. Two literals
  // chosen by the emitter (`process` / `unavailable_in_this_runtime`); it names no mailbox, no
  // address, no path and nothing a person wrote.
  "memoryReading",
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
  // A crash the contract deliberately did NOT exit on, added WITH its call site. `survived` is a
  // `++` counter on `uncaught_exception_survived` — how many times the crash handlers have met an
  // uncaught throw its host named as survivable rather than exiting (today one shape: a database
  // driver throwing from a timer when a connection dies with a write buffered, whose only effect
  // on `exit(1)` is a restart loop through the outage). It is here because it is the ESCALATION
  // SIGNAL and there is no other: one of these is a known driver defect riding out an outage, and
  // a thousand is a process that should have died an hour ago. The line runs only when something
  // has already gone wrong, so a census drop would leave `droppedFields=["survived"]` exactly
  // where an operator is sizing a suppression.
  "survived",
  // The auto-suggest pass's own count, added WITH its call site. `bought` is the number of held
  // senders a pass stored an advisory suggestion for — a `++` counter under a fixed page,
  // structurally an integer naming no sender, subject or verdict. NAMED rather than folded into
  // `count`: "how many were eligible" and "how many were answered for" are different quantities
  // and the gap between them IS the reading — a pass that examined ten and bought three stopped
  // early, the one thing this line exists to make visible. It matters most on the desktop, where
  // the pass runs against a model the person is paying for directly, and
  // `droppedFields=["bought"]` would leave no record of what was done on their key.
  "bought",
  // The known-set memo's per-cycle census (`known_set_read`), added AFTER the first live run
  // refused ALL FOUR — every live line read
  // `droppedFields=["rows","bytes","bytesSaved","droppedBy"]` while the `reason` sentence
  // explaining them survived. All four are content-free: `rows` is a `.length`; `bytes` and
  // `bytesSaved` are sums of column WIDTHS — arithmetic over lengths, never values. `droppedBy`
  // is the only string: a `WorkerRepo` method name from a property key, or a leadership sentence
  // the worker hands `KnownSetCache.drop` — nothing runtime-composed. NAMED because the reading
  // IS the ratio of the last two, and `droppedBy` makes the line actionable: a memo re-reading
  // every cycle is a classification bug in `KNOWN_SET_NEUTRAL`. `dbReads` and `hits` are absent:
  // the event's existence already says what `dbReads` would.
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
  // WHICH arm, and what happened to it — the per-sink half of the same story. A pager with two
  // vendors can lose one of them without losing a single page, so "did anything get through"
  // stopped being a sufficient question; `sink` names the arm, `outcome` is the CLOSED code for
  // its last attempt (never the vendor's prose — that rides in `sinkErrors`, which is already
  // bounded and redacted by the sink), and `survivors` names the redundancy that is left.
  // `outcome` is a token from a closed set and `sink` is an author-written sink name, so both
  // are structurally content-free in this census's sense.
  "sink", "outcome", "survivors",
  // ── AI cost accounting: AnthropicCallReport, spread wholesale as `ai_call`. Per-action cost is
  //    measured from these five token counts, which is why they are named rather than eaten
  //    by a `token` substring rule. See SUBSTRING_EXEMPT_FIELDS.
  "model", "ok", "latencyMs", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "thinkingTokens", "costMicroUsd",
] as const;

/**
 * Name FRAGMENTS that mean "never write this value", matched as a SUBSTRING of the normalised key
 * — which is what catches `imapPassword`, `smtp_password`, `TF_KEK_V1` and `Set-Cookie` under one
 * entry each. Short, ambiguous words are deliberately NOT here — they live in {@link
 * SECRET_EXACT_NAMES}: `pass` as a substring eats `passed` and `bypass`, `text` eats `context`,
 * `key` eats `alertKey` and `keyVersion`. Precision matters less than it used to (an unmatched
 * key is dropped by the allowlist rather than emitted), but a false positive here silently blanks
 * a field the allowlist deliberately keeps.
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
 * ordinary words: `pass` eats `passed`, `text` eats `context`, `key` eats `alertKey`. The last
 * five are `crypto.ts`'s envelope components. `reason` is deliberately absent from both lists:
 * ~40 call sites pass it a static English sentence the author wrote. `keyVersion` is absent too:
 * a KEK VERSION is an integer the health endpoint already publishes; it is simply not on {@link
 * ALLOWED_FIELDS}, so it is dropped rather than redacted. Nothing here duplicates a fragment
 * above — `secretEnc`, `stackTrace` and `bodyText` are covered by `secret`, `stack` and `body`.
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
 * Value shapes that are secrets whatever key they arrive under — the residual once the key gate
 * holds. Every one is SELF-LABELLING, and that is the whole selection rule. An entropy rule was
 * rejected on a concrete failure: `[A-Za-z0-9_-]{32,}` matches a UUID, so it would redact every
 * `accountId` and `mailboxId` — breaking the one thing an operator needs at 3am. A base64 KEK
 * under an allowlisted key is therefore still emittable in principle — the stated residual: it
 * takes a deliberate edit under a reviewed name, a diff, not an accident. The patterns cover the
 * accidents that have actually happened here (a driver message with `host=…&user=…`, an echoed
 * `Authorization` header).
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
 * Collapse a key to its comparison form: case, `-`, `_`, `.` and whitespace all disappear, so
 * `body_text`, `bodyText`, `Body-Text` and `BODY TEXT` are one name — and `TF_KEK_V1` becomes
 * `tfkekv1`, which contains `kek`. camelCase needs no special handling: lowercasing collapses it
 * into the same string a SCREAMING_SNAKE spelling collapses into. The separator stripping earns
 * its keep on names a fragment does not already span: `e.mail`, `to-ken` and `sub ject` contain
 * no secret fragment as written and would merely be DROPPED, which hides the value but tells the
 * operator nothing; collapsed, they are `email`, `token` and `subject`, and the line says
 * `[redacted]`.
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
 * LAST, so a field named `event` silently replaced the constructed value. They are now REMOVED
 * before sanitising — and the removal, not the spread order, is the control, established by
 * mutation testing: reverting the spread leaves every test green, and so does deleting the
 * removal — two redundant controls no test can tell apart; what keeps that honest is the
 * DISJOINTNESS of the two lists, asserted directly. `errorClass`/`errorCode` are NOT here: two
 * worker sites pass `errorCode` with a string `err`, so the logger's copy winning would replace a
 * real signal with `null` — they go through the grammars instead.
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
  // `errorText` is here on `causeClass`'s reading: it exists only as a derivation from a thrown
  // primitive ({@link describeThrownText}), so a payload supplying one could only dress a message
  // up as the throw. Redundant with the census while it stays off ALLOWED_FIELDS, which is the
  // disjointness the log suite asserts for every name on this list.
  "errorText",
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

/** One definition of the length bound, shared by the two string channels below. */
function boundString(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
}

/** A string that announces itself as a secret is not emitted whatever key carried it. */
function scrubString(value: string): string {
  for (const pattern of SECRET_VALUE_PATTERNS) if (pattern.test(value)) return REDACTION;
  return boundString(value);
}

/**
 * An address inside a free-text string, replaced by its shape. `SECRET_VALUE_PATTERNS` redacts a
 * whole string that ANNOUNCES a secret; this is the other case, where the sentence is the
 * diagnosis and one token inside it is somebody's mailbox — redacting the whole line would throw
 * the diagnosis away. The domain must be dotted, so a `user:pass@host` inside a URL is left for
 * the pattern above to refuse whole rather than half-masked into something that pattern no longer
 * matches — which is why {@link redactThrownText} runs the patterns FIRST.
 */
const ADDRESS_IN_TEXT = /[^\s<>()[\]:;,"']+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
/** What an address becomes. Not `[redacted]`: the reader is meant to see that one WAS there. */
const ADDRESS_MASK = "[address]";

/**
 * The one channel that carries a stranger's prose. `err` reduces to class and code so no driver
 * message reaches a log; a thrown STRING is the exception — no `name`, no `code`, so reducing it
 * discards the whole diagnosis. The text is kept and put through two readings: the secret
 * patterns, which refuse the WHOLE string (a `host=…&user=…` message is not partially safe); then
 * the address mask, which keeps the sentence and takes the mailbox out — and only then the length
 * bound, so a truncation cannot cut an address in half and leave the half in. The residual is
 * anything ELSE a stranger's message might carry, which is why this exists for a thrown string
 * and never for an `Error`'s `message`.
 */
function redactThrownText(text: string): string {
  for (const pattern of SECRET_VALUE_PATTERNS) if (pattern.test(text)) return REDACTION;
  return boundString(text.replace(ADDRESS_IN_TEXT, ADDRESS_MASK));
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
 * The safe shape of a thrown value: class name and `code`, both through an identifier grammar.
 * Never the message, never the stack — see the file header. The grammar is the string-channel
 * half: `name` and `code` are mutable and library-supplied, and neither is inherently an
 * identifier just because it usually is one — a connection string fails {@link ERROR_CODE_RE} on
 * its `://`, which is precisely the string the api-vercel host once lost to a log drain. A
 * grammar rather than an enumerated taxonomy on purpose: a list in `core` would have to know
 * every error class in sixteen packages, and forgetting one blanks a real class name at the
 * moment it matters most.
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
 * THE TEXT OF A THROWN STRING — the one thrown value whose whole diagnosis is its text.
 *
 * `throw "…"` reduces to `errorClass: "String", errorCode: null`, a line saying a string was
 * thrown and nothing about which one. This is NOT the `errorDetail` this file removed: an
 * `Error`'s `message` is driver-written and quotes connection strings and credentials, and stays
 * discarded. A thrown primitive has no `message` — the value IS the diagnosis, it is unreachable
 * from a payload key ({@link RESERVED_KEYS}), and it takes the same value scrubber and length
 * bound as every allowlisted string.
 */
function describeThrownText(err: unknown): string | null {
  return typeof err === "string" && err.length > 0 ? redactThrownText(err) : null;
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
 * The safe shape of a thrown value's CAUSE — the same two grammars, one layer in. A wrapper class
 * is often the least informative thing about a failure: every caller logs `LeaseUnavailableError`
 * and, before this, nothing else — once the entire record of a mailbox that did not sync for half
 * an hour. Exactly `name` + `code` through {@link describeError}. imapflow's `serverResponseCode`
 * may NOT travel: it uppercases the SERVER's own bracket atom — a server-chosen string wearing an
 * identifier's clothes; its only safe destination is `mailboxes.error_detail`, where MEMBERSHIP
 * of a closed set is tested. The walk stops at the first `code`, reporting the deepest layer
 * reached — `ETIMEOUT` from under a wrapper.
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
      // A thrown STRING's own text, derived here for the reason the cause is: a fact a call site
      // has to remember to extract is the fact missing from the one line that mattered.
      const thrownText = thrown === undefined ? null : describeThrownText(thrown);
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
        ...(thrownText === null ? {} : { errorText: thrownText }),
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
