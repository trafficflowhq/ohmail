import { createHmac } from "node:crypto";

/**
 * AN AUTHENTICATOR, as a person's phone holds one: RFC 6238 (SHA-1, 30 s, six digits) over the key the server
 * gave at enrollment. The server takes each time step once, and one step either side of its own clock, so an
 * authenticator here hands out each step once and waits for the next when both are spent: a journey never
 * offers a code the server has already taken, and never meets the refusal that would read as a fault.
 */
export const STEP_MS = 30_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(key: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of key.replace(/[\s=]+/g, "").toUpperCase()) {
    const at = ALPHABET.indexOf(ch);
    if (at === -1) throw new Error("an authenticator's key is Base32");
    value = (value << 5) | at;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one time step. */
export function codeAt(key: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32(key)).update(counter).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = (((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

export class Authenticator {
  private spent = -1;
  constructor(private readonly key: string, private readonly now: () => number = Date.now, private readonly pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}

  /** The next code no step of it was used for: this step's, else the next step's, else the wait for the step after. */
  async code(): Promise<string> {
    for (;;) {
      const step = Math.floor(this.now() / STEP_MS);
      for (const s of [step, step + 1]) {
        if (s > this.spent) {
          this.spent = s;
          return codeAt(this.key, s);
        }
      }
      await this.pause((step + 1) * STEP_MS - this.now() + 50);
    }
  }
}
