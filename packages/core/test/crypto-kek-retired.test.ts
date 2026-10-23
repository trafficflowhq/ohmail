import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  keyProviderFromEnv, keyProviderFromEnvOptional, kekEnvIdentity, kekRetiredThroughFromEnv,
} from "../src/crypto.js";
import {
  keyRingVar, versionLabel as v, KEY_RING_PREFIX, KEY_RING_RETIRED,
} from "../../../test/support/key-ring-env.js";

/**
 * RETIRING A KEY VERSION — the last step of a rotation, and the one the loader used to make impossible.
 *
 * A rotation adds the next version to both hosts, re-wraps every stored envelope onto it
 * (`run-kek-rewrap`), and then removes the old version, which is the step that takes a leaked key out
 * of the hosts' environment. The loader required versions contiguous FROM 1, so removing the first
 * version refused boot on the API and the worker alike while the re-wrap tool said it "may now be
 * removed". The retired-versions declaration says that every version up to n left this host after a
 * re-wrap: the ring then starts at n + 1, and every other rule of the loader stands (contiguous,
 * highest active, no two versions with one key's bytes, the reserved prefix). Whether a stored secret
 * still names a retired version is a question for the database, asked by the hosts at boot
 * (`kekRetiredReferences`); this file is the environment half.
 */

const KEY_ONE = "a".repeat(64);
const KEY_TWO = "b".repeat(64);
const KEY_THREE = "c".repeat(64);
const KEY_FOUR = "d".repeat(64);

/** The documented ring construction, recomputed independently of the implementation. */
function ring(...pairs: Array<[number, string]>): string {
  const h = createHash("sha256").update("tf-kek-ring/1\n", "ascii");
  for (const [n, hex] of [...pairs].sort((a, b) => a[0] - b[0])) h.update(`${n}:${hex.toLowerCase()}\n`, "ascii");
  return h.digest("hex").slice(0, 8);
}

/** The message a loader call refuses with, or "" when it does not refuse. */
function refusal(load: () => unknown): string {
  try { load(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  return "";
}

describe("a retired key version can leave the host", () => {
  it("boots on the second version alone once the first is declared retired, and reads what the re-wrap wrote", async () => {
    // Before: a secret sealed under the first version. The re-wrap's ring holds both and writes under the second.
    const before = keyProviderFromEnv({ [keyRingVar(1)]: KEY_ONE });
    const old = await before.encrypt("imap-password");
    expect(old.keyVersion).toBe(1);
    const both = keyProviderFromEnv({ [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO });
    const moved = await both.encrypt(await both.decrypt(old.ciphertext, old.keyVersion));
    expect(moved.keyVersion).toBe(2);

    // After: the first version is gone from the host and declared retired. The host boots, the second is active.
    const env = { [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" };
    const after = keyProviderFromEnv(env);
    expect(after.currentKeyVersion()).toBe(2);
    expect(await after.decrypt(moved.ciphertext, moved.keyVersion)).toBe("imap-password");
    const fresh = await after.encrypt("a new password");
    expect(fresh.keyVersion).toBe(2);
    expect(await after.decrypt(fresh.ciphertext, 2)).toBe("a new password");

    // What the host no longer holds it cannot open: an envelope of the first version is refused by name,
    // which is the failure the boot-time check exists to keep from ever being reached.
    await expect(after.decrypt(old.ciphertext, 1)).rejects.toThrow(/no KEK for version 1/);

    // Every door to the ring agrees: the optional provider, the published identity, the floor.
    expect(keyProviderFromEnvOptional(env)?.currentKeyVersion()).toBe(2);
    expect(kekEnvIdentity(env)).toEqual({ active: 2, count: 1, fingerprint: ring([2, KEY_TWO]) });
    expect(kekRetiredThroughFromEnv(env)).toBe(1);
  });

  it("retires several versions at once: the ring starts above the highest one retired", () => {
    const env = { [keyRingVar(3)]: KEY_THREE, [keyRingVar(4)]: KEY_FOUR, [KEY_RING_RETIRED]: "2" };
    expect(keyProviderFromEnv(env).currentKeyVersion()).toBe(4);
    expect(kekEnvIdentity(env)).toEqual({ active: 4, count: 2, fingerprint: ring([3, KEY_THREE], [4, KEY_FOUR]) });
    expect(kekRetiredThroughFromEnv(env)).toBe(2);
  });

  it("two hosts that retired the same version publish the same identity; one that did not, another", () => {
    const retired = kekEnvIdentity({ [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" })!;
    expect(kekEnvIdentity({ [KEY_RING_RETIRED]: "1", [keyRingVar(2)]: KEY_TWO })).toEqual(retired);
    // A host that still holds the first version is a different ring, and /health shows it before a row is touched.
    const holding = kekEnvIdentity({ [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO })!;
    expect(holding.active).toBe(retired.active);
    expect(holding.fingerprint).not.toBe(retired.fingerprint);
  });
});

describe("the declaration is checked as strictly as the ring", () => {
  it("a retired version that is still set refuses boot, naming the version and both ways out", () => {
    const env = { [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" };
    const msg = refusal(() => keyProviderFromEnv(env));
    expect(msg).toContain(`${keyRingVar(1)} is set`);
    expect(msg).toContain(`${KEY_RING_RETIRED}=1`);
    expect(msg).toContain(`remove ${keyRingVar(1)}`);
    expect(msg).toContain(`unset ${KEY_RING_RETIRED}`);
    expect(msg).not.toContain(KEY_ONE);
    // The optional door and the identity refuse the same environment: a host that only publishes its
    // ring must not report a healthy one.
    expect(refusal(() => keyProviderFromEnvOptional(env))).toBe(msg);
    expect(refusal(() => kekEnvIdentity(env))).toBe(msg);
  });

  it("the ring above the retired versions must still be contiguous", () => {
    expect(refusal(() => keyProviderFromEnv({ [keyRingVar(3)]: KEY_THREE, [KEY_RING_RETIRED]: "1" })))
      .toContain(`contiguous from ${v(2)} (${KEY_RING_RETIRED}=1): ${keyRingVar(2)} is missing (found ${v(3)})`);
    expect(refusal(() => keyProviderFromEnv({
      [keyRingVar(2)]: KEY_TWO, [keyRingVar(4)]: KEY_FOUR, [KEY_RING_RETIRED]: "1",
    }))).toContain(`${keyRingVar(3)} is missing (found ${v(2)}, ${v(4)})`);
  });

  it("a declaration with no key left refuses, on the optional door too", () => {
    const env = { [KEY_RING_RETIRED]: "1" };
    const msg = refusal(() => keyProviderFromEnvOptional(env));
    expect(msg).toContain(`${KEY_RING_RETIRED}=1 is set and no ${KEY_RING_PREFIX}_V<n> is`);
    expect(msg).toContain(`set ${keyRingVar(2)}`);
    expect(refusal(() => kekEnvIdentity(env))).toBe(msg);
    expect(refusal(() => keyProviderFromEnv(env))).toBe(msg);
  });

  it("a malformed declaration refuses and never echoes what it was given", () => {
    for (const raw of ["x7q", "0", "01", "-1", "1.5", "2a", "1e3", v(1), "999999999999999999999"]) {
      const msg = refusal(() => keyProviderFromEnv({ [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: raw }));
      expect(msg, JSON.stringify(raw)).toContain(`${KEY_RING_RETIRED} must be a whole number of 1 or more`);
      if (raw.length > 1) expect(msg, JSON.stringify(raw)).not.toContain(raw);
    }
  });

  it("an empty declaration is absent, as an empty key is", () => {
    for (const raw of ["", "   "]) {
      const env = { [keyRingVar(1)]: KEY_ONE, [KEY_RING_RETIRED]: raw };
      expect(keyProviderFromEnv(env).currentKeyVersion()).toBe(1);
      expect(kekRetiredThroughFromEnv(env)).toBe(0);
    }
    expect(kekRetiredThroughFromEnv({})).toBe(0);
    expect(kekRetiredThroughFromEnv({ [keyRingVar(1)]: KEY_ONE })).toBe(0);
  });

  it("identical bytes under two versions still refuse above a retired floor", () => {
    expect(refusal(() => keyProviderFromEnv({
      [keyRingVar(2)]: KEY_TWO, [keyRingVar(3)]: KEY_TWO, [KEY_RING_RETIRED]: "1",
    }))).toContain(`identical bytes: ${v(2)} = ${v(3)}`);
  });

  it("the reserved prefix stays reserved beside a declaration", () => {
    expect(refusal(() => keyProviderFromEnv({
      [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1", [`${KEY_RING_PREFIX}_VX`]: KEY_THREE,
    }))).toContain("RESERVED");
  });
});

describe("without a declaration the contract is the one it always was", () => {
  it("the second version alone is refused, and the message says how a retired first version is declared", () => {
    const msg = refusal(() => keyProviderFromEnv({ [keyRingVar(2)]: KEY_TWO }));
    expect(msg).toContain(`KEK versions must be contiguous from 1: ${keyRingVar(1)} is missing (found ${v(2)})`);
    expect(msg).toContain(`${KEY_RING_RETIRED}=1`);
    expect(msg).toContain(`put ${keyRingVar(1)} back`);
    // Two versions missing at the bottom name the floor that would retire both.
    expect(refusal(() => keyProviderFromEnv({ [keyRingVar(3)]: KEY_THREE }))).toContain(`${KEY_RING_RETIRED}=2`);
  });

  it("a gap in the middle is never offered as a retirement: only the oldest versions retire", () => {
    const msg = refusal(() => keyProviderFromEnv({ [keyRingVar(1)]: KEY_ONE, [keyRingVar(3)]: KEY_THREE }));
    expect(msg).toContain(`${keyRingVar(2)} is missing (found ${v(1)}, ${v(3)})`);
    expect(msg).not.toContain(KEY_RING_RETIRED);
  });

  it("a contiguous ring from 1 loads unchanged, and reads nothing retired", () => {
    const env = { [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO };
    expect(keyProviderFromEnv(env).currentKeyVersion()).toBe(2);
    expect(kekEnvIdentity(env)).toEqual({ active: 2, count: 2, fingerprint: ring([1, KEY_ONE], [2, KEY_TWO]) });
    expect(kekRetiredThroughFromEnv(env)).toBe(0);
  });
});
