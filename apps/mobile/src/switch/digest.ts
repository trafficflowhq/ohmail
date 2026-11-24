/**
 * THE DIGEST OF A PAIRING, the one thing of a sign-in the switch's first call carries: SHA-256 over the server's
 * origin, a newline and the account id, base64url without padding. It names no server and no account to whoever
 * reads it, and lets the receiver tell its own pairing from another. The hash is handed in (expo-crypto on the phone).
 *
 * And a handoff's CHALLENGE: SHA-256 of the verifier's characters, base64url without padding, as the server derives
 * it from the verifier at the redeem. A verifier native hands over is held to its challenge here too.
 */
export type Sha256Base64 = (text: string) => Promise<string>;

const urlSafe = (b64: string): string => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pairingDigest(sha256: Sha256Base64, origin: string, accountId: string): Promise<string> {
  return urlSafe(await sha256(`${origin}\n${accountId}`));
}

export async function challengeOf(sha256: Sha256Base64, verifier: string): Promise<string> {
  return urlSafe(await sha256(verifier));
}
