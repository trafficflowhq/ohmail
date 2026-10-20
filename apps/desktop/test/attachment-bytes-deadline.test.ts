import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NET_TIMEOUTS, IMAP_READ_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import { OhmailEngine } from "@ohmail/client-engine";

import { ATTACHMENT_BYTES_DEADLINE_MS, BRIDGE_DEADLINE_MS, bridgeFetch, createEngineAdapter } from "../src/bridge-fetch.js";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { ensurePreview } from "../../webapp/app/shell/attachments.js";

/**
 * ONE ATTACHMENT'S BYTES GET THE ENGINE'S OWN READ BOUND, NOT THE MINUTE.
 *
 * The desktop reads a PDF for its preview the way the browser does, `GET /attachments/<id>` over the
 * bridge, and the bridge gave every call one minute. The engine bounds that read itself (one IMAP
 * read, `IMAP_READ_DEADLINE_MS`), and a save of the same file, which goes through the shell, has no
 * window deadline at all: a large PDF on a slow link saved, and its preview failed at 60 s with
 * "check your connection". Every other bridge call keeps the minute.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function encode(status: number, body: string | Uint8Array = "{}", headers: [string, string][] = []): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: headers }));
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const PDF = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d31";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 a large file");

/** An engine that answers the file list at once and `GET /attachments/<id>` after `bytesMs`. */
function engineAnswering(bytesMs: number): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const url = String(payload?.url);
      if (url === "/messages/m1/attachments") {
        return encode(200, JSON.stringify({
          items: [{ id: PDF, filename: "Report.pdf", contentType: "application/pdf", sizeBytes: 38 << 20, inline: false, messageId: "m1" }],
        }), [["content-type", "application/json"]]);
      }
      await new Promise((r) => setTimeout(r, bytesMs));
      return encode(200, PDF_BYTES, [["content-type", "application/pdf"]]);
    },
  };
}

/** An engine that never answers. */
function engineSilent(): void {
  host.__TAURI_INTERNALS__ = { invoke: () => new Promise(() => {}) };
}

afterEach(() => {
  vi.useRealTimers();
  delete host.__TAURI_INTERNALS__;
});

async function settleAfter(call: Promise<Response>, ms: number): Promise<string> {
  const verdict = call.then((r) => `answered ${r.status}`, (err: Error) => err.name);
  await vi.advanceTimersByTimeAsync(ms);
  return await Promise.race([verdict, Promise.resolve("still pending")]);
}

describe("the preview's read of a PDF over the real bridge adapter", () => {
  it("an engine that takes 75 s to read the file still opens the preview", async () => {
    vi.useFakeTimers();
    enableDesktopAttachments();
    engineAnswering(75_000);
    const engine = new OhmailEngine({ adapter: createEngineAdapter() });
    await engine.loadAttachments("m1");
    const preview = ensurePreview(engine, "m1", PDF);
    await vi.advanceTimersByTimeAsync(75_000);
    await preview;
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    const item = held.state === "ready" ? held.items.find((i) => i.id === PDF) : undefined;
    expect(item?.error, "the bridge gave the read up").toBeUndefined();
    expect(item?.state).toBe("ready");
    expect(engine.attachmentBlobOf("m1", PDF)?.type).toBe("application/pdf");
  });
});

describe("bridgeFetch — the bytes route's deadline", () => {
  it("is the engine's read bound and the dial before it, with room, and still a bound", async () => {
    expect(ATTACHMENT_BYTES_DEADLINE_MS).toBeGreaterThan(
      IMAP_READ_DEADLINE_MS + DEFAULT_NET_TIMEOUTS.connectionMs + DEFAULT_NET_TIMEOUTS.greetingMs,
    );
    expect(ATTACHMENT_BYTES_DEADLINE_MS).toBe(240_000);
    vi.useFakeTimers();
    engineSilent();
    const call = bridgeFetch(`/attachments/${PDF}`);
    expect(await settleAfter(call, ATTACHMENT_BYTES_DEADLINE_MS - 1)).toBe("still pending");
    expect(await settleAfter(call, 1)).toBe("BridgeDeadlineError");
  });

  it("control: every other read keeps the minute, the bytes route's neighbours included", async () => {
    for (const [method, path] of [
      ["GET", `/attachments/${PDF}/meta`],
      ["GET", "/messages/m1/attachments"],
      ["GET", "/mailboxes"],
      ["POST", "/attachments/staging"],
      ["POST", `/attachments/${PDF}`],
    ] as const) {
      vi.useFakeTimers();
      engineSilent();
      const call = bridgeFetch(path, { method });
      expect(await settleAfter(call, BRIDGE_DEADLINE_MS), `${method} ${path}`).toBe("BridgeDeadlineError");
      vi.useRealTimers();
    }
  });
});
