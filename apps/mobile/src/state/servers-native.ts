/**
 * The REAL keystore half of the server-profile store — expo-secure-store behind the two-method
 * `SecureKV` seam. The one module in this app that imports the keystore API; node-side tests
 * inject a memory map through the same seam and never load this file.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: the refresh tokens never ride a cloud or OS backup onto
 * another device — a restored phone re-pairs with one scan per server, which is the ceremony's
 * own recovery and cheaper than a credential that silently multiplied.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { ServerProfileStore, type SecureKV } from "./servers";

/**
 * The digest a re-pair names a stored refresh token's family by (`previousSession`): the server's
 * `hashToken`, SHA-256 of the UTF-8 bytes as base64url without padding.
 */
export async function nativeFamilyDigest(refreshToken: string): Promise<string> {
  const b64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, refreshToken, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function secureKV(): SecureKV {
  const opts: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  return {
    get: (key) => SecureStore.getItemAsync(key, opts),
    set: (key, value) => SecureStore.setItemAsync(key, value, opts),
    remove: (key) => SecureStore.deleteItemAsync(key, opts),
  };
}

/** One store for the app's lifetime — the mutation chain must be shared to mean anything. */
let store: ServerProfileStore | null = null;

export function nativeServerProfiles(): ServerProfileStore {
  return (store ??= new ServerProfileStore(secureKV()));
}
