import { and, count, countDistinct, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { devices, sessions, users } from "@trafficflow/db";
import type { Db } from "./context.js";

/**
 * THE ACCOUNT'S NAMED DEVICES, AS THREE WHOLE NUMBERS: what the settings record says of them, and
 * all it says. A named device is a row of `devices`: a paired phone or browser, a desktop app's own
 * sign-in. A plain browser sign-in makes none.
 *
 *   made      the account's device rows. ONLY RISES: a row is deleted with its account and by
 *             nothing else (the erasure's sweep; retention only blanks a row's address).
 *   revoked   the rows a person took back in Devices (`devices.revoked_at`, stamped once after that
 *             take-back committed and never cleared). ONLY RISES.
 *   live      the rows that hold a session not revoked: the named rows of the Devices list.
 *
 * A CLIENT DECIDES A NOTICE FROM THE TWO THAT ONLY RISE, never from `live`: that one also falls when
 * a device signs itself out, when a newer sign-in replaces an install's previous one, at a reuse
 * sweep and at a change of a second factor, so a sign-out followed by a pairing reads as no change
 * between two readings, and the pairing was told to nobody. `made` is counted at read from the rows
 * themselves and held by no counter: a path that makes a device raises it by making the row, whether
 * or not it remembers to ring (`auth/device-doorbell.ts`).
 *
 * Numbers alone. Nothing here reads a label, a kind or an address, and nothing that reads these
 * three can learn one.
 *
 * Both reads go through the per-user indexes (`devices_user_idx`, `sessions_user_idx`) by way of the
 * account's users: neither table has an index that leads with the account, and this runs at every
 * read of the settings record.
 */
export interface DeviceNumbers {
  readonly made: number;
  readonly revoked: number;
  readonly live: number;
}

/**
 * THE ACCOUNT'S NAMED DEVICES AS ANOTHER STORE KNOWS THEM. A desktop app signed in to a server keeps a
 * copy of that account, and the copy's own `devices` rows are not the account's: the server makes and
 * takes back its devices. Its feed hands the window the numbers the server's own settings record said
 * (`apps/sidecar/src/cloud-mirror-devices.ts`), or none while it has read none, in place of the copy's
 * own count. A store that mirrors nothing hands no port and counts its own rows, as before.
 */
export interface DeviceNumbersPort {
  /** The three numbers for `accountId`, or `null`: none known, and the record then carries none. */
  numbers(accountId: string): DeviceNumbers | null;
}

export async function deviceNumbers(db: Db, accountId: string): Promise<DeviceNumbers> {
  const own = db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
  const [rows] = await db.select({ made: count(), revoked: count(devices.revokedAt) }).from(devices)
    .where(and(eq(devices.accountId, accountId), inArray(devices.userId, own)));
  const [held] = await db.select({ live: countDistinct(sessions.deviceId) }).from(sessions)
    .where(and(
      eq(sessions.accountId, accountId),
      inArray(sessions.userId, own),
      isNotNull(sessions.deviceId),
      isNull(sessions.revokedAt),
    ));
  return { made: Number(rows?.made ?? 0), revoked: Number(rows?.revoked ?? 0), live: Number(held?.live ?? 0) };
}
