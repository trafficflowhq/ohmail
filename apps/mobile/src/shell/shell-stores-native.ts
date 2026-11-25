/**
 * The shell's stores as the connection layer's port (`take-back.ts`), over the shell's native module: the `-native`
 * twin the node suite never imports. Absent where the module is absent (an older build), so nothing is claimed.
 */
import * as Crypto from "expo-crypto";

import { scopeOf } from "./scope";
import { shellNative } from "./shell-native";
import type { ShellStores } from "./take-back";

const sha256Hex = (text: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });

let calendarReady: boolean | undefined;
const listeners = new Set<(prepared: boolean) => void>();
const CALENDAR_PREPARATION_DEADLINE_MS = 30_000;

export function markCalendarCopiesPrepared(prepared: boolean): void {
  if (calendarReady === true) return;
  calendarReady = prepared;
  for (const listener of listeners) listener(prepared);
  listeners.clear();
}

export function waitForCalendarCopies(): Promise<boolean> {
  if (calendarReady !== undefined) return Promise.resolve(calendarReady);
  return new Promise((ready) => {
    const settle = (prepared: boolean) => {
      listeners.delete(settle);
      clearTimeout(timer);
      ready(prepared);
    };
    const timer = setTimeout(() => settle(false), CALENDAR_PREPARATION_DEADLINE_MS);
    listeners.add(settle);
  });
}

export function nativeShellStores(calendarOnly: boolean): ShellStores | undefined {
  const native = shellNative();
  if (native === null) return undefined;
  return {
    scopeOf: (ownerKey) => scopeOf(ownerKey, sha256Hex),
    keeperScopes: () => native.keeperScopes(),
    ...(calendarOnly ? {
      prepareCalendarKeeper: () => native.prepareCalendarKeeper(),
      eraseKeeper: (scope: string) => native.keeperErase(scope),
      releaseCalendarErasure: (scope: string) => native.releaseCalendarErasure(scope),
      waitForCalendarCopies,
      calendarCopiesPrepared: () => calendarReady === true,
      fenceCalendarWipe: (scope: string) => native.fenceCalendarWipe(scope),
      releaseCalendarWipe: (scope: string) => native.releaseCalendarWipe(scope),
    } : {}),
    forgetKeeper: (scope) => native.keeperForget(scope),
    clearViewCopies: () => native.clearWebData(),
  };
}
