import { createServer } from "node:http";
import type { AlertSinkHealth } from "@trafficflow/db/cloud";
import type { ApiCronTargetHealth } from "./api-cron.js";

/**
 * What the worker's health endpoint reports. It answers 200 in the STANDBY state as well as the leader
 * one for the length of a deploy (the platform kills anything else, and a killed hot spare can never
 * take over), bounded by {@link evaluateHealth}'s clock. It must not LIE the other way:
 * `lastCycleAt`/`lagSeconds` advance ONLY on a cycle that synced a mailbox (or had nothing to sync),
 * and `healthy` is FALSE for a leader with mailboxes to serve that served none past the bound (with
 * `expected`/`mailboxes`/`quarantined`/`awaitingCredentials`/`truncated` published beside it). A 503
 * gates a DEPLOYMENT going active, never a running instance. `kekFingerprint` + `kekActiveVersion` +
 * `kekVersionCount` are the KEK-drift tripwire from `kekEnvIdentity()` in `@trafficflow/core`; ALL
 * THREE must match (fingerprint covers the whole ring; `kekActiveVersion` persists as `key_version`). */
export interface HealthSnapshot {
  /**
   * WHICH BUILD IS ANSWERING — the commit sha, or `"dev"` when nothing said. Named `version`, not
   * `buildVersion`, so it is the same key the API publishes (the operator check compares two `/health`
   * bodies, and a differently-named field makes that a translation exercise). Until this existed a
   * worker deploy could only be confirmed out of band; the webapp is provable per chunk and the API
   * echoes `TF_BUILD_VERSION`, and this is the third host answering the same question. Resolution and
   * source order: {@link buildVersionOf} in `config.ts`.
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
   * WHY it is degraded — a fixed token from {@link DegradedReason}, NEVER null while {@link degraded}
   * is true. That clause did not hold until the causes were named: `degradedReason` named only two of
   * six conditions, and a ROSTER SHORTFALL published `degraded: true, degradedReason: null` (measured
   * twice on real deploy probes), leaving the reader to derive the cause from `expected` vs `mailboxes`.
   * The invariant is now STRUCTURAL: {@link evaluateHealth} computes this token first and derives
   * `degraded` from it (`degraded === (degradedReason !== null)`), so a nameless degraded state cannot
   * be constructed. `test/health-verdict.test.ts` walks every cause and checks it anyway.
   */
  degradedReason: DegradedReason | null;
  /**
   * The mailboxes this shard is supposed to serve and is NOT serving, decomposed by cause. `expected`
   * minus `mailboxes` is already a subtraction anybody can do; what it never said is which of five
   * situations produced it, and those want five different responses — from "dual mode working" to "a
   * paying customer's mail is not syncing and no code path admits it". COUNTS ONLY: which mailbox is in
   * which bucket is in the worker's log and `mailboxes.sync_blocked_reason`, neither of which belongs
   * on an endpoint anybody can reach.
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
   * EVERY CONFIGURED PAGER ARM AND WHETHER IT IS ACTUALLY DELIVERING — one entry per arm, in compose
   * order. `[]` on a standby instance. The state it closes is the one the pager cannot report: an arm
   * that has refused every delivery since it was configured, beside one that works — `attempts: 0`
   * says "never exercised", not healthy. CLOSED CODES ONLY (`ok`/`misconfigured`/`refused`/
   * `unreachable`/`timeout`/`threw`); the vendor's error sentence stays in the gated log line, not on
   * this reachable endpoint. A memory read, so `/health` still touches no database.
   */
  alertSinks: AlertSinkHealth[];
  /**
   * THE API-CRON SCHEDULE, PER TARGET — the internal API routes this worker drives on a clock
   * (`api-cron.ts`: billing reconcile hourly, session reap and the SMTP SIZE back-fill daily).
   * Published because its predecessor (the API deployment's platform cron) failed by SAYING NOTHING
   * for three weeks: a schedule that stops must be a row going visibly stale (`lastOkAt` ageing past
   * `everySeconds`, a closed `outcome`), never an absence. `[]` where unconfigured, on shards > 0, and
   * on a standby. Closed codes and clocks only, a memory read, so `/health` touches no database.
   */
  apiCron: ApiCronTargetHealth[];
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
 * Why `degraded` is true while nothing is unhealthy. A closed set, published, ranked so the cause
 * names the incident. `stale_cycle` — a connected leader whose last COMPLETED cycle is older than the
 * bound (invisible to `serving_nothing`, which needs `connected === 0`). `database_fault` — the
 * worker's own DB failing (a token because `expected`/`mailboxes`/`quarantined`/`truncated` read
 * healthy under it). `duty_gap` — enabled mailboxes in NO accounted-for bucket
 * (`roster_invariant_violated`), the one cause that is a BUG here. `roster_shortfall` — owed and
 * unserved for an accounted cause (`unserved` carries the breakdown). `at_capacity` — `maxMailboxes`
 * (`TF_MAX_MAILBOXES` or a shard). The three unhealthy tokens are the FLOOR, ranked last. NOT a cause:
 * `organized_elsewhere:*` (see {@link UnservedBreakdown.standDown}). */
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
   * degraded calculus. Dual mode's invariant is EXACTLY ONE active organizer per mailbox, by a lease
   * in `ohmail/_meta`; a Cloud worker meeting a fresh `local` claim stands down (`status='disabled'`,
   * `disabled_reason='organized_elsewhere:local'`, zero passes) — the product working. Counting it
   * degraded was half the measured oscillation this field was added for (`13/13 degraded: false` ↔
   * `12/13 degraded: true`) and scales with desktop adoption. `index.ts`'s `SyncBlock` header records
   * the two lease populations differ: {@link leaseUnreadable} degrades (nothing syncing); a stand-down
   * does not (another organizer is, by design).
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
 * THE WORKER-SIDE DEGRADED CAUSES, as one named struct — the structural half of the invariant. Before
 * HEALTH-REASON this was a single `workerDegraded: boolean` ORing four conditions in `index.ts`, and
 * that anonymous true is exactly what made `degradedReason: null` reachable. There is now no anonymous
 * channel: `index.ts` builds this struct once, derives its own `degraded` (and the `worker_heartbeats`
 * column) from it via {@link anyDegradedCause}, and hands the SAME struct to {@link evaluateHealth} —
 * so heartbeat row and endpoint cannot disagree, and a fifth cause must be a named field here first.
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
 * THE VERDICT. Pure, so its truth table is a unit test. Two states reported 200 while nothing synced,
 * each a production outage. `leader: false, standby: true, mailboxes: 0` is a hot spare AND a worker
 * wedged in lock acquisition; the fix is a CLOCK (a deploy spare waits ~5 s). And `leader: true` with
 * zero of N was 503 only when a QUARANTINE was recorded — every other way of serving nothing answered
 * 200. The second rule has a GRACE PERIOD so it cannot lock the door on its own fix: on a COLD start an
 * instance is leader within seconds and an external outage would else instantly-503 the deploy, so
 * `maxMs` is above the health-check timeout (the platform accepts the deployment first). The clock is
 * `lastCycleAt ?? leaderSince`. It still cannot see a fast crash loop (detector is DB-side:
 * `worker_heartbeats.started_at` advancing while `last_cycle_at` does not). */
export function evaluateHealth(input: HealthInput): HealthVerdict {
  // THE STALE-CYCLE RULE — degraded, never unhealthy. The serving-nothing rule requires
  // `connected === 0`, so a leader whose mailboxes are all attached but whose cycle stopped COMPLETING
  // was invisible (`healthy: true, degraded: false` however stale `lastCycleAt` went — measured
  // `lagSeconds: 560` during a cold backfill). This names that without touching the deploy-gate
  // verdict. Keyed on `lastCycleAt` ALONE, never the `?? leaderSince` fallback, so the one legitimate
  // long window — the first post-takeover cycle (~5 min) — cannot trip it. The bound
  // (8 min, `DEFAULT_STALE_CYCLE_MAX_MS`) clears that shape with margin.
  const staleCycle = input.leader && input.connected > 0 && input.lastCycleAt !== null
    && input.now - input.lastCycleAt >= input.staleCycleMaxMs;

  // THE RANKED CAUSE, AND `degraded` DERIVED FROM IT. This order is the whole change: it was a
  // two-arm ternary over six conditions where the four with no arm published `degraded: true,
  // degradedReason: null`. Ranked by which one NAMES THE INCIDENT, cause before symptom:
  // `database_fault` first (an outage produces stale cycles and shortfalls); `duty_gap` next (the one
  // BUG in this file's roster, meaning mail that will never sync); `roster_shortfall` (breakdown in
  // `unserved`); `at_capacity` (a deliberate `TF_MAX_MAILBOXES`/shard decision); `stale_cycle` last of
  // the real causes; and the unhealthy token as the FLOOR (a 503 body already carries `unhealthyReason`).
  // `degraded` is then DERIVED, not ORed — there is no expression that raises it without a name.
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

  // WHAT THIS SHARD IS ACTUALLY OWED — `expected` minus the mailboxes another organizer legitimately
  // holds. The stand-down ruling (`UnservedBreakdown.standDown`) must reach this rule and not only the
  // degraded one, or it is a preference: a Cloud shard whose whole duty is organized by desktop
  // installs serves zero for a correct reason, and 503 there would refuse deployments over the product
  // working. Not a new policy — `expected: 0` has never been a fault — this only says a mailbox someone
  // else organizes is not what this worker owes. The window is short (a stand-down writes
  // `status='disabled'`, so the next roster pass drops it from `expected`).
  const owed = Math.max(0, input.expected - input.standDown);
  if (input.leader && owed > 0 && input.connected === 0) {
    const since = input.lastCycleAt ?? input.leaderSince;
    if (since !== null && input.now - since >= input.maxMs) return verdict("serving_nothing");
  }

  // A takeover in flight is NOT waiting for the lock — it holds it, so the standby clock must not fire
  // on it. The exemption is UNBOUNDED, the honest limit of the rule: a takeover that WEDGES is
  // indistinguishable from one working hard. It used to cover a first sync (`attach()` drained inline,
  // so a takeover spent MINUTES per mailbox — ~six measured in production — and at `maxMailboxes=64`
  // that was hours of green `/health`). Now attach is connect + lease + folders + kickstart + IDLE and
  // syncs nothing, so the window shrank from drain-time to connect-time; it did NOT close (64 mailboxes
  // × a hung dial is still unbounded). The detector is DB-side (`worker_heartbeats.started_at`
  // advancing while `last_cycle_at` does not). Do not read the smaller window as a fixed bound.
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
