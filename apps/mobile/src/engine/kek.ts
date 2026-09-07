/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE INSTALL'S KEY-ENCRYPTION KEY — one per install, in the platform keystore
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A standalone phone holds the mailbox password itself: the engine seals it into a
 * `mailbox_credentials` envelope and the envelope is only openable with this key. On the desktop
 * the native shell owns the keystore and hands the key to a child process through `OHMAIL_KEK`
 * (`apps/sidecar/src/main.ts`, `keksFromEnv`). There is no child process here — the engine runs in
 * this app's own runtime — so the same key crosses the same boundary as a VALUE, in the same
 * spelling: sixty-four lower-case hex characters, one 32-byte AES-256 key, version 1.
 *
 * The spelling is copied deliberately rather than invented. `keksFromEnv` is the validator every
 * other door already passes through, and a phone that agreed with it on everything except the
 * encoding would be a second contract nobody diffed.
 *
 * ── THREE RULES, AND EACH OF THEM IS A DATA-LOSS FAILURE IF BROKEN ────────────────────────
 *
 *  · **A key that is present and MALFORMED is a refusal, never a regeneration.** This is the one
 *    that matters most and the one an ordinary "self-healing" reflex gets wrong. Every stored
 *    credential on this device is sealed under the key that is there; minting a fresh one because
 *    the old value looked wrong does not recover anything — it makes the mailbox password
 *    permanently unopenable and reports success while doing it. The engine's own composition takes
 *    the same position from the other side: with no durable key it REFUSES to store a credential
 *    rather than store one under a key that dies (`refusingKeyProvider`).
 *
 *  · **A generated key is READ BACK before it is used.** A keystore write that silently does not
 *    land leaves this launch sealing credentials under a key the next launch cannot find, and the
 *    symptom arrives later, on a different screen, as a mailbox that asks for its password again
 *    for no reason. The read-back turns that into a failure at the moment it happens.
 *
 *  · **Two callers get ONE key.** The mutation chain below is not decoration: two `ensureKek`
 *    calls in one tick both read absent, both generate, both write, and the credential sealed by
 *    the loser's key is unopenable by the winner's. A single JS runtime has no true concurrency
 *    and that is exactly why this is easy to get wrong — the interleaving is at the `await`.
 *
 * ── IT IS NEVER LOGGED, AND "NEVER" INCLUDES ERROR MESSAGES ───────────────────────────────
 *
 * No function here puts the key, or any part of it, into a thrown message, a returned reason or a
 * diagnostic. That is the rule `main.ts` states for the desktop ring ("a value is validated and
 * converted; it is never echoed, in an error message or anywhere else"), and the failure it guards
 * is the ordinary one: a developer adds the offending value to a message to make a bug easier to
 * find, and the key lands wherever that message goes. `kek-store.test.ts` asserts the refusal text
 * for a malformed value does not contain the value.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 *
 * It does not import a keystore or a random source. Both arrive through seams, for the reason
 * `servers-native.ts` states for the pairing store: the node-side suite drives this logic through
 * a memory double and never loads a native module. The real bindings are composed one level up,
 * in `local-engine.ts`, from the app's existing `secureKV()` — ONE keystore seam in this app, not
 * a second one for the engine.
 *
 * ── ROTATION, AND WHY THERE IS ONLY A VERSION 1 HERE ──────────────────────────────────────
 *
 * The desktop's ring exists so a key can be rotated without a data migration: the highest version
 * encrypts, older versions stay loaded so rows carrying an earlier `key_version` still decrypt.
 * The phone's ring is the same shape ({@link kekRing}) but is generated with a single version,
 * because nothing on a phone can rotate it yet — there is no operator and no second key source.
 * The shape is kept so that adding version 2 is a write and a map entry rather than a redesign,
 * and so the value handed to the engine is the same `Record<number, …>` the desktop hands it.
 */
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
 * THE KEY IS MALFORMED AND NOTHING WILL BE REGENERATED — see the banner's first rule.
 *
 * Its own class so a caller can tell "this device has no engine key yet" (which is ordinary and
 * recoverable) from "this device's engine key is unreadable" (which is neither). The message never
 * carries the offending value.
 */
export class KekUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KekUnreadableError";
  }
}

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
 * THE KEY FOR THIS INSTALL — read, or minted once and read back.
 *
 * Returns the hex spelling rather than bytes on purpose. The conversion to a `Buffer` belongs
 * inside the engine bundle, where the `Buffer` global is bound by the bundler's `inject`; this
 * module is app-side code that Metro bundles, where no such global is guaranteed to exist. So the
 * boundary carries the same string the desktop's environment variable carries, and exactly one
 * place converts it.
 *
 * @throws {KekUnreadableError} when a key is present and does not match {@link KEK_HEX_RE}, or
 * when a freshly generated key does not read back as what was written.
 */
export async function ensureKek(kv: SecureKV, randomKekHex: RandomKekHex): Promise<string> {
  return serialize(async () => {
    const existing = await kv.get(KEK_KEY);
    if (existing !== null) {
      const trimmed = existing.trim();
      if (!KEK_HEX_RE.test(trimmed)) {
        // No value, no length, no prefix — see the banner. A reader who needs to know what is in
        // the slot can look at the slot; a log line cannot be taken back.
        throw new KekUnreadableError(
          "this install's engine key is stored but unreadable. It is NOT being replaced: every " +
            "credential on this device is sealed under the key that is there, so minting a new " +
            "one would make the mailbox password permanently unopenable rather than recover it.",
        );
      }
      return trimmed;
    }

    const minted = (await randomKekHex()).trim();
    if (!KEK_HEX_RE.test(minted)) {
      // The random source, not the store. Distinguished because the fix is in a different file.
      throw new KekUnreadableError(
        `the random source produced something that is not a ${KEK_BYTES}-byte key in hex ` +
          `(${minted.length} characters). No key was stored.`,
      );
    }
    await kv.set(KEK_KEY, minted);
    // ── THE READ-BACK, AND IT IS NOT BELT AND BRACES ────────────────────────────────────────
    // `set` resolving means the platform accepted the write, not that a later `get` returns it.
    // Without this the failure surfaces on a LATER launch as a mailbox that has forgotten its
    // password, with nothing pointing at the keystore.
    const readBack = await kv.get(KEK_KEY);
    if (readBack === null || readBack.trim() !== minted) {
      throw new KekUnreadableError(
        "this install's engine key was written to the keystore and did not read back. Nothing " +
          "has been sealed under it — a credential stored now would be unopenable on the next " +
          "launch.",
      );
    }
    return minted;
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
 * REMOVE THIS INSTALL'S ENGINE KEY.
 *
 * The other half of the standalone door's take-back: switching the door away deletes the engine
 * database, and the key that opened it has no reason to outlive it. Exposed as a primitive here
 * rather than performed here, because the take-back is a sequence the door owns — the store first,
 * then the key, and a kill between them leaves a key that opens nothing rather than a database
 * nothing can open.
 *
 * NOTE for whoever wires that sequence: this key is in the keystore, which on iOS SURVIVES
 * deleting the app (`install-marker.ts` states the asymmetry and why the pairing store needs a
 * generation marker because of it). A surviving key is not a credential leak — the sealed rows
 * live in the app container and go with it — but it should still be removed when the door is
 * switched, because "I turned this off" is a gesture people believe in.
 */
export async function forgetKek(kv: SecureKV): Promise<void> {
  return serialize(async () => {
    await kv.remove(KEK_KEY);
  });
}
