export interface AiCredits {
  remaining: number;
  total?: number;
  draftCost?: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The budget is optional on older hosts. A reported balance can stand on its own. */
export function aiCreditsOf(raw: unknown): AiCredits | null {
  if (raw === null || typeof raw !== "object") return null;
  const { remaining, total, draftCost } = raw as Record<string, unknown>;
  if (!isCount(remaining)) return null;
  return {
    remaining,
    ...(isCount(total) && total > 0 ? { total } : {}),
    ...(isCount(draftCost) ? { draftCost } : {}),
  };
}
