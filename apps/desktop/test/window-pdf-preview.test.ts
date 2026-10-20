import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * THE WINDOW'S PDF PREVIEW, IN CHROMIUM (WebView2's engine). The page runs the window's own pdf.js
 * module (`src/window-pdfjs.ts`, `rigs/pdf-preview-entry.ts`) under the window's policy, and its
 * server holds pdf.js's library and worker as the window build emits them: the `pdfjs-dist` build
 * this package installs, byte for byte, each answered with the shell's non-document policy
 * (`navigation.rs`). A loopback server rather than an intercepted origin, because only a real
 * request carries `Sec-Fetch-Dest`, which tells a worker's script from a module the page imports.
 *
 * A generated PDF draws (its centre pixel is the fill), the worker is fetched once as a worker and
 * never as a script, and pdf.js's main-thread worker global never appears. The control is the
 * window's policy as it stood before, `worker-src 'none'`: the load fails, the worker's file is
 * never asked for, and pdf.js never falls back to parsing on the page. The shell's policy is what
 * keeps the worker from the network: under it a worker can neither fetch, import nor eval, and the
 * same worker without it can do all three. A 40 MiB PDF fetched over the bridge and drawn grows the
 * renderer by at most the raw-answer bound (4x + 48 MiB, `attachment-preview-renderer-memory`);
 * measured at about +120 MiB (2026-10-20, Chromium 151).
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const MIB = 1024 * 1024;

/** The two files `windowPdfjs()` emits, from this package's install (the root's where it has none). */
const fromDesktop = createRequire(join(ROOT, "apps/desktop/package.json"));
const LIBRARY = readFileSync(fromDesktop.resolve("pdfjs-dist/build/pdf.min.mjs"));
const WORKER = readFileSync(fromDesktop.resolve("pdfjs-dist/build/pdf.worker.min.mjs"));

/** The shell's answer to every file that is not a page, read from the Rust that sends it. */
const NON_DOCUMENT_CSP = /pub const NON_DOCUMENT_CSP: &str = "([^"]+)";/.exec(
  readFileSync(join(ROOT, "apps/desktop/src-tauri/src/navigation.rs"), "utf8"),
)![1]!;
const policyOf = (file: string): string =>
  (JSON.parse(readFileSync(join(ROOT, "apps/desktop/src-tauri", file), "utf8")) as { app: { security: { csp: string } } }).app.security.csp;
const WINDOW_POLICY = policyOf("tauri.windows.conf.json");
const BEFORE_POLICY = WINDOW_POLICY.replace("worker-src 'self'", "worker-src 'none'");

/** A one-page PDF filled with one colour, padded to `size` bytes with a stream nothing draws. */
function pdf(size = 0): Buffer {
  const content = Buffer.from("0.8 0.1 0.1 rg 0 0 200 200 re f");
  const objs: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
  ];
  const build = (pad: number): Buffer => {
    const all = pad > 0 ? [...objs, Buffer.concat([Buffer.from(`<< /Length ${pad} >>\nstream\n`), noise(pad), Buffer.from("\nendstream")])] : objs;
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    const offsets: number[] = [];
    let at = parts[0]!.length;
    all.forEach((o, i) => {
      offsets.push(at);
      const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
      parts.push(obj);
      at += obj.length;
    });
    const xref = [`xref\n0 ${all.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
    return Buffer.concat(parts);
  };
  if (size === 0) return build(0);
  const bare = build(1).length - 1;
  const padded = build(size - bare);
  return padded.length === size ? padded : build(size - bare - (padded.length - size));
}

function noise(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 2654435761) >>> 24;
  return b;
}

const PDF40_ID = "0b5e8d3c-1f2a-4c3b-9d8e-000000000040";
const PDF40 = pdf(40 * MIB);

let browser: Browser | null = null;
let server: Server | null = null;
let origin = "";
let bundle = "";
const dirs: string[] = [];
/** What the page's documents asked the server for: path, and `Sec-Fetch-Dest`. */
let asked: Array<[string, string | null]> = [];
let policy = WINDOW_POLICY;

const PROBE = `const out = {};
try { out.eval = new Function("return 7")() === 7 ? "ran" : "?"; } catch { out.eval = "refused"; }
try { out.fetch = (await fetch("/ping")).status; } catch { out.fetch = "refused"; }
try { await import("/probe-import.mjs"); out.import = "loaded"; } catch { out.import = "refused"; }
postMessage(out);`;

beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-pdf-preview-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/desktop/test/rigs/pdf-preview-entry.ts")],
    bundle: true, format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic",
    outdir: out, loader: { ".css": "css", ".svg": "file", ".png": "file", ".woff2": "file", ".woff": "file" },
    // The window build's alias, so the shared overlay's own import meets the same module.
    alias: { "pdfjs-dist": join(ROOT, "apps/desktop/src/window-pdfjs.ts"), "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
  });
  bundle = readFileSync(join(out, "pdf-preview-entry.js"), "utf8");
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    asked.push([path, (req.headers["sec-fetch-dest"] as string | undefined) ?? null]);
    const js = (body: string | Buffer, csp: string | null = NON_DOCUMENT_CSP) => {
      res.writeHead(200, { "content-type": "text/javascript", ...(csp ? { "content-security-policy": csp } : {}) });
      res.end(body);
    };
    if (path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": policy });
      res.end('<!doctype html><meta charset="utf-8"><script src="/rig.js"></script>');
    } else if (path === "/rig.js") js(bundle);
    else if (path === "/pdf.min.mjs") js(LIBRARY);
    else if (path === "/pdf.worker.min.mjs") js(WORKER);
    else if (path === "/probe-closed.mjs") js(PROBE);
    else if (path === "/probe-open.mjs") js(PROBE, null);
    else if (path === "/probe-import.mjs") js("export const x = 1;");
    else if (path === "/ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Rig = { render: (b64: string) => Promise<Record<string, unknown>>; open: (id: string) => Promise<Record<string, unknown>>; worker: () => string };

/** One fresh page under `under`, with the console it printed and the requests it made. */
async function onPage<T>(under: string, run: (page: Page) => Promise<T>): Promise<{ result: T; console: string[]; asked: Array<[string, string | null]> }> {
  policy = under;
  asked = [];
  const context = await browser!.newContext();
  const page = await context.newPage();
  const printed: string[] = [];
  page.on("console", (m) => printed.push(m.text()));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  const result = await run(page);
  await context.close();
  return { result, console: printed, asked: [...asked] };
}

const SMALL = pdf().toString("base64");
const rendering = (b64: string) => (page: Page) =>
  page.evaluate(async ([pdfB64]) => {
    const rig = (window as unknown as { rig: Rig }).rig;
    const drawn = await rig.render(pdfB64!);
    return { ...drawn, worker: rig.worker() };
  }, [b64]);
const workerAsks = (seen: Array<[string, string | null]>) => seen.filter(([p]) => p === "/pdf.worker.min.mjs");

describe("the window draws a PDF with its own worker", () => {
  it("under the window's policy a PDF draws, the worker is fetched once as a worker, and nothing parses on the page", async () => {
    const { result, console: printed, asked: seen } = await onPage(WINDOW_POLICY, rendering(SMALL));
    expect(result).toMatchObject({ pages: 1, px: [204, 26, 26, 255], worker: "undefined" });
    expect(workerAsks(seen), "the worker's file was not fetched exactly once, as a worker").toEqual([["/pdf.worker.min.mjs", "worker"]]);
    expect(seen.filter(([p]) => p === "/pdf.min.mjs").map(([, d]) => d)).toEqual(["script"]);
    expect(printed.filter((l) => /fake worker/i.test(l))).toEqual([]);
  }, 60_000);

  it("THE CONTROL: under worker-src 'none' the load fails, the worker is never asked for, and pdf.js does not fall back", async () => {
    expect(BEFORE_POLICY).not.toBe(WINDOW_POLICY);
    const { result, console: printed, asked: seen } = await onPage(BEFORE_POLICY, rendering(SMALL));
    expect(result).toMatchObject({ worker: "undefined" });
    expect(result.error, "a PDF drew with no worker the policy admits").toBeTruthy();
    expect(workerAsks(seen), "the refused worker's file was fetched anyway").toEqual([]);
    expect(printed.filter((l) => /fake worker/i.test(l)), "pdf.js parsed the PDF on the page's own thread").toEqual([]);
  }, 60_000);

  it("the shell's non-document policy binds a worker: no fetch, no import, no eval; the same worker without it has all three", async () => {
    const probe = (name: string) => (page: Page) =>
      page.evaluate((file) => new Promise((done) => {
        const w = new Worker(`/${file}`, { type: "module" });
        w.onmessage = (e) => done(e.data);
        w.onerror = () => done({ error: true });
      }), name);
    const closed = await onPage(WINDOW_POLICY, probe("probe-closed.mjs"));
    expect(closed.result).toEqual({ eval: "refused", fetch: "refused", import: "refused" });
    const open = await onPage(WINDOW_POLICY, probe("probe-open.mjs"));
    expect(open.result, "the instrument cannot see a worker reach out").toEqual({ eval: "ran", fetch: 200, import: "loaded" });
  }, 60_000);
});

/* ── a 40 MiB PDF, fetched over the bridge as the preview asks for it ─────────────────────── */

/** The shell's `engine_request` wire: [4 bytes BE: meta length][meta JSON][body]. */
function wire(status: number, body: Buffer, contentType: string): Buffer {
  const meta = Buffer.from(JSON.stringify({ status, statusText: "", h: [["content-type", contentType]] }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  return Buffer.concat([len, meta, body]);
}

async function bridged(page: Page): Promise<void> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Tauri-Response" };
  await page.route("http://ipc.localhost/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...cors, "Access-Control-Allow-Headers": "*" }, body: "" });
    const command = decodeURIComponent(new URL(request.url()).pathname.slice(1));
    const url = String((JSON.parse(request.postData() ?? "{}") as { url?: unknown }).url ?? "");
    const raw = command !== "engine_request"
      ? null
      : url === "/messages/m1/attachments"
        ? wire(200, Buffer.from(JSON.stringify({ items: [{ id: PDF40_ID, filename: "big.pdf", contentType: "application/pdf", sizeBytes: PDF40.length, messageId: "m1", inline: false, contentId: null }] })), "application/json")
        : url === `/attachments/${PDF40_ID}`
          ? wire(200, PDF40, "application/octet-stream")
          : wire(404, Buffer.from('{"error":{"code":"not_found"}}'), "application/json");
    return raw
      ? route.fulfill({ status: 200, headers: { ...cors, "Tauri-Response": "ok", "Content-Type": "application/octet-stream" }, body: raw })
      : route.fulfill({ status: 200, headers: { ...cors, "Tauri-Response": "ok", "Content-Type": "application/json" }, body: "null" });
  });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const pending = new Map<number, [(v: unknown) => void, (e: unknown) => void]>();
    let next = 1;
    const internals = {
      invoke(command: string, payload: unknown) {
        return new Promise((ok, no) => {
          const id = next++;
          pending.set(id, [ok, no]);
          (w.fetch as typeof fetch)(`http://ipc.localhost/${encodeURIComponent(command)}`, {
            method: "POST", body: JSON.stringify(payload ?? {}),
            headers: { "Content-Type": "application/json", "Tauri-Callback": String(id), "Tauri-Error": String(id), "Tauri-Invoke-Key": "rig" },
          }).then((r) => ((r.headers.get("content-type") ?? "").startsWith("application/json") ? r.json() : r.arrayBuffer()))
            .then((v) => { pending.get(id)?.[0](v); pending.delete(id); }, (e) => { pending.get(id)?.[1](e); pending.delete(id); });
        });
      },
    };
    w.__TAURI_INTERNALS__ = internals;
  });
}

function rssOf(pid: number, field: "VmRSS" | "VmHWM"): number {
  return Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) * 1024;
}

describe.runIf(process.platform === "linux")("the renderer's memory for a 40 MiB PDF", () => {
  it("fetched over the bridge and drawn, it grows the renderer by at most 4x its bytes + 48 MiB", async () => {
    policy = WINDOW_POLICY;
    const context = await browser!.newContext();
    const page = await context.newPage();
    await bridged(page);
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
    const cdp = await browser!.newBrowserCDPSession();
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number }> };
    const renderers = processInfo.filter((p) => p.type === "renderer").map((p) => p.id);
    for (const pid of renderers) writeFileSync(`/proc/${pid}/clear_refs`, "5");
    const before = new Map(renderers.map((pid) => [pid, rssOf(pid, "VmRSS")]));
    const result = await page.evaluate((id) => (window as unknown as { rig: Rig }).rig.open(id), PDF40_ID);
    const growth = Math.max(...renderers.map((pid) => rssOf(pid, "VmHWM") - before.get(pid)!));
    await cdp.detach();
    await context.close();
    process.stderr.write(`[renderer-memory] 40 MiB PDF, bridge + pdf.js worker: renderer peak RSS +${(growth / MIB).toFixed(1)} MiB\n`);
    expect(result).toMatchObject({ size: PDF40.length, type: "application/pdf", pages: 1, px: [204, 26, 26, 255] });
    expect(growth, `the 40 MiB PDF grew the renderer by ${(growth / MIB).toFixed(1)} MiB`).toBeLessThan(4 * PDF40.length + 48 * MIB);
  }, 120_000);
});
