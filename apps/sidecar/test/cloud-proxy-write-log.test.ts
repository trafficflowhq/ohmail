import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_DEADLINE_MS } from "../src/cloud-auth.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import { STAGED_UPLOAD_TIMEOUT_MS } from "../src/cloud-staged-upload.js";
import { createSidecarLog } from "../src/log.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import type { CloudMirror } from "../src/cloud-mirror.js";

/**
 * A DESKTOP ON THE CLOUD DOOR LOGS EACH WRITE IT FORWARDS (incident 0916).
 *
 * Every screener decision, draft, move and send on this door is forwarded to the hosted account,
 * and none of them reached `engine.log`: an incident there was not investigable from the client.
 * One line per forwarded mutation, through the REAL logger so the census cannot drop a field the
 * call site hands over — and nothing of the request body on any line.
 */

const ADDRESS = "stranger@example.test";
const SUBJECT = "Quarterly figures for Dana";
const KEY = "idem-2f9c1e7a-5b44-4d1e-9a0f-3c2b8d6e1a70";

interface Answer { status: number; body: unknown }

function door(answer: (path: string) => Answer) {
  const lines: string[] = [];
  const sent: string[] = [];
  const auth = {
    authedFetch: async (path: string) => {
      sent.push(path);
      const a = answer(path);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    },
  } as unknown as CloudAuth;
  const mirror = {
    online: () => true,
    markConnectivity: () => {},
    awaitCloudSeq: async () => true,
    awaitFreshPull: async () => true,
    localSeq: async () => null,
  } as unknown as CloudMirror;
  const proxy = createWriteThroughProxy({ auth, mirror, log: createSidecarLog({ sink: (l) => lines.push(l) }) });
  const post = (path: string, body: unknown, key: string | null = KEY) => proxy.forward(new Request(`http://engine${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }) },
  }));
  const events = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);
  return { proxy, post, lines, sent, events };
}

describe("a forwarded write leaves one line in the engine log", () => {
  it("a Screener decision and a saved draft each log their route, status and time", async () => {
    const d = door(() => ({ status: 200, body: { ok: true } }));
    expect((await d.post("/screener/11111111-1111-4111-8111-111111111111", { sender: ADDRESS, decision: "in" })).status).toBe(200);
    expect((await d.post("/drafts", { subject: SUBJECT, to: [{ address: ADDRESS }], body: "numbers" })).status).toBe(200);
    const forwarded = d.events("cloud_write_forwarded");
    expect(forwarded.map((l) => [l.method, l.routeClass, l.status])).toEqual([
      ["POST", "/screener/:id", 200],
      ["POST", "/drafts", 200],
    ]);
    for (const l of forwarded) {
      expect(typeof l.ms).toBe("number");
      // A prefix of the key's hash, so a line can be matched to the account's record of the
      // write — never the key, which replays the write.
      expect(l.keyHash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(d.lines.join("\n")).not.toContain(KEY);
    expect(d.events("cloud_write_refused")).toEqual([]);
  });

  it("no line carries the body's address or subject", async () => {
    const d = door(() => ({ status: 200, body: { ok: true } }));
    await d.post("/screener/11111111-1111-4111-8111-111111111111", { sender: ADDRESS, decision: "in" });
    await d.post("/drafts", { subject: SUBJECT, to: [{ address: ADDRESS }], body: "numbers" });
    expect(d.lines.length).toBeGreaterThan(0);
    const all = d.lines.join("\n");
    expect(all).not.toContain(ADDRESS);
    expect(all).not.toContain(SUBJECT);
    expect(all).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("a write the account refuses logs the refusal with the account's code", async () => {
    const d = door(() => ({ status: 409, body: { error: { code: "draft_conflict", message: `for ${ADDRESS}` } } }));
    expect((await d.post("/drafts", { subject: SUBJECT }, null)).status).toBe(409);
    expect(d.events("cloud_write_forwarded").map((l) => [l.status, l.keyHash])).toEqual([[409, null]]);
    expect(d.events("cloud_write_refused").map((l) => [l.routeClass, l.status, l.code])).toEqual([["/drafts", 409, "draft_conflict"]]);
    expect(d.lines.join("\n")).not.toContain(ADDRESS);
  });

  it("a read is not a write and logs nothing", async () => {
    const d = door(() => ({ status: 200, body: { items: [] } }));
    await d.proxy.forward(new Request("http://engine/consent"));
    expect(d.sent).toEqual(["/consent"]);
    expect(d.events("cloud_write_forwarded")).toEqual([]);
  });
});

describe("a send's upload is bounded as a staged file's is, not as a write's", () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A server still reading the body: the forward settles only when its signal aborts. */
  function slowDoor() {
    const connectivity: boolean[] = [];
    const auth = {
      authedFetch: (_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    } as unknown as CloudAuth;
    const mirror = { online: () => true, markConnectivity: (on: boolean) => { connectivity.push(on); } } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror });
    const settle = async (path: string, ms: number): Promise<string> => {
      const verdict = proxy.forward(new Request(`http://engine${path}`, {
        method: "POST", body: JSON.stringify({ attachments: [{ contentBase64: "QUFB" }] }),
        headers: { "content-type": "application/json", "idempotency-key": KEY },
      })).then((r) => `answered ${r.status}`);
      await vi.advanceTimersByTimeAsync(ms);
      return await Promise.race([verdict, Promise.resolve("still pending")]);
    };
    return { settle, connectivity };
  }

  it("a send still uploading past the write deadline is not cut, and its own timeout leaves the door online", async () => {
    vi.useFakeTimers();
    const d = slowDoor();
    const send = d.settle("/drafts/d-1/send", REQUEST_DEADLINE_MS + 1_000);
    expect(await send).toBe("still pending");
    expect(d.connectivity).toEqual([]);
    // At the bound the window is answered the retryable 503, and other writes stay open.
    expect(await d.settle("/drafts/d-2/send", STAGED_UPLOAD_TIMEOUT_MS)).toBe("answered 503");
    expect(d.connectivity).toEqual([]);
  });

  it("control: any other write keeps its deadline, and a forward that fails marks the door offline", async () => {
    vi.useFakeTimers();
    const d = slowDoor();
    expect(await d.settle("/drafts", REQUEST_DEADLINE_MS)).toBe("answered 503");
    expect(d.connectivity).toEqual([false]);
  });
});
