import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSENT_READ_FAILED_PATH, consentOverBridge, consentOverBridgeStandalone } from "../src/local-consent.js";

/**
 * THE PAIRED WINDOW'S CONSENT WIRE CARRIES WHAT A FAILED READ NEEDS: a refusal rejects
 * with its STATUS, and a failure report goes down the bridge to the engine's own door, whose
 * `consent_read_failed` line is the only record of it.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

let sent: Array<{ method: string; url: string; body: string }>;
beforeEach(() => {
  sent = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") return undefined;
      const p = payload as { method: string; url: string; body: number[] };
      sent.push({ method: p.method, url: p.url, body: new TextDecoder().decode(Uint8Array.from(p.body)) });
      if (p.url === "/consent") return encode(503, JSON.stringify({ error: { code: "offline_read_only", message: "offline" } }));
      return encode(204, "");
    },
  };
});
afterEach(() => { delete host.__TAURI_INTERNALS__; });

describe("the paired window's consent wire", () => {
  it("a refused read rejects carrying the status", async () => {
    const err = await consentOverBridge.state().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: unknown }).status).toBe(503);
  });

  it("a failure report is posted to the engine's door, exactly the report", async () => {
    await consentOverBridge.readFailed?.({ attempt: 2, reason: "refused", status: 503 });
    expect(sent).toEqual([{
      method: "POST", url: CONSENT_READ_FAILED_PATH,
      body: JSON.stringify({ attempt: 2, reason: "refused", status: 503 }),
    }]);
  });

  it("the standalone door reports through the same wire", () => {
    expect(consentOverBridgeStandalone.readFailed).toBe(consentOverBridge.readFailed);
  });
});
