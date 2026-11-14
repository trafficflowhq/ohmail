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

export function nativeShellStores(): ShellStores | undefined {
  const native = shellNative();
  if (native === null) return undefined;
  return {
    scopeOf: (ownerKey) => scopeOf(ownerKey, sha256Hex),
    keeperScopes: () => native.keeperScopes(),
    forgetKeeper: (scope) => native.keeperForget(scope),
    clearViewCopies: () => native.clearWebData(),
  };
}
