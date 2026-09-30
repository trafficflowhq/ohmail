/**
 * THE USAGE REPORT OF ONE MODEL CALL, and the per-call hook that receives it. A leaf outside
 * `ai/` so the ports (classifier, drafter, proposer) can name the hook without an edge into the
 * model half. Types only; `ai/anthropic-client.ts` fills them and re-exports both.
 */

/**
 * What one metered model call cost, in the vocabulary a margin analysis needs. Handed to
 * the model client's `onUsage` after every call, success or failure.
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
 * ONE CALL'S OWN USAGE HOOK, beside the model client's process-level `onUsage`.
 *
 * Opaque by design: it is handed the report and learns nothing about who asked. A host that
 * needs the account or the action holds them in the closure it passes, so attribution stays out
 * of the AI package. Fired once per call, success or failure, BEFORE the process-level reporter
 * and on the SAME object, so a reporter can tell a claimed report from an unclaimed one. Never
 * awaited; a throw is swallowed.
 */
export interface AiCallOptions {
  onUsage?: (report: AnthropicCallReport) => void;
}
