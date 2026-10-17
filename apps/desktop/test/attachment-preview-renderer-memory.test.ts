import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * WHAT A RAW ANSWER COSTS THE DESKTOP RENDERER, MEASURED IN CHROMIUM (WebView2's engine). The page is
 * the desktop's own (`rigs/preview-memory-entry.ts`: the bridge adapter, a real engine, the real guard
 * as Windows ships it) under the Windows overlay's policy, and the shell is answered as Tauri answers:
 * over `http://ipc.localhost` while the policy admits it, else by `eval` of a JSON array, one number
 * per byte. Peak RSS growth of the renderer process is read from /proc (VmHWM, reset just before).
 *
 * Bounds: each class of raw answer grows the renderer by at most 4x its bytes + 48 MiB and crosses as
 * bytes; a picture preview by at most 3x + 48 MiB; the controls, under the base's closed policy, by
 * more than 8x. Watched red: `tauri.windows.conf.json`'s connect-src back to `'none'`. An inline
 * class draws its letter in the reader's frame (the real sanitizer, document and sandbox) and must
 * show every picture, by object URL; its control, the same message with `data:` pictures, grows the
 * renderer by more than twice that bound.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>;
const MIB = 1024 * 1024;
const ROOT = process.cwd();
const ORIGIN = "http://tauri.localhost";
const STAGED = "0123456789abcdef".repeat(2); // the shell's handle for one staged file
const TEXT_CAP = 2 * MIB; // attachment_preview.rs TEXT_PREVIEW_MAX_BYTES

/** A platform's policy as its document carries it: the config's, less `frame-ancestors`. */
const policyOf = (file: string): string =>
  (JSON.parse(readFileSync(join(ROOT, "apps/desktop/src-tauri", file), "utf8")) as { app: { security: { csp: string } } })
    .app.security.csp.split("; ").filter((d) => !d.startsWith("frame-ancestors ")).join("; ");
const WINDOWS_POLICY = policyOf("tauri.windows.conf.json");
const CLOSED_POLICY = policyOf("tauri.conf.json");

function chunk(tag: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

/** A 32x32 PNG padded to `size` with an ancillary chunk of noise: big on the wire, tiny decoded. */
function png(size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(32 * (1 + 96), 0x5a);
  const head = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr)]);
  const tail = Buffer.concat([chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const pad = Buffer.alloc(Math.max(0, size - head.length - tail.length - 12));
  for (let i = 0; i < pad.length; i += 1) pad[i] = (i * 2654435761) >>> 24;
  return Buffer.concat([head, chunk("prVt", pad), tail]);
}

/** A calendar part of exactly `size` bytes. */
function ics(size: number): Buffer {
  const head = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:rig@example.invalid\r\nSUMMARY:Rig\r\nDESCRIPTION:";
  const tail = "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  return Buffer.from(head + "x".repeat(size - head.length - tail.length) + tail, "latin1");
}

type Part = { messageId: string; mime: string; bytes: Buffer; contentId?: string };
const PARTS: Record<string, Part> = {};
const part = (n: number, p: Part): string => {
  const id = `0b5e8d3c-1f2a-4c3b-9d8e-${String(n).padStart(12, "0")}`;
  PARTS[id] = p;
  return id;
};
const IMG8 = part(8, { messageId: "m1", mime: "image/png", bytes: png(8 * MIB) });
const IMG40 = part(40, { messageId: "m1", mime: "image/png", bytes: png(40 * MIB) });
const TXT1 = part(1001, { messageId: "m1", mime: "text/plain", bytes: Buffer.alloc(MIB, "a") });
const TXT40 = part(1040, { messageId: "m1", mime: "text/plain", bytes: Buffer.alloc(40 * MIB, "a") });
part(4000, { messageId: "m-inline4", mime: "image/png", bytes: png(4 * MIB), contentId: "c4" });
for (let i = 0; i < 12; i += 1) {
  part(1600 + i, { messageId: "m-inline16", mime: "image/png", bytes: png(Math.floor((16 * MIB) / 12)), contentId: `c16-${i}` });
}
for (let i = 0; i < 3; i += 1) part(256 + i, { messageId: "m-cal", mime: "text/calendar", bytes: ics(256 * 1024) });
const partBytes = (messageId: string) =>
  Object.values(PARTS).filter((p) => p.messageId === messageId).reduce((n, p) => n + p.bytes.length, 0);

const BODIES = Buffer.from(JSON.stringify({
  items: Array.from({ length: 20 }, (_, i) => ({ messageId: `body-${i}`, text: "b".repeat(MIB), html: null })),
}));
const SNAPSHOT_ROWS = 10_240;
const SNAPSHOT = Buffer.from(JSON.stringify({
  asOfSeq: SNAPSHOT_ROWS, nextCursor: null, window: { days: 30, minRows: 100 },
  changes: Array.from({ length: SNAPSHOT_ROWS }, (_, i) => ({
    type: "message", op: "create", id: `msg-${i}`, seq: i + 1, updatedAt: "2026-10-17T00:00:00.000Z",
    entity: { id: `msg-${i}`, mailboxId: "mb-1", subject: "s".repeat(900) },
  })),
}));

/** The shell's `engine_request` wire: [4 bytes BE: meta length][meta JSON][body]. */
function wire(status: number, body: Buffer, contentType: string): Buffer {
  const meta = Buffer.from(JSON.stringify({ status, statusText: "", h: [["content-type", contentType]] }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  return Buffer.concat([len, meta, body]);
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** What the shell answers a command with: raw bytes, or a JSON value. */
function shellAnswer(command: string, payload: Record<string, unknown>): { raw: Buffer } | { json: unknown } {
  if (command === "engine_request") {
    const url = String(payload.url);
    const list = /^\/messages\/([^/?]+)\/attachments$/.exec(url);
    if (list) {
      const items = Object.entries(PARTS).filter(([, p]) => p.messageId === decodeURIComponent(list[1]!)).map(([id, p]) => ({
        id, filename: `${id}.x`, contentType: p.mime, sizeBytes: p.bytes.length, messageId: p.messageId,
        inline: p.contentId !== undefined, contentId: p.contentId ?? null,
      }));
      return { raw: wire(200, json({ items }), "application/json") };
    }
    const one = /^\/attachments\/([0-9a-f-]{36})$/.exec(url);
    if (one && PARTS[one[1]!]) return { raw: wire(200, PARTS[one[1]!]!.bytes, "application/octet-stream") };
    if (url.startsWith("/messages/bodies?")) return { raw: wire(200, BODIES, "application/json") };
    if (url.startsWith("/sync/snapshot")) return { raw: wire(200, SNAPSHOT, "application/json") };
    return { raw: wire(404, json({ error: { code: "not_found", message: url } }), "application/json") };
  }
  if (command === "stage_attachment_preview") {
    const f = PARTS[String(payload.attachmentId)]!;
    return {
      json: f.mime.startsWith("image/")
        ? { url: `http://attachment-preview.localhost/${STAGED}`, token: STAGED, size: f.bytes.length }
        : f.bytes.length > TEXT_CAP ? { size: f.bytes.length, tooLarge: true } : { size: f.bytes.length, text64: f.bytes.toString("base64") },
    };
  }
  return { json: null };
}

/** The answer as Tauri's postMessage responder writes a raw response: `runCallback(id, JSON.parse('[…]'))`. */
function rawAnswer(id: number, bytes: Buffer): string {
  let digits = "";
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    digits += (i ? "," : "") + bytes[i];
    if (digits.length > 1 << 20) { parts.push(digits); digits = ""; }
  }
  parts.push(digits);
  return `window.__TAURI_INTERNALS__.runCallback(${id}, JSON.parse('[${parts.join("")}]'))`;
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let bundle = "";
const dirs: string[] = [];

beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-preview-mem-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/desktop/test/rigs/preview-memory-entry.ts")],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic",
    outdir: out, loader: { ".css": "css", ".svg": "file", ".png": "file", ".woff2": "file", ".woff": "file" },
    // The reader's frame (`MessageBody`) reads its sentences through next-intl, which is use-intl here.
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
  });
  bundle = readFileSync(join(out, "preview-memory-entry.js"), "utf8");
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function rssOf(pid: number, field: "VmRSS" | "VmHWM"): number {
  return Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) * 1024;
}

type Reading = { bridgeTransport: string | null; answers: number; json: number };
type Rig = {
  open: (id: string, how: string) => Promise<Record<string, unknown>>;
  load: (kind: string, messageId?: string, carrier?: string) => Promise<Record<string, unknown>>;
  transport: () => Reading;
};

/**
 * One fresh page under `policy`, `run` measured in it. The runtime is Tauri's own shape
 * (`ipc-protocol.js`): every command is first a POST to the command scheme, and the first refusal
 * latches the page onto the message channel for good.
 */
async function measure(policy: string, run: (page: Page) => Promise<Record<string, unknown>>) {
  const context = await browser!.newContext();
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script src="/rig.js"></script>` });
  });
  let served = 0;
  let lastStaged: Buffer = Buffer.alloc(0);
  await page.route("http://attachment-preview.localhost/**", (route) => {
    served += 1;
    return route.fulfill({ contentType: "image/png", body: lastStaged });
  });
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Tauri-Response" };
  await page.route("http://ipc.localhost/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...cors, "Access-Control-Allow-Headers": "*" }, body: "" });
    const command = decodeURIComponent(new URL(request.url()).pathname.slice(1));
    const payload = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    if (command === "stage_attachment_preview") lastStaged = PARTS[String(payload.attachmentId)]?.bytes ?? Buffer.alloc(0);
    const answer = shellAnswer(command, payload);
    return "raw" in answer
      ? route.fulfill({ status: 200, headers: { ...cors, "Tauri-Response": "ok", "Content-Type": "application/octet-stream" }, body: answer.raw })
      : route.fulfill({ status: 200, headers: { ...cors, "Tauri-Response": "ok", "Content-Type": "application/json" }, body: JSON.stringify(answer.json) });
  });
  await page.exposeFunction("__rigPostMessage", (id: number, command: string, payload: Record<string, unknown>) => {
    if (command === "stage_attachment_preview") lastStaged = PARTS[String(payload.attachmentId)]?.bytes ?? Buffer.alloc(0);
    const answer = shellAnswer(command, payload);
    const script = "raw" in answer ? rawAnswer(id, answer.raw) : `window.__TAURI_INTERNALS__.runCallback(${id}, ${JSON.stringify(answer.json)})`;
    setTimeout(() => void page.evaluate(script).catch(() => undefined), 0);
  });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { __rigPostMessage: (i: number, c: string, p: unknown) => void };
    const pending = new Map<number, [(v: unknown) => void, (e: unknown) => void]>();
    let next = 1;
    let failed = false;
    const internals = {
      invoke(command: string, payload: unknown) {
        return new Promise((ok, no) => {
          const id = next++;
          pending.set(id, [ok, no]);
          send(id, command, payload ?? {});
        });
      },
      runCallback(id: number, value: unknown) { pending.get(id)?.[0](value); pending.delete(id); },
      runError(id: number, value: unknown) { pending.get(id)?.[1](value); pending.delete(id); },
    };
    function send(id: number, command: string, payload: unknown): void {
      if (failed) { w.__rigPostMessage(id, command, payload); return; }
      (w.fetch as typeof fetch)(`http://ipc.localhost/${encodeURIComponent(command)}`, {
        method: "POST", body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", "Tauri-Callback": String(id), "Tauri-Error": String(id), "Tauri-Invoke-Key": "rig" },
      }).then((response) => {
        const type = (response.headers.get("content-type") ?? "").split(",")[0];
        return type === "application/json" ? response.json() : type === "text/plain" ? response.text() : response.arrayBuffer();
      }).then((value) => internals.runCallback(id, value), () => {
        failed = true;
        send(id, command, payload);
      });
    }
    w.__TAURI_INTERNALS__ = internals;
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  const cdp = await browser!.newBrowserCDPSession();
  const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number }> };
  const renderers = processInfo.filter((p) => p.type === "renderer").map((p) => p.id);
  for (const pid of renderers) writeFileSync(`/proc/${pid}/clear_refs`, "5");
  const before = new Map(renderers.map((pid) => [pid, rssOf(pid, "VmRSS")]));
  const result = await run(page);
  const growth = Math.max(...renderers.map((pid) => rssOf(pid, "VmHWM") - before.get(pid)!));
  const transport = (await page.evaluate(() => (window as unknown as { rig: Rig }).rig.transport())) as Reading;
  await cdp.detach();
  await context.close();
  return { growth, result: { ...result, served }, transport };
}

const opening = (id: string, how: "preview" | "bytes") => (page: Page) =>
  page.evaluate(([fid, way]) => (window as unknown as { rig: Rig }).rig.open(fid!, way!), [id, how]);
const loading = (kind: string, messageId = "", carrier = "object") => (page: Page) =>
  page.evaluate(([k, m, c]) => (window as unknown as { rig: Rig }).rig.load(k!, m!, c!), [kind, messageId, carrier]);

const say = (what: string, growth: number) => process.stderr.write(`[renderer-memory] ${what}: renderer peak RSS +${(growth / MIB).toFixed(1)} MiB\n`);

describe.runIf(process.platform === "linux")("the desktop preview's renderer memory", () => {
  it("an 8 and a 40 MiB picture load from the preview scheme, the renderer growing by at most 3x + 48 MiB", async () => {
    for (const [id, mib] of [[IMG8, 8], [IMG40, 40]] as const) {
      const { growth, result } = await measure(WINDOWS_POLICY, opening(id, "preview"));
      say(`${mib} MiB image, preview scheme`, growth);
      expect(result, `the ${mib} MiB preview did not load`).toMatchObject({ state: "ready", loaded: true, width: 32, served: 1 });
      expect(growth, `${mib} MiB image grew the renderer by ${(growth / MIB).toFixed(1)} MiB`).toBeLessThan(3 * mib * MIB + 48 * MIB);
    }
  }, 120_000);

  it("text crosses only under the 2 MiB cap; 40 MiB is too large and costs the renderer nothing", async () => {
    const small = await measure(WINDOWS_POLICY, opening(TXT1, "preview"));
    say("1 MiB text, inline", small.growth);
    expect(small.result).toMatchObject({ state: "ready", textLength: MIB });
    expect(small.growth).toBeLessThan(64 * MIB);
    const big = await measure(WINDOWS_POLICY, opening(TXT40, "preview"));
    say("40 MiB text, too large", big.growth);
    expect(big.result).toMatchObject({ state: "ready", tooLarge: true });
    expect(big.growth).toBeLessThan(16 * MIB);
  }, 120_000);

  it("THE CONTROL: the byte fetch the desktop preview made before, as it crossed then, grows the renderer by more than 8x the file", async () => {
    const { growth, result, transport } = await measure(CLOSED_POLICY, opening(IMG8, "bytes"));
    say("8 MiB image, bytes through the closed policy's JSON channel", growth);
    expect(result).toMatchObject({ state: "ready", loaded: true, served: 0 });
    expect(transport.bridgeTransport).toBe("json");
    expect(growth, "the instrument did not see the JSON array").toBeGreaterThan(8 * 8 * MIB);
  }, 120_000);
});

describe.runIf(process.platform === "linux")("every class of raw answer crosses as bytes, and costs the renderer at most 4x them + 48 MiB", () => {
  const CLASSES = [
    { name: "a bodies page, 20 x 1 MiB", bytes: BODIES.length, run: loading("bodies"), held: { rows: 20, chars: 20 * MIB } },
    // Drawn in the reader's frame, by the window's object URLs: every picture shown, none as data:.
    { name: "one 4 MiB inline picture", bytes: partBytes("m-inline4"), run: loading("inline", "m-inline4"), held: { minted: 1, drawn: 1, blob: 1, data: 0 } },
    { name: "a 16 MiB inline message, 12 parts", bytes: partBytes("m-inline16"), run: loading("inline", "m-inline16"), held: { minted: 12, drawn: 12, blob: 12, data: 0 } },
    { name: "three 256 KiB calendar parts", bytes: partBytes("m-cal"), run: loading("calendar", "m-cal"), held: { texts: 3 } },
    { name: "a 10 MiB snapshot page", bytes: SNAPSHOT.length, run: loading("snapshot"), held: { changes: SNAPSHOT_ROWS } },
  ];
  for (const c of CLASSES) {
    it(c.name, async () => {
      const { growth, result, transport } = await measure(WINDOWS_POLICY, c.run);
      say(`${c.name} (${(c.bytes / MIB).toFixed(2)} MiB)`, growth);
      expect(result).toMatchObject(c.held);
      expect(transport, "a raw answer took the JSON fallback").toMatchObject({ bridgeTransport: "ipc", json: 0 });
      expect(growth, `grew the renderer by ${(growth / MIB).toFixed(1)} MiB`).toBeLessThan(4 * c.bytes + 48 * MIB);
    }, 120_000);
  }

  it("THE CONTROL: the same 16 MiB message drawn from data: pictures grows the renderer by more than twice the bound", async () => {
    const bytes = partBytes("m-inline16");
    const { growth, result, transport } = await measure(WINDOWS_POLICY, loading("inline", "m-inline16", "data"));
    say("a 16 MiB inline message drawn from data: pictures", growth);
    expect(result).toMatchObject({ minted: 12, drawn: 12, blob: 0, data: 12 });
    expect(transport).toMatchObject({ bridgeTransport: "ipc", json: 0 });
    expect(growth, "the instrument did not see the data: copies").toBeGreaterThan(2 * (4 * bytes + 48 * MIB));
  }, 120_000);

  it("THE CONTROL: the 16 MiB message under the closed policy crosses as JSON arrays, more than 8x its bytes", async () => {
    const bytes = partBytes("m-inline16");
    const { growth, result, transport } = await measure(CLOSED_POLICY, loading("inline", "m-inline16"));
    say("a 16 MiB inline message through the closed policy's JSON channel", growth);
    expect(result).toMatchObject({ minted: 12 });
    expect(transport.bridgeTransport).toBe("json");
    expect(growth, "the instrument did not see the JSON arrays").toBeGreaterThan(8 * bytes);
  }, 120_000);
});
