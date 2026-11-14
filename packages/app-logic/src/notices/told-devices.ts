/**
 * THE NUMBERS OF THE ACCOUNT'S DEVICES THIS DEVICE HAS TOLD. A device paired to the account is
 * told from two numbers of the settings record that only rise: how many named devices were ever
 * made, and how many of them a person took back in Devices. Compared with what the app last read
 * in memory, a pairing made while no app was open was told nowhere: the first reading after a
 * start had nothing to compare with. So each device keeps, per account, the two numbers it has
 * told, and the caller compares the record with these at every settle, the first one too.
 *
 * Kept in this device's own storage under one name per account, as two whole numbers and nothing
 * else: no device's name, kind or address is in the record these come from, and none is kept. Read
 * closed: a value that is anything but exactly these two whole numbers is no kept numbers, which
 * reads as a device that learns from now and tells nothing. An account's numbers are never read
 * for another: the name carries the account.
 *
 * Removed where an account ends on a device, in one place on each surface: the web's sign-out
 * (`forgetThisBrowser`), the desktop window's sweep (`forgetWindowScopes`), and on the phone with
 * the web view's data, which the native side clears whole when a pairing is forgotten
 * (`payShellWipe`). A device that then signs in again has none kept and tells nothing of itself.
 */
import { TOLD_DEVICES_PREFIX } from "@ohmail/client-engine";
import { localStorageDoor, type StorageDoor } from "../storage/durable.js";
import { scopeSuffix, type StorageScope } from "../storage/scope.js";

/** The name's start, the engine's (`notices/sample.ts`); the account's scope follows. */
export { TOLD_DEVICES_PREFIX };

/** The name the numbers told for `scope` are kept under. */
export function toldDevicesKey(scope: StorageScope): string {
  return `${TOLD_DEVICES_PREFIX}${scopeSuffix(scope)}`;
}

/** What this device has told of an account's devices: the two numbers that only rise. */
export interface ToldDevices {
  readonly made: number;
  readonly revoked: number;
}

/** Where a device keeps them. */
export interface ToldDevicesStore {
  /** The numbers kept for `scope`, or `null`: none kept, or a value that does not read closed. */
  read(scope: string): ToldDevices | null;
  write(scope: string, told: ToldDevices): void;
}

/** A whole number from nothing upwards. */
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The kept value read closed: exactly its two own members, each a whole number, or `null`. */
function readClosed(text: string | null): ToldDevices | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "made") || !Object.hasOwn(value, "revoked"))
    return null;
  const { made, revoked } = value as { made: unknown; revoked: unknown };
  return count(made) && count(revoked) ? { made, revoked } : null;
}

/** The store over this device's own storage, or over `door` where a test hands one in. */
export function toldDevicesIn(door: StorageDoor = localStorageDoor("notices.told")): ToldDevicesStore {
  return {
    read: (scope) => readClosed(door.get(toldDevicesKey(scope))),
    write(scope, told) {
      // Built new from the two numbers: whatever else an object handed in carried is not kept.
      door.set(toldDevicesKey(scope), JSON.stringify({ made: told.made, revoked: told.revoked }));
    },
  };
}
