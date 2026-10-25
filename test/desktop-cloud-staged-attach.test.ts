/** @vitest-environment jsdom */
/// <reference path="../apps/desktop/src/build-flags.d.ts" />
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ComposeAttachment, EngineMutation } from "@ohmail/client-engine";
import { composeAttachCap, COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "@ohmail/client-engine";
import { createEngineAdapter, type EngineStatus } from "../apps/desktop/src/bridge-fetch.js";
import { CLOUD_URL } from "../apps/desktop/src/doors.js";
import {
  DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, desktopSendSurface, stagesAttachments,
} from "../apps/desktop/src/desktop-send-surface.js";
import { createStagedUploads, STAGED_UPLOAD_PATH_PREFIX } from "../apps/sidecar/src/cloud-staged-upload.js";
import { STAGED_UPLOAD_PATH_PREFIX as WINDOW_PREFIX } from "../apps/desktop/src/bridge-fetch.js";

/**
 * ═══ THE DESKTOP'S HOSTED DOOR SENDS A LARGE ATTACHMENT THE WAY THE BROWSER DOES ═══════════════
 *
 * The reported refusal: a 4 MB video from the desktop app on a hosted account, where the browser
 * took it. The window's real adapter (`createEngineAdapter`), over a shell whose engine half is the
 * real staged-upload door (`cloud-staged-upload.ts`) in front of a fake account and a fake storage.
 * It spans the window and the engine, so it lives in the repository's own test directory, which is
 * never published.
 *
 * Mutations watched: build the adapter without the option (the base) → the staged case goes red
 * with the bytes inline; drop the engine's rewrite → the window is handed the signed URL and the
 * no-storage-host case goes red.
 */

const MIB = 1024 * 1024;
const SIGNED_HOST = "storage.example";

interface Seen { method: string; path: string; body: unknown; headers: Record<string, string> }

function encodeAnswer(res: { status: number; headers: Headers; bytes: Uint8Array }): Uint8Array {
  const h: Array<[string, string]> = [];
  res.headers.forEach((v, k) => h.push([k, v]));
  const meta = new TextEncoder().encode(JSON.stringify({ status: res.status, statusText: "", h }));
  const out = new Uint8Array(4 + meta.length + res.bytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, false);
  out.set(meta, 4);
  out.set(res.bytes, 4 + meta.length);
  return out;
}

/** The shell, the engine's hosted door, the account and its storage — all four recorded. */
function rig(storage: "up" | "down" = "up") {
  const window: Seen[] = [];
  const account: Seen[] = [];
  const stored: Array<{ url: string; method: string; headers: Record<string, string>; sha: string; bytes: number }> = [];
  let minted = 0;

  const accountAnswer = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    account.push({ method: req.method, path, body: text ? JSON.parse(text) : null, headers });
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/drafts" && req.method === "POST") return json(201, { id: "draft-1", bcc: [] });
    if (path.endsWith("/send-attempt")) return json(200, { found: false });
    if (path === "/attachments/staging") {
      minted += 1;
      return json(201, {
        id: `ticket-${minted}`,
        uploadUrl: `https://${SIGNED_HOST}/upload/sign/staging/${minted}?token=signature`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": "video/mp4", "x-upsert": "false" },
      });
    }
    if (path.endsWith("/send")) return json(200, { status: "sent", providerMessageId: "<id@x>" });
    return json(200, {});
  };

  const staged = createStagedUploads({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (storage === "down") throw new TypeError("fetch failed");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const bytes = new Uint8Array(init!.body as ArrayBuffer);
      stored.push({
        url, method: init?.method ?? "GET", headers, bytes: bytes.byteLength,
        sha: createHash("sha256").update(bytes).digest("hex"),
      });
      return new Response("", { status: 200 });
    }) as typeof fetch,
  });

  /** The engine's hosted door, reduced to the two routes this slice adds and the relay. */
  const engine = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method === "PUT" && path.startsWith(STAGED_UPLOAD_PATH_PREFIX)) return staged.upload(req);
    if (req.method === "POST" && path === "/attachments/staging") return staged.rewriteMint(await accountAnswer(req));
    return accountAnswer(req);
  };

  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    async invoke(command: string, payload?: Record<string, unknown>) {
      if (command !== "engine_request") throw new Error(`unexpected command ${command}`);
      const p = payload as {
        method: string; url: string; headers: Array<[string, string]>;
        body?: number[]; bodyText?: string; body64?: string;
      };
      const headers: Record<string, string> = Object.fromEntries(p.headers);
      // The shell's three spellings of a body (`engine.rs` `window_request_body`).
      const bytes = p.bodyText !== undefined ? new TextEncoder().encode(p.bodyText)
        : p.body64 !== undefined ? Uint8Array.from(Buffer.from(p.body64, "base64"))
        : Uint8Array.from(p.body ?? []);
      const body = bytes.length ? bytes : undefined;
      window.push({
        method: p.method, path: p.url, headers,
        body: body && headers["content-type"]?.includes("json") ? JSON.parse(new TextDecoder().decode(body)) : body?.byteLength ?? null,
      });
      const res = await engine(new Request(`http://engine.local${p.url}`, {
        method: p.method, headers, ...(body ? { body } : {}),
      }));
      return encodeAnswer({ status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) });
    },
  };
  return { window, account, stored };
}

afterEach(() => { delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

function video(bytes: number): ComposeAttachment {
  const raw = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4096) raw[i] = i % 251;
  return { filename: "clip.mp4", contentType: "video/mp4", contentBase64: raw.toString("base64") };
}

const send = (attachments: ComposeAttachment[]): EngineMutation => ({
  kind: "mail_send", mailboxId: "mbx-1", inReplyTo: null, subject: "the clip", body: "here",
  to: [{ name: null, address: "you@example.com" }], attachments,
} as EngineMutation);

const managed = { state: "serving", mode: "cloud", cloudUrl: CLOUD_URL } as EngineStatus;

describe("the hosted door stages a 4 MB video through the engine", () => {
  it("one ticket, one PUT of the same bytes to storage, references in the send", async () => {
    const { window, account, stored } = rig();
    const file = video(4 * MIB);
    const adapter = createEngineAdapter({ stageAttachments: stagesAttachments(managed) });
    await adapter.mutate(send([file]), { idempotencyKey: "k-video" });

    expect(account.filter((c) => c.path === "/attachments/staging")).toHaveLength(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.method).toBe("PUT");
    expect(stored[0]!.headers).toEqual({ "content-type": "video/mp4", "x-upsert": "false" });
    expect(stored[0]!.sha).toBe(createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex"));

    const sent = account.find((c) => c.path.endsWith("/send"))!.body as Record<string, unknown>;
    expect(sent.stagedAttachmentIds).toEqual(["ticket-1"]);
    expect(sent.attachments).toBeUndefined();
  });

  it("the window never addresses storage: its PUT goes to the engine's door", async () => {
    const { window } = rig();
    const adapter = createEngineAdapter({ stageAttachments: true });
    await adapter.mutate(send([video(4 * MIB)]), { idempotencyKey: "k-door" });
    expect(window.every((c) => c.path.startsWith("/"))).toBe(true);
    expect(JSON.stringify(window)).not.toContain(SIGNED_HOST);
    const put = window.find((c) => c.method === "PUT")!;
    expect(put.path).toBe(`${STAGED_UPLOAD_PATH_PREFIX}ticket-1`);
    expect(put.body).toBe(4 * MIB);
  });

  it("a file at the window's ceiling crosses whole: one PUT, the same bytes stored", async () => {
    const { window, stored } = rig();
    const file = video(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES - 1);
    const adapter = createEngineAdapter({ stageAttachments: true });
    await adapter.mutate(send([file]), { idempotencyKey: "k-ceiling" });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.bytes).toBe(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES - 1);
    expect(stored[0]!.sha).toBe(createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex"));
    expect(window.find((c) => c.method === "PUT")!.body).toBe(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES - 1);
  }, 60_000);

  it("storage out of reach keeps the door's code, so the outbox counts the send toward its end", async () => {
    const { account } = rig("down");
    const err = await createEngineAdapter({ stageAttachments: true })
      .mutate(send([video(4 * MIB)]), { idempotencyKey: "k-down" }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "staging_unreachable", status: 503, retryable: true, retryAfterMs: 5_000, entityId: "draft-1",
    });
    expect(account.some((c) => c.path.endsWith("/send"))).toBe(false);
  });

  it("the window and the engine name one upload path", () => {
    expect(WINDOW_PREFIX).toBe(STAGED_UPLOAD_PATH_PREFIX);
  });
});

describe("the other doors keep the inline shape", () => {
  it("an adapter that does not ask sends the bytes inline and mints nothing — the standalone shape", async () => {
    const { account, stored } = rig();
    const adapter = createEngineAdapter();
    await adapter.mutate(send([video(4 * MIB)]), { idempotencyKey: "k-inline" });
    expect(account.some((c) => c.path === "/attachments/staging")).toBe(false);
    expect(stored).toHaveLength(0);
    const sent = account.find((c) => c.path.endsWith("/send"))!.body as Record<string, unknown>;
    expect(Array.isArray(sent.attachments)).toBe(true);
  });
});

describe("the hosted door's compose cap reads the browser's number", () => {
  it("for every mailbox, small or large", () => {
    for (const announced of [null, 10 * MIB, 20 * MIB, 25 * MIB, 30 * MIB, 57 * MIB, 70 * MIB]) {
      expect(composeAttachCap(announced, desktopSendSurface(managed)))
        .toBe(composeAttachCap(announced, COMPOSE_ATTACH_STAGED_SURFACE_BYTES));
    }
    expect(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES).toBe(COMPOSE_ATTACH_STAGED_SURFACE_BYTES);
  });
});
