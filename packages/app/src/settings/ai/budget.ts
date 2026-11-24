export interface AiCredits {
  /** The main balance: what is left of the month's allowance (the trial's pot during a trial). */
  remaining: number;
  /** The monthly allowance, where the server states it. */
  total?: number;
  draftCost?: number;
  /** The one-time setup credits, a separate pool with its own expiry, while they last. Never part of `remaining`. */
  setup?: { remaining: number; expiresAt: string | null };
  /** A running trial: `remaining` is the trial's pot, not a month's allowance. */
  trial?: true;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The budget is optional on older hosts. A reported balance can stand on its own. `lifecycle` is the same answer's
 * lifecycle, read only to know a running trial.
 */
export function aiCreditsOf(raw: unknown, lifecycle?: unknown): AiCredits | null {
  if (raw === null || typeof raw !== "object") return null;
  const { remaining, total, draftCost, setup } = raw as Record<string, unknown>;
  if (!isCount(remaining)) return null;
  const pool = setupOf(setup);
  const trial = (lifecycle as { state?: unknown } | null | undefined)?.state === "trialing";
  return {
    remaining,
    ...(isCount(total) && total > 0 ? { total } : {}),
    ...(isCount(draftCost) ? { draftCost } : {}),
    ...(pool ? { setup: pool } : {}),
    ...(trial ? { trial: true as const } : {}),
  };
}

/** The setup pool while it holds credits; an unreadable expiry is no date, never a guessed one. */
function setupOf(raw: unknown): AiCredits["setup"] | null {
  if (raw === null || typeof raw !== "object") return null;
  const { remaining, expiresAt } = raw as Record<string, unknown>;
  if (!isCount(remaining) || remaining === 0) return null;
  return {
    remaining,
    expiresAt: typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : null,
  };
}
