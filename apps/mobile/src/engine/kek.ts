/**
 * The standalone install's key-encryption key — one per install, in the platform keystore.
 * The engine seals the mailbox password into an envelope only openable with this key; the key
 * crosses the boundary in `keksFromEnv`'s exact spelling (64 lower-case hex, version 1) so
 * there is no second contract. Three rules, each a data-loss failure if broken: a
 * present-but-malformed key is a refusal, never a regeneration (minting afresh makes the
 * password permanently unopenable while reporting success); a generated key is read back
 * before use; two callers get one key (two `ensureKek` in one tick would seal under the
 * loser's key — hence the chain). Never logged, errors included (`kek-store.test.ts`). Seams, not imports; the ring shape keeps v2 a map entry.
 */
import { refuse, type Refusal } from "../refusal";
import type { SecureKV } from "../state/servers";

/**
 * Where the key lives in the keystore. Versioned in the NAME as well as in the ring, so a future
 * rotation adds a key beside this one rather than overwriting the only copy of the old one.
 *
 * Namespaced apart from `ohmail.servers.v1`, which is the PAIRING store: a standalone install has
 * no pairings (the mode is exclusive with server profiles) and the fresh-install purge walks the
 * pairing index, so these two must not share a prefix and cannot be confused for one another.
 */
export const KEK_KEY = "ohmail.engine.kek.v1";

/**
 * The desktop's contract, verbatim: 64 hex characters, one 32-byte AES-256 key.
 *
 * LOWER-CASE ONLY on the way out — {@link ensureKek} generates lower-case and stores what it
 * generated. Accepted case-insensitively on the way IN, because `keksFromEnv` does
 * (`KEK_HEX_RE = /^[0-9a-f]{64}$/i`) and a value this app wrote under an older build must not
 * become a refusal on an upgrade.
 */
export const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

/** How many bytes a version-1 key is. AES-256. */
export const KEK_BYTES = 32;

/** What a caller must supply to make one: 32 bytes of cryptographic randomness, as hex. */
export type RandomKekHex = () => string | Promise<string>;

/**
 * WHAT {@link ensureKek} ANSWERS — a key, or a refusal a reader can act on.
 *
 * It used to throw English `Error`s, which `faultDetail` classifies as somebody else's words and
 * quotes verbatim inside a translated sentence. The failure is a VALUE carrying a deck key now, in
 * the shape `bootEngine` already returns, so the door routes it the way `gate.ts` routes every
 * other refusal — to Servers, the one surface that renders a reason and the remedies. It carries
 * NO arguments, which makes the banner's logging rule structural: there is nowhere for the value
 * in the slot to travel.
 */
export type KekVerdict =
  | { kind: "key"; hex: string }
  | { kind: "refused"; reason: Refusal };

/**
 * ONE MUTATION AT A TIME, for this module's lifetime.
 *
 * Module-level rather than per-instance because the thing being serialized is a single keystore
 * slot, not an object: two `ensureKek` callers holding different store handles would still be two
 * writers of one key. The chain is the same primitive `ServerProfileStore` uses for its index, and
 * it exists for the same measured reason — two interleaved read-modify-writes of one slot lose one.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  // Swallowed on the CHAIN only: one caller's failure must not reject the next caller's turn.
  // The failure still reaches its own caller through `next`.
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The key for this install — read, or minted once and read back. Returns the hex spelling
 * rather than bytes on purpose: the conversion to a `Buffer` belongs inside the engine bundle,
 * where the bundler's `inject` binds the global; this is app-side code Metro bundles, where no
 * such global is guaranteed. So the boundary carries the same string the desktop's environment
 * variable carries, and exactly one place converts it. Refuses — never throws, never
 * regenerates — on a present key that does not match {@link KEK_HEX_RE}, a random source that
 * produces a non-key, or a fresh key that does not read back as written.
 */
export async function ensureKek(kv: SecureKV, randomKekHex: RandomKekHex): Promise<KekVerdict> {
  return serialize(async () => {
    const existing = await kv.get(KEK_KEY);
    if (existing !== null) {
      const trimmed = existing.trim();
      if (!KEK_HEX_RE.test(trimmed)) {
        // No value, no length, no prefix — see the banner. A reader who needs to know what is in
        // the slot can look at the slot; a log line cannot be taken back.
        return { kind: "refused", reason: refuse("kekUnreadable") };
      }
      return { kind: "key", hex: trimmed };
    }

    const minted = (await randomKekHex()).trim();
    if (!KEK_HEX_RE.test(minted)) {
      // The random source, not the store. Distinguished because the fix is in a different file.
      return { kind: "refused", reason: refuse("kekNotGenerated") };
    }
    await kv.set(KEK_KEY, minted);
    // ── THE READ-BACK, AND IT IS NOT BELT AND BRACES ────────────────────────────────────────
    // `set` resolving means the platform accepted the write, not that a later `get` returns it.
    // Without this the failure surfaces on a LATER launch as a mailbox that has forgotten its
    // password, with nothing pointing at the keystore.
    const readBack = await kv.get(KEK_KEY);
    if (readBack === null || readBack.trim() !== minted) {
      return { kind: "refused", reason: refuse("kekNotKept") };
    }
    return { kind: "key", hex: minted };
  });
}

/**
 * The key ring in the shape the engine's composition takes — `version → hex`.
 *
 * One version, for the reason the banner gives. Kept as a ring rather than a bare string so the
 * value handed across the composition boundary is the same shape the desktop hands across it, and
 * so a second version is an entry rather than a signature change.
 */
export function kekRing(hex: string): Record<number, string> {
  return { 1: hex };
}

/**
 * Remove this install's engine key — the other half of the standalone door's take-back:
 * switching the door away deletes the engine database, and the key that opened it has no
 * reason to outlive it. A primitive here rather than performed here, because the take-back is
 * a sequence the door owns — store first, then key, so a kill between them leaves a key that
 * opens nothing rather than a database nothing can open. Note: this key is in the keystore,
 * which on iOS survives deleting the app (`install-marker.ts` states the asymmetry). A
 * surviving key is not a credential leak — the sealed rows go with the container — but it is
 * still removed when the door is switched, because "I turned this off" is believed.
 */
export async function forgetKek(kv: SecureKV): Promise<void> {
  return serialize(async () => {
    await kv.remove(KEK_KEY);
  });
}
