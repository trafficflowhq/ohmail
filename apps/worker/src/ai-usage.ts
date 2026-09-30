import type { ClassifierPort, DraftPort, Logger, WorkflowPort } from "@trafficflow/core";
import { AI_USAGE_LINES_PER_POST, type AiUsageLine, type UsageReceipt } from "@trafficflow/db";
import { usageLineOf, type UsageHook } from "./ai-usage-line.js";

export { screenerUsageHook, type UsageHook } from "./ai-usage-line.js";

/** How long lines wait before the timer flushes them. */
export const AI_USAGE_FLUSH_MS = 30_000;
/** The most lines held; past it the OLDEST are dropped and counted. */
export const AI_USAGE_BUFFER_MAX = 5_000;

/** The one method of the entitlements port a buffer needs. */
export interface UsageRecorder {
  recordUsage(lines: readonly AiUsageLine[]): Promise<UsageReceipt>;
}

export interface AiUsageBuffer {
  push(line: AiUsageLine): void;
  /** Send what is held, in batches, stopping at the buffer's budget. Never throws. */
  flush(): Promise<void>;
  /** Stop the timer. Held lines stay until the next flush. */
  stop(): void;
}

/**
 * THE WORKER'S USAGE LINES, held for at most {@link AI_USAGE_FLUSH_MS} and sent once. Delivery is
 * at most once: a batch the program does not take is logged and dropped, never retried, because
 * a retried batch with no identity counts its lines twice. So the record under-reports on a crash
 * by at most 30 s of calls plus one failed flush, and never over-reports. It prices, sums and
 * stores nothing; the timer is unref'd, so it never holds a stopping process open.
 */
export function makeAiUsageBuffer(opts: {
  port: UsageRecorder; log: Logger;
  /** How long one flush may take: the caller's call budget (`ENTITLEMENTS_CALL_BUDGET_MS`). */
  budgetMs: number;
  flushMs?: number; max?: number;
}): AiUsageBuffer {
  const flushMs = opts.flushMs ?? AI_USAGE_FLUSH_MS;
  const max = opts.max ?? AI_USAGE_BUFFER_MAX;
  let held: AiUsageLine[] = [];
  let droppedOldest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by a 404: the program has no `/v1/usage`, so nothing more is held or sent this process. */
  let noDoor = false;

  const arm = (): void => {
    if (timer !== null || noDoor) return;
    timer = setTimeout(() => { timer = null; void flush(); }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  async function flush(): Promise<void> {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (held.length === 0 && droppedOldest === 0) return;
    // Taken before the first await: a line pushed mid-flush joins the next batch, never this one.
    const lines = held;
    held = [];
    const dropped = droppedOldest;
    droppedOldest = 0;
    const deadline = Date.now() + opts.budgetMs;
    let sent = 0;
    const failed = { refused: 0, unreachable: 0 };
    for (let i = 0; i < lines.length; i += AI_USAGE_LINES_PER_POST) {
      const batch = lines.slice(i, i + AI_USAGE_LINES_PER_POST);
      const left = deadline - Date.now();
      const receipt: UsageReceipt = left <= 0 ? "unreachable" : await within(opts.port.recordUsage(batch), left);
      if (receipt === "settled") sent += batch.length;
      else if (receipt === "no_door") {
        // Refused, and for good: the rest of this flush and every later line are dropped unsent.
        failed.refused += lines.length - i;
        noDoor = true;
        opts.log.warn("ai_usage_recording_stopped", { why: "no_usage_door" });
        break;
      } else failed[receipt] += batch.length;
    }
    if (sent > 0 || (failed.refused + failed.unreachable === 0 && dropped > 0)) {
      opts.log.info("ai_usage_flushed", { lines: sent, droppedOldest: dropped });
    }
    // One line per class: a refusal is the program's answer, never logged as an outage.
    for (const status of ["refused", "unreachable"] as const) {
      if (failed[status] > 0) {
        opts.log.warn("ai_usage_flush_failed", { lines: failed[status], status, droppedOldest: dropped });
      }
    }
  }

  return {
    push(line) {
      if (noDoor) return;
      held.push(line);
      if (held.length > max) {
        droppedOldest += held.length - max;
        held.splice(0, held.length - max);
      }
      arm();
    },
    flush,
    stop() { if (timer !== null) { clearTimeout(timer); timer = null; } },
  };
}

/** A receipt, or `unreachable` when the bound passes first. The call itself is never awaited past it. */
async function within(p: Promise<UsageReceipt>, ms: number): Promise<UsageReceipt> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<UsageReceipt>((resolve) => { t = setTimeout(() => resolve("unreachable"), ms); });
  (t as { unref?: () => void } | undefined)?.unref?.();
  try {
    return await Promise.race([p.catch((): UsageReceipt => "unreachable"), bound]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

/**
 * THE INGEST CLASSIFIER, attributed: `classify` only, as `classify_ingest`, its line into the
 * buffer. It exposes NO `screen`: a Screener call through this wrapper would be recorded as
 * ingest, so the Screener pass takes its own classifier and carries its line on its release.
 */
export function attributedIngestClassifier(
  port: ClassifierPort, accountId: string, hook: UsageHook, buffer: AiUsageBuffer,
): ClassifierPort {
  return {
    classify: (input) => port.classify(input, {
      onUsage: hook((r) => buffer.push(usageLineOf(r, accountId, "classify_ingest"))),
    }),
  };
}

/** A workflow step's drafter, attributed as `workflow`, its line into the buffer. */
export function attributedWorkflowDrafter(
  drafter: DraftPort, accountId: string, hook: UsageHook, buffer: AiUsageBuffer,
): DraftPort {
  return {
    draft: (input, call) => drafter.draft(input, {
      ...(call?.signal ? { signal: call.signal } : {}),
      onUsage: hook((r) => buffer.push(usageLineOf(r, accountId, "workflow"))),
    }),
  };
}

/**
 * A proposer whose one call's line is handed to `take`, for the pass's release to carry. The
 * proposal pass releases on every exit, so its line needs no buffer.
 */
export function attributedProposer(
  port: WorkflowPort, accountId: string, hook: UsageHook, take: (line: AiUsageLine) => void,
): WorkflowPort {
  return {
    propose: (patterns) => port.propose(patterns, {
      onUsage: hook((r) => take(usageLineOf(r, accountId, "propose"))),
    }),
  };
}
