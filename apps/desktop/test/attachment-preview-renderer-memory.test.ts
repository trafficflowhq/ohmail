import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * WHAT A DESKTOP PREVIEW COSTS THE RENDERER, MEASURED. The window's CSP refuses Tauri's `ipc:` fetch,
 * so a command's raw answer comes back through `eval` as `JSON.parse('[…]')`: one number per byte.
 * The page here is the desktop's own (`rigs/preview-memory-entry.ts`: the bridge adapter, a real
 * engine, `ensurePreview`) under `index.html`'s CSP, and the shell is answered exactly that way;
 * the staged image is served on the preview scheme's Windows spelling. Peak RSS growth of the
 * renderer process is read from /proc (VmHWM, reset just before the press).
 *
 * WebKitGTK, measured on the same page shapes (8 / 40 MiB): the JSON path +329 / +1350 MiB, the
 * scheme +27 / +116 MiB. The bounds: an image preview grows the renderer by at most 3x its size +
 * 48 MiB; the control (the engine's byte fetch, the old desktop preview) must exceed 8x its size.
 *
 * Mutation watched: `ensurePreview` taking the byte fetch when armed → the bounded cases are red.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const MIB = 1024 * 1024;
const ROOT = process.cwd();
const ORIGIN = "http://tauri.localhost";
const STAGED = "0123456789abcdef".repeat(2); // the shell's handle for one staged file
const TEXT_CAP = 2 * MIB; // attachment_preview.rs TEXT_PREVIEW_MAX_BYTES

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

const FILES: Record<string, { mime: string; bytes: Buffer }> = {
  "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c0008": { mime: "image/png", bytes: png(8 * MIB) },
  "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c0040": { mime: "image/png", bytes: png(40 * MIB) },
  "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c1001": { mime: "text/plain", bytes: Buffer.alloc(MIB, "a") },
  "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c1040": { mime: "text/plain", bytes: Buffer.alloc(40 * MIB, "a") },
};
const [IMG8, IMG40, TXT1, TXT40] = Object.keys(FILES) as [string, string, string, string];

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
    outdir: out, loader: { ".css": "css", ".svg": "file", ".png": "file", ".woff2": "file" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
  });
  bundle = readFileSync(join(out, "preview-memory-entry.js"), "utf8");
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The answer as Tauri's postMessage responder writes it: `runCallback(id, JSON.parse('[…]'))`. */
function rawAnswer(id: number, status: number, body: Buffer, contentType: string): string {
  const meta = Buffer.from(JSON.stringify({ status, statusText: "", h: [["content-type", contentType]] }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  const wire = Buffer.concat([len, meta, body]);
  let digits = "";
  const parts: string[] = [];
  for (let i = 0; i < wire.length; i += 1) {
    digits += (i ? "," : "") + wire[i];
    if (digits.length > 1 << 20) { parts.push(digits); digits = ""; }
  }
  parts.push(digits);
  return `window.__TAURI_INTERNALS__.runCallback(${id}, JSON.parse('[${parts.join("")}]'))`;
}

function rssOf(pid: number, field: "VmRSS" | "VmHWM"): number {
  return Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) * 1024;
}

/** Open one part in a fresh page and answer the renderer's peak RSS growth over the press. */
async function measure(id: string, how: "preview" | "bytes"): Promise<{ growth: number; result: Record<string, unknown> }> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(ROOT, "apps/desktop/index.html"), "utf8"))![1]!;
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="/rig.js"></script>` });
  });
  let served = 0;
  await page.route("http://attachment-preview.localhost/**", (route) => {
    served += 1;
    return route.fulfill({ contentType: FILES[id]!.mime, body: FILES[id]!.bytes });
  });
  await page.addInitScript(() => {
    const pending = new Map<number, [(v: unknown) => void, (e: unknown) => void]>();
    let next = 1;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke(command: string, payload: unknown) {
        const n = next++;
        return new Promise((ok, no) => {
          pending.set(n, [ok, no]);
          void (window as unknown as { __rigInvoke: (n: number, c: string, p: unknown) => Promise<void> }).__rigInvoke(n, command, payload);
        });
      },
      runCallback(n: number, value: unknown) { pending.get(n)?.[0](value); pending.delete(n); },
      runError(n: number, value: unknown) { pending.get(n)?.[1](value); pending.delete(n); },
    };
  });
  await page.exposeFunction("__rigInvoke", async (n: number, command: string, payload: Record<string, unknown>) => {
    let script: string;
    if (command === "engine_request" && String(payload.url).endsWith("/attachments")) {
      const items = Object.entries(FILES).map(([fid, f]) => ({ id: fid, filename: `${fid}.x`, contentType: f.mime, sizeBytes: f.bytes.length, messageId: "m1" }));
      script = rawAnswer(n, 200, Buffer.from(JSON.stringify({ items })), "application/json");
    } else if (command === "engine_request" && /\/attachments\/[0-9a-f-]{36}$/.test(String(payload.url))) {
      const f = FILES[String(payload.url).split("/").pop()!]!;
      script = rawAnswer(n, 200, f.bytes, "application/octet-stream");
    } else if (command === "stage_attachment_preview") {
      const f = FILES[String(payload.attachmentId)]!;
      const answer = f.mime.startsWith("image/")
        ? { url: `http://attachment-preview.localhost/${STAGED}`, token: STAGED, size: f.bytes.length }
        : f.bytes.length > TEXT_CAP ? { size: f.bytes.length, tooLarge: true } : { size: f.bytes.length, text64: f.bytes.toString("base64") };
      script = `window.__TAURI_INTERNALS__.runCallback(${n}, ${JSON.stringify(answer)})`;
    } else {
      script = `window.__TAURI_INTERNALS__.runCallback(${n}, null)`;
    }
    setTimeout(() => void page.evaluate(script).catch(() => undefined), 0);
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  const cdp = await browser!.newBrowserCDPSession();
  const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number }> };
  const renderers = processInfo.filter((p) => p.type === "renderer").map((p) => p.id);
  for (const pid of renderers) writeFileSync(`/proc/${pid}/clear_refs`, "5");
  const before = new Map(renderers.map((pid) => [pid, rssOf(pid, "VmRSS")]));
  const result = (await page.evaluate(([fid, way]) => (window as unknown as { rig: { open: (a: string, b: string) => Promise<Record<string, unknown>> } }).rig.open(fid!, way!), [id, how])) as Record<string, unknown>;
  const growth = Math.max(...renderers.map((pid) => rssOf(pid, "VmHWM") - before.get(pid)!));
  await cdp.detach();
  await context.close();
  return { growth, result: { ...result, served } };
}

const say = (what: string, growth: number) => process.stderr.write(`[preview-memory] ${what}: renderer peak RSS +${(growth / MIB).toFixed(1)} MiB\n`);

describe.runIf(process.platform === "linux")("the desktop preview's renderer memory", () => {
  it("an 8 and a 40 MiB picture load from the preview scheme, the renderer growing by at most 3x + 48 MiB", async () => {
    for (const [id, mib] of [[IMG8, 8], [IMG40, 40]] as const) {
      const { growth, result } = await measure(id, "preview");
      say(`${mib} MiB image, preview scheme`, growth);
      expect(result, `the ${mib} MiB preview did not load`).toMatchObject({ state: "ready", loaded: true, width: 32, served: 1 });
      expect(growth, `${mib} MiB image grew the renderer by ${(growth / MIB).toFixed(1)} MiB`).toBeLessThan(3 * mib * MIB + 48 * MIB);
    }
  }, 120_000);

  it("text crosses only under the 2 MiB cap; 40 MiB is too large and costs the renderer nothing", async () => {
    const small = await measure(TXT1, "preview");
    say("1 MiB text, inline", small.growth);
    expect(small.result).toMatchObject({ state: "ready", textLength: MIB });
    expect(small.growth).toBeLessThan(64 * MIB);
    const big = await measure(TXT40, "preview");
    say("40 MiB text, too large", big.growth);
    expect(big.result).toMatchObject({ state: "ready", tooLarge: true });
    expect(big.growth).toBeLessThan(16 * MIB);
  }, 120_000);

  it("THE CONTROL: the byte fetch the desktop preview made before grows the renderer by more than 8x the file", async () => {
    const { growth, result } = await measure(IMG8, "bytes");
    say("8 MiB image, bytes through the command channel", growth);
    expect(result).toMatchObject({ state: "ready", loaded: true, served: 0 });
    expect(growth, "the instrument did not see the JSON array").toBeGreaterThan(8 * 8 * MIB);
  }, 120_000);
});
