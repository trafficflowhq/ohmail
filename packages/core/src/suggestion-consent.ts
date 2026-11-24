/** Carries a consent grant only between the desktop window and its local relay. */
export const SUGGESTION_GRANT_HEADER = "x-ohmail-suggestion-grant";

/** The local relay withdraws the previous grant before the window starts a new read. */
export const WITHDRAW_SUGGESTION_GRANT_PATH = "/local/window/suggestion-consent/withdraw";

/** An affirmative consent answer names a real instant with an explicit time zone. */
export function isSuggestionConsentTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  // Date.parse can normalize a nonexistent day. Check the calendar fields before applying the zone.
  const wall = new Date(`${match[1]}Z`);
  return Number.isFinite(wall.getTime()) && wall.toISOString().slice(0, 19) === match[1];
}
