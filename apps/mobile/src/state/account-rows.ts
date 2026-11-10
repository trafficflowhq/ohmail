/**
 * THE KEYSTORE ROWS ONE ACCOUNT OWNS ON THIS PHONE, by name: the keystore cannot list its keys, so an erased
 * account's Forget removes exactly these (`pairing.ts#forgetProfile`). A new per-account row is added here.
 */
import { seedNotNowKey } from "./seed-offer";

export function accountRows(ownerKey: string): string[] {
  return [seedNotNowKey(ownerKey)];
}
