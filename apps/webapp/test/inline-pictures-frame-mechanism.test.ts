import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHARED_CSP_DIRECTIVES } from "../app/security-headers";

/**
 * THE READER'S FRAME DRAWS A PICTURE ITS WINDOW MINTED — in Chromium (WebView2, Chrome) and WebKit
 * (WKWebView, WebKitGTK, Safari). A browser door hands the frame each embedded picture as the object
 * URL its window minted. The frame can read one only because it shares the window's origin
 * (`allow-same-origin` in `FRAME_SANDBOX`, no scripts) and its policy names `blob:`; the two
 * controls take each away and the picture must not draw. Page: `inline-frame/entry.ts` (the real
 * sanitizer, document and sandbox), under the web app's and each desktop window's own policy.
 * Read by pixels as well as by `naturalWidth`: an opaque frame cannot be asked.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const pw = require_("@playwright/test") as typeof import("@playwright/test");
type Browser = Awaited<ReturnType<typeof pw.chromium.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const ROOT = process.cwd();
const ORIGIN = "https://app.ohmail.test";

/** A desktop window's policy as its document carries it: the config's, less `frame-ancestors`. */
const desktopPolicy = (file: string): string =>
  (JSON.parse(readFileSync(join(ROOT, "apps/desktop/src-tauri", file), "utf8")) as { app: { security: { csp: string } } })
    .app.security.csp.split("; ").filter((d) => !d.startsWith("frame-ancestors ")).join("; ");
const POLICIES: Record<string, string> = {
  "the web app's": [...SHARED_CSP_DIRECTIVES.filter((d) => !d.startsWith("frame-ancestors ")), "script-src 'self'"].join("; "),
  "the Linux window's": desktopPolicy("tauri.linux.conf.json"),
  "the Windows window's": desktopPolicy("tauri.windows.conf.json"),
};

function chunk(tag: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

/** A 32x32 PNG of pure red: a drawn picture is 1024 red pixels in the frame's screenshot. */
function redPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 }, () => [255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array.from({ length: 32 }, () => row));
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = [...redPng()];

let bundle = "";
const dirs: string[] = [];
beforeAll(async () => {
  const { build } = await import("esbuild");
  const out = mkdtempSync(join(tmpdir(), "ohmail-inline-frame-"));
  dirs.push(out);
  await build({
    entryPoints: [join(ROOT, "apps/webapp/test/inline-frame/entry.ts")],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic", outdir: out,
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty", ".json": "json" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
    logLevel: "warning",
  });
  bundle = readFileSync(join(out, "entry.js"), "utf8");
}, 120_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Arm { carrier: "blob" | "data"; sandbox?: string; policyWithoutBlob?: boolean }
type Rig = {
  mount: (png: number[], arm: Arm) => Promise<{ written: boolean; policy: string | null; sandbox: string; naturalWidth: number | null }>;
  mountAsk: (arm: boolean) => Promise<{
    asks: string[]; href: string | null; marked: boolean; at: Record<"ask" | "honest", { x: number; y: number }>;
  }>;
  redPixels: (b64: string) => Promise<number>;
  FRAME_SANDBOX: string;
};

async function open(browser: Browser, policy: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    if (new URL(route.request().url()).pathname === "/rig.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><body></body><script src="/rig.js"></script>`,
    });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => typeof (window as unknown as { rig?: unknown }).rig === "object");
  return page;
}

async function arm(page: Page, a: Arm) {
  const result = await page.evaluate(([png, x]) => (window as unknown as { rig: Rig }).rig.mount(png as number[], x as Arm), [PNG, a] as const);
  const shot = await page.locator("iframe").screenshot();
  const red = await page.evaluate((b64) => (window as unknown as { rig: Rig }).rig.redPixels(b64), shot.toString("base64"));
  return { result, red };
}

const ENGINES = [["chromium", pw.chromium], ["webkit", pw.webkit]] as const;
for (const [name, engine] of ENGINES) {
  const present = existsSync(engine.executablePath());
  describe.runIf(present)(`${name}: the reader's frame and a picture its window minted`, () => {
    let browser: Browser | null = null;
    beforeAll(async () => { browser = await engine.launch(); }, 120_000);
    afterAll(async () => { await browser?.close(); });

    for (const [label, policy] of Object.entries(POLICIES)) {
      it(`${label} policy: drawn in the reader's frame; not without allow-same-origin, not without blob: in its policy`, async () => {
        const page = await open(browser!, policy);
        const reader = await page.evaluate(() => (window as unknown as { rig: Rig }).rig.FRAME_SANDBOX);
        expect(reader.split(" ")).toContain("allow-same-origin");

        const drawn = await arm(page, { carrier: "blob" });
        expect(drawn.result).toMatchObject({ written: true, policy: "img-src data: blob:", sandbox: reader, naturalWidth: 32 });
        expect(drawn.red, "the minted picture did not draw in the reader's frame").toBeGreaterThan(900);

        const opaque = reader.split(" ").filter((t) => t !== "allow-same-origin").join(" ");
        const control = await arm(page, { carrier: "blob", sandbox: opaque });
        expect(control.result).toMatchObject({ written: true, sandbox: opaque, naturalWidth: null });
        expect(control.red, "a frame of another origin drew the window's picture").toBe(0);

        const unlisted = await arm(page, { carrier: "blob", policyWithoutBlob: true });
        expect(unlisted.result).toMatchObject({ written: true, policy: "img-src data:", naturalWidth: 0 });
        expect(unlisted.red, "the frame drew a blob: its policy does not name").toBe(0);

        const data = await arm(page, { carrier: "data" });
        expect(data.result).toMatchObject({ written: true, naturalWidth: 32 });
        expect(data.red, "the instrument cannot see a drawn picture").toBeGreaterThan(900);
        process.stderr.write(`[inline-frame] ${name}, ${label} policy: red pixels drawn ${drawn.red}, ` +
          `no allow-same-origin ${control.red}, no blob: in the policy ${unlisted.red}, data: ${data.red}\n`);
        await page.context().close();
      }, 60_000);
    }

    /* THE WEB ASKS OUTSIDE THE LETTER (`link-ask.ts`). A marked link reaches the frame with no
       address; once armed, its press opens ohmail's own page in a new tab under the frame's sandbox,
       naming the real host and holding the one link there. Mutations: the arming removed → no tab
       opens; the address left on the link → the press opens the destination itself. */
    it("the web app's policy: an armed marked link opens ohmail's page naming the real host; an honest one opens; unarmed, nothing", async () => {
      const page = await open(browser!, POLICIES["the web app's"]!);
      const context = page.context();
      await context.route("https://elsewhere.ohmail.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Elsewhere</title><p>The page.</p>" }));
      const errors: string[] = [];
      const watch = (p: Page): void => {
        p.on("console", (m) => { if (m.type() === "error") errors.push(`${p.url()}: ${m.text()}`); });
        p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`));
      };
      watch(page);
      context.on("page", watch);
      const asked: string[] = [];
      context.on("request", (r) => asked.push(r.url()));
      const rig = (arm: boolean) => page.evaluate((a) => (window as unknown as { rig: Rig }).rig.mountAsk(a), arm);
      // A real press, where the link stands: nothing is run inside the frame, which has no scripts.
      const press = async (at: { x: number; y: number }): Promise<Page | null> => {
        const opened = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
        await page.mouse.click(at.x, at.y);
        const tab = await opened;
        await tab?.waitForLoadState("domcontentloaded");
        return tab;
      };

      const unarmed = await rig(false);
      expect({ ...unarmed, at: undefined }).toEqual({ asks: ["https://evil.ohmail.test/x?n=1"], href: null, marked: true, at: undefined });
      expect(await press(unarmed.at.ask), "a marked link opened something before it was armed").toBeNull();

      const armed = await rig(true);
      expect(armed.href).toMatch(/^blob:/);
      const ask = await press(armed.at.ask);
      expect(ask, "the armed link opened no tab").not.toBeNull();
      const askedAt = ask!.url();
      expect(askedAt).toMatch(/^blob:/);
      const said = await ask!.locator("body").innerText();
      expect(said).toContain("It goes to evil.ohmail.test.");
      expect(said).toContain("https://evil.ohmail.test/x?n=1");
      expect(said, "the ask page named the decoy").not.toContain("bank.ohmail.test");
      expect(await ask!.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))
        .toEqual(["https://evil.ohmail.test/x?n=1"]);
      await ask!.close();

      const honest = await press(armed.at.honest);
      expect(honest?.url()).toBe("https://elsewhere.ohmail.test/page");
      await honest?.close();

      expect(errors).toEqual([]);
      const fetched = asked.filter((u) => !/^(?:blob|data):/.test(u) && !u.startsWith(ORIGIN) && !u.startsWith("https://elsewhere.ohmail.test/"));
      expect(fetched, "the ask fetched something").toEqual([]);
      process.stderr.write(`[inline-frame] ${name}: the armed marked link opened ${askedAt.slice(0, 5)}… and the honest one its page\n`);
      await context.close();
    }, 60_000);
  });
}
