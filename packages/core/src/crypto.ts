import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// KeyProvider — envelope encryption. A random per-secret DEK encrypts the plaintext
// (AES-256-GCM); the DEK is wrapped by a versioned KEK. The default `StaticKeyProvider` holds
// KEKs in-process (tests + a stopgap for a real EU-region KMS later); `keyVersion` travels so
// rotation is possible. Moved to `@trafficflow/core`: the always-on worker needs the same
// primitive to decrypt `mailbox_credentials` at boot, and the worker may only depend on core +
// db; the auth layer re-exports the same symbols, so the auth surface is unchanged. Whichever
// host holds a KEK — the API and now the worker — holds credential-decrypting material; both run
// at the same trust level.

export interface KeyProvider {
  /** Envelope-encrypt `plaintext`; returns an opaque token + the KEK version used. */
  encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }>;
  /** Inverse of {@link encrypt}. `keyVersion` selects the KEK that wrapped the DEK. */
  decrypt(ciphertext: string, keyVersion: number): Promise<string>;
  /** The KEK version new secrets are encrypted under. */
  currentKeyVersion(): number;
}

interface Envelope {
  wdek: string;  // wrapped DEK
  div: string;   // DEK-wrap IV
  dtag: string;  // DEK-wrap auth tag
  iv: string;    // data IV
  tag: string;   // data auth tag
  ct: string;    // ciphertext
}

const AES = "aes-256-gcm";

/**
 * Reject a ring in which two VERSIONS hold identical bytes. A "rotation" that reuses key material
 * is a cryptographic no-op with a persisted lie attached: new rows carry the new `key_version`
 * while the old bytes still decrypt them, and because both hosts agree on the duplicated ring,
 * the drift fingerprint shows nothing wrong. Failing at load is the only cheap place; after rows
 * carry the new version it is a data-correction exercise. The error names ONLY the version
 * numbers — never the bytes, a prefix or a digest: boot failures end up in logs. Duplicates are
 * detected on the BYTES via an in-process SHA-256 (no hex copy interned), so uppercase and
 * lowercase hex of one key are one key.
 */
function assertDistinctKekBytes(keks: ReadonlyMap<number, Buffer>): void {
  const byDigest = new Map<string, number[]>();
  for (const [v, k] of [...keks.entries()].sort((a, b) => a[0] - b[0])) {
    const digest = createHash("sha256").update(k).digest("base64");
    const versions = byDigest.get(digest);
    if (versions) versions.push(v);
    else byDigest.set(digest, [v]);
  }
  const dupes = [...byDigest.values()].filter((vs) => vs.length > 1);
  if (dupes.length) {
    const groups = dupes.map((vs) => vs.map((v) => `V${v}`).join(" = ")).join("; ");
    throw new Error(
      `KEK versions hold identical bytes: ${groups}. A rotation that reuses key material ` +
      "is a cryptographic no-op — rows stamped with the new version still decrypt under " +
      "the old bytes, and both hosts agree, so ring-drift monitoring cannot see it. " +
      "Generate a fresh 32-byte KEK for each version.",
    );
  }
}

export class StaticKeyProvider implements KeyProvider {
  private readonly keks: Map<number, Buffer>;
  private readonly current: number;

  /** @param keks version→32-byte KEK. Highest version is the current one. */
  constructor(keks: Record<number, Buffer>) {
    this.keks = new Map(Object.entries(keks).map(([v, k]) => [Number(v), k]));
    if (this.keks.size === 0) throw new Error("StaticKeyProvider requires at least one KEK");
    for (const [v, k] of this.keks) {
      if (k.length !== 32) throw new Error(`KEK v${v} must be 32 bytes (AES-256)`);
    }
    // Checked here as well as in `readKeks`: the env loader is not the only door to a
    // provider, and a hand-built ring must obey the same invariant.
    assertDistinctKekBytes(this.keks);
    this.current = Math.max(...this.keks.keys());
  }

  /** Convenience: a single-version provider from a 32-byte secret (tests). */
  static fromSecret(secret: Buffer, version = 1): StaticKeyProvider {
    return new StaticKeyProvider({ [version]: secret });
  }

  currentKeyVersion(): number {
    return this.current;
  }

  private kek(version: number): Buffer {
    const k = this.keks.get(version);
    if (!k) throw new Error(`no KEK for version ${version}`);
    return k;
  }

  async encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
    const keyVersion = this.current;
    const dek = randomBytes(32);

    const iv = randomBytes(12);
    const c = createCipheriv(AES, dek, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();

    const div = randomBytes(12);
    const wc = createCipheriv(AES, this.kek(keyVersion), div);
    const wdek = Buffer.concat([wc.update(dek), wc.final()]);
    const dtag = wc.getAuthTag();

    const env: Envelope = {
      wdek: wdek.toString("base64url"), div: div.toString("base64url"), dtag: dtag.toString("base64url"),
      iv: iv.toString("base64url"), tag: tag.toString("base64url"), ct: ct.toString("base64url"),
    };
    return {
      ciphertext: Buffer.from(JSON.stringify(env), "utf8").toString("base64url"),
      keyVersion,
    };
  }

  async decrypt(ciphertext: string, keyVersion: number): Promise<string> {
    const env = JSON.parse(Buffer.from(ciphertext, "base64url").toString("utf8")) as Envelope;

    const wd = createDecipheriv(AES, this.kek(keyVersion), Buffer.from(env.div, "base64url"));
    wd.setAuthTag(Buffer.from(env.dtag, "base64url"));
    const dek = Buffer.concat([wd.update(Buffer.from(env.wdek, "base64url")), wd.final()]);

    const d = createDecipheriv(AES, dek, Buffer.from(env.iv, "base64url"));
    d.setAuthTag(Buffer.from(env.tag, "base64url"));
    const pt = Buffer.concat([d.update(Buffer.from(env.ct, "base64url")), d.final()]);
    return pt.toString("utf8");
  }
}

// The ONE KEK env loader. It lived in the worker's config with no API counterpart, and a KEK
// differing between hosts makes every credential row undecryptable on one of them; both hosts
// parse HERE and publish the same {@link KekEnvIdentity} so drift shows on `/health`. Contract:
// `TF_KEK_V1 … TF_KEK_Vn`, 64 hex chars each; versions CONTIGUOUS from 1 — a gap is rejected. The
// HIGHEST version is ACTIVE; older ones stay loaded; adding a version needs no migration.
// Correctness is not revocation: adding a version protects new writes only — a leaked key keeps
// opening untouched rows and backups; retiring a version means re-wrapping the envelopes, then
// removing it. Identical bytes in two versions are rejected at load. Empty counts as ABSENT. The
// `TF_KEK_V` prefix is RESERVED: any non-canonical name (`TF_KEK_VX`, `TF_KEK_V02`) is a hard
// boot failure — skipping it is the silent mid-rotation drift this loader exists to prevent.

/** The RESERVED prefix: every non-empty `TF_KEK_V*` must be a canonical version. */
const KEK_ENV_PREFIX = "TF_KEK_V";
/** `TF_KEK_V<n>`, n ≥ 1, no leading zeros. */
const KEK_ENV_RE = /^TF_KEK_V([1-9][0-9]*)$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Reject a non-canonical name under the reserved prefix, with the most specific
 * diagnosis available. The suggested spelling ECHOES THE RAW DIGITS: rendering it via
 * `String(Number(digits))` turned `TF_KEK_V999999999999999999999` into the advice
 * "write TF_KEK_V1e+21".
 */
function rejectReservedName(name: string): never {
  const rest = name.slice(KEK_ENV_PREFIX.length);
  if (/^\d+$/.test(rest)) {
    const stripped = rest.replace(/^0+/, "");
    if (stripped === "") throw new Error(`${name}: KEK versions start at 1`);
    throw new Error(
      `${name} is not a valid KEK version (write TF_KEK_V${stripped}, no leading zeros)`,
    );
  }
  throw new Error(
    `${name} is not a valid KEK version name: the TF_KEK_V prefix is RESERVED — ` +
    "use TF_KEK_V<n> (n >= 1, no leading zeros) or rename this variable. Ignoring it " +
    "would leave this host silently short of a KEK version mid-rotation",
  );
}

/**
 * Parse every `TF_KEK_V<n>` in `env` into version→KEK. Empty map ⇒ none configured.
 * Throws on a malformed name, a bad key, or a gap in the version sequence.
 */
function readKeks(env: NodeJS.ProcessEnv): Map<number, Buffer> {
  const keks = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(KEK_ENV_PREFIX)) continue;                // a bare, un-versioned name is unrelated
    if (value === undefined || value.trim() === "") continue;      // "" ⇒ absent
    const m = KEK_ENV_RE.exec(name);
    if (!m) rejectReservedName(name);
    const digits = m[1]!;
    const version = Number(digits);
    if (!Number.isSafeInteger(version)) {
      throw new Error(
        `${name}: KEK version ${digits} is out of range (versions must be <= ${Number.MAX_SAFE_INTEGER})`,
      );
    }
    const hex = value.trim();
    if (!HEX_64.test(hex)) {
      throw new Error(`${name} must be 64 hex chars (a 32-byte AES-256 KEK)`);
    }
    keks.set(version, Buffer.from(hex, "hex"));
  }
  if (keks.size === 0) return keks;

  const versions = [...keks.keys()].sort((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new Error(
        `KEK versions must be contiguous from 1: TF_KEK_V${i + 1} is missing ` +
        `(found ${versions.map((v) => `V${v}`).join(", ")})`,
      );
    }
  }
  // Here as well as in the provider, so a host that only PUBLISHES its ring identity
  // (kekEnvIdentity never constructs a provider) fails closed on a duplicated ring too.
  assertDistinctKekBytes(keks);
  return keks;
}

/** Non-secret fingerprint of ONE KEK: the first 8 hex of SHA-256(KEK). */
export function kekFingerprint(kek: Buffer): string {
  return createHash("sha256").update(kek).digest("hex").slice(0, 8);
}

/** Domain separator so a ring digest can never collide with a bare-key digest. */
const KEK_RING_DOMAIN = "tf-kek-ring/1\n";

/**
 * Fingerprint of a WHOLE versioned key ring — the value two hosts compare. Construction, stable
 * and independent of env enumeration order: SHA-256 over `"tf-kek-ring/1\n"` plus
 * `${version}:${lowercase-hex}\n` in ascending version order, first 8 hex chars. It fingerprints
 * the RING, not the active key, and that is the point: the previous active-only fingerprint could
 * not see the drift it existed to detect — `{1=A, 2=B}` and `{1=C, 2=B}` published the same value
 * while neither host could decrypt the other's `key_version = 1` rows. The version number beside
 * each key also separates `{1=A}` from `{1=A, 2=A}` — a ring the loader now refuses, kept
 * version-qualified so the property holds for a map the loader never saw.
 */
export function kekRingFingerprint(keks: ReadonlyMap<number, Buffer> | Record<number, Buffer>): string {
  const entries: Array<[number, Buffer]> = keks instanceof Map
    ? [...keks.entries()]
    : Object.entries(keks as Record<number, Buffer>).map(([v, k]) => [Number(v), k]);
  if (entries.length === 0) throw new Error("kekRingFingerprint requires at least one KEK");
  entries.sort((a, b) => a[0] - b[0]);
  const h = createHash("sha256").update(KEK_RING_DOMAIN, "ascii");
  for (const [v, k] of entries) h.update(`${v}:${k.toString("hex")}\n`, "ascii");
  return h.digest("hex").slice(0, 8);
}

/**
 * What a host publishes about its KEK material — comparable, never revealing.
 *
 * All THREE fields must match between the API host and the worker host. `fingerprint`
 * alone is not enough on its own for a human reading two JSON blobs, and `active`
 * alone is not enough either: a mismatch in `active` means the two hosts write rows
 * under different `key_version` values, and a mismatch in `fingerprint` means at least
 * one loaded version differs in bytes. The sync worker publishes this from `/health`; the API
 * host renders the SAME object from the same function.
 */
export interface KekEnvIdentity {
  /** The version new secrets are encrypted under (the highest loaded). */
  active: number;
  /** How many versions are loaded (== `active`, since the sequence is contiguous). */
  count: number;
  /** {@link kekRingFingerprint} of EVERY loaded version, not just the active one. */
  fingerprint: string;
}

/**
 * Build the process's {@link KeyProvider} from `TF_KEK_V1…Vn`. **Throws** when none
 * is configured — a host that needs to decrypt mailbox credentials and has no KEK
 * must fail at boot, not at the first mailbox.
 */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const keks = readKeks(env);
  if (keks.size === 0) {
    throw new Error("no KEK configured: set TF_KEK_V1 (64 hex chars = a 32-byte AES-256 KEK)");
  }
  return new StaticKeyProvider(Object.fromEntries(keks));
}

/**
 * {@link keyProviderFromEnv} for hosts that legitimately run without KEK material
 * (tests, and the worker's injected-provider path): `undefined` when NO `TF_KEK_V*`
 * is set at all. A PRESENT-but-malformed KEK still throws — silently degrading that
 * to "no KEK" is how a typo becomes an outage.
 */
export function keyProviderFromEnvOptional(env: NodeJS.ProcessEnv = process.env): KeyProvider | undefined {
  return readKeks(env).size === 0 ? undefined : keyProviderFromEnv(env);
}

/**
 * The host's {@link KekEnvIdentity}, or `undefined` when no `TF_KEK_V*` is configured.
 * This is the object BOTH hosts publish verbatim — see {@link KekEnvIdentity}.
 */
export function kekEnvIdentity(env: NodeJS.ProcessEnv = process.env): KekEnvIdentity | undefined {
  const keks = readKeks(env);
  if (keks.size === 0) return undefined;
  return {
    active: Math.max(...keks.keys()),
    count: keks.size,
    fingerprint: kekRingFingerprint(keks),
  };
}

/**
 * The comparable KEK fingerprint for `/health` — of the WHOLE ring
 * ({@link kekRingFingerprint}), so a host missing a rotated key OR carrying a
 * different historical key reports a DIFFERENT value. Publish it next to
 * `active`/`count` (see {@link kekEnvIdentity}); the fingerprint on its own does not
 * tell an operator WHICH version new writes land under.
 */
export function kekFingerprintFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return kekEnvIdentity(env)?.fingerprint;
}
