import {
  createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, timingSafeEqual,
} from "node:crypto";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WEB PUSH ENCRYPTION AND VAPID — RFC 8291 + RFC 8292, on the node standard library alone
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The wake sender POSTs a fifteen-byte constant to an endpoint a phone's UnifiedPush distributor
 * minted. Until now it sent that constant in the clear, which reaches the distributor and stops
 * there: a UnifiedPush 3.x connector registers with a VAPID public key and renders ONLY messages
 * that are RFC 8291 `aes128gcm`-encrypted to the device's own key and RFC 8292 VAPID-signed by the
 * server it registered with. A plaintext body arrives and is dropped. This module is the arm that
 * makes the same constant renderable.
 *
 * ── NO DEPENDENCY, AND THAT IS A DECISION RATHER THAN A CONSTRAINT ────────────────────────────
 *
 * `web-push` is the obvious package and it is deliberately not here. This is a long-running
 * process holding database credentials and KEK material, the whole surface it needs is ECDH on one
 * named curve plus HKDF plus AES-GCM plus one ECDSA signature — all of which `node:crypto` has —
 * and every one of those is a primitive whose correctness is pinned by a published test vector. A
 * dependency here would buy nothing and add a supply-chain edge to the process with the most to
 * lose. The same argument `pinned-fetch.ts` makes for using `http.request` over `undici`.
 *
 * ── THE PLAINTEXT IS NOT THIS MODULE'S BUSINESS, AND THAT IS LOAD-BEARING ─────────────────────
 *
 * Nothing here knows what a wake is. {@link encryptWebPushBody} takes bytes and returns bytes, so
 * the "the payload is a closed constant" invariant stays where it can be policed: in the sender,
 * whose censuses read the sender's own source. A module that knew the constant would be a second
 * place it could be widened, and a second place a reviewer would have to think to look.
 *
 * ── WHY THE RECORD BUILDER IS SPLIT IN TWO ────────────────────────────────────────────────────
 *
 * {@link encryptWebPushRecord} takes the salt and the ephemeral private key as REQUIRED arguments;
 * {@link encryptWebPushBody} generates both and calls it. The split exists so that RFC 8291's own
 * published example drives the SHIPPED code path rather than a test-only twin: the vector fixes
 * every input including the randomness, and a function that generated its own could only be
 * checked against itself. There is deliberately no optional "inject the randomness" parameter on
 * the production entry point — an override that exists is an override that can be passed by
 * accident, and reusing a salt/ephemeral pair reuses an AES-GCM key and nonce, which is the one
 * mistake in this file that would be catastrophic and silent.
 */

/** Every refusal from this module, with a short reason safe to log (it names a class, not a key). */
export class WebPushRefusal extends Error {
  constructor(public readonly why: string) {
    super(why);
    this.name = "WebPushRefusal";
  }
}

/**
 * The subscriber's keys, exactly as a UnifiedPush connector hands them over and exactly as
 * `push_subscriptions` stores them: `p256dh` is the device's public key (base64url, uncompressed
 * P-256 point) and `auth` is its authentication secret (base64url, 16 bytes).
 */
export interface WebPushKeys {
  p256dh: string;
  auth: string;
}

/** Record size. One record is all a fifteen-byte payload will ever need; 4096 is the customary value. */
const RECORD_SIZE = 4096;

/** RFC 8291 §3.3's context string, with its terminating NUL. */
const KEY_INFO_PREFIX = Buffer.from("WebPush: info\0", "utf8");
/** RFC 8188 §2.2's derivation labels, each with its terminating NUL. */
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");

/** An uncompressed P-256 point is `0x04 || X || Y` — 65 bytes, always. */
const POINT_BYTES = 65;
/** A P-256 private scalar is 32 bytes, always. */
const SCALAR_BYTES = 32;

/**
 * Decode unpadded base64url and REQUIRE an exact byte length.
 *
 * `Buffer.from(s, "base64url")` is famously forgiving: it ignores characters it does not
 * understand and returns a SHORTER buffer rather than throwing. So a truncated key, a key with a
 * stray newline from a shell `$(cat …)`, and a key that is simply the wrong thing all arrive as
 * plausible-looking bytes. Checking the length is what turns those into a named refusal instead of
 * a wake that is encrypted to nothing.
 */
function decodeExact(value: string, bytes: number, what: string): Buffer {
  if (typeof value !== "string" || value === "") throw new WebPushRefusal(`${what} is empty`);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new WebPushRefusal(`${what} is not unpadded base64url`);
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== bytes) {
    throw new WebPushRefusal(`${what} is ${buf.length} bytes, expected ${bytes}`);
  }
  return buf;
}

/** The public point for a private scalar. A generator multiplication — no peer is involved. */
function publicFromPrivate(rawPrivate: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(rawPrivate);
  return ecdh.getPublicKey();
}

/**
 * Left-pad a scalar to 32 bytes.
 *
 * ── WHY THIS EXISTS, AND IT IS NOT A TIDINESS FUNCTION ────────────────────────────────────────
 *
 * `ECDH.prototype.getPrivateKey()` returns the scalar as a MINIMAL-LENGTH big-endian buffer: it
 * strips leading zero bytes. A P-256 scalar whose top byte happens to be zero therefore comes back
 * as 31 bytes, and that happens for about one key in 256.
 *
 * MEASURED, on this machine: 19 of 5000 generated keys were 31 bytes (0.38%), and 10 of 3000 calls
 * to {@link encryptWebPushBody} threw `ephemeral key must be 32 bytes` before this padding existed
 * — so roughly one sealed wake in three hundred failed to send, intermittently, with nothing to
 * distinguish it from a network fault. It was found by a full-suite run in which the VAPID claim-set
 * test went red on a 31-byte key; in isolation that file had passed twenty-plus times, which is
 * exactly how a one-in-256 defect hides.
 *
 * The strict length assertions are KEPT rather than relaxed. A scalar that is short because of this
 * encoding quirk is padded here, at the one place the quirk enters; a scalar that is short for any
 * other reason (a truncated paste into an environment variable) is still a refusal, which is the
 * distinction worth preserving. Note the generator script is unaffected: it reads the scalar from a
 * JWK, and RFC 7518 fixes `d` at the curve's byte length — checked, 3000/3000 at 32 bytes.
 */
function padScalar(scalar: Buffer): Buffer {
  if (scalar.length === SCALAR_BYTES) return scalar;
  if (scalar.length > SCALAR_BYTES) throw new WebPushRefusal("scalar is longer than the curve order");
  const out = Buffer.alloc(SCALAR_BYTES);
  scalar.copy(out, SCALAR_BYTES - scalar.length);
  return out;
}

/**
 * ── RFC 8291 §3.3 + RFC 8188 §2.2/§2.3, with the randomness supplied ─────────────────────────
 *
 * The two HKDF steps in one sentence: the device's `auth` secret and the ECDH secret are combined
 * into an input keying material that binds BOTH public keys (so a record cannot be replayed at a
 * different device), and that IKM plus the per-message salt derives the AES-128-GCM key and nonce.
 *
 * `crypto.hkdfSync(digest, ikm, salt, info, length)` is a full HKDF — extract then expand — which
 * is exactly the shape both specs describe. RFC 8291 writes its step out as two HMACs
 * (`PRK_key = HMAC(auth_secret, ecdh_secret)`, then `IKM = HMAC(PRK_key, key_info || 0x01)`)
 * because it is spelling out what HKDF does for a 32-byte output; the `|| 0x01` is HKDF-Expand's
 * counter, not an extra input. Reading it as literal concatenation is the classic way to get a
 * plausible, wrong answer here, so it is written down: the note above the vector test is what
 * proves which reading is right.
 *
 * @param plaintext the payload. A string is taken as UTF-8; bytes are taken as they are. This
 * module does not care what either means — see the header.
 * @param keys the subscriber's `p256dh` and `auth`.
 * @param salt 16 bytes, FRESH PER MESSAGE.
 * @param ephemeralPrivate the server's per-message P-256 scalar, FRESH PER MESSAGE.
 */
export function encryptWebPushRecord(
  plaintext: string | Uint8Array, keys: WebPushKeys, salt: Buffer, ephemeralPrivate: Buffer,
): Buffer {
  const uaPublic = decodeExact(keys.p256dh, POINT_BYTES, "p256dh");
  if (uaPublic[0] !== 0x04) throw new WebPushRefusal("p256dh is not an uncompressed point");
  // `auth` is 16 bytes by RFC 8291 §3.2. Checked rather than accepted at any length, because a
  // connector that handed over something else would produce a record no device could open, and
  // the failure would look like a delivery problem rather than a configuration one.
  const authSecret = decodeExact(keys.auth, 16, "auth");
  if (salt.length !== 16) throw new WebPushRefusal("salt must be 16 bytes");
  if (ephemeralPrivate.length !== SCALAR_BYTES) throw new WebPushRefusal("ephemeral key must be 32 bytes");

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(ephemeralPrivate);
  const asPublic = ecdh.getPublicKey();

  let ecdhSecret: Buffer;
  try {
    // Node validates that the peer point is ON the curve here and throws if it is not, which is
    // RFC 8291 §4's "MUST verify the public key is on the P-256 curve" — an invalid-curve point is
    // how an attacker extracts a private key, so this throw is a security control and not a
    // formatting check. Converted to a named refusal so a bad registration is a skipped endpoint
    // rather than an exception climbing out of the sender.
    ecdhSecret = ecdh.computeSecret(uaPublic);
  } catch {
    throw new WebPushRefusal("p256dh is not a valid point on P-256");
  }

  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  // The RFC 8188 header: salt, record size, then the key id — which for Web Push is the server's
  // ephemeral public key, so the device knows what to run ECDH against.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);

  // A single record, so the padding delimiter is 0x02 ("this is the last one") and there is no
  // padding after it. `0x01` here would say "another record follows" and the device would wait
  // for one that never comes.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const body = Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return Buffer.concat([header, body]);
}

/**
 * Encrypt for one subscriber, with fresh randomness. THE production entry point.
 *
 * The salt and the ephemeral keypair are generated here and are never reused: an AES-GCM key and
 * nonce pair used twice leaks the authentication key, and both derive from exactly these two
 * values. There is no way for a caller to supply them, which is the point — see the header.
 *
 * `plaintext` accepts a STRING as well as bytes, and that is for the caller's census rather than
 * for convenience: the wake sender's payload is a module-level string constant, and a call that
 * reads `encryptWebPushBody(WAKE_BODY, keys)` is one a source scan can pin by name. Forcing an
 * `Buffer.from(WAKE_BODY, "utf8")` at every call site would put an expression between the constant
 * and the encryptor, and an expression is a place something else can be substituted.
 */
export function encryptWebPushBody(plaintext: string | Uint8Array, keys: WebPushKeys): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // `padScalar` is load-bearing, not defensive: `getPrivateKey()` strips leading zero bytes, so
  // about one generated key in 256 is 31 bytes and would fail the length assertion below. See its
  // docblock — this was one failed seal in roughly three hundred.
  return encryptWebPushRecord(plaintext, keys, randomBytes(16), padScalar(ecdh.getPrivateKey()));
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  VAPID (RFC 8292) — the server saying WHICH server it is
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The connector was handed a public key at registration and from then on it accepts only messages
 * signed by the matching private key. That is the whole mechanism: not authorisation to send, but
 * identity — "this wake came from the server you paired with, not from anybody who learned your
 * endpoint URL". Endpoint URLs travel through a distributor, so that distinction is worth having.
 */
export interface VapidIdentity {
  /**
   * The public key, base64url, 87 characters. NOT a secret: it is served to clients so they can
   * register with it, and it rides in `k=` on every request.
   */
  readonly publicKey: string;
  /**
   * The `Authorization` header value for one endpoint: `vapid t=<JWT>, k=<publicKey>`.
   *
   * The JWT's audience is the endpoint's ORIGIN and not its full URL (RFC 8292 §2), which is why
   * this takes the endpoint rather than being computed once: one token is valid for every endpoint
   * at one distributor and for none at another.
   */
  authorizationFor(endpoint: string): string;
}

/** How long a VAPID token lives. RFC 8292 §2 caps `exp` at 24 hours from now; half that is ample. */
const TOKEN_TTL_S = 12 * 60 * 60;
/** Re-sign this long before expiry, so a token is never handed out on the edge of being refused. */
const TOKEN_RENEW_MARGIN_S = 60 * 60;

/**
 * Build the deployment's VAPID identity from the two base64url halves.
 *
 * ── THE PAIR IS ASSERTED HERE, AND THAT IS THE WHOLE VALUE OF TAKING BOTH ─────────────────────
 *
 * The public key could be derived from the private one, so taking both looks redundant. It is not:
 * the public key is ALSO served to clients by a different process (the API holds only the public
 * half — the private key never goes near a request handler), so the two values exist separately in
 * an operator's configuration whether this function asks for them or not. Asking for both lets
 * this refuse a MISMATCHED pair, which is what a copy-paste from two generations produces and is
 * otherwise completely silent: phones register with one key, the server signs with another, and
 * every wake is dropped by the connector with nothing logged anywhere. That failure is invisible
 * from both ends, so it is worth a comparison at boot.
 *
 * @param subject RFC 8292's optional `sub` claim, a `mailto:` or `https:` URI. Omitted from the
 * token when absent — the spec says SHOULD rather than MUST, and inventing a contact address for
 * an operator who did not give one would put a wrong fact in a signed token.
 */
export function makeVapidIdentity(opts: {
  publicKey: string; privateKey: string; subject?: string | null; now?: () => number;
}): VapidIdentity {
  const rawPublic = decodeExact(opts.publicKey, POINT_BYTES, "TF_VAPID_PUBLIC_KEY");
  if (rawPublic[0] !== 0x04) throw new WebPushRefusal("TF_VAPID_PUBLIC_KEY is not an uncompressed point");
  const rawPrivate = decodeExact(opts.privateKey, SCALAR_BYTES, "TF_VAPID_PRIVATE_KEY");

  let derived: Buffer;
  try {
    derived = publicFromPrivate(rawPrivate);
  } catch {
    throw new WebPushRefusal("TF_VAPID_PRIVATE_KEY is not a valid P-256 scalar");
  }
  if (derived.length !== rawPublic.length || !timingSafeEqual(derived, rawPublic)) {
    throw new WebPushRefusal("TF_VAPID_PUBLIC_KEY and TF_VAPID_PRIVATE_KEY are not a pair");
  }

  const subject = (opts.subject ?? "").trim();
  if (subject !== "" && !/^(mailto:|https:\/\/)/.test(subject)) {
    throw new WebPushRefusal("TF_VAPID_SUBJECT must be a mailto: or https:// URI");
  }

  // Built once. The signing key is a scalar plus the point it implies, which is what a JWK needs;
  // going through JWK rather than DER keeps this to one shape and no ASN.1.
  const signingKey = createPrivateKey({
    key: {
      kty: "EC", crv: "P-256",
      d: rawPrivate.toString("base64url"),
      x: derived.subarray(1, 33).toString("base64url"),
      y: derived.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });

  const publicKey = rawPublic.toString("base64url");
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8")
    .toString("base64url");
  const now = opts.now ?? Date.now;

  /**
   * One token per AUDIENCE, cached until it is close to expiring.
   *
   * Not an optimisation worth much on its own — an ECDSA signature is well under a millisecond —
   * but the sender dials the same handful of distributors over and over, and a cache keyed by
   * origin means the token a device sees is stable rather than different on every wake. The map is
   * bounded in practice by the number of distinct distributors the deployment's users chose; a
   * token is ~200 bytes.
   */
  const tokens = new Map<string, { jwt: string; expEpochS: number }>();

  return {
    publicKey,
    authorizationFor(endpoint: string): string {
      let audience: string;
      try {
        // `origin` and not `href`: RFC 8292 §2 makes the audience the push service, and the path
        // of an endpoint is the per-device topic. Signing over the path would mint one token per
        // device and disclose nothing extra — but it would also break any push service that
        // checks the audience against its own origin, which is what the spec tells them to do.
        audience = new URL(endpoint).origin;
      } catch {
        throw new WebPushRefusal("endpoint is not a url");
      }

      const nowS = Math.floor(now() / 1000);
      const cached = tokens.get(audience);
      if (cached && cached.expEpochS - nowS > TOKEN_RENEW_MARGIN_S) {
        return `vapid t=${cached.jwt}, k=${publicKey}`;
      }

      const expEpochS = nowS + TOKEN_TTL_S;
      const claims = Buffer.from(JSON.stringify(
        subject === "" ? { aud: audience, exp: expEpochS } : { aud: audience, exp: expEpochS, sub: subject },
      ), "utf8").toString("base64url");
      const signingInput = Buffer.from(`${header}.${claims}`, "utf8");
      // `ieee-p1363` is RAW r‖s, which is what JOSE's ES256 is. Node's DEFAULT is DER, and a DER
      // signature in a JWT is accepted by nothing — it is the single most common way to produce a
      // token that looks entirely well formed and verifies nowhere.
      const sig = sign("sha256", signingInput, { key: signingKey, dsaEncoding: "ieee-p1363" });
      const jwt = `${header}.${claims}.${sig.toString("base64url")}`;
      tokens.set(audience, { jwt, expEpochS });
      return `vapid t=${jwt}, k=${publicKey}`;
    },
  };
}

/**
 * What the environment says about this deployment's VAPID identity.
 *
 * ── THE THREE ANSWERS ARE THREE DIFFERENT OPERATIONAL SITUATIONS, NOT ONE MISSING VALUE ───────
 *
 * Collapsing `absent` and `invalid` into "no identity" is the mistake this type exists to prevent,
 * and the difference is the whole reason the caller can behave correctly:
 *
 *  · `configured` — sign and seal.
 *  · `absent` — the operator set NOTHING. A supported, ordinary state: the wake still goes out in
 *    the clear to raw consumers (an `ntfy` topic somebody watches directly), the app still syncs
 *    on foreground, and registrations that offered keys are skipped. Degradation, one line in the
 *    log, nothing else.
 *  · `invalid` — the operator set SOMETHING and it is wrong: a truncated paste, a mismatched pair,
 *    half the pair. This must NOT be treated as `absent`, because the keyless arm would keep
 *    working and the operator would have no way to learn that the thing they configured does
 *    nothing. It is a configuration error and it is reported as one.
 *
 * Which is why this returns a discriminated answer rather than `VapidIdentity | null`: a nullable
 * return makes the two failures the same value, and then the sender cannot tell them apart no
 * matter how carefully it is written.
 */
export type VapidFromEnv =
  | { kind: "configured"; identity: VapidIdentity }
  /** Nothing was set. The keyless arm runs; keyed registrations are skipped. */
  | { kind: "absent"; why: string }
  /** Something was set and it is unusable. The caller refuses to send rather than half-working. */
  | { kind: "invalid"; why: string };

/**
 * Read the identity from the environment.
 *
 * Returns a reason rather than throwing, because a boot that died here would take mail syncing
 * down for a latency feature — the caller decides what an unusable configuration is worth, and for
 * the organizer the answer is "refuse to send wakes, keep syncing mail".
 *
 * The half-configured cases are `invalid` and not `absent`, deliberately. Setting only
 * `TF_VAPID_PUBLIC_KEY` is the half-configuration an operator actually produces — it is the value
 * that goes in two places and the one that is not a secret, so it is the one that gets pasted
 * first and remembered — and a server serving a public key it cannot sign for is a phone that
 * registers happily and never rings.
 */
export function vapidIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): VapidFromEnv {
  const pub = (env.TF_VAPID_PUBLIC_KEY ?? "").trim();
  const priv = (env.TF_VAPID_PRIVATE_KEY ?? "").trim();
  if (pub === "" && priv === "") return { kind: "absent", why: "no VAPID keypair is configured" };
  if (priv === "") {
    return { kind: "invalid", why: "TF_VAPID_PUBLIC_KEY is set but TF_VAPID_PRIVATE_KEY is not" };
  }
  if (pub === "") {
    return { kind: "invalid", why: "TF_VAPID_PRIVATE_KEY is set but TF_VAPID_PUBLIC_KEY is not" };
  }
  try {
    return {
      kind: "configured",
      identity: makeVapidIdentity({
        publicKey: pub, privateKey: priv, subject: env.TF_VAPID_SUBJECT ?? null,
      }),
    };
  } catch (err) {
    // The `why` from a WebPushRefusal names a class of problem and never echoes key material —
    // this string reaches a log drain.
    return {
      kind: "invalid",
      why: err instanceof WebPushRefusal ? err.why : "VAPID configuration is unreadable",
    };
  }
}
