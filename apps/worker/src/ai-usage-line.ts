import type { AiCallOptions, AnthropicCallReport } from "@trafficflow/core";
import { aiUsageLineOf, type AiUsageLine, type SpendAction } from "@trafficflow/db";

/**
 * A MODEL CALL'S USAGE LINE, as this process attributes it, and the Screener's per-call hook. Its own
 * module, importing the root barrels only, because the desktop engine runs the Screener pass too:
 * the buffer beside it names the hosted entry point, and that must never reach the engine's graph.
 */

/** Wraps a per-call hook so the process reporter knows it was claimed. See `config.ts`'s relay. */
export type UsageHook = (fn: (report: AnthropicCallReport) => void) => NonNullable<AiCallOptions["onUsage"]>;

/** One report as a line attributed to `accountId` and `action`. The host is always the worker. */
export const usageLineOf = (r: AnthropicCallReport, accountId: string, action: SpendAction): AiUsageLine =>
  aiUsageLineOf(r, { accountId, action, host: "worker" });

/** A per-call hook that hands the Screener pass its line, for the candidate's release. */
export function screenerUsageHook(
  hook: UsageHook, accountId: string, take: (line: AiUsageLine) => void,
): AiCallOptions {
  return { onUsage: hook((r) => take(usageLineOf(r, accountId, "screener"))) };
}
