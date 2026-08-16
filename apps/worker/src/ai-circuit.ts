import type { AiCreditGate } from "@trafficflow/db/cloud";
import { ClassifierFaultError } from "./classifier-fault.js";
import { SensitivePayloadRefusal } from "@trafficflow/core";
import type { ClassifierPort, ClassifierInput, ClassifierResult, Logger } from "@trafficflow/core";

/**
 * THE CLASSIFIER CIRCUIT BREAKER. What stops a model-provider incident from becoming
 * "ohmail stopped delivering mail".
 *
 * ## The failure it exists for, stated exactly
 *
 * `pipeline.ts` RETHROWS a classifier fault, deliberately: the message stays un-ingested
 * and the sync cursor unadvanced, so `runSyncCycle` re-plans the same mail next pass and the
 * charge is honoured by a retry that is both guaranteed and free. That is the right behaviour
 * for a blip. For an OUTAGE it composes into two failures the product cannot accept:
 *
 *  · **Mail stops.** The throw aborts `runSyncCycle`'s whole batch — every later create/move,
 *    the cursor upsert and `reconcileMailbox` are all skipped. One unclear message at the head
 *    of the batch therefore blocks the mailbox, not just itself.
 *  · **The mailbox is quarantined.** `cycle()` counts every `runSyncCycle` throw toward
 *    `maxSyncFailures` (3), then DETACHES the mailbox and writes `status='error'`. Three failed
 *    polls of a third-party API and the customer's mailbox is marked broken.
 *
 * Both contradict the published promise that "rules with no AI at all run first and are meant to
 * handle most mail". So: after N consecutive model faults the circuit OPENS and {@link port}
 * returns `undefined`. The worker composes that into `runSyncCycle`, `pipeline.ts`'s
 * `classifier &&` short-circuits, and mail flows rules-only — no model call, and (because the
 * gate is asked LAST in that `&&` chain) no debit either.
 *
 * ## Why it lives here and not in `pipeline.ts`
 *
 * The design rules out a throwing decorator around `ClassifierPort` by name: `pipeline.ts` has no
 * try/catch around the classify call, so anything that throws there aborts the message's whole
 * ROUTING rather than degrading it. The breaker therefore decides OUTSIDE the pipeline, by
 * withholding the port, and `pipeline.ts` stays byte-identical.
 *
 * ## Why ONE circuit per process, not one per mailbox
 *
 * The failure domain is the shared API key and endpoint. Per-mailbox circuits would each burn
 * their own N faults into the same global outage — N × (mailboxes) stalled cycles instead of N —
 * and `cycle()` iterates the rotation serially, so a single process-wide counter converges after
 * at most N faults in total. The CHARGE records below are still per mailbox, because a classify
 * ledger source is mailbox-scoped.
 *
 * ## The money, which is the part that is easy to get wrong
 *
 * When the circuit trips, the message that was already charged gets filed rules-only and is
 * never re-classified — so H2's "the guaranteed free retry honours the charge" stops being true
 * for exactly that message, and the charge must come back. It cannot come back through
 * `gate.refund(source)`: by trip time the second attempt's `duplicate` outcome has already
 * CLEARED that source's marker, so `refund` finds nothing and silently does nothing.
 * The gate therefore exposes {@link AiCreditGate.refundAttempt}, and this module records the
 * `attempt` string `spend()` returned when it actually charged. At most one refund per trip per
 * mailbox; a success clears the record, so delivered work is never refunded.
 */

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
   * The classifier to use for THIS cycle: a counting wrapper while the circuit is closed or
   * half-open, `undefined` while it is open.
   *
   * Resolve it ONCE per cycle and pass the result in — never hold a wrapper across the open
   * transition. A present-but-open classifier would let `pipeline.ts`'s `&&` chain reach
   * `tryDebit`, charge, and only then fail: one orphaned charge per message per cycle, for the
   * whole outage.
   */
  port(): ClassifierPort | undefined;
  /**
   * Wrap this mailbox's account gate so the circuit learns which ledger attempt it charged.
   *
   * Calls `spend()` rather than `tryDebit()` — they are the same decision, but only `spend`
   * reports `charged` and the `attempt` string, and both are needed to refund exactly the work
   * that gets abandoned when the circuit trips.
   */
  meter(mailboxId: string, gate: AiCreditGate): AiCreditGate;
  state(): ClassifierCircuitState;
}

/** One open charge this process made and has not yet seen delivered. */
interface OpenCharge { gate: AiCreditGate; attempt: string }

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
  let cooldownMs = baseCooldown;
  /** mailboxId → the attempt this process charged and has not seen delivered or refunded. */
  const openCharges = new Map<string, OpenCharge>();

  /** Refund every charge that the abandonment of the AI branch has just orphaned. */
  function refundOpenCharges(reason: string): void {
    for (const [mailboxId, charge] of openCharges) {
      // Never awaited: this runs inside a classify failure path whose job is to rethrow, and a
      // refund is best-effort by design (`refundAttempt` never throws, and an un-refunded
      // charge is recoverable while a delayed rethrow is not). Exactly-once is enforced in the
      // database, not by this call site.
      void charge.gate.refundAttempt(charge.attempt, { mailboxId, reason });
      log?.warn("classify_charge_refunded", { mailboxId, attempt: charge.attempt, reason });
    }
    openCharges.clear();
  }

  function trip(): void {
    opens++;
    retryAt = now() + cooldownMs;
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
    cooldownMs = baseCooldown;
  }

  /**
   * ONE counting wrapper around ONE question — used for BOTH methods of the port.
   *
   * `screen` was not forwarded at all while the only caller was the routing pipeline, and an
   * absent method is not a compile error: `ClassifierPort.screen` is optional, so a consumer that
   * asks for it falls back to `classify`. That fallback is documented as a degradation and it is
   * a real one — the routing question's answer for a first-contact sender is `ohmail/Screener`,
   * which the Screener reads as "hold", so a caller getting the fallback pays full price for
   * advice that says nothing. The worker's auto-suggest pass is that caller, so the method is
   * forwarded, through the same breaker: a screening fault is a fault of the same endpoint and the
   * same key, and counting it anywhere else would give one outage two thresholds.
   *
   * `screen` is forwarded ONLY when `inner` implements it, so the wrapper keeps answering the
   * optionality question the same way the port it wraps does — never claiming a capability the
   * real classifier does not have.
   */
  async function guard(
    ask: (input: ClassifierInput) => Promise<ClassifierResult>, input: ClassifierInput,
  ): Promise<ClassifierResult> {
    let result: ClassifierResult;
    try {
      result = await ask(input);
    } catch (err) {
      // ── A REFUSAL AT THE SINK IS NOT A MODEL FAULT, AND COUNTING IT AS ONE WAS THE BUG ────
      //
      // `SensitivePayloadRefusal` says so on the class itself: "a caller must never treat it as
      // retryable, and the worker's circuit breaker must never count it as an outage." This
      // clause is that sentence being true. Without it the sensitivity gate FIRING — the
      // sensitive-mail invariant failing closed at the sink, exactly as designed — incremented `consecutiveFaults`,
      //
      // NOTE, after the ruling that opened AI to outbound-consented mail: this wrapper is on the
      // AUTOMATIC routing path, which is the path the ruling deliberately did not change. It
      // sets no `outbound` on its input, so the sink still refuses credential mail here and
      // this clause is still the one that keeps that refusal from tripping the breaker. What
      // changed is elsewhere — `ScreenerService.suggest`, where a person's press redacts the
      // payload and declares it, so no refusal can arise. If a `classifier_sensitive_refusal`
      // is ever attributed to the Screener's path, the caller skipped `redactForModel` and
      // somebody paid for a throw.
      // and `DEFAULT_FAULT_THRESHOLD` of them withheld the classifier from the WHOLE mailbox
      // and flapped it through the doubling cooldown for as long as such mail kept arriving.
      // Nothing ever leaked; the cost was availability, plus a `classifier_fault` log line
      // blaming Anthropic for our own detector.
      //
      // BY CLASS, never by `err.name`. `dead-letter.ts` states the rule — "membership cannot be
      // forged by a mail server; a shape test can" — and every other typed arm in the worker
      // (`ClassifierFaultError`, `LeaseUnavailableError`, `MimeParseError`) is matched the same
      // way. The import is a VALUE import of `@trafficflow/core`, which `deps.test.ts` permits:
      // its `FORBIDDEN_IN_SRC` covers services, api and the client packages, and core is one of
      // the worker's two declared runtime dependencies — so this resolves inside the worker's
      // Docker image and not merely through the vitest alias. There is one copy of the class,
      // the same module instance `index.ts` builds `makeHaikuClassifier` from, so `instanceof`
      // holds. (That list is matched as RAW SUBSTRINGS against the whole file, comments
      // included, so do not spell the forbidden specifiers out here.)
      //
      // ── IT IS NEUTRAL, NOT A SUCCESS ─────────────────────────────────────────────────────
      //
      // The throw happens before `consecutiveFaults++` and before `close()`, so a refusal
      // neither counts toward a trip nor clears a genuine outage that is already accumulating.
      // A refusal carries no information about whether the model is answering, and inventing
      // either reading from it would make the breaker's threshold depend on the mail mix.
      //
      // ── AND IT IS RETHROWN UNWRAPPED, WHICH IS A DELIBERATE HANDOVER ─────────────────────
      //
      // `sync.ts#attempt` rethrows `ClassifierFaultError` IMMEDIATELY and by class, which exits
      // the ingest loop and holds every folder's cursor — the poison-batch shape. An unwrapped
      // refusal instead reaches the dead-letter boundary, where it is message-scoped, so
      // the rest of the batch is ingested and later mail keeps flowing.
      //
      // THAT IS NOT THE WHOLE FIX AND MUST NOT BE READ AS ONE. The boundary retries the message
      // once and then WRITES IT OFF, so the message is never ingested at all — and a refusal is
      // deterministic in the bytes, so it will never ingest later either. The right end state is
      // that the message arrives WITHOUT an AI suggestion (mail with no suggestion is a smaller
      // failure than mail that does not arrive), and that decision belongs to `pipeline.ts`,
      // whose `catch` is the only place that can drop the AI branch and keep the message.
      // This clause is the prerequisite for it: `pipeline.ts` cannot recognise a refusal that
      // has already been wrapped here. See `test/ai-refusal.test.ts`, which pins both halves.
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
        refundOpenCharges("classifier_sensitive_refusal");
        throw err;
      }
      consecutiveFaults++;
      log?.warn("classifier_fault", { consecutiveFaults, threshold, err });
      // A fault that lands while OPEN is a failed half-open probe: re-open with the longer
      // cooldown rather than counting toward a second threshold.
      if (retryAt !== null || consecutiveFaults >= threshold) trip();
      throw new ClassifierFaultError(err);
    }
    // Delivered. The charge for this message bought what it paid for, so drop the record —
    // this is what stops a later trip refunding work the customer actually received.
    openCharges.clear();
    close();
    return result;
  }

  const wrapper: ClassifierPort = {
    classify: (input) => guard(inner.classify.bind(inner), input),
    ...(inner.screen ? { screen: (input: ClassifierInput) => guard(inner.screen!.bind(inner), input) } : {}),
  };

  return {
    port(): ClassifierPort | undefined {
      if (retryAt === null) return wrapper;
      if (now() < retryAt) return undefined;
      // Cooldown elapsed: HALF-OPEN. Hand back the live wrapper so the next classify is a probe.
      // `retryAt` stays set until a success clears it, so a failing probe re-opens (with the
      // doubled cooldown) instead of being counted as an ordinary fault.
      log?.info("classifier_circuit_half_open", { opens, reason: "cooldown elapsed — probing" });
      return wrapper;
    },

    meter(mailboxId: string, gate: AiCreditGate): AiCreditGate {
      return {
        ...gate,
        async tryDebit(source, meta) {
          const outcome = await gate.spend(source, meta);
          if (outcome.permitted && outcome.charged) {
            // Record it BEFORE the model runs. If the model then faults us into a trip, this is
            // the attempt whose money has to come back.
            openCharges.set(mailboxId, { gate, attempt: outcome.attempt });
          }
          return outcome.permitted;
        },
      };
    },

    state(): ClassifierCircuitState {
      return { open: retryAt !== null && now() < retryAt, consecutiveFaults, opens, retryAt, cooldownMs };
    },
  };
}
