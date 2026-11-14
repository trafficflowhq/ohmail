/**
 * THE FILINGS THAT WAIT, AS READ: the reader of the filings block (moved out of the web shell's `MailboxFilings.tsx`
 * as it stood). The wire's answer is narrowed: anything that is not its shape reads as unreadable, never as
 * "nothing waits". The old path imports it from here until it leaves.
 */
import type { MailboxFacts } from "../../mail-state/mail-state.js";

/** One folder's filings that wait: how many, since when, why, and what Leave would settle them through. */
export interface FilingGroup {
  folder: string;
  count: number;
  /** Deletes waiting to land in Trash: Leave never settles them. */
  deletes: number;
  through: string | null;
  since: string | null;
  nextAttemptAt: string | null;
  at: string | null;
  reasons: Array<{ reason: string | null; count: number }>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The wire narrowed: anything that is not the shape reads as unreadable, never as "nothing waits". */
export function filingGroupsOf(body: unknown, mailboxId: string): FilingGroup[] | null {
  const b = body as { mailboxId?: unknown; groups?: unknown } | null;
  if (!b || b.mailboxId !== mailboxId || !Array.isArray(b.groups)) return null;
  const out: FilingGroup[] = [];
  for (const g of b.groups as Array<Record<string, unknown>>) {
    const folder = str(g?.folder);
    if (folder === null || !Array.isArray(g.reasons)) return null;
    out.push({
      folder,
      count: num(g.count),
      deletes: num(g.deletes),
      through: str(g.through),
      since: str(g.since),
      nextAttemptAt: str(g.nextAttemptAt),
      at: str(g.at),
      reasons: (g.reasons as Array<Record<string, unknown>>).map((r) => ({
        reason: str(r?.reason),
        count: num(r?.count),
      })),
    });
  }
  return out;
}

/** Waiting by the strip's rule: stuck or deferred. */
export const filingWaits = (m: Pick<MailboxFacts, "status" | "organizerRole" | "filing">): boolean =>
  m.status !== "disabled" &&
  m.organizerRole !== "reader" &&
  Boolean(m.filing && ((m.filing.stuck ?? 0) > 0 || m.filing.deferred > 0));
