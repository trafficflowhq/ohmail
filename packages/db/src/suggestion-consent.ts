import { modelConsentGate, readManagedModelConsent } from "./model-consent.js";
import { eq } from "drizzle-orm";
import type { AccessPort } from "./entitlements-port.js";
import type { Tx } from "./change-log.js";
import { accountSettings } from "./schema-mail.js";

/** The account's current settings row. The caller decides the defaults for missing settings. */
export async function readAccountSettings(db: Tx, accountId: string) {
  const [row] = await db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)).limit(1);
  return row;
}

/** Read the account's current affirmative grant. A missing or unreadable row grants nothing. */
export async function readSuggestionGrant(db: Tx, accountId: string): Promise<Date | null> {
  try {
    const stamp = (await readAccountSettings(db, accountId))?.autoSuggestAt;
    if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime())) return null;
    return stamp;
  } catch {
    return null;
  }
}

/** Automatic runs stay bound to their timestamp. A manual press supplies no automatic grant. */
export function suggestionConsentGate(db: Tx, accountId: string, expected: Date | null | undefined, access?: AccessPort) {
  return modelConsentGate(async () => {
    if (access && !(await readManagedModelConsent(db, accountId, access))) return false;
    if (expected === undefined) return true;
    const current = await readSuggestionGrant(db, accountId);
    return current !== null && current.getTime() === expected?.getTime();
  }, expected === null);
}
