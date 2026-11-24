/**
 * THE HOSTED ACCOUNT'S DEVICES, AS THE MIRROR LAST READ THEM. A desktop app signed in to a server
 * keeps a copy of that account, and the copy's `devices` rows are only this computer's own: the
 * server makes and takes back the account's devices. So the window's settings record answers the
 * three numbers the HOSTED settings record said (`devicesMade`, `devicesRevoked`, `devices`), and a
 * device paired to the account anywhere is told in the window.
 *
 * Kept in this process alone, per local account, behind a port as the calendar's switch is read
 * (`DeviceNumbersPort`): no column and no journal entry. They need not outlive the process: the
 * mirror reads them once at its start, from the hosted snapshot's first page, before its first pull
 * (a ring it pulled before a restart, or one that was lost, has no settings change left past its
 * cursor), and every path that makes or takes back a device rings the hosted settings record after
 * its commit, so a later rise reaches this mirror as a settings change of its own. A process that has
 * read none answers none, and a window with no numbers tells nothing and keeps nothing: the numbers
 * it has told are its own (`told-devices.ts`).
 * A new mirror starts knowing none, and a mirror that stops forgets its account's, so one hosted
 * account's numbers are never answered for another signed in after it on the same copy.
 *
 * Read closed, as the client's `devicesOf` reads them: the record's own three members, each a whole
 * number from nothing up, all three or none. Numbers alone: no label, kind, id or address.
 */
import type { DeviceNumbers, DeviceNumbersPort } from "@trafficflow/services/mail";

/** A whole number from nothing up. */
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The hosted settings record's three numbers read closed, or `null`. */
export function hostedDevicesOf(record: unknown): DeviceNumbers | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined);
  const live = own("devices");
  const made = own("devicesMade");
  const revoked = own("devicesRevoked");
  return count(live) && count(made) && count(revoked) ? { made, revoked, live } : null;
}

const held = new Map<string, DeviceNumbers>();

/** What the mirror read of the account's devices in a hosted settings record: kept, or forgotten where it said none. */
export function keepHostedDevices(accountId: string, record: unknown): void {
  const numbers = hostedDevicesOf(record);
  if (numbers === null) held.delete(accountId);
  else held.set(accountId, numbers);
}

/**
 * The read at the mirror's start: the hosted snapshot page's one settings record, read closed. Kept
 * only while nothing is known yet for the account: a pull that kept numbers meanwhile read them
 * later than this page was served. Anything it cannot read keeps none.
 */
export function keepHostedDevicesAtStart(accountId: string, page: unknown): void {
  if (held.has(accountId)) return;
  if (typeof page !== "object" || page === null || !Object.hasOwn(page, "changes")) return;
  const changes = (page as { changes: unknown }).changes;
  if (!Array.isArray(changes)) return;
  const records = changes.filter(
    (c: unknown) => typeof c === "object" && c !== null && Object.hasOwn(c, "type") && (c as { type: unknown }).type === "settings",
  );
  if (records.length !== 1 || !Object.hasOwn(records[0], "entity")) return;
  const numbers = hostedDevicesOf((records[0] as { entity: unknown }).entity);
  if (numbers !== null) held.set(accountId, numbers);
}

/** A mirror starts or stops for the account: nothing is known of its devices. */
export function forgetHostedDevices(accountId: string): void {
  held.delete(accountId);
}

/** The port the window's feed is handed. */
export const hostedDevices: DeviceNumbersPort = {
  numbers: (accountId) => held.get(accountId) ?? null,
};
