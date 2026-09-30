import {
  aiUsageLineOf, AI_USAGE_LINES_PER_RELEASE,
  type AiUsageHost, type AiUsageLine, type SpendAction,
} from "@trafficflow/db";
import type { AiCallOptions } from "@trafficflow/core/mail";

/**
 * THE MODEL CALLS ONE PIECE OF WORK MADE, as its release carries them. The host is the composition
 * root's statement; absent, no hook is handed to the model and every release goes out as before.
 * The model client learns nothing about who asked: the account and the action live in this
 * closure. At most {@link AI_USAGE_LINES_PER_RELEASE} lines, the first ones kept.
 */
export interface UsageLines {
  /** For the model call; `undefined` on a host that records nothing. */
  readonly call: AiCallOptions | undefined;
  /** How many lines were collected. */
  readonly count: number;
  /** Spread into the release: `{}` when nothing was collected. */
  field(): { usage?: readonly AiUsageLine[] };
}

export function usageLines(
  host: AiUsageHost | undefined, accountId: string, action: SpendAction,
): UsageLines {
  const lines: AiUsageLine[] = [];
  return {
    call: host === undefined ? undefined : {
      onUsage: (r) => {
        if (lines.length < AI_USAGE_LINES_PER_RELEASE) lines.push(aiUsageLineOf(r, { accountId, action, host }));
      },
    },
    get count() { return lines.length; },
    field: () => (lines.length > 0 ? { usage: [...lines] } : {}),
  };
}
