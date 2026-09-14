import { PAGE_MAX_ROW_BYTES } from "@trafficflow/core/transport-frame";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";

/**
 * A PAGE IS BOUNDED BY BYTES AS WELL AS BY ROWS, AND THE BYTE IS THE ONE THE TRANSPORT REFUSES ON.
 *
 * A refused frame is not a slow page: the stdio host answers `sidecar_failed` and the bootstrap
 * never completes, identically on every retry. Measured, never estimated — {@link weighChange}
 * serializes with the SAME `JSON.stringify` the route's `jsonResponse` uses, so the figure the
 * builder spends is the figure the wire carries.
 */

/**
 * What one draft row may weigh, and the floor the message walk leaves for it.
 *
 * Derived, not chosen: the plain body is bounded by `DRAFT_BODY_MAX_BYTES` and the rich half by
 * the `drafts_html_cap` CHECK at the same number, so `ROW_FIELDS` covers only the bounded rest.
 * Two jobs, one number — a draft heavier than this carries bytes no ceiling ever admitted and is
 * WITHHELD, and the message walk stops here rather than at the budget's end, so the first draft
 * of every page has room without overshooting.
 */
const ROW_FIELDS = 64 * 1024;
export const DRAFT_ROW_MAX_BYTES = 2 * DRAFT_BODY_MAX_BYTES + ROW_FIELDS;

/** The bytes one change adds to the page body: its own JSON plus the comma that joins it. */
export function weighChange(change: unknown): number {
  return Buffer.byteLength(JSON.stringify(change), "utf8") + 1;
}

/**
 * One budget, entered at the top of the page and threaded through every phase.
 *
 * Not one ceiling per phase: a page's bytes are one number, and per-segment ceilings compose into
 * no ceiling at all. {@link reserve} is how a phase yields room to the one after it, which is the
 * only reason the split exists — the message walk stops a draft's width early so the draft walk
 * always has somewhere to put its first row.
 */
export class PageByteBudget {
  private spent = 0;

  constructor(private readonly limit: number = PAGE_MAX_ROW_BYTES) {}

  /** What a page may still spend, with `held` bytes kept back for a later phase. */
  remaining(held = 0): number {
    return this.limit - this.spent - held;
  }

  /** Would `bytes` still fit, with `held` bytes kept back for a later phase? */
  admits(bytes: number, held = 0): boolean {
    return bytes <= this.remaining(held);
  }

  /** Spend. Callers that must emit anyway (a page's first row) charge and carry on. */
  charge(bytes: number): void {
    this.spent += bytes;
  }

  get used(): number {
    return this.spent;
  }
}
