import type { SpendPort } from "@trafficflow/db";
import { ClassifierFaultError } from "./classifier-fault.js";
import { SensitivePayloadRefusal } from "@trafficflow/core";
import type { ClassifierPort, ClassifierInput, ClassifierResult, Logger } from "@trafficflow/core";

/**
 * THE CLASSIFIER CIRCUIT BREAKER — what stops a model-provider incident from becoming "ohmail stopped
 * delivering mail". `pipeline.ts` RETHROWS a classifier fault (message un-ingested, cursor unadvanced, so
 * `runSyncCycle` re-plans it free) — right for a blip, but for an OUTAGE it stops mail (the throw aborts
 * the batch) and quarantines the mailbox (`cycle()` counts throws to `maxSyncFailures` = 3, then
 * `status='error'`). So after N consecutive faults the circuit OPENS, {@link port} returns `undefined`,
 * `pipeline.ts`'s `classifier &&` short-circuits, and mail flows rules-only (no model call, no debit — the
 * gate is asked LAST). It decides OUTSIDE the pipeline so `pipeline.ts` stays byte-identical; ONE circuit
 * per process (the failure domain is the shared API key). Charges are per mailbox: a trip refunds via
 * `attempt` (not `gate.refund(source)`, whose marker the `duplicate` cleared), and a success clears only that mailbox's record ({@link ClassifierCircuit.port}); the TRIP is unscoped (every open charge is owed). */

/** Consecutive model faults before the circuit opens. */
export const DEFAULT_FAULT_THRESHOLD = 2;
/** First cooldown; doubles per consecutive trip. */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** Ceiling for the cooldown — an outage must not park the AI for longer than this. */
export const DEFAULT_MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * Re-exported so every existing consumer of this module keeps compiling. The definition moved to
 * a leaf module with no imports: `sync.ts` needs only the discriminator, and importing it from
 * here dragged the whole breaker into the sync loop's closure. See `classifier-fault.ts`.
 */
export { ClassifierFaultError } from "./classifier-fault.js";

export interface ClassifierCircuitState {
  open: boolean;
  /** Consecutive faults since the last success. Reset to 0 by any success. */
  consecutiveFaults: number;
  /** How many times the circuit has opened in this process. */
  opens: number;
  /** When the current OPEN state stops withholding the port (epoch ms), or `null`. */
  retryAt: number | null;
  /**
   * When the circuit FIRST opened in its current unbroken run of trips, or `null` while it has never
   * opened since the last success. DIFFERENT from `retryAt` and from the newest trip: {@link cooldownMs}
   * doubles per consecutive trip and the breaker half-opens between them, so a provider down an hour has
   * tripped ~six times and the newest trip is minutes old — anything reading `retryAt` for "how long has
   * AI been unavailable" reads minutes for ever. Set on the trip that opens a CLOSED circuit, left alone
   * by every re-trip, cleared by {@link close}. Published on the worker heartbeat, the only evidence
   * outside this process that mail is being filed rules-only.
   */
  firstOpenedAt: Date | null;
  /**
   * When this process last saw the provider ANSWER, or `null` if it never has. `firstOpenedAt` being null
   * is two states in one value — the provider is fine, or this process has not asked yet — which a worker
   * that just replaced another cannot tell apart, and neither could the database it beats into, so a deploy
   * mid-outage read as a recovery and restarted the alert clock. This is the missing half: set by
   * {@link close} (called on every success, the one event meaning the provider responded). A replacement
   * worker publishes `null` until its first successful call, and the heartbeat writer keeps the inherited
   * outage until then.
   */
  lastSuccessAt: Date | null;
  /** The cooldown the NEXT trip will use. */
  cooldownMs: number;
}

export interface ClassifierCircuitOptions {
  faultThreshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  log?: Logger;
}

export interface ClassifierCircuit {
  /**
   * The classifier to use for THIS cycle: a counting wrapper while the circuit is closed or half-open,
   * `undefined` while open. Resolve it ONCE per cycle and pass the result in — never hold a wrapper across
   * the open transition, because a present-but-open classifier lets `pipeline.ts`'s `&&` chain reach the
   * spend, charge, and only then fail: one orphaned charge per message per cycle for the whole outage.
   * `mailboxId` names whose charge record a success clears, the SAME id passed to {@link meter}. Omitted
   * by a caller that took no metered port (the account-scoped auto-suggest pass); a wrapper with no mailbox
   * clears nobody's record, which is what it means for a caller that has none of its own.
   */
  port(mailboxId?: string): ClassifierPort | undefined;
  /**
   * Wrap this mailbox's spend port so the circuit learns which ledger attempt it charged.
   *
   * The wrapper only OBSERVES: it forwards the call unchanged and records the attempt when the
   * answer says this call moved money. `attempt` is what a reversal must name, and the port
   * carries it precisely because there is no in-process marker to consult across a hop.
   */
  meter(mailboxId: string, port: SpendPort): SpendPort;
  state(): ClassifierCircuitState;
}

/** One open charge this process made and has not yet seen delivered. */
interface OpenCharge {
  port: SpendPort;
  accountId: string;
  /** The BARE key, which a release must carry — the claim is per work, not per attempt. */
  attemptKey: string;
  /** What the port said it charged. A reversal names this and never the key. */
  attempt: string;
}

export function makeClassifierCircuit(
  inner: ClassifierPort,
  opts: ClassifierCircuitOptions = {},
): ClassifierCircuit {
  const threshold = Math.max(1, opts.faultThreshold ?? DEFAULT_FAULT_THRESHOLD);
  const baseCooldown = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxCooldown = opts.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log;

  let consecutiveFaults = 0;
  let opens = 0;
  let retryAt: number | null = null;
  let firstOpenedAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let cooldownMs = baseCooldown;
  /** mailboxId → the attempt this process charged and has not seen delivered or refunded. */
  const openCharges = new Map<string, OpenCharge>();

  /**
   * Refund the charges the abandonment of the AI branch has just orphaned.
   *
   * `only` names one mailbox; absent means every one of them. A refusal is one mailbox's
   * message and a trip is the whole provider, so the two callers below want different scopes.
   */
  function refundOpenCharges(reason: string, only?: string): void {
    for (const [mailboxId, charge] of openCharges) {
      if (only !== undefined && mailboxId !== only) continue;
      // Never awaited: this runs inside a classify failure path whose job is to rethrow, and a
      // reversal is best-effort by design (an un-refunded charge is recoverable while a delayed
      // rethrow is not). Exactly-once is enforced in the database, not by this call site.
      void charge.port.release(charge.accountId, {
        action: "classify_ingest", attemptKey: charge.attemptKey,
        refund: true, attempt: charge.attempt, meta: { mailboxId, reason },
      });
      log?.warn("classify_charge_refunded", { mailboxId, attempt: charge.attempt, reason });
      openCharges.delete(mailboxId);
    }
  }

  function trip(): void {
    opens++;
    retryAt = now() + cooldownMs;
    // ONLY on the trip that opens a CLOSED circuit. A re-trip after a failed probe is the SAME
    // outage continuing, and moving the stamp there would reset the age on every cooldown — so
    // the one figure that says how long mail has been degraded would never exceed one cooldown,
    // and the ten-minute rule built on it could never fire during the outage it is written for.
    firstOpenedAt ??= new Date(now());
    log?.error("classifier_circuit_open", {
      consecutiveFaults, opens, cooldownMs, retryAt,
      reason: "consecutive model faults — degrading to RULES-ONLY routing; mail keeps flowing",
    });
    // The AI branch is now abandoned for every message in flight, so the charges those messages
    // made bought nothing and never will. This is the ONLY moment at which that becomes true.
    refundOpenCharges("classifier_circuit_open");
    cooldownMs = Math.min(cooldownMs * 2, maxCooldown);
  }

  function close(): void {
    if (retryAt !== null || consecutiveFaults > 0) {
      log?.info("classifier_circuit_closed", { opens, reason: "a probe succeeded" });
    }
    consecutiveFaults = 0;
    retryAt = null;
    // The provider answered — the run of trips is over and the next open starts a new age. The
    // stamp below records that this process has had an answer AT ALL, which is what tells a
    // reader that its closed circuit is health rather than inexperience.
    firstOpenedAt = null;
    // THE SAME CLOCK THE TRIP USES. `firstOpenedAt` is stamped from the injected `now()` and
    // this was stamped from the machine's, so a test that advances its own clock produced two
    // times that cannot be compared — and in production a host whose clock steps could record a
    // success that precedes the outage it ended. One clock, or the pair means nothing.
    lastSuccessAt = new Date(now());
    cooldownMs = baseCooldown;
  }

  /**
   * ONE counting wrapper around ONE question — used for BOTH methods of the port. `screen` was not
   * forwarded while the only caller was the routing pipeline, and an absent method is not a compile error:
   * `ClassifierPort.screen` is optional, so a consumer falls back to `classify`, whose answer for a
   * first-contact sender is `ohmail/Screener` ("hold") — a caller getting the fallback pays full price for
   * advice that says nothing. The auto-suggest pass is that caller, so `screen` is forwarded through the
   * same breaker (a screening fault is the same endpoint and key; counting it elsewhere gives one outage
   * two thresholds). Forwarded ONLY when `inner` implements it, so the wrapper never claims a capability
   * the real classifier lacks.
   */
  async function guard(
    mailboxId: string | undefined,
    ask: (input: ClassifierInput) => Promise<ClassifierResult>, input: ClassifierInput,
  ): Promise<ClassifierResult> {
    let result: ClassifierResult;
    try {
      result = await ask(input);
    } catch (err) {
      // A REFUSAL AT THE SINK IS NOT A MODEL FAULT, AND COUNTING IT AS ONE WAS THE BUG.
      // `SensitivePayloadRefusal` says on the class the breaker must never count it as an outage; without
      // this the sensitivity gate FIRING incremented `consecutiveFaults` and `DEFAULT_FAULT_THRESHOLD` of
      // them withheld the classifier from the whole mailbox (nothing leaked; the cost was availability).
      // This wrapper is on the AUTOMATIC path the outbound-consent ruling did NOT change; the pressed
      // `ScreenerService.suggest` redacts via `redactForModel`. BY CLASS, never `err.name` (`dead-letter.ts`'s
      // rule), like `ClassifierFaultError`/`LeaseUnavailableError`/`MimeParseError` — a VALUE import of
      // `@trafficflow/core` `deps.test.ts` permits (its `FORBIDDEN_IN_SRC` is matched as raw substrings, so
      // do not spell specifiers here). NEUTRAL, not a success (thrown before `consecutiveFaults++`/`close()`),
      // and rethrown UNWRAPPED to the message-scoped dead-letter boundary; the full fix is `pipeline.ts`'s catch (`test/ai-refusal.test.ts`).
      if (err instanceof SensitivePayloadRefusal) {
        // ERROR level, not warn. `pipeline.ts` refuses sensitive mail before the credit gate and
        // before the classifier is touched, so a refusal arriving HERE means `classifySensitivity`
        // and `screenOutboundText` disagreed about the same bytes: the first line of defence
        // missed what the second caught. That is a defect report about our own detector and it
        // must be as loud as one. `screen` is `{safe, category, reason}` and carries no message
        // content by construction, which is why it is safe to log whole.
        log?.error("classifier_sensitive_refusal", {
          screen: err.screen, consecutiveFaults,
          reason: "the outbound screen refused this payload at the SINK — nothing was sent, but "
            + "an upstream check that should have set no_ai did not; NOT counted as a model fault",
        });
        // The money. `pipeline.ts` charges BEFORE it classifies, and its no-refund argument is
        // that the retry is free and honours the charge. That argument does not survive here:
        // the screen is deterministic in the bytes, so every retry refuses again and the charge
        // buys nothing, ever. Same call and same one-charge-in-flight assumption the success
        // path below already makes when it clears the map.
        // THIS mailbox's charge, not everybody's. The screen is deterministic in the bytes of
        // ONE message, so it says nothing about any other mailbox's call — and another
        // mailbox's classification may still be in flight and about to be delivered.
        refundOpenCharges("classifier_sensitive_refusal", mailboxId);
        throw err;
      }
      consecutiveFaults++;
      log?.warn("classifier_fault", { consecutiveFaults, threshold, err });
      // A fault that lands while OPEN is a failed half-open probe: re-open with the longer
      // cooldown rather than counting toward a second threshold.
      if (retryAt !== null || consecutiveFaults >= threshold) trip();
      throw new ClassifierFaultError(err);
    }
    // Delivered. THIS mailbox's charge bought what it paid for, so drop its record — which is
    // what stops a later trip refunding work the customer actually received. Only its own: a
    // success here is no evidence at all about a charge another mailbox has open, and clearing
    // that one silently forfeits its refund.
    if (mailboxId !== undefined) openCharges.delete(mailboxId);
    close();
    return result;
  }

  /**
   * The counting wrapper for one mailbox. Built per `port()` call — once per cycle per mailbox —
   * rather than held, for the reason `port()` documents: a wrapper kept across the open
   * transition charges every message and then fails it.
   */
  function wrapperFor(mailboxId: string | undefined): ClassifierPort {
    return {
      classify: (input) => guard(mailboxId, inner.classify.bind(inner), input),
      ...(inner.screen
        ? { screen: (input: ClassifierInput) => guard(mailboxId, inner.screen!.bind(inner), input) }
        : {}),
    };
  }

  return {
    port(mailboxId?: string): ClassifierPort | undefined {
      if (retryAt === null) return wrapperFor(mailboxId);
      if (now() < retryAt) return undefined;
      // Cooldown elapsed: HALF-OPEN. Hand back the live wrapper so the next classify is a probe.
      // `retryAt` stays set until a success clears it, so a failing probe re-opens (with the
      // doubled cooldown) instead of being counted as an ordinary fault.
      log?.info("classifier_circuit_half_open", { opens, reason: "cooldown elapsed — probing" });
      return wrapperFor(mailboxId);
    },

    meter(mailboxId: string, port: SpendPort): SpendPort {
      return {
        ...port,
        async spend(accountId, action, attemptKey, meta) {
          const outcome = await port.spend(accountId, action, attemptKey, meta);
          if (outcome.verdict === "ok") {
            // Record it BEFORE the model runs. If the model then faults us into a trip, this is
            // the attempt whose money has to come back. Only `ok` — a `duplicate` charged
            // nothing, and reversing its attempt would hand back a charge for work that may
            // already have been delivered.
            openCharges.set(mailboxId, {
              port, accountId, attemptKey, attempt: outcome.attempt,
            });
          }
          return outcome;
        },
      };
    },

    state(): ClassifierCircuitState {
      return {
        open: retryAt !== null && now() < retryAt,
        consecutiveFaults, opens, retryAt, cooldownMs, firstOpenedAt, lastSuccessAt,
      };
    },
  };
}
