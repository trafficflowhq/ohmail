import { createServer } from "node:http";
import type { AlertSinkHealth } from "@trafficflow/db/cloud";

/**
 * What the worker's health endpoint reports, and for how long it is
 * willing to call an idle instance healthy.
 *
 * It answers **200 in the standby state as well as the leader one, for the length of a
 * deploy** — the platform's health check kills anything else, and a hot spare that gets killed can
 * never take over. What later changed is the phrase "for the length of a
 * deploy": the verdict is {@link evaluateHealth}, and it is bounded by a clock. Read that
 * function's header for why each rule exists; this one is about the FIELDS.
 *
 * It must also never LIE the other way. `leader: true` + a fresh `lagSeconds` used to be
 * reachable while sync was entirely dead: per-mailbox failures were swallowed and the
 * empty timer cycle refreshed freshness regardless, so a worker with zero connected
 * mailboxes looked perfectly healthy. Two rules fix that:
 *
 *  • `lastCycleAt`/`lagSeconds` advance ONLY on a cycle in which at least one mailbox
 *    actually synced (or in which there was genuinely nothing to sync), so the
 *    "no cycle for N minutes" alert fires on a dead leader instead of being lulled — and it
 *    is what {@link evaluateHealth} measures the serving-nothing rule against;
 *  • `expected` / `mailboxes` / `quarantined` / `awaitingCredentials` / `truncated` are
 *    published side by side, and `healthy` is FALSE for a leader that has mailboxes to serve
 *    and has served none of them past the bound — whatever the reason, which is the
 *    correction: the old rule needed a recorded quarantine and so answered 200 for every
 *    other way of serving nothing. A partial failure (one bad customer) stays 200: one broken
 *    mailbox must never take down every other account's sync.
 *
 * A 503 does NOT cause the platform to replace the instance. The platform's health check gates a
 * DEPLOYMENT becoming active and never re-probes a running service,
 * so on a live worker this is a signal for a human and for the alert pass,
 * and nothing else acts on it. That is precisely why the bounds are generous: the cost of
 * being late is a slow page, and the cost of being early is a deployment that cannot go live.
 *
 * `kekFingerprint` + `kekActiveVersion` + `kekVersionCount` are the KEK-drift tripwire: the
 * API host reports the SAME three fields from the same `kekEnvIdentity()` in
 * `@trafficflow/core`, so a KEK drift between hosts (⇒ every mailbox credential
 * undecryptable, invisible until a mailbox is touched) is a one-glance comparison instead
 * of a silent total outage. ALL THREE must match, and none of them alone is sufficient:
 * the fingerprint covers the whole RING (so a differing HISTORICAL key shows up, which an
 * active-key-only fingerprint could not see), while `kekActiveVersion` is what new writes
 * persist as `key_version` — two hosts holding identical bytes under different active
 * versions are still incompatible.
 */
export interface HealthSnapshot {
  /**
   * WHICH BUILD IS ANSWERING — the commit sha, or `"dev"` when nothing said.
   *
   * Named `version` and not `buildVersion` so it is the same key the API publishes, for the
   * same reason `kek` exists beside the three flat KEK fields: the operator check is meant to be
   * a comparison of two `/health` bodies, and a field that means the same thing under a
   * different name makes that comparison a translation exercise.
   *
   * Until this existed a worker deploy could only be confirmed out of band — matching a
   * deployment UUID from the platform CLI's listing against what its upload printed, which is
   * the deploy tool agreeing with itself. The webapp has long been provable per chunk and
   * the API echoes `TF_BUILD_VERSION`; this is the third host finally answering the same
   * question. Resolution and source order: {@link buildVersionOf} in `config.ts`.
   */
  version: string;
  /**
   * Why {@link version} is unknown, or null. It NEVER moves the verdict — see
   * `buildIdentityErrorOf` for why the API's 503 would be an outage here.
   */
  buildError: string | null;
  leader: boolean;
  standby: boolean;
  /** Mailboxes CONNECTED and in the sync rotation. */
  mailboxes: number;
  /** Accounts this process is responsible for (its shard). */
  accounts: number;
  /** Enabled mailboxes this process is SUPPOSED to serve, after the cap. */
  expected: number;
  /** Selected mailboxes currently detached with a retry backoff (status='error'). */
  quarantined: number;
  /** Selected mailboxes with no `imap` credential row yet — enabled but unsyncable. */
  awaitingCredentials: number;
  /** Enabled mailboxes dropped by `maxMailboxes`; nothing in this process serves them. */
  truncated: number;
  /**
   * Messages this process's mailboxes could not ingest on three or more attempts — recorded in
   * `message_failures`, still probed once per deployed build, and no longer plausibly one deploy
   * away from working. `WorkerStats.escalatedMessages` for the full argument.
   *
   * A COUNT, never a coordinate: the mailbox and the UID are in the database and in the worker's own
   * log, and neither belongs on an endpoint anybody can reach. It changes no verdict — a message the
   * parser refuses is not a reason to fail a deployment, and the platform gates deployments on this
   * endpoint.
   */
  escalatedMessages: number;
  /**
   * Something is wrong even if not fatal. Always accompanied by a {@link degradedReason} — the
   * two fields are one value, and the boolean is kept only because operator docs and probes name it.
   */
  degraded: boolean;
  /**
   * WHY it is degraded — a fixed token from {@link DegradedReason}, and NEVER null while
   * {@link degraded} is true.
   *
   * That last clause is the whole field, and it did not hold until the causes were named. `degradedReason` named
   * exactly two conditions (`stale_cycle`, then `database_fault`) out of the six that can raise
   * `degraded`, and the sentence that used to stand here — "the worker's other degraded causes are
   * readable from the counts beside it" — was an assumption nobody had checked against a deploy.
   * It is false in the commonest case: a ROSTER SHORTFALL published `degraded: true,
   * degradedReason: null` and left the reader to derive the cause from `expected` vs `mailboxes`,
   * which tells you a mailbox is missing and not one word about why. Measured twice on real
   * deploy probes as `degraded: true, degradedReason: null` over a one-mailbox shortfall — both
   * times the reader
   * went looking for a fault that was not there.
   *
   * The invariant is now STRUCTURAL rather than asserted: {@link evaluateHealth} computes this
   * token first and derives `degraded` from it (`degraded === (degradedReason !== null)`), so a
   * degraded state with no name is not a bug to be caught but a value that cannot be constructed.
   * `test/health-verdict.test.ts` walks every cause and checks it anyway, because a
   * structural argument about code is worth exactly as much as the code it describes.
   */
  degradedReason: DegradedReason | null;
  /**
   * The mailboxes this shard is supposed to serve and is NOT serving, decomposed by cause.
   *
   * `expected` minus `mailboxes` was already published and is already a subtraction anybody can do;
   * what it never said is which of five different situations produced it, and those situations want
   * five different responses — from "do nothing, this is dual mode working" through to "a paying
   * customer's mail is not syncing and no code path admits it".
   *
   * COUNTS ONLY. Which mailbox is in which bucket is in the worker's log and in
   * `mailboxes.sync_blocked_reason`; neither belongs on an endpoint anybody can reach.
   */
  unserved: UnservedBreakdown;
  /**
   * How long THIS PROCESS'S DATABASE has been failing, or null while it is answering.
   *
   * Published for the same reason `waitingForLockSeconds` is: `degraded: true` with a token but
   * no clock cannot tell a two-second pooler blip from a twenty-minute outage, and those want
   * opposite responses. It is a memory read — `/health` touches no database, which for this field
   * is load-bearing rather than incidental, since the condition it reports is precisely the one in
   * which no database-backed surface can answer.
   */
  databaseFaultSeconds: number | null;
  /** The HTTP verdict: false ⇒ 503. */
  healthy: boolean;
  /** WHY it is 503 — a fixed token from {@link UnhealthyReason}, never a runtime string. */
  unhealthyReason: UnhealthyReason | null;
  /**
   * Seconds this instance has been standing by WITHOUT having won the lock, or null once it
   * has (a takeover in flight, or leadership). Published because `standby: true` alone
   * was the whole blind spot: five seconds of it is a rolling deploy and two hours of it is an
   * outage, and the field that told them apart did not exist.
   */
  waitingForLockSeconds: number | null;
  /** The lock is WON and the worker is still starting up — not a spare, not yet serving. */
  takingOver: boolean;
  lastCycleAt: string | null;
  lagSeconds: number | null;
  /** Ring fingerprint of EVERY loaded KEK version (`kekRingFingerprint`), not the active one. */
  kekFingerprint: string | null;
  /** The version new secrets are written under — the persisted `key_version`. */
  kekActiveVersion: number | null;
  /** How many KEK versions this host loaded (contiguous from 1, so == the active version). */
  kekVersionCount: number | null;
  /**
   * The SAME `kekEnvIdentity()` object the API host publishes under the same key, so the
   * risk-2 drift check is a literal `diff <(curl worker/health | jq .kek) <(curl api/health | jq .kek)`.
   *
   * The three flat fields above are kept because existing operator docs and tests name them,
   * but they are NOT diffable against the API: it nests `{active, count, fingerprint}` while
   * this publishes `kekActiveVersion` / `kekVersionCount` / `kekFingerprint`, so a plain diff
   * of two HEALTHY hosts showed three differences and the "just diff the two /health responses"
   * instruction was, strictly, wrong. This field makes it right.
   */
  kek: { active: number; count: number; fingerprint: string } | null;
  shard: { index: number; shards: number };
  /**
   * EVERY CONFIGURED PAGER ARM AND WHETHER IT IS ACTUALLY DELIVERING — one entry per arm, in
   * the order the worker composed them. `[]` on a standby instance (no worker, no pass yet).
   *
   * The state this closes is the one the pager itself cannot report: an arm that has refused
   * every delivery since it was configured, beside an arm that works. Nothing fails, no
   * escalation fires, the pages land — and the deployment has one vendor while believing it
   * has two. `attempts: 0` says "never exercised", which is not the same claim as healthy.
   *
   * CLOSED CODES ONLY (`ok` / `misconfigured` / `refused` / `unreachable` / `timeout` /
   * `threw`). The vendor's own error sentence stays in the log line, where a drain gates it;
   * this endpoint is reachable by anyone and an unbounded third-party string does not belong
   * on it. A memory read like every other field here, so `/health` still touches no database.
   */
  alertSinks: AlertSinkHealth[];
  /** Present in the fatal state (a failed takeover, or a LOST leader lock). */
  error?: string;
}

/**
 * Why `/health` answers 503. A closed set, because it is published.
 *
 * · `fatal` — a failed takeover or a LOST leader lock. Pre-P18 behaviour, unchanged.
 * · `serving_nothing` — a leader that has mailboxes to serve and has been serving none of them
 *   for longer than the bound.
 * · `waiting_for_lock` — an instance that has been unable to take the leader lock for longer
 *   than the bound. A rolling deploy produces five seconds of this; a wedge produces hours.
 */
export type UnhealthyReason = "fatal" | "serving_nothing" | "waiting_for_lock";

/**
 * Why `degraded` is true while nothing is unhealthy. A closed set, because it is published.
 *
 * · `stale_cycle` — a leader with mailboxes CONNECTED whose last COMPLETED cycle is older than
 *   the bound. `serving_nothing` cannot see this state (it requires `connected === 0`), so a
 *   connected leader stayed `healthy: true, degraded: false` however stale its cycle — measured
 *   in production at `lagSeconds: 560` during a cold backfill. DEGRADED and never unhealthy:
 *   the platform gates deployments on this endpoint and never re-probes a running service, so an
 *   unhealthy verdict here could refuse a deploy over a slow backfill while changing nothing on
 *   a live instance. A signal for a human and the alert pass, exactly like `degraded` itself.
 * · `database_fault` — the worker's own database is failing. It gets a TOKEN rather than
 *   riding `workerDegraded` anonymously because the sentence above it — "the worker's other
 *   degraded causes are readable from the counts" — is false for this one and for no other: the
 *   correct behaviour under a database outage is that every mailbox stays attached, so
 *   `expected`, `mailboxes`, `quarantined` and `truncated` all read exactly as they do on a
 *   healthy shard. Without the token the published body would say `degraded: true` and offer
 *   nothing that explains it.
 *
 *   Degraded and NEVER unhealthy, on the stale-cycle rule's argument taken one step further: a
 *   503 does not restart a running instance, so the only thing it could change is whether a
 *   DEPLOYMENT is allowed to go live — and refusing to ship during a database incident is
 *   refusing to ship the fix. It ranks ABOVE `stale_cycle` because a database outage produces
 *   stale cycles, so naming the cause beats naming the symptom.
 * · `duty_gap` — enabled mailboxes of this shard are in NO accounted-for bucket: not served, not
 *   awaiting credentials, not quarantined, not held by another organizer. The worker already
 *   logs this as `roster_invariant_violated` and it is the one cause here that is a bug in the
 *   worker rather than a condition it is reporting.
 * · `roster_shortfall` — mailboxes this shard owes and is not serving, for a cause that IS
 *   accounted for. `unserved` beside it carries the breakdown, which is the whole point: a
 *   shortfall of quarantined mailboxes and a shortfall of credential-less ones look identical in
 *   `expected` vs `mailboxes` and want opposite responses.
 * · `at_capacity` — `maxMailboxes` dropped enabled mailboxes of this shard. Nothing in this
 *   deployment serves them, and no clock will ever fix it: it is `TF_MAX_MAILBOXES` or a shard.
 *
 * The three unhealthy tokens are members too, so that the FLOOR of the ranking is total. They are
 * ranked last deliberately — when the worker is 503 the reader already has `unhealthyReason`, so
 * echoing it into this field adds nothing and any other cause present adds something. A `fatal`
 * with a duty gap answers `degradedReason: "duty_gap", unhealthyReason: "fatal"`; a `fatal` with
 * nothing else to say answers `"fatal"` in both, which is redundant and never null.
 *
 * ── WHAT IS DELIBERATELY *NOT* A DEGRADED CAUSE ────────────────────────────────────────────
 *
 * A mailbox another organizer legitimately holds (`organized_elsewhere:*` — the desktop
 * stand-down of the dual-mode design). See {@link UnservedBreakdown.standDown}.
 */
export type DegradedReason =
  | "database_fault"
  | "duty_gap"
  | "roster_shortfall"
  | "at_capacity"
  | "stale_cycle"
  | UnhealthyReason;

/**
 * The mailboxes this shard owes and is not serving, by cause. Sums to {@link UnservedBreakdown.total}.
 *
 * Computed over the DUTY (`served`) rather than as `expected - mailboxes`, so it stays exact while
 * the rotation and the roster disagree — which they do for the length of every roster pass.
 */
export interface UnservedBreakdown {
  /** Owed mailboxes not in the rotation, whatever the cause. INCLUDES {@link standDown}. */
  total: number;
  /** Detached behind a retry backoff (`status='error'`, a provider that keeps refusing). */
  quarantined: number;
  /** Enabled but with no `imap` credential row — nothing to dial with. */
  awaitingCredentials: number;
  /**
   * ANOTHER ORGANIZER HOLDS THE LEASE, AND THIS IS NOT A FAULT — the one bucket excluded from the
   * degraded calculus, by a deliberate ruling against the dual-mode design.
   *
   * Dual mode's whole invariant is EXACTLY ONE active organizer per mailbox, arbitrated by a lease
   * in `ohmail/_meta`. A Cloud worker meeting a fresh `local` claim stands down — writes
   * `status='disabled'` with `disabled_reason='organized_elsewhere:local'`, runs zero pipeline
   * passes, and is at that moment doing precisely what the product says it does. Counting that as
   * a degraded worker is the health endpoint calling a correct hand-off a defect.
   *
   * IT WAS COUNTED, and it is half of the measured oscillation this field was added for: a
   * mailbox flipping between enabled and stood-down moved the shard between `13/13 degraded: false`
   * and `12/13 degraded: true` with nothing to name, on an account whose desktop install holds the
   * lease exactly as designed. That reading was not merely unexplained, it was WRONG — and the
   * error scales with desktop adoption, since every dual-mode user's mailbox would contribute one.
   *
   * The comment this replaces argued the other way ("a lease-unavailable mailbox still counts
   * toward `expected` … nothing is syncing it. That is the honest answer") and it is honest about
   * the wrong population. `index.ts`'s own `SyncBlock` header already records that the two lease
   * populations "are not the same state": for {@link leaseUnreadable} nothing IS syncing the
   * mailbox and it degrades; for a stand-down something is — another organizer, by design.
   */
  standDown: number;
  /**
   * The lease could not be READ — so this worker is not organizing the mailbox and cannot say
   * anybody else is. Unlike {@link standDown} that is a fault, and it degrades.
   */
  leaseUnreadable: number;
  /**
   * In no bucket at all. Mid-attach when read during a roster pass, which is why this ALONE does
   * not raise `duty_gap`: the durable verdict is the end-of-pass invariant check in `index.ts`
   * (`roster_invariant_violated`), and a mailbox that is three seconds into its connect must not
   * page anybody. It still counts toward the shortfall, because it is one.
   */
  unaccounted: number;
}

/**
 * THE WORKER-SIDE DEGRADED CAUSES, as one named struct — the structural half of the invariant.
 *
 * Before HEALTH-REASON this was a single `workerDegraded: boolean` ORing four conditions together in
 * `index.ts`, and the boolean is exactly what made `degradedReason: null` reachable: an anonymous
 * true has no name to publish. There is now no anonymous channel. `index.ts` builds this struct
 * once, derives its own `degraded` (and the `worker_heartbeats` column) from it via
 * {@link anyDegradedCause}, and hands the SAME struct to {@link evaluateHealth} — so the heartbeat
 * row and the endpoint cannot disagree, and a fifth cause has to be a named field here before it
 * can raise anything.
 */
export interface DegradedCauses {
  /** The worker's own database is failing. */
  databaseFault: boolean;
  /** The end-of-roster-pass invariant found mailboxes in no accounted-for bucket. */
  dutyGap: boolean;
  /**
   * Owed mailboxes not being served, EXCLUDING stand-downs —
   * `unserved.total - unserved.standDown`. See {@link UnservedBreakdown.standDown}.
   */
  unserved: number;
  /**
   * Owed mailboxes another organizer holds. Published, and deliberately inert in the calculus;
   * it is here rather than only in the snapshot because {@link evaluateHealth} needs it to keep
   * the serving-nothing rule from firing on a shard whose whole duty is legitimately elsewhere.
   */
  standDown: number;
  /** Enabled mailboxes of this shard that `maxMailboxes` dropped (`WorkerStats.truncated`). */
  capacityDropped: number;
}

/** Whether any WORKER-side cause is present. The verdict's own clocks are not in scope here. */
export function anyDegradedCause(c: DegradedCauses): boolean {
  return c.databaseFault || c.dutyGap || c.unserved > 0 || c.capacityDropped > 0;
}

/** Everything {@link evaluateHealth} is allowed to know. No clock, no database, no I/O. */
export interface HealthInput extends DegradedCauses {
  /** ms epoch. Passed in, so the truth table is a pure function of its arguments. */
  now: number;
  /** The supervisor recorded a fatal: a failed takeover, or a lost lock. */
  fatal: boolean;
  leader: boolean;
  standby: boolean;
  /** The lock is won; `startWorkerWithLock` has not returned yet. */
  takingOver: boolean;
  /** Enabled mailboxes of this shard that this process is supposed to serve. */
  expected: number;
  /** Mailboxes CONNECTED and in the rotation. */
  connected: number;
  /** ms epoch at which this instance entered standby. */
  standbySince: number;
  /** ms epoch at which it became leader, or null while it is not one. */
  leaderSince: number | null;
  /** The last cycle in which something actually synced (ms epoch), or null. */
  lastCycleAt: number | null;
  /** The bound both clocks are measured against (`WorkerConfig.servingNothingMaxMs`). */
  maxMs: number;
  /** How stale a COMPLETED cycle may go, mailboxes connected, before the verdict says
   *  `degraded` (`WorkerConfig.staleCycleMaxMs`). Never moves `healthy`. */
  staleCycleMaxMs: number;
}

export interface HealthVerdict {
  healthy: boolean;
  /** Strictly `degradedReason !== null` — see {@link HealthSnapshot.degradedReason}. */
  degraded: boolean;
  /** The single most actionable cause, ranked. Never null while {@link degraded} is true. */
  degradedReason: DegradedReason | null;
  unhealthyReason: UnhealthyReason | null;
}

/**
 * THE VERDICT. Pure, so its truth table is a unit test and not an integration guess.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────────────
 *
 * Two states reported 200 while nothing synced, and both cost a production outage.
 *
 * `leader: false, standby: true, mailboxes: 0` is what a hot spare looks like AND what a worker
 * wedged inside lock acquisition looks like — a recorded open blind
 * spot, and once it hid eight minutes of dead sync while
 * the operator read a green probe. The fix is a CLOCK: a spare during a rolling deploy waits
 * ~5 s, so anything past the bound is not a spare.
 *
 * And `leader: true` with zero of N mailboxes was 503 only when a QUARANTINE had been recorded
 * (`quarantined > 0`). Every other way of serving nothing — a mailbox with no credential row, a
 * roster pass that never finished, the `roster_invariant_violated` gap — answered 200. Zero of
 * N is zero of N; the reason belongs in the log line, not in the verdict.
 *
 * ── AND WHY THE SECOND RULE HAS A GRACE PERIOD, WHICH THE BRIEF DID NOT ASK FOR ────────────
 *
 * Because without one it is a deploy gate that can lock the door on the fix. The platform evaluates
 * the health check while a deployment comes up: on a COLD start (nothing holding the lock —
 * i.e. after the previous instance crashed, i.e. exactly during an incident) an instance can be
 * leader within seconds, and if the cause of the incident is external — the provider is down,
 * every attach fails — an instantly-503 check fails the deploy of the very build that fixes
 * something else. Measuring the state against the same bound as the standby clock keeps the
 * alarm honest and keeps the door open: `maxMs` is above the health-check timeout, so the platform has
 * already accepted the deployment before this rule can fire.
 *
 * The clock is `lastCycleAt ?? leaderSince`, both of which the process already tracks, so it
 * needs no polling: a leader that is serving nothing completes no successful cycle, so
 * `lastCycleAt` stops advancing the moment the last mailbox drops out — and for a leader that
 * never had one, the takeover instant is the honest start.
 *
 * ── WHAT IT STILL CANNOT SEE, SAID PLAINLY ────────────────────────────────────────────────
 *
 * A fast crash loop. One early outage restarted the process every ~26 s; every clock here restarts
 * with it, and a dead process serves no endpoint at all. No rule shaped like this one can catch
 * that — the detector is DB-side (`worker_heartbeats.started_at` advancing while
 * `last_cycle_at` does not), and it is a recorded follow-up.
 */
export function evaluateHealth(input: HealthInput): HealthVerdict {
  // ── THE STALE-CYCLE RULE — degraded, never unhealthy ─────────────────────────────────────
  //
  // The serving-nothing rule requires `connected === 0`, so a leader whose mailboxes are all
  // attached but whose cycle has stopped COMPLETING was invisible: `healthy: true, degraded:
  // false` however stale `lastCycleAt` went (measured in production, `lagSeconds: 560` during a
  // cold backfill, green throughout). This names that state without touching the verdict
  // the platform's deploy gate reads.
  //
  // Keyed on `lastCycleAt` ALONE — never the `?? leaderSince` fallback the serving-nothing
  // clock uses — so the one legitimately long window, the first post-takeover cycle (measured
  // ~5 min in production), cannot trip it: a fresh leader has no completed cycle to be
  // stale about until its first one lands. The bound (8 min, `DEFAULT_STALE_CYCLE_MAX_MS`)
  // still clears that measured shape with margin, for the day the long cycle is the second one.
  const staleCycle = input.leader && input.connected > 0 && input.lastCycleAt !== null
    && input.now - input.lastCycleAt >= input.staleCycleMaxMs;

  // ── THE RANKED CAUSE, AND `degraded` DERIVED FROM IT ─────────────────────────────────────
  //
  // This order is the whole change. It used to be a two-arm ternary over six conditions, and the
  // four with no arm published `degraded: true, degradedReason: null` — a state that says "this
  // worker is not right" and refuses to say how, which is worse than silence because somebody
  // acts on it. Ranked by WHICH ONE NAMES THE INCIDENT, cause before symptom throughout:
  //
  //  · `database_fault` first, on the origin tag's own argument — an outage produces stale cycles and, once
  //    the roster pass stops resolving, shortfalls too, and only one of the three is the incident;
  //  · `duty_gap` next: it is the one cause here that is a BUG in this file's roster rather than a
  //    condition being reported, and it means mail that will never sync;
  //  · `roster_shortfall`, whose breakdown rides beside it in `unserved`;
  //  · `at_capacity` below the shortfall because it is a decision this deployment made on purpose
  //    (raise `TF_MAX_MAILBOXES`, add a shard), not something that went wrong;
  //  · `stale_cycle` last of the real causes — every cause above it can produce one;
  //  · and the unhealthy token as the FLOOR, so the chain is total. It is last because a 503 body
  //    already carries `unhealthyReason`: echoing it here adds nothing, while any other cause
  //    present adds something.
  //
  // `degraded` is then DERIVED, not ORed independently. That is what makes the invariant
  // structural: there is no expression anywhere that can raise `degraded` without choosing a name.
  const causeOf = (unhealthyReason: UnhealthyReason | null): DegradedReason | null =>
    input.databaseFault ? "database_fault"
      : input.dutyGap ? "duty_gap"
        : input.unserved > 0 ? "roster_shortfall"
          : input.capacityDropped > 0 ? "at_capacity"
            : staleCycle ? "stale_cycle"
              : unhealthyReason;

  const verdict = (unhealthyReason: UnhealthyReason | null): HealthVerdict => {
    const degradedReason = causeOf(unhealthyReason);
    return {
      healthy: unhealthyReason === null,
      degraded: degradedReason !== null,
      degradedReason,
      unhealthyReason,
    };
  };

  if (input.fatal) return verdict("fatal");

  // ── WHAT THIS SHARD IS ACTUALLY OWED ─────────────────────────────────────────────────────
  //
  // `expected` minus the mailboxes another organizer legitimately holds. The stand-down ruling
  // (see `UnservedBreakdown.standDown`) has to reach this rule and not only the degraded one, or
  // it is not a ruling but a preference: a Cloud shard whose whole duty is organized by desktop
  // installs serves zero mailboxes for a correct reason, and answering 503 to that would refuse
  // deployments over the product working as designed.
  //
  // It is also not a new policy — `expected: 0` has never been a fault ("a leader with nothing to
  // serve is healthy"), and this says only that a mailbox somebody else is organizing is not part
  // of what this worker has to serve. In practice the window is short (a stand-down writes
  // `status='disabled'`, so the next roster pass drops the mailbox from `expected` outright); the
  // rule is corrected because the short window is an accident of another component's timing.
  const owed = Math.max(0, input.expected - input.standDown);
  if (input.leader && owed > 0 && input.connected === 0) {
    const since = input.lastCycleAt ?? input.leaderSince;
    if (since !== null && input.now - since >= input.maxMs) return verdict("serving_nothing");
  }

  // A takeover in flight is NOT waiting for the lock — it holds it, so the standby clock must not
  // fire on it. The exemption is UNBOUNDED, and that is the honest limit of the rule, recorded
  // here rather than discovered: a takeover that WEDGES is indistinguishable, from the
  // supervisor's vantage point, from one that is working hard.
  //
  // ── WHAT THE NON-BLOCKING ATTACH CHANGED, AND WHAT IT DID NOT ─────────────────────────────
  //
  // This exemption used to have to cover a first sync: `attach()` drained inline, so a takeover
  // legitimately spent MINUTES per mailbox (an early measure was most of an hour for one large
  // first import, and about six minutes per mailbox was measured in production later). At
  // `maxMailboxes=64`
  // that was hours of green `/health` over a boot serving almost nothing.
  //
  // Now attach is connect + lease + folders + kickstart + IDLE and syncs nothing, so
  // the window this exemption hides shrank from drain-time to connect-time — seconds per mailbox.
  // It did NOT close: 64 mailboxes × a hung provider dial is still unbounded, and no rule shaped
  // like this one can see it, for the same reason it cannot see a fast crash loop. The detector is
  // DB-side (`worker_heartbeats.started_at` advancing while `last_cycle_at` does not) and stays
  // a recorded follow-up. Do not read the smaller window as a fixed bound.
  if (input.standby && !input.takingOver && input.now - input.standbySince >= input.maxMs) {
    return verdict("waiting_for_lock");
  }

  return verdict(null);
}

export interface HealthServer {
  /** The bound port (resolved, so `port: 0` yields the ephemeral one in tests). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A dependency-free `node:http` listener on `PORT`. Every path answers the same JSON
 * snapshot — a health check must never depend on getting the path right — and nothing
 * here touches the database, so a health probe can never add load or block on Postgres.
 */
export async function startHealthServer(
  opts: { port: number; snapshot: () => HealthSnapshot },
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const snap = opts.snapshot();
    const body = JSON.stringify({ ok: snap.healthy, ...snap });
    res.writeHead(snap.healthy ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => { server.removeListener("error", reject); resolve(); });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    port,
    close() {
      return new Promise<void>((resolve) => {
        // Health checks use keep-alive; without this the close would wait for them.
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
