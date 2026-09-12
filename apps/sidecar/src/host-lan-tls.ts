import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LAN DOOR'S OWN KEY — TLS whose trust is established by the PAIRING CEREMONY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS EXISTS TO FIX, MEASURED ────────────────────────────────────────────────────────
 *
 * The LAN door served plain HTTP, and the only client it was ever built for cannot speak plain
 * HTTP. A release Android build targets API 36, where `cleartextTrafficPermitted` defaults to
 * FALSE, and the shipped manifest declares no exemption — so the app refuses to open the socket
 * at all (`java.net.UnknownServiceException: CLEARTEXT communication to <addr> not permitted by
 * network security policy`), before a byte moves. iOS App Transport Security imposes the same
 * refusal by default on any `http://` load. Every earlier exercise of this path was a DEBUG
 * build, whose manifest carries `usesCleartextTraffic="true"`, which is why the door looked
 * reachable for its whole life.
 *
 * The obvious fix — a `network_security_config.xml` permitting cleartext — was rejected. Android's
 * config grammar has no CIDR syntax, so "private ranges only" cannot be expressed declaratively;
 * the honest spellings are a blanket cleartext exemption (which turns every request the app makes
 * anywhere into a downgradable one) or a per-address list that cannot be written for an address
 * chosen at pairing time. Trading a functional break for a transport downgrade on the app that
 * carries a person's whole mailbox is a worse product, not a shipped feature.
 *
 * So the DOOR grows TLS, and the trust comes from the ceremony rather than from a certificate
 * authority.
 *
 * ── WHY NOT A REAL CERTIFICATE, AND WHY NOT THE PLEX TRICK ───────────────────────────────────
 *
 * No public CA issues for `10.0.2.15`, and there is no name to be issued for: the address is
 * whatever DHCP handed this machine this morning. The well-known workaround (Plex's
 * `*.plex.direct`) mints a per-server certificate from a wildcard the vendor controls, resolved
 * through the vendor's own DNS — which requires an always-on issuing service and an account.
 * This product's desktop app has neither by design, and shipping a publicly-trusted private key
 * inside a downloadable binary would be handing every user a universal certificate for our own
 * domain. Rejected on both counts.
 *
 * ── WHAT IS ENFORCED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────
 *
 * The pairing link carries this key's SPKI fingerprint (`host-lan-pin.ts` composes it; the phone
 * pins it for that host). The client's rule is then exactly one thing:
 *
 *   **the key the door presents must be the key the person scanned, byte for byte.**
 *
 * Everything a normal TLS client checks is deliberately NOT checked, and each absence is a
 * decision rather than an omission:
 *
 *  · **No chain.** There is no issuer to trust — the pin IS the trust anchor, and it is a
 *    stronger one than a CA (it names one key, not every key a CA will ever sign).
 *  · **No hostname match.** The pin is bound to `(host, port)` on the phone's side, so the name
 *    in the certificate adds nothing; an attacker at a different address still cannot present
 *    the pinned key. The subject alternative name is therefore one fixed reserved name
 *    (`ohmail-desktop-host.invalid`, RFC 2606 — a TLD that can never be delegated), which is an
 *    honest way of saying "this certificate asserts no identity". Putting the machine's current
 *    IP in it would be worse: it would suggest an identity claim the address can invalidate by
 *    the next DHCP lease, while the key — the thing that actually matters — had not changed.
 *  · **No expiry.** A pinned self-signed key's `notAfter` is theatre: nothing renews it, nobody
 *    checks a revocation list for it, and the only thing an expiry could do is un-pair every
 *    phone in the household on a date nobody chose — including on a machine whose clock is
 *    simply wrong. The validity window is therefore wide and fixed. What replaces the expiry is
 *    the take-back that already exists and is stronger: the Devices pane revokes a device, and
 *    a re-pair re-pins.
 *
 * ── THE KEY IS PERSISTENT, AND LOSING IT IS LOUD ─────────────────────────────────────────────
 *
 * The key is generated once and kept, so disarming and re-arming host mode — or restarting the
 * machine — leaves every paired phone paired. It is only ever generated when the file is
 * genuinely ABSENT: any other read failure (a permission problem, a half-written file) turns the
 * LAN door OFF with a named reason instead of minting a new identity, because a new identity is
 * an un-pairing of every device in the household and a transient `EACCES` must not be able to
 * cause one. The recoverable failure is always preferred to the destructive one.
 *
 * ── NO DEPENDENCY ────────────────────────────────────────────────────────────────────────────
 *
 * `node:crypto` generates the key and signs, but it has no certificate builder, so the X.509 is
 * written here as DER by hand. That follows `packages/core/src/net/webpush.ts`'s ruling for the
 * same reasons it gives: this is a long-running process holding mail and credentials, the surface
 * needed is one signature over one structure, and every byte of that structure is fixed by a
 * published specification and asserted against a parser (`node:crypto`'s own, plus the TLS
 * handshake in the e2e test) rather than against itself.
 */

/** Where the door's identity lives, under the engine's data directory. */
export const LAN_KEY_FILE = "lan-door.key.pem";
export const LAN_CERT_FILE = "lan-door.cert.pem";

/**
 * The name in the certificate. Reserved by RFC 2606 so it can never be delegated to anybody, and
 * chosen precisely because it identifies nothing — see the header on why the name is not the
 * identity here.
 */
export const LAN_CERT_NAME = "ohmail-desktop-host.invalid";

/* ── DER, the small amount of it this needs ─────────────────────────────────────────────────── */

/** DER length octets for a payload of `n` bytes — short form under 128, long form above. */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV. */
function tlv(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(payload.length), payload]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const ia5 = (s: string): Buffer => tlv(0x16, Buffer.from(s, "ascii"));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
/** `[n]` constructed, explicit tagging. */
const explicit = (n: number, payload: Buffer): Buffer => tlv(0xa0 | n, payload);
/** `[n]` primitive, implicit tagging — SubjectAltName's `dNSName` is `[2]` IMPLICIT IA5String. */
const implicitPrimitive = (n: number, payload: Buffer): Buffer => tlv(0x80 | n, payload);

/** A positive INTEGER in minimal two's-complement form. */
function integer(value: Buffer | number): Buffer {
  let body: Buffer;
  if (typeof value === "number") {
    body = Buffer.from([value]);
  } else {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0x00) i += 1;
    body = value.subarray(i);
  }
  // A leading bit of 1 would read as negative; RFC 5280 requires serials to be positive.
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(0x02, body);
}

/** A BIT STRING with `unused` trailing bits — 0 for the wrappers, 7 for the keyUsage byte. */
function bitString(content: Buffer, unused = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
}

/** A dotted OID as DER content. */
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part % 128];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/**
 * A validity bound. RFC 5280 §4.1.2.5: years through 2049 are UTCTime, 2050 and later are
 * GeneralizedTime. Both are implemented because the window this uses straddles the boundary, and
 * a stack that rejects the wrong encoding would fail the handshake rather than the pin check —
 * which is a confusing way to learn about an encoding bug.
 */
function time(iso: { y: number; mo: number; d: number; h: number; mi: number; s: number }): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const tail = `${p(iso.mo)}${p(iso.d)}${p(iso.h)}${p(iso.mi)}${p(iso.s)}Z`;
  return iso.y < 2050
    ? tlv(0x17, Buffer.from(`${p(iso.y % 100)}${tail}`, "ascii"))
    : tlv(0x18, Buffer.from(`${p(iso.y, 4)}${tail}`, "ascii"));
}

/* ── the certificate ────────────────────────────────────────────────────────────────────────── */

const OID_CN = "2.5.4.3";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

/** `SEQUENCE { OID }` — ECDSA algorithm identifiers carry no parameters (RFC 5758 §3.2). */
const ECDSA_SHA256_ALG = seq(oid(OID_ECDSA_SHA256));

/** `CN=<name>` as an X.501 Name. */
const nameOf = (cn: string): Buffer => seq(set(seq(oid(OID_CN), utf8(cn))));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? seq(oid(id), bool(true), octets(value))
    : seq(oid(id), octets(value));
}

/**
 * Build the self-signed certificate for `publicKey`, signed by `privateKey`.
 *
 * The validity window is 2020-01-01 through 2099-12-31 and that is not laziness — see the header:
 * an expiry on a pinned key can only ever un-pair a household, never protect one. The lower bound
 * is kept in the past so a machine whose clock has not yet synchronised at boot does not present
 * a not-yet-valid certificate to a client that (unlike ours) does check.
 */
export function buildSelfSignedCert(publicKey: KeyObject, privateKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const subject = nameOf(LAN_CERT_NAME);
  const tbs = seq(
    explicit(0, integer(2)), // v3
    integer(randomBytes(16)),
    ECDSA_SHA256_ALG,
    subject, // issuer — self-signed, so issuer and subject are the same Name
    seq(
      time({ y: 2020, mo: 1, d: 1, h: 0, mi: 0, s: 0 }),
      time({ y: 2099, mo: 12, d: 31, h: 23, mi: 59, s: 59 }),
    ),
    subject,
    spki,
    explicit(
      3,
      seq(
        // Not a CA: this key signs nothing but its own handshakes.
        extension(OID_BASIC_CONSTRAINTS, true, seq()),
        // digitalSignature only — an ECDSA key in a (EC)DHE suite signs the handshake and does
        // no key transport. Bit 0 set, seven unused bits in the trailing octet.
        extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
        extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
        // One name, and it asserts nothing — see the header.
        extension(OID_SUBJECT_ALT_NAME, false, seq(implicitPrimitive(2, Buffer.from(LAN_CERT_NAME, "ascii")))),
      ),
    ),
  );
  // node's `sign` with an EC key produces the DER `SEQUENCE { r, s }` X.509 wants, because
  // `dsaEncoding` defaults to "der". A change to "ieee-p1363" here would produce a signature
  // every TLS stack rejects, so it is left at the default rather than stated.
  const signature = sign("sha256", tbs, privateKey);
  return seq(tbs, ECDSA_SHA256_ALG, bitString(signature));
}

/** DER to PEM, 64-column, with the label. */
function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/* ── the identity on disk ───────────────────────────────────────────────────────────────────── */

/** The door's identity: what `startLanListener` serves with, and what the phone pins. */
export interface LanIdentity {
  /** PEM private key — never logged, never leaves this process except into the TLS context. */
  readonly key: string;
  /** PEM certificate. */
  readonly cert: string;
  /**
   * base64url of `SHA-256(SubjectPublicKeyInfo DER)` — the value the pairing link carries and the
   * phone pins. Taken from the KEY, not from the certificate: it survives a re-issued certificate
   * over the same key, which is the property that makes it a stable identity.
   */
  readonly fingerprint: string;
}

/** Why the LAN door has no identity, when one was asked for. Fixed text, never a path or a value. */
export interface LanIdentityRefusal {
  readonly reason: string;
}

export type LanIdentityOutcome =
  | { kind: "identity"; identity: LanIdentity }
  | { kind: "refused"; refusal: LanIdentityRefusal };

/** `SHA-256(SPKI)`, base64url — the one spelling of the fingerprint in this repository. */
export function spkiFingerprint(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url");
}

/**
 * The door's identity, generated on first use and kept for ever afterwards.
 *
 * ── THE ONLY GENERATION TRIGGER IS ENOENT, AND THAT IS THE WHOLE SAFETY ARGUMENT ─────────────
 *
 * Minting a new key un-pairs every device in the household. A missing file is the one state where
 * that is certainly correct (there was nothing to un-pair). Every other failure — `EACCES`, a
 * truncated file, a key node will not parse — is a state where an existing identity may still be
 * on disk and recoverable, so this REFUSES and the LAN door stays shut with a sentence the pane
 * can show. A door that is off is a fixable afternoon; a re-keyed door is every phone in the house
 * needing a fresh QR code, caused by a permission bit.
 */
export function ensureLanIdentity(dataDir: string, log?: Diagnostic): LanIdentityOutcome {
  const keyPath = join(dataDir, LAN_KEY_FILE);
  const certPath = join(dataDir, LAN_CERT_FILE);

  let keyPem: string | null = null;
  try {
    keyPem = readFileSync(keyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.("host_lan_identity_unreadable", {
        err,
        reason: "the same-network door's key file exists but could not be read, so this launch " +
          "serves no same-network access; a new key is deliberately NOT minted, because that " +
          "would un-pair every device already paired with this computer",
      });
      return {
        kind: "refused",
        refusal: {
          reason: "same-network access is off for this launch: this computer's same-network key " +
            "could not be read. Nothing was changed — fix the file's permissions and start ohmail " +
            "again, and every paired device stays paired.",
        },
      };
    }
  }

  if (keyPem !== null) {
    try {
      const privateKey = createPrivateKey(keyPem);
      const publicKey = createPublicKey(privateKey);
      // The CERTIFICATE is rebuilt rather than read back. It carries no state the key does not
      // (no expiry to preserve, no name to preserve — see the header), so re-deriving it is
      // strictly simpler than parsing one, and it means a corrupt or truncated certificate file
      // costs a rebuild instead of an un-pairing. The fingerprint is the key's and does not move.
      const cert = buildSelfSignedCert(publicKey, privateKey);
      const certPem = pem("CERTIFICATE", cert);
      writeAtomic(certPath, certPem, 0o644);
      return {
        kind: "identity",
        identity: { key: keyPem, cert: certPem, fingerprint: spkiFingerprint(publicKey) },
      };
    } catch (err) {
      log?.("host_lan_identity_unreadable", {
        err,
        reason: "the same-network door's key file is present but is not a usable key, so this " +
          "launch serves no same-network access; a new key is deliberately NOT minted over it",
      });
      return {
        kind: "refused",
        refusal: {
          reason: "same-network access is off for this launch: this computer's same-network key " +
            "file is unusable. It was left exactly as it is — move it aside to start over, which " +
            "means pairing every device again.",
        },
      };
    }
  }

  try {
    // P-256 rather than RSA: generation is instantaneous (an RSA-2048 keygen on the boot path is
    // a visible stall on a slow machine), every TLS stack on both target platforms has it, and
    // the fingerprint is 32 bytes either way.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const newKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const certPem = pem("CERTIFICATE", buildSelfSignedCert(publicKey, privateKey));
    mkdirSync(dataDir, { recursive: true });
    writeAtomic(keyPath, newKeyPem, 0o600);
    writeAtomic(certPath, certPem, 0o644);
    log?.("host_lan_identity_created", {
      reason: "this computer minted its same-network identity; devices pair against it and stay " +
        "paired across restarts",
    });
    return {
      kind: "identity",
      identity: { key: newKeyPem, cert: certPem, fingerprint: spkiFingerprint(publicKey) },
    };
  } catch (err) {
    log?.("host_lan_identity_failed", {
      err,
      reason: "this computer could not store a same-network identity, so same-network access is " +
        "off for this launch",
    });
    return {
      kind: "refused",
      refusal: {
        reason: "same-network access is off for this launch: this computer could not store the " +
          "key it needs to serve a secure address.",
      },
    };
  }
}

/**
 * Write, atomically, with the mode on the temporary file rather than after the rename — the
 * `ai-provider.ts` idiom, and here the window it closes is the one that matters: a private key
 * must never exist at the final path in a readable mode, not even for a moment.
 */
function writeAtomic(path: string, contents: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode });
  renameSync(tmp, path);
}
