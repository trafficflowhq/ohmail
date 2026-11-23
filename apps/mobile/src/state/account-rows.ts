/**
 * THE KEYSTORE ROWS ONE ACCOUNT OWNS ON THIS PHONE, by name: the keystore cannot list its keys, so an erased
 * account's Forget removes exactly these (`pairing.ts#forgetProfile`). A new per-account row is added here.
 */
import type { UnscreenedPileWire } from "@ohmail/wire";
import { secureOwnerSuffix } from "./servers";
import { seedNotNowKey } from "./seed-offer";

export function pileNoteNotNowKey(ownerKey: string, pile: UnscreenedPileWire): string {
  return `ohmail.pileNote.notNow.${pile}.${secureOwnerSuffix(ownerKey)}`;
}

export function accountRows(ownerKey: string): string[] {
  return [seedNotNowKey(ownerKey), pileNoteNotNowKey(ownerKey, "news"), pileNoteNotNowKey(ownerKey, "receipts")];
}
