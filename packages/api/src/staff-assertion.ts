import {
  createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject,
} from "node:crypto";

/**
 * THE STAFF ASSERTION — a short-lived Ed25519 statement that a live staff session asked for
 * ONE request to another program: `v1.<kid>.<b64url(claims)>.<b64url(sig)>`, the signature over
 * the first three parts joined by dots. `req` binds method, path with query and body hash, so
 * an assertion cannot be replayed against a different request. The audience is the caller's
 * choice and is recorded; the verifier holds its own constant. Node `crypto` only.
 */

export const STAFF_ASSERTION_VERSION = "v1";
export const STAFF_ASSERTION_ISSUER = "ohmail-api";
export const STAFF_ASSERTION_READ_TTL_SECONDS = 120;
export const STAFF_ASSERTION_WRITE_TTL_SECONDS = 60;
export const STAFF_ASSERTION_MAX_REQUESTS = 8;
/**
 * How far in the verifier's future an `iat` may sit and still be admitted: the minting API and
 * the verifying program run on separate clocks. `exp` gets no such allowance.
 */
export const STAFF_ASSERTION_CLOCK_SKEW_SECONDS = 30;

export type StaffAssertionTier = 0 | 1 | 2;

export interface StaffAssertionClaims {
  v: 1;
  iss: string;
  aud: string;
  /** The `staff_users` id. */
  sub: string;
  /** The `staff_sessions` id the mint was asked through. */
  sid: string;
  /** The staff login address at mint time, so the verifier's audit row can name a person. */
  label: string;
  roles: string[];
  tier: StaffAssertionTier;
  /** The request id both audit trails carry. */
  rid: string;
  /** {@link requestDigest} of the one request this assertion is for. */
  req: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
  jti: string;
}

export interface StaffSigningKey {
  kid: string;
  privateKey: KeyObject;
}

/** A key id: short, printable, no dot (the dot is the token's separator). */
export const STAFF_ASSERTION_KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** `sha256hex(METHOD + " " + pathWithQuery + "\n" + bodySha256)`; a GET's body is "". */
export function requestDigest(method: string, pathWithQuery: string, bodySha256: string): string {
  return sha256Hex(`${method.toUpperCase()} ${pathWithQuery}\n${bodySha256.toLowerCase()}`);
}

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string): Buffer | null =>
  /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, "base64url") : null;

/** The claims in their fixed key order, so one claim set always serializes to one string. */
function claimsJson(c: StaffAssertionClaims): string {
  return JSON.stringify({
    v: c.v, iss: c.iss, aud: c.aud, sub: c.sub, sid: c.sid, label: c.label, roles: c.roles,
    tier: c.tier, rid: c.rid, req: c.req, iat: c.iat, exp: c.exp, jti: c.jti,
  });
}

export function mintStaffAssertion(claims: StaffAssertionClaims, key: StaffSigningKey): string {
  const head = `${STAFF_ASSERTION_VERSION}.${key.kid}.${b64url(Buffer.from(claimsJson(claims), "utf8"))}`;
  const sig = sign(null, Buffer.from(head, "utf8"), key.privateKey);
  return `${head}.${b64url(sig)}`;
}

export const newJti = (): string => randomUUID();

export type StaffAssertionVerdict =
  | { ok: true; claims: StaffAssertionClaims; kid: string }
  | { ok: false; code: "assertion_invalid"; why: string };

export interface StaffAssertionExpectation {
  aud: string;
  /** Unix seconds. */
  now: number;
  method: string;
  pathWithQuery: string;
  bodySha256: string;
  /** A write's assertion may live {@link STAFF_ASSERTION_WRITE_TTL_SECONDS} at most. */
  write?: boolean;
}

/**
 * The reference verifier, in the order a verifier must ask: shape, key by `kid`, signature,
 * then the claims (`v`, `iss`, `aud`, the TTL ceiling, `iat - 30 s <= now < exp`, `req`). Every
 * refusal is the one code; `why` is for logs and tests, never for the caller.
 */
export function verifyStaffAssertion(
  token: string, publicKeys: ReadonlyMap<string, KeyObject>, expect: StaffAssertionExpectation,
): StaffAssertionVerdict {
  const refuse = (why: string): StaffAssertionVerdict => ({ ok: false, code: "assertion_invalid", why });
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== STAFF_ASSERTION_VERSION) return refuse("shape");
  const [, kid, body, sigPart] = parts as [string, string, string, string];
  const key = publicKeys.get(kid);
  if (!key) return refuse("unknown_kid");
  const sig = fromB64url(sigPart);
  const raw = fromB64url(body);
  if (!sig || !raw) return refuse("shape");
  const signed = Buffer.from(`${STAFF_ASSERTION_VERSION}.${kid}.${body}`, "utf8");
  if (!verify(null, signed, key, sig)) return refuse("signature");
  let c: StaffAssertionClaims;
  try {
    c = JSON.parse(raw.toString("utf8")) as StaffAssertionClaims;
  } catch {
    return refuse("shape");
  }
  if (c.v !== 1 || c.iss !== STAFF_ASSERTION_ISSUER) return refuse("issuer");
  if (c.aud !== expect.aud) return refuse("audience");
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) return refuse("shape");
  const ttl = expect.write ? STAFF_ASSERTION_WRITE_TTL_SECONDS : STAFF_ASSERTION_READ_TTL_SECONDS;
  if (c.exp - c.iat > ttl) return refuse("ttl");
  if (expect.now < c.iat - STAFF_ASSERTION_CLOCK_SKEW_SECONDS) return refuse("not_yet_valid");
  if (expect.now >= c.exp) return refuse("expired");
  if (c.req !== requestDigest(expect.method, expect.pathWithQuery, expect.bodySha256)) {
    return refuse("request");
  }
  return { ok: true, claims: c, kid };
}

/**
 * The signing key from its environment value: a PKCS#8 PEM (literal `\n` escapes allowed),
 * that PEM base64-encoded on one line, or the base64 DER. Anything that is not an Ed25519
 * private key is `null` — the mint then answers `503 assertion_unarmed`, never a weaker key.
 */
export function staffSigningKeyOf(raw: string | undefined, kid: string | undefined): StaffSigningKey | null {
  const value = raw?.trim();
  const id = kid?.trim();
  if (!value || !id || !STAFF_ASSERTION_KID_RE.test(id)) return null;
  try {
    let pem = value.replace(/\\n/g, "\n");
    if (!pem.includes("-----BEGIN")) {
      const decoded = Buffer.from(value, "base64");
      const text = decoded.toString("utf8");
      pem = text.includes("-----BEGIN") ? text : "";
      if (!pem) {
        const key = createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
        return key.asymmetricKeyType === "ed25519" ? { kid: id, privateKey: key } : null;
      }
    }
    const key = createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? { kid: id, privateKey: key } : null;
  } catch {
    return null;
  }
}

/** The public half as SPKI DER base64 — the form a verifier's key list carries. */
export function spkiBase64Of(key: KeyObject): string {
  const pub = key.type === "public" ? key : createPublicKey(key);
  return pub.export({ format: "der", type: "spki" }).toString("base64");
}

export function publicKeyOfSpki(spkiBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
}
