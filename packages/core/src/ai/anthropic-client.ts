import { assertPublicHttpUrlShape } from "../net/ssrf-guard.js";
import type { AnthropicLike } from "./classify.js";
import type { Logger } from "../log.js";
import type { AiCallOptions, AnthropicCallReport } from "../ai-call-report.js";

export type { AiCallOptions, AnthropicCallReport } from "../ai-call-report.js";

/**
 * The live model client — a `fetch` shim over `POST /v1/messages` satisfying {@link
 * AnthropicLike}, the seam the three port factories take. A shim and not `@anthropic-ai/sdk`: the
 * SDK is not in the lockfile and would land in the worker image and the Vercel bundle, while the
 * ports use one method — `messages.create(params)`; retries, timeouts and error typing are ~150
 * lines. In `packages/core` because the worker may import core + db only (the dependency test
 * pins the list recursively) and is this client's biggest consumer. Hermetic: `fetchImpl` is
 * injectable, nothing executes at import time, and a deployment without `ANTHROPIC_API_KEY` never
 * constructs it.
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
 * Published list prices, USD per million tokens, as of 2026-09-28.
 *
 * Hard-coded deliberately and narrowly: the alternative is that per-action cost is unknowable at
 * the moment of spend, which is the state this table exists to end. A model absent from this
 * table reports `costMicroUsd: null` rather than a wrong number — silence beats a fabricated
 * margin. Re-check when a model id or a list price changes.
 */
export const MODEL_PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
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
 * The worst-case wall time one call through this client can take. A per-ATTEMPT timeout reads
 * like a whole-call bound and is not one: `AI_CLAIM_TTL_MS` was sized at 60 s on the stated
 * ground that "the worker's model timeout is 30 s", while the real ceiling is three attempts plus
 * two backoffs — a live holder's claim expired mid-call and a second caller bought a second
 * provider call against one credit. Two terms: `timeoutMs × (maxRetries + 1)`, plus `maxRetries ×
 * MAX_RETRY_AFTER_MS` — the server's `retry-after` cap dominates the exponential default, and a
 * bound that only holds when the provider is not asking us to wait is not a bound. Excludes DNS
 * and connection setup; leave margin above it.
 */
export function callCeilingMs(o: { timeoutMs?: number; maxRetries?: number } = {}): number {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, o.maxRetries ?? DEFAULT_MAX_RETRIES);
  return timeoutMs * (maxRetries + 1) + maxRetries * MAX_RETRY_AFTER_MS;
}

export interface AnthropicClientOptions {
  /** The API key. NEVER logged, never put in an error message (see {@link scrub}). */
  apiKey: string;
  /**
   * Where the model lives. Judged at construction by the repository's own address gate — see
   * {@link assertModelBaseUrl}. Absent ⇒ {@link DEFAULT_ANTHROPIC_BASE_URL}.
   */
  baseUrl?: string;
  /**
   * Permit a {@link baseUrl} on a loopback/private address. OFF by default, and the ONLY
   * relaxation: scheme, userinfo and the reserved name spaces still apply. For the one
   * deployment shape that needs it — a self-host operator running their own model gateway on
   * their own box — where the strict rule would refuse a correct configuration.
   */
  allowPrivateBaseUrl?: boolean;
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
   * Called after EVERY metered call, success or failure: the process-level hook, where a host
   * writes its `ai_call` line. A host that records usage by account attributes each call through
   * the call's own hook ({@link AiCallOptions}), which fires first. Invoked through a try/catch: a
   * reporter that throws must not become the outcome of a call that succeeded. It may return a
   * promise, and this client AWAITS it, because on a serverless host an unawaited write may never
   * land. A rejecting reporter is swallowed like a throwing one.
   */
  onUsage?: (report: AnthropicCallReport) => void | Promise<void>;
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
 * One signal that aborts when either does — `AbortSignal.any`, spelled out for runtimes that lack
 * it. The per-attempt timeout and the caller's deadline are both limits on the same fetch.
 */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const both = new AbortController();
  const stop = (): void => {
    both.abort();
    a.removeEventListener("abort", stop);
    b.removeEventListener("abort", stop);
  };
  a.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  return both.signal;
}

/**
 * Build a live client. Constructing it performs NO I/O and validates nothing about the key
 * beyond its presence — key SHAPE is a config concern, asserted at boot by
 * {@link assertAnthropicKey}, so a bad secret fails the deployment rather than the mail.
 */
export function makeAnthropicClient(opts: AnthropicClientOptions): AnthropicLike {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("makeAnthropicClient: apiKey is required");

  const baseUrl = assertModelBaseUrl(
    (opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, ""),
    opts.allowPrivateBaseUrl === true,
  );
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const log = opts.log;
  const report = opts.onUsage ?? ((r: AnthropicCallReport) => {
    // The default is not "nothing": an unmeasured cost is its own failure mode, and this default
    // IS the failure mode, not the mitigation. A host that forgets `onUsage` gets a deployment
    // where every metered call works, every credit is debited, and nothing records what the
    // tokens cost — and with no `log` either, this line resolves to `undefined?.info(…)` and does
    // literally nothing. That was the worker's state for a stretch: the arm making most of the
    // product's model calls, silently unmeasured, beside a comment claiming otherwise. The guard
    // is not here (a default cannot detect its own absence) but in the entitlements program's
    // daily reconcile, which compares recorded calls against the credit ledger.
    log?.info("ai_call", { ...r });
  });

  async function emit(r: AnthropicCallReport, own?: AiCallOptions["onUsage"]): Promise<void> {
    // The call's own hook FIRST, on the same object (see {@link AiCallOptions}). Then the process
    // reporter, AWAITED; the try/catch covers a synchronous throw and a rejected promise. See
    // {@link AnthropicClientOptions.onUsage} for why the await is here at all.
    try { own?.(r); } catch { /* a hook that fails is not allowed to become the outcome */ }
    try { await report(r); } catch { /* a reporter that fails is not allowed to become the outcome */ }
  }

  if (typeof doFetch !== "function") {
    throw new Error("makeAnthropicClient: no fetch implementation (Node >= 18 or pass fetchImpl)");
  }

  return {
    messages: {
      async create(
        params: unknown, call?: { signal?: AbortSignal } & AiCallOptions,
      ): Promise<{ content: unknown; usage?: unknown }> {
        const startedAt = now();
        // THE CALLER'S DEADLINE BINDS EVERY ATTEMPT AND EVERY WAIT BETWEEN THEM. A per-attempt
        // timeout plus a `retry-after` of up to 20 s outlived the function it ran in; once the
        // signal fires no attempt starts and a wait in progress ends, so the caller's own close
        // (a refund, a sentence) runs inside the time it held back for it.
        const deadline = call?.signal;
        const waitFor = async (ms: number): Promise<void> => {
          if (!deadline) return sleep(ms);
          if (deadline.aborted) return;
          await Promise.race([
            sleep(ms),
            new Promise<void>((resolve) => deadline.addEventListener("abort", () => resolve(), { once: true })),
          ]);
        };
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
          if (deadline?.aborted) {
            lastError ??= new AnthropicTransportError("anthropic request not started: the caller's deadline passed");
            break;
          }
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
              signal: deadline ? eitherSignal(AbortSignal.timeout(timeoutMs), deadline) : AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            // Held: the transport fault is classified with the response handling below.
            transportError = err;
          }

          if (response) {
            lastStatus = response.status;
            lastRequestId = response.headers.get("request-id");
            if (response.ok) {
              const parsed = (await response.json()) as { content?: unknown; usage?: unknown; model?: unknown };
              const usage = readUsage(parsed.usage);
              const model = typeof parsed.model === "string" ? parsed.model : requestedModel;
              await emit({
                model, ok: true, status: response.status, latencyMs: now() - startedAt,
                attempts: attempt, requestId: lastRequestId, ...usage,
                costMicroUsd: estimateCostMicroUsd(model, usage),
              }, call?.onUsage);
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
            await waitFor(wait);
            continue;
          }

          lastError = new AnthropicTransportError(
            scrub(`anthropic request failed: ${String((transportError as Error)?.name ?? transportError)}`, apiKey),
            transportError,
          );
          if (attempt > maxRetries) break;
          await waitFor(Math.round(backoffMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5)));
        }

        await emit({
          model: requestedModel, ok: false, status: lastStatus, latencyMs: now() - startedAt,
          attempts: attempt, requestId: lastRequestId,
          inputTokens: null, outputTokens: null, cacheReadTokens: null,
          cacheWriteTokens: null, thinkingTokens: null, costMicroUsd: null,
        }, call?.onUsage);
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
/**
 * The base URL gate. This is the one outbound path carrying BOTH the reader's mail and a live
 * credential, so an operator's string takes the address rules every other outbound URL here
 * takes: https only, no userinfo, no loopback/private/link-local address, none of the reserved
 * name spaces. At CONSTRUCTION — boot — so a wrong value fails the deployment and not the first
 * customer's mail. An explicit port is admitted: an ordinary shape, not an address rule.
 *
 * `assertPublicHttpUrlShape` is the shared gate's synchronous half, not a second copy. It
 * resolves nothing, so a NAME's addresses are unchecked here and it returns no pin.
 */
export function assertModelBaseUrl(baseUrl: string, allowPrivate: boolean): string {
  try {
    assertPublicHttpUrlShape(baseUrl, {
      httpsOnly: !allowPrivate, allowExplicitPort: true, allowPrivateAddress: allowPrivate,
    });
  } catch (e) {
    // Re-thrown naming the variable an operator can act on; the gate's own message says nothing
    // about where the value came from, and "not a permitted url" alone is unactionable at boot.
    throw new Error(`ANTHROPIC_BASE_URL is ${(e as Error).message}`);
  }
  return baseUrl;
}

export function assertAnthropicKey(value: string): string {
  const key = value.trim();
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) {
    throw new Error(
      `ANTHROPIC_API_KEY must be an Anthropic API key — it must start with ${ANTHROPIC_KEY_PREFIX}`,
    );
  }
  return key;
}
