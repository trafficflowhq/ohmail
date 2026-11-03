import { describe, it, expect } from "vitest";
import { createECDH, hkdfSync, randomBytes } from "node:crypto";
import {
  encryptWebPushBody, encryptWebPushRecord, makeVapidIdentity, vapidIdentityFromEnv,
  WebPushRefusal,
} from "../src/net/webpush.js";
import { makeSubscriber, openAes128Gcm, parseVapidAuthorization } from "./webpush-subscriber.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  RFC 8291 / RFC 8292, PINNED TO THE SPECIFICATIONS' OWN NUMBERS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This module was written from two RFCs against a connector nobody here can run headlessly, so
 * "it looks right" is worth nothing: a Web Push payload that is subtly wrong is indistinguishable
 * from a correct one until a real phone silently fails to render it, and the failure surfaces
 * nowhere — the distributor forwards the bytes, the connector drops them, and no status code
 * anywhere says why. There is exactly one way to hold this down, and it is the specification's own
 * published example.
 *
 * ── THE ANCHOR ────────────────────────────────────────────────────────────────────────────────
 *
 * RFC 8291 §5 publishes a complete worked example: a plaintext, a subscriber keypair, an
 * authentication secret, the server's ephemeral keypair, the salt, and the resulting body. Every
 * input including the randomness is fixed, so the whole encryption can be reproduced exactly —
 * which is the reason `encryptWebPushRecord` takes the salt and the ephemeral key as arguments
 * instead of generating them. The vector drives the SHIPPED function; there is no test-only twin
 * that could drift from it.
 *
 * ── WHAT WOULD HAVE BEEN MISSED WITHOUT IT ────────────────────────────────────────────────────
 *
 * RFC 8291 §3.3 spells its derivation out as two HMACs (`PRK_key = HMAC(auth_secret, ecdh_secret)`,
 * then `IKM = HMAC(PRK_key, key_info || 0x01)`) rather than naming HKDF, and the `|| 0x01` reads
 * like a literal byte to append to the info string. It is HKDF-Expand's block counter. Both
 * readings produce a well-formed 118-byte record that no device can open. The vector is what
 * distinguishes them, and a round-trip test against our own decryptor would have passed either way
 * because both halves would have shared the misreading.
 */

/** RFC 8291 §5 + Appendix A, transcribed from the RFC. Line wrapping removed; the user agent's authentication
 *  secret is named `auth`, as its subscription names it, and Appendix A's shared ECDH secret is derived below
 *  from the two keys rather than written down. */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  /** §5's "resulting message body", with the RFC's presentational line breaks removed. */
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
    + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  /** Appendix A's intermediate values, so a mismatch says WHICH step went wrong. */
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
} as const;

const b64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** Left-pad a scalar to 32 bytes — see the short-scalar regression test below. */
const padTo32 = (b: Buffer): Buffer => {
  if (b.length === 32) return b;
  const out = Buffer.alloc(32);
  b.copy(out, 32 - b.length);
  return out;
};

describe("RFC 8291 §5 — the specification's own example, byte for byte", () => {
  it("produces the RFC's published message body exactly", () => {
    const record = encryptWebPushRecord(
      Buffer.from(RFC8291.plaintext, "utf8"),
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      b64u(RFC8291.salt),
      b64u(RFC8291.asPrivate),
    );
    expect(record.toString("base64url")).toBe(RFC8291.body);
  });

  it("the vector's own intermediate values are the ones the header implies", () => {
    // Not a second derivation — a check that the fixture is internally consistent, so a typo in
    // the transcription above is caught here rather than read as a defect in the module.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(b64u(RFC8291.asPrivate));
    expect(ecdh.getPublicKey().toString("base64url")).toBe(RFC8291.asPublic);
    // The shared secret is checked through the IKM it keys (§3.3), so either key or `auth` mistyped fails here.
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), b64u(RFC8291.uaPublic), b64u(RFC8291.asPublic)]);
    const ikm = hkdfSync("sha256", ecdh.computeSecret(b64u(RFC8291.uaPublic)), b64u(RFC8291.auth), info, 32);
    expect(Buffer.from(ikm).toString("base64url")).toBe(RFC8291.ikm);

    const ua = createECDH("prime256v1");
    ua.setPrivateKey(b64u(RFC8291.uaPrivate));
    expect(ua.getPublicKey().toString("base64url")).toBe(RFC8291.uaPublic);
    // Appendix A's remaining values exist so the header above documents real numbers; they are
    // reached through the record itself in the assertion above.
    expect(b64u(RFC8291.ikm)).toHaveLength(32);
    expect(b64u(RFC8291.cek)).toHaveLength(16);
    expect(b64u(RFC8291.nonce)).toHaveLength(12);
  });

  it("the header is the 86 octets RFC 8188 describes, in that order", () => {
    const record = encryptWebPushRecord(
      Buffer.from(RFC8291.plaintext, "utf8"),
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      b64u(RFC8291.salt), b64u(RFC8291.asPrivate),
    );
    expect(record.subarray(0, 16).toString("base64url")).toBe(RFC8291.salt);   // salt
    expect(record.readUInt32BE(16)).toBe(4096);                               // record size
    expect(record[20]).toBe(65);                                              // keyid length
    expect(record.subarray(21, 86).toString("base64url")).toBe(RFC8291.asPublic);
  });

  it("the decryptor the other guards use reads the RFC's own body back", () => {
    // The subscriber helper is a separate implementation; pointing it at the RFC's body rather
    // than at ours is what stops the two agreeing on a shared mistake.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(b64u(RFC8291.uaPrivate));
    const out = openAes128Gcm(b64u(RFC8291.body), {
      p256dh: RFC8291.uaPublic, auth: RFC8291.auth,
      privateKey: b64u(RFC8291.uaPrivate), authSecret: b64u(RFC8291.auth),
    });
    expect(out.toString("utf8")).toBe(RFC8291.plaintext);
  });
});

describe("the production encryptor: fresh randomness, and a payload only the addressee can open", () => {
  it("round-trips an arbitrary payload to the device it was sealed for", () => {
    const sub = makeSubscriber();
    const record = encryptWebPushBody(Buffer.from('{"type":"wake"}', "utf8"), sub);
    expect(openAes128Gcm(record, sub).toString("utf8")).toBe('{"type":"wake"}');
  });

  it("the fifteen-byte wake seals to 118 bytes — the size an operator will see on the wire", () => {
    // 86-byte header + 15 bytes + the 0x02 delimiter + a 16-byte GCM tag. Pinned because
    // `content-length` is computed from it and a header that disagrees with the body is a request
    // every push service rejects.
    const sub = makeSubscriber();
    expect(encryptWebPushBody(Buffer.from('{"type":"wake"}', "utf8"), sub)).toHaveLength(118);
  });

  it("NEVER reuses a salt or an ephemeral key — the one mistake here that would be catastrophic", () => {
    /**
     * An AES-GCM key/nonce pair used twice leaks the authentication key, and both derive from the
     * salt and the ephemeral keypair. So two encryptions of the SAME plaintext to the SAME device
     * must share no header bytes and no ciphertext.
     */
    const sub = makeSubscriber();
    const a = encryptWebPushBody(Buffer.from("same", "utf8"), sub);
    const b = encryptWebPushBody(Buffer.from("same", "utf8"), sub);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);      // salt
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);    // ephemeral public key
    expect(a.equals(b)).toBe(false);
    // And both still open, so the difference is randomness rather than damage.
    expect(openAes128Gcm(a, sub).toString("utf8")).toBe("same");
    expect(openAes128Gcm(b, sub).toString("utf8")).toBe("same");
  });

  it("NEVER fails on a short ephemeral scalar — the one-in-256 defect", () => {
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════
     *  `getPrivateKey()` STRIPS LEADING ZEROS, AND THAT BROKE ONE SEAL IN A FEW HUNDRED
     * ══════════════════════════════════════════════════════════════════════════════════════
     *
     * `ECDH.prototype.getPrivateKey()` returns a MINIMAL-LENGTH big-endian buffer. A P-256 scalar
     * whose top byte is zero therefore comes back as 31 bytes, which happens for roughly one key in
     * 256 — and `encryptWebPushRecord` asserts exactly 32, so it threw.
     *
     * Measured before the fix: a small share of seals threw `ephemeral key must be 32 bytes`. In
     * production that is one wake in a few hundred failing to send, intermittently, indistinguishable
     * from a network fault.
     *
     * HOW IT WAS FOUND, because it is the interesting part: a FULL-SUITE run went red on the VAPID
     * claim-set test with `TF_VAPID_PRIVATE_KEY is 31 bytes` — that test's own `pair()` helper had
     * the same latent flaw. Run in isolation, this file had passed more than twenty times. A
     * one-in-256 defect is invisible to a targeted re-run and looks exactly like a flake in a big
     * one, which is why the temptation is to re-run and move on.
     *
     * The iteration count is chosen so the pre-fix code fails with overwhelming probability:
     * P(no 31-byte key in 1500 draws) ≈ (255/256)^1500 ≈ 3e-3. Deterministic enough to be a
     * regression test rather than a lottery, and it runs in well under a second.
     */
    const sub = makeSubscriber();
    let failures = 0;
    let lastError: string | null = null;
    for (let i = 0; i < 1500; i++) {
      try {
        const record = encryptWebPushBody('{"type":"wake"}', sub);
        expect(record).toHaveLength(118);
      } catch (err) {
        failures += 1;
        lastError ??= err instanceof Error ? err.message : String(err);
      }
    }
    expect(failures, `${failures} of 1500 seals threw (first: ${lastError})`).toBe(0);
  });

  it("pads a short scalar rather than relaxing the length rule for env keys", () => {
    /**
     * The distinction the padding preserves. A scalar that is short because of the encoding quirk
     * above is padded at the one place the quirk enters; a scalar an OPERATOR supplied short — a
     * truncated paste into an environment variable — is still a refusal. Relaxing the assertion
     * instead of padding would have lost that.
     */
    const shortEnvKey = Buffer.alloc(31, 7).toString("base64url");
    expect(() => makeVapidIdentity({
      publicKey: "B".repeat(87), privateKey: shortEnvKey,
    })).toThrow(/31 bytes, expected 32/);
  });

  it("a body sealed for one device does not open with another's key — it fails the GCM tag", () => {
    const alice = makeSubscriber();
    const bob = makeSubscriber();
    const record = encryptWebPushBody(Buffer.from('{"type":"wake"}', "utf8"), alice);
    // Not "decodes to something else" — the tag must fail, which is the property that makes an
    // endpoint URL insufficient to send a message this app will act on.
    expect(() => openAes128Gcm(record, bob)).toThrow();
  });

  it("refuses a malformed subscriber key by NAME rather than encrypting to nothing", () => {
    const sub = makeSubscriber();
    const cases: [string, { p256dh: string; auth: string }][] = [
      ["a truncated p256dh", { p256dh: sub.p256dh.slice(0, 40), auth: sub.auth }],
      ["an empty p256dh", { p256dh: "", auth: sub.auth }],
      ["a compressed point", { p256dh: Buffer.concat([
        Buffer.from([0x02]), Buffer.alloc(64),
      ]).toString("base64url"), auth: sub.auth }],
      ["an auth secret of the wrong length", { p256dh: sub.p256dh, auth: randomBytes(8).toString("base64url") }],
      ["base64 padding instead of base64url", { p256dh: `${sub.p256dh}==`, auth: sub.auth }],
    ];
    for (const [what, keys] of cases) {
      expect(() => encryptWebPushBody(Buffer.from("x", "utf8"), keys), what)
        .toThrow(WebPushRefusal);
    }
  });

  it("refuses a point that is well formed and NOT on the curve", () => {
    // RFC 8291 §4: failing to validate this is how an attacker extracts a private key. 65 bytes,
    // 0x04 prefix, arbitrary coordinates — everything a length check would accept.
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]);
    expect(() => encryptWebPushBody(Buffer.from("x", "utf8"), {
      p256dh: offCurve.toString("base64url"), auth: randomBytes(16).toString("base64url"),
    })).toThrow(WebPushRefusal);
  });
});

describe("RFC 8292 — the VAPID header says which server sent this", () => {
  const pair = (): { publicKey: string; privateKey: string } => {
    const e = createECDH("prime256v1");
    e.generateKeys();
    return {
      publicKey: e.getPublicKey().toString("base64url"),
      // Padded: `getPrivateKey()` strips leading zeros, and a 31-byte value here is what made
      // this file go red in a full-suite run about one time in eight.
      privateKey: padTo32(e.getPrivateKey()).toString("base64url"),
    };
  };

  it("signs a token that verifies against the key in its own k= field", () => {
    const keys = pair();
    const id = makeVapidIdentity({ ...keys, subject: "mailto:ops@example.net" });
    const parsed = parseVapidAuthorization(id.authorizationFor("https://ntfy.example.net/upABC"));

    expect(parsed.verified, "the signature does not verify — a DER/raw mixup produces exactly this")
      .toBe(true);
    expect(parsed.k).toBe(keys.publicKey);
    expect(id.publicKey).toBe(keys.publicKey);
    expect(parsed.header).toEqual({ typ: "JWT", alg: "ES256" });
  });

  it("the audience is the endpoint's ORIGIN and never its path", () => {
    // RFC 8292 §2. The path of a UnifiedPush endpoint is a per-device topic, so signing over it
    // would mint one token per device — and break any push service that checks `aud` against its
    // own origin, which is what the spec tells them to do.
    const id = makeVapidIdentity({ ...pair() });
    const a = parseVapidAuthorization(id.authorizationFor("https://ntfy.example.net/upABC"));
    expect(a.claims.aud).toBe("https://ntfy.example.net");
    const b = parseVapidAuthorization(id.authorizationFor("https://ntfy.example.net:8443/x/y?z=1"));
    expect(b.claims.aud).toBe("https://ntfy.example.net:8443");
  });

  it("carries EXACTLY {aud, exp} — and sub only when an operator configured one", () => {
    /**
     * The claim set is a closed list, and this is the census for it. A JWT is the one part of a
     * wake request that is signed, structured and easy to extend, so it is exactly where a
     * per-account value would end up: a `jti` derived from the account, a `sub` naming the user.
     * Anything added here is red.
     */
    const withoutSub = makeVapidIdentity({ ...pair() });
    expect(Object.keys(parseVapidAuthorization(withoutSub.authorizationFor("https://p.example"))
      .claims).sort()).toEqual(["aud", "exp"]);

    const withSub = makeVapidIdentity({ ...pair(), subject: "mailto:ops@example.net" });
    const claims = parseVapidAuthorization(withSub.authorizationFor("https://p.example")).claims;
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "sub"]);
    expect(claims.sub).toBe("mailto:ops@example.net");
  });

  it("expires within RFC 8292's 24-hour ceiling, from a constant offset", () => {
    const at = Date.parse("2026-08-21T12:00:00Z");
    const id = makeVapidIdentity({ ...pair(), now: () => at });
    const exp = parseVapidAuthorization(id.authorizationFor("https://p.example")).claims.exp;
    expect(typeof exp).toBe("number");
    const ttl = (exp as number) - Math.floor(at / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("reuses one token per audience and mints a new one for a different distributor", () => {
    const id = makeVapidIdentity({ ...pair() });
    const one = id.authorizationFor("https://a.example/up/1");
    const same = id.authorizationFor("https://a.example/up/2");
    const other = id.authorizationFor("https://b.example/up/1");
    expect(same).toBe(one);          // same origin, same token
    expect(other).not.toBe(one);     // different origin, different audience, different token
  });

  it("re-signs once the cached token is close to expiring", () => {
    let clock = Date.parse("2026-08-21T12:00:00Z");
    const id = makeVapidIdentity({ ...pair(), now: () => clock });
    const first = id.authorizationFor("https://a.example/up");
    clock += 60 * 60 * 1000;                                    // an hour later: still fresh
    expect(id.authorizationFor("https://a.example/up")).toBe(first);
    clock += 11 * 60 * 60 * 1000;                               // twelve hours in: past the margin
    const later = id.authorizationFor("https://a.example/up");
    expect(later).not.toBe(first);
    expect(parseVapidAuthorization(later).verified).toBe(true);
  });

  it("REFUSES A MISMATCHED PAIR — the failure that is otherwise completely silent", () => {
    /**
     * Two generations pasted together. Phones register with one public key, the server signs with
     * the other, every wake is dropped by the connector, and nothing anywhere reports it: the
     * distributor accepted the POST, so there is no status code and no log line. This refusal is
     * the only thing that ever says so.
     */
    const a = pair();
    const b = pair();
    expect(() => makeVapidIdentity({ publicKey: a.publicKey, privateKey: b.privateKey }))
      .toThrow(/not a pair/);
  });

  it("refuses malformed key material and a subject that is not a URI", () => {
    const p = pair();
    expect(() => makeVapidIdentity({ publicKey: p.publicKey.slice(0, 40), privateKey: p.privateKey }))
      .toThrow(WebPushRefusal);
    expect(() => makeVapidIdentity({ publicKey: p.publicKey, privateKey: "" }))
      .toThrow(WebPushRefusal);
    expect(() => makeVapidIdentity({ ...p, subject: "ops@example.net" }))
      .toThrow(/mailto: or https/);
    expect(() => makeVapidIdentity({ ...p, subject: "tel:+41000000000" }))
      .toThrow(/mailto: or https/);
    // An https subject IS allowed by RFC 8292 — so the rule above is not "mailto only".
    expect(() => makeVapidIdentity({ ...p, subject: "https://ohmail.example/contact" })).not.toThrow();
  });

  it("refuses an endpoint that is not a url, rather than signing for a guessed audience", () => {
    const id = makeVapidIdentity({ ...pair() });
    expect(() => id.authorizationFor("not-a-url")).toThrow(WebPushRefusal);
  });
});

describe("reading the environment: absent, invalid and configured are three different answers", () => {
  const p = (): { publicKey: string; privateKey: string } => {
    const e = createECDH("prime256v1");
    e.generateKeys();
    return {
      publicKey: e.getPublicKey().toString("base64url"),
      // Padded: `getPrivateKey()` strips leading zeros, and a 31-byte value here is what made
      // this file go red in a full-suite run about one time in eight.
      privateKey: padTo32(e.getPrivateKey()).toString("base64url"),
    };
  };

  it("nothing set is ABSENT — a supported state, not an error", () => {
    const got = vapidIdentityFromEnv({});
    expect(got.kind).toBe("absent");
  });

  it("HALF set is INVALID, not absent — the half-configuration an operator actually produces", () => {
    /**
     * The distinction the sender depends on. If a half-configuration read as `absent`, the keyless
     * arm would keep working and the operator would have no way to learn that the key they pasted
     * does nothing at all.
     */
    const keys = p();
    expect(vapidIdentityFromEnv({ TF_VAPID_PUBLIC_KEY: keys.publicKey }).kind).toBe("invalid");
    expect(vapidIdentityFromEnv({ TF_VAPID_PRIVATE_KEY: keys.privateKey }).kind).toBe("invalid");
  });

  it("a mismatched or malformed pair is INVALID, with a reason that names no key material", () => {
    const a = p();
    const b = p();
    const got = vapidIdentityFromEnv({
      TF_VAPID_PUBLIC_KEY: a.publicKey, TF_VAPID_PRIVATE_KEY: b.privateKey,
    });
    expect(got.kind).toBe("invalid");
    const why = got.kind === "invalid" ? got.why : "";
    expect(why).toMatch(/not a pair/);
    // The reason reaches a log drain, so it must not echo the values it was given.
    expect(why).not.toContain(a.publicKey);
    expect(why).not.toContain(b.privateKey);
  });

  it("a matching pair is CONFIGURED, and whitespace around a pasted value is tolerated", () => {
    const keys = p();
    const got = vapidIdentityFromEnv({
      TF_VAPID_PUBLIC_KEY: `  ${keys.publicKey}\n`,
      TF_VAPID_PRIVATE_KEY: `${keys.privateKey}  `,
      TF_VAPID_SUBJECT: "mailto:ops@example.net",
    });
    expect(got.kind).toBe("configured");
    if (got.kind !== "configured") return;
    expect(got.identity.publicKey).toBe(keys.publicKey);
    expect(parseVapidAuthorization(got.identity.authorizationFor("https://p.example")).claims.sub)
      .toBe("mailto:ops@example.net");
  });
});
