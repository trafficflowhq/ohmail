import { createHash } from "node:crypto";
import { vi } from "vitest";

/**
 * SHA-256 FOR `crypto.subtle.digest` THAT A FAKE-TIMER POLL CAN WAIT FOR.
 *
 * The link check awaits `linkTokenHash`, which hashes with WebCrypto on Node's threadpool, in
 * real time. A test's `until` loop advances fake time in a few milliseconds of real time, so on a
 * loaded host the hash lands after the loop has spent its steps and the test fails in 12 ms with
 * "timed out waiting for the proved link". This computes the same bytes with `node:crypto` and
 * settles as a microtask, which the fake-time steps drain. Any other algorithm goes to WebCrypto.
 */
export async function digestNow(
  algorithm: AlgorithmIdentifier, data: BufferSource,
  real: SubtleCrypto["digest"] = crypto.subtle.digest.bind(crypto.subtle),
): Promise<ArrayBuffer> {
  const name = typeof algorithm === "string" ? algorithm : algorithm.name;
  if (name.toUpperCase() !== "SHA-256") return real(algorithm, data);
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
}

/** Puts {@link digestNow} in place of `crypto.subtle.digest`; returns the restore. */
export function installDigestNow(): () => void {
  const real = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation((a, d) => digestNow(a, d, real));
  return () => spy.mockRestore();
}
