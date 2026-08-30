import type { AnthropicLike } from "./classify.js";
import type { Logger } from "../log.js";

/**
 * THE LIVE MODEL CLIENT. A `fetch` shim over `POST /v1/messages` that satisfies
 * {@link AnthropicLike}, the narrow structural seam `makeHaikuClassifier`, `makeSonnetDrafter`
 * and `makeOpusProposer` already take.
 *
 * ## Why a shim and not `@anthropic-ai/sdk`
 *
 * The SDK is not in the lockfile, and adding it would land in two places that both pay for it:
 * the worker's Docker image and the Vercel function bundle. What the three ports actually use of
 * a client is ONE method — `messages.create(params) => { content, usage? }` — so the SDK's value
 * here would be retries, timeouts and error typing, which is ~150 lines. The seam was designed
 * for exactly this (`classify.ts`: "the concrete client is constructed by the app/worker and
 * injected"), so the shim is the intended shape rather than a workaround.
 *
 * ## Why it lives in `packages/core`
 *
 * `apps/worker` may import **core + db only** — the worker's dependency test pins that list
 * recursively, because a `@trafficflow/services` import typechecks, resolves through the vitest
 * alias, and then throws `MODULE_NOT_FOUND` inside the worker's image. The worker is the biggest
 * consumer of this client (classify runs once per message), so core is the only home it can
 * reach — and it is where the ports it feeds already live.
 *
 * ## Hermetic by construction
 *
 * `fetchImpl` is injectable and every test passes one, so the default suite makes no network
 * call. Nothing in this module executes at import time; a deployment without
 * `ANTHROPIC_API_KEY` never constructs it.
 */

/** The `anthropic-version` every request pins. Bumping it is an API-shape decision, not config. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** Default host. Overridable so a test can point at a local stub without patching globals. */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Every Anthropic API key starts with this. Checked at CONFIG LOAD, not here — a deployment that
 * was handed the wrong secret (a Stripe key, a mail-provider key, a truncated paste) must fail at boot
 * rather than on the first customer's mail. See `assertAnthropicKey`.
 */
export const ANTHROPIC_KEY_PREFIX = "sk-ant-";

/** Requests we retry: transient by definition. 4xx other than 408/409/429 are our bug. */
const RETRIABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
/** Never honour an absurd `retry-after`; a 20-minute sleep inside a sync cycle is an outage. */
const MAX_RETRY_AFTER_MS = 20_000;

/**
 * What one metered model call cost, in the vocabulary a margin analysis needs. Handed to
 * {@link AnthropicClientOptions.onUsage} after every call, success or failure.
 *
 * This exists because the plan card sells "20 000 AI actions for $29/mo", and until the token
 * counts behind one action are on record that number is a guess. Every field is either measured
 * or explicitly `null` — nothing here is inferred.
 */
export interface AnthropicCallReport {
  /** The model actually billed (the response's `model`, falling back to the request's). */
  model: string;
  /** `false` ⇒ the call ended in a throw; token fields are `null`. */
  ok: boolean;
  /** HTTP status of the last attempt, or `null` if no response was ever received. */
  status: number | null;
  /** Wall time across every attempt, including backoff. What a user waits. */
  latencyMs: number;
  /** 1 ⇒ no retry happened. */
  attempts: number;
  /** Anthropic's `request-id` header — the only handle their support can act on. */
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /**
   * Output tokens spent on thinking. Present on Sonnet 5 / Opus 5, which run ADAPTIVE THINKING
   * BY DEFAULT — and `max_tokens` caps thinking plus text together, so this is the number that
   * says whether a `max_tokens` is generous or about to truncate the answer.
   */
  thinkingTokens: number | null;
  /**
   * Estimated cost in USD micro-dollars (1e-6 USD), or `null` for a model this build has no
   * price for. An ESTIMATE — the invoice is authoritative — but it is the only per-action number
   * available at the moment the action happens, which is what makes a tier's margin measurable
   * rather than reconstructible a month later.
   */
  costMicroUsd: number | null;
}

/**
 * Published list prices, USD per million tokens, as of 2026-07-31.
 *
 * Hard-coded deliberately and narrowly: the alternative is that per-action cost is unknowable at
 * the moment of spend, which is the state this table exists to end. A model absent from this
 * table reports `costMicroUsd: null` rather than a wrong number — silence beats a fabricated
 * margin. Re-check when a model id changes or an introductory price expires (Sonnet 5's
 * $2/$10 introductory rate runs through 2026-08-31; the STANDARD rate is used here, so the
 * estimate is conservative — it over-states cost while the intro price holds).
 */
export const MODEL_PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
};

/** Cache reads bill at ~0.1× input; cache writes at ~1.25× input (5-minute TTL). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimate one call's cost in micro-dollars. Exported so a test can pin the arithmetic against
 * a known usage block rather than against whatever the table happens to say today.
 */
export function estimateCostMicroUsd(
  model: string,
  usage: { inputTokens?: number | null; outputTokens?: number | null;
           cacheReadTokens?: number | null; cacheWriteTokens?: number | null },
): number | null {
  const price = MODEL_PRICES_USD_PER_MTOK[model];
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // (tokens / 1e6) * usdPerMTok * 1e6 micro-dollars-per-usd  ⇒  tokens * usdPerMTok.
  const usdMicros =
    input * price.input +
    cacheRead * price.input * CACHE_READ_MULTIPLIER +
    cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
    output * price.output;
  return Math.round(usdMicros);
}

/** A non-2xx answer from the API, with everything an operator needs and nothing secret. */
export class AnthropicApiError extends Error {
  override readonly name = "AnthropicApiError";
  constructor(
    readonly status: number,
    /** Anthropic's own `error.type` (`rate_limit_error`, `overloaded_error`, …). */
    readonly errorType: string | null,
    readonly requestId: string | null,
    message: string,
  ) {
    super(message);
  }
}

/** The request never completed — DNS, TLS, socket, or our own timeout. */
export class AnthropicTransportError extends Error {
  override readonly name = "AnthropicTransportError";
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

/**
 * THE WORST-CASE WALL TIME one call through this client can take, in milliseconds.
 *
 * It exists because a per-ATTEMPT timeout reads like a whole-call bound and is not one, and
 * something outside this module was sized against the wrong number: the exclusive AI work claim
 * (`AI_CLAIM_TTL_MS`) was set to 60 s on the stated ground that *"the worker's model timeout is
 * 30 s"*. The worker passes `timeoutMs: 30_000` and no `maxRetries`, so its real ceiling is three
 * attempts plus two backoffs — and a live holder's claim expired while it was still inside the
 * call, letting a second caller take the claim over and buy a second provider call against the
 * one credit the first had already paid. Anyone bounding a lease, a lock or a function duration
 * against this client must bound it against THIS, never against `timeoutMs`.
 *
 * The two terms:
 *
 *  · `timeoutMs × (maxRetries + 1)` — every attempt can burn its full deadline;
 *  · `maxRetries × MAX_RETRY_AFTER_MS` — a server `retry-after` is honoured up to that cap, which
 *    dominates the exponential default (500 ms doubling, ±25 % jitter) by more than an order of
 *    magnitude. Taking the cap rather than the default is what makes this a CEILING: a bound that
 *    holds only when the provider is not asking us to wait is not a bound at all, and a 429 storm
 *    is exactly when several callers are queued on the same source.
 *
 * Deliberately excludes DNS, connection setup and the caller's own work around the call, so a
 * consumer sizing a lease should still leave margin above it.
 */
export function callCeilingMs(o: { timeoutMs?: number; maxRetries?: number } = {}): number {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, o.maxRetries ?? DEFAULT_MAX_RETRIES);
  return timeoutMs * (maxRetries + 1) + maxRetries * MAX_RETRY_AFTER_MS;
}

export interface AnthropicClientOptions {
  /** The API key. NEVER logged, never put in an error message (see {@link scrub}). */
  apiKey: string;
  baseUrl?: string;
  /** Per-ATTEMPT timeout. Total wall time can reach `timeoutMs × (maxRetries + 1)` plus backoff. */
  timeoutMs?: number;
  /** Retries after the first attempt. 0 ⇒ never retry. */
  maxRetries?: number;
  /** First backoff step; doubles per retry, with ±25% jitter. */
  backoffMs?: number;
  /** Injected in tests so the default suite makes no network call. */
  fetchImpl?: typeof fetch;
  /** Injected so a test can drive the backoff clock without waiting. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter source; injected so backoff is deterministic under test. */
  random?: () => number;
  /**
   * Called after EVERY metered call, success or failure. This is the margin-measurement hook: the
   * hosts wire it to their structured logger, so one grep gives the token counts and estimated
   * cost of every AI action the product has ever performed.
   *
   * Invoked through a try/catch — a reporter that throws must not become the outcome of a
   * model call that succeeded.
   */
  onUsage?: (report: AnthropicCallReport) => void;
  /** Convenience: when set and `onUsage` is not, usage is logged as `ai_call` at info level. */
  log?: Logger;
}

/** Remove any occurrence of the key from a string bound for a log or an Error. */
function scrub(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pull the token counts out of a `usage` object without trusting its shape. */
function readUsage(usage: unknown): Pick<
  AnthropicCallReport,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "thinkingTokens"
> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: numberOrNull(u.input_tokens),
    outputTokens: numberOrNull(u.output_tokens),
    cacheReadTokens: numberOrNull(u.cache_read_input_tokens),
    cacheWriteTokens: numberOrNull(u.cache_creation_input_tokens),
    thinkingTokens: numberOrNull(details.thinking_tokens),
  };
}

/**
 * `retry-after` in milliseconds, or `null`. Accepts the seconds form only — the HTTP-date form
 * is legal but Anthropic does not send it, and mis-parsing a date into a multi-hour sleep inside
 * a sync cycle is worse than ignoring the header.
 */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Build a live client. Constructing it performs NO I/O and validates nothing about the key
 * beyond its presence — key SHAPE is a config concern, asserted at boot by
 * {@link assertAnthropicKey}, so a bad secret fails the deployment rather than the mail.
 */
export function makeAnthropicClient(opts: AnthropicClientOptions): AnthropicLike {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("makeAnthropicClient: apiKey is required");

  const baseUrl = (opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const log = opts.log;
  const report = opts.onUsage ?? ((r: AnthropicCallReport) => {
    // The default is not "nothing": an unmeasured cost is the failure mode #49 names. With no
    // logger either, we stay silent rather than writing to a stdout the host does not own.
    log?.info("ai_call", { ...r });
  });

  function emit(r: AnthropicCallReport): void {
    try { report(r); } catch { /* a reporter that throws is not allowed to become the outcome */ }
  }

  if (typeof doFetch !== "function") {
    throw new Error("makeAnthropicClient: no fetch implementation (Node >= 18 or pass fetchImpl)");
  }

  return {
    messages: {
      async create(params: unknown): Promise<{ content: unknown; usage?: unknown }> {
        const startedAt = now();
        const requestedModel =
          typeof (params as { model?: unknown } | null)?.model === "string"
            ? (params as { model: string }).model
            : "unknown";
        const body = JSON.stringify(params);
        let attempt = 0;
        let lastStatus: number | null = null;
        let lastRequestId: string | null = null;
        let lastError: unknown;

        for (;;) {
          attempt++;
          let response: Response | undefined;
          let transportError: unknown;
          try {
            response = await doFetch(`${baseUrl}/v1/messages`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": ANTHROPIC_API_VERSION,
              },
              body,
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            transportError = err;
          }

          if (response) {
            lastStatus = response.status;
            lastRequestId = response.headers.get("request-id");
            if (response.ok) {
              const parsed = (await response.json()) as { content?: unknown; usage?: unknown; model?: unknown };
              const usage = readUsage(parsed.usage);
              const model = typeof parsed.model === "string" ? parsed.model : requestedModel;
              emit({
                model, ok: true, status: response.status, latencyMs: now() - startedAt,
                attempts: attempt, requestId: lastRequestId, ...usage,
                costMicroUsd: estimateCostMicroUsd(model, usage),
              });
              return { content: parsed.content, usage: parsed.usage };
            }

            // Read the body for the error TYPE. Anthropic's messages never contain the key, but
            // scrub anyway — this string ends up in logs and in a 500's diagnosis.
            const text = await response.text().catch(() => "");
            let errorType: string | null = null;
            let detail = text.slice(0, 500);
            try {
              const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
              if (typeof parsed.error?.type === "string") errorType = parsed.error.type;
              if (typeof parsed.error?.message === "string") detail = parsed.error.message;
            } catch { /* not JSON: keep the truncated raw text */ }

            lastError = new AnthropicApiError(
              response.status, errorType, lastRequestId,
              scrub(`anthropic ${response.status}${errorType ? ` ${errorType}` : ""}: ${detail}`, apiKey),
            );
            if (!RETRIABLE_STATUS.has(response.status) || attempt > maxRetries) break;
            const wait = retryAfterMs(response.headers)
              ?? Math.round(backoffMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5));
            await sleep(wait);
            continue;
          }

          lastError = new AnthropicTransportError(
            scrub(`anthropic request failed: ${String((transportError as Error)?.name ?? transportError)}`, apiKey),
            transportError,
          );
          if (attempt > maxRetries) break;
          await sleep(Math.round(backoffMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5)));
        }

        emit({
          model: requestedModel, ok: false, status: lastStatus, latencyMs: now() - startedAt,
          attempts: attempt, requestId: lastRequestId,
          inputTokens: null, outputTokens: null, cacheReadTokens: null,
          cacheWriteTokens: null, thinkingTokens: null, costMicroUsd: null,
        });
        throw lastError;
      },
    },
  };
}

/**
 * Assert an `ANTHROPIC_API_KEY` is shaped like one, and return it.
 *
 * The same discipline `liveSecretKey` applies to `STRIPE_SECRET_KEY`, for the same reason: a
 * deployment handed the wrong secret cannot detect it later. Every failure here names the
 * VARIABLE and never the value — config errors surface in `/health`'s `detail`, and the moment
 * one echoes the secret the pattern gets copied to something that matters.
 */
export function assertAnthropicKey(value: string): string {
  const key = value.trim();
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) {
    throw new Error(
      `ANTHROPIC_API_KEY must be an Anthropic API key — it must start with ${ANTHROPIC_KEY_PREFIX}`,
    );
  }
  return key;
}
