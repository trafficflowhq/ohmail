import { eq } from "drizzle-orm";
import { accounts } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { UNMETERED_ACCESS, type AccessPort } from "./entitlements-port.js";

/** Account settings for managed AI. Missing rows leave dispatch permission unknown. */
export async function readAiSwitch(db: Tx, accountId: string): Promise<boolean | undefined> {
  const [row] = await db.select({ aiEnabled: accounts.aiEnabled }).from(accounts)
    .where(eq(accounts.id, accountId)).limit(1);
  return row?.aiEnabled;
}

export async function readManagedModelConsent(db: Tx, accountId: string, access: AccessPort): Promise<boolean> {
  const verdict = await access.accessOrFault?.(accountId, { forDispatch: true });
  return verdict !== undefined && verdict !== "fault" && verdict !== UNMETERED_ACCESS && verdict.ok === true
    && (verdict.dispatchAiEnabled ?? verdict.limits.aiEnabled) === true && await readAiSwitch(db, accountId) === true;
}

/** A withdrawal drops the work. Callers distinguish it from an unavailable model. */
export class ModelConsentWithdrawn extends Error {
  override readonly name = "ModelConsentWithdrawn";
}

/** Share one live consent check across a request's participants and provider retries. */
export function modelConsentGate(read: () => boolean | Promise<boolean>, withdrawn = false) {
  const allowed = async (): Promise<boolean> => {
    if (withdrawn) return false;
    try {
      if (await read() !== true) withdrawn = true;
    } catch {
      withdrawn = true;
    }
    return !withdrawn;
  };
  return {
    get withdrawn() {
      return withdrawn;
    },
    allowed,
    async beforeDispatch() {
      if (!(await allowed())) throw new ModelConsentWithdrawn();
    },
  };
}
