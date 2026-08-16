import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON, AuthenticationResponseJSON, WebAuthnCredential,
} from "@simplewebauthn/server";
import type { AuthConfig } from "./types.js";

export interface StoredWebauthnCredential {
  credentialId: string;   // base64url
  publicKey: string;      // base64url COSE key
  counter: bigint;
  transports: string[];
}

/** Begin a registration ceremony. The returned `options.challenge` MUST be
 *  persisted (single-use) and echoed back at verify time. */
export async function buildRegistrationOptions(
  cfg: AuthConfig,
  user: { id: string; email: string; displayName: string },
  existing: StoredWebauthnCredential[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    attestationType: "none",
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: bigint;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

/**
 * Verify a registration response against the stored challenge + our RP-ID and the
 * origin the ceremony was OPENED on.
 *
 * `expectedOrigin` is a REQUIRED single value read from
 * `webauthn_challenges.origin` — never `cfg.origin` (which may now be an allow-list)
 * and never the verify request's own header. Passing the allow-list here would
 * accept a ceremony opened on one allow-listed origin and finished on another;
 * `@simplewebauthn` compares `clientDataJSON.origin` against exactly this string, so
 * the pin is enforced by the signed client data itself.
 */
export async function verifyRegistration(
  cfg: AuthConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  expectedOrigin: string,
): Promise<VerifiedRegistration> {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: cfg.rpID,
    requireUserVerification: false,
  });
  if (!v.verified || !v.registrationInfo) {
    throw new Error("registration verification failed");
  }
  const info = v.registrationInfo;
  const cred = info.credential;
  return {
    credentialId: cred.id,
    publicKey: Buffer.from(cred.publicKey).toString("base64url"),
    counter: BigInt(cred.counter),
    transports: (cred.transports ?? []) as string[],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

/** Begin an authentication (assertion) ceremony. */
export async function buildAuthenticationOptions(
  cfg: AuthConfig,
  allow: StoredWebauthnCredential[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: "preferred",
    allowCredentials: allow.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
  });
}

export interface VerifiedAssertion {
  credentialId: string;
  newCounter: bigint;
}

/**
 * Verify an assertion against the stored challenge, our RP-ID, the origin the
 * ceremony was OPENED on (see {@link verifyRegistration}), and the stored
 * public key. `@simplewebauthn/server` itself REJECTS a regressed signature counter
 * (clone detection) — this wrapper surfaces that.
 */
export async function verifyAssertion(
  cfg: AuthConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  stored: StoredWebauthnCredential,
  expectedOrigin: string,
): Promise<VerifiedAssertion> {
  const credential: WebAuthnCredential = {
    id: stored.credentialId,
    publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
    counter: Number(stored.counter),
    transports: stored.transports as WebAuthnCredential["transports"],
  };
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: cfg.rpID,
    credential,
    requireUserVerification: false,
  });
  if (!v.verified) throw new Error("assertion verification failed");
  return { credentialId: stored.credentialId, newCounter: BigInt(v.authenticationInfo.newCounter) };
}
