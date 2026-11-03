import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

type Browser = Awaited<ReturnType<typeof import("@playwright/test").chromium.launch>>;

/**
 * THE VENDORED PDF WORKER MUST MATCH THE INSTALLED pdfjs-dist, OR PDF PREVIEW BREAKS SILENTLY.
 *
 * `AttachmentPreview` renders PDFs with pdf.js and points `workerSrc` at a worker committed to
 * `public/pdf.worker.min.mjs` (webpack cannot bundle the `.mjs` worker, and a CDN is refused by
 * `worker-src 'self'`). pdf.js throws on a main-thread/worker VERSION MISMATCH, so a bump of the
 * `pdfjs-dist` dependency without recopying the worker would break every PDF preview on the live
 * host while every unit test stayed green. This is that guard: bump the dep, this goes red until
 * the worker is recopied.
 */
describe("the vendored pdf.js worker", () => {
  it("is the exact version of the installed pdfjs-dist", () => {
    const require = createRequire(import.meta.url);
    const installed = require("pdfjs-dist/package.json").version as string;

    const workerPath = fileURLToPath(new URL("../public/pdf.worker.min.mjs", import.meta.url));
    const worker = readFileSync(workerPath, "utf8");
    const stamped = /pdfjsVersion = ([0-9][0-9.]*)/.exec(worker)?.[1];

    expect(stamped, "public/pdf.worker.min.mjs carries no version stamp").toBeTruthy();
    expect(
      stamped,
      `worker is ${stamped}, pdfjs-dist is ${installed} — recopy build/pdf.worker.min.mjs into public/`,
    ).toBe(installed);
  });

  /* The file is published as upstream's build, byte for byte, and no content gate reads it: the
   * bytes ARE the review. A worker edited by hand, or copied from another build, reddens here. */
  it("is byte for byte the installed pdfjs-dist build", () => {
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve("pdfjs-dist/package.json"));
    const upstream = readFileSync(join(pkg, "build", "pdf.worker.min.mjs"));
    const ours = readFileSync(fileURLToPath(new URL("../public/pdf.worker.min.mjs", import.meta.url)));
    expect(ours.equals(upstream), "recopy build/pdf.worker.min.mjs from pdfjs-dist into public/").toBe(true);
  });
});

/**
 * A PDF SET IN AN UNEMBEDDED STANDARD FONT DRAWS ITS TEXT. Helvetica, Times and Courier are rarely
 * embedded; left to the machine's fonts, a browser with none of them drew the page and no words. The
 * preview reads pdf.js's own standard font data from `public/pdfjs/standard_fonts/` instead, on this
 * origin, which the build copies there (`copyStandardFonts`, next.config.mjs). The render runs in
 * Chromium with no system fonts at all, over what that copy writes.
 */
describe("pdf.js standard font data, copied by the build", () => {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("pdfjs-dist/package.json"));
  let ours = "";

  beforeAll(async () => {
    ours = mkdtempSync(join(tmpdir(), "ohmail-standard-fonts-"));
    const { copyStandardFonts } = await import("../next.config.mjs");
    copyStandardFonts(ours);
  });
  afterAll(() => { if (ours) rmSync(ours, { recursive: true, force: true }); });

  it("is byte for byte the installed pdfjs-dist's, every file and its licences", () => {
    const upstream = readdirSync(join(pkg, "standard_fonts")).sort();
    expect(upstream).toContain("LiberationSans-Regular.ttf");
    expect(readdirSync(ours).sort()).toEqual(upstream);
    for (const f of upstream) {
      expect(readFileSync(join(ours, f)).equals(readFileSync(join(pkg, "standard_fonts", f))), f).toBe(true);
    }
  });

  describe.runIf(process.platform === "linux")("in a browser with no fonts installed", () => {
    let browser: Browser | null = null;
    let server: Server | null = null;
    let origin = "";
    let rig = "";
    const fontsAsked: string[] = [];
    let dir = "";

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "ohmail-pdf-fonts-"));
      const { build } = await import("esbuild");
      await build({
        stdin: {
          contents: `import { openOverPort, STANDARD_FONTS } from "./pdf-port";
            window.ink = async (b64, fonts) => {
              const load = () => import("/pdf.min.mjs");
              const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              const task = openOverPort(load, () => "/pdf.worker.min.mjs", { data, ...(fonts ? STANDARD_FONTS : {}) });
              const doc = await task.promise;
              const page = await doc.getPage(1);
              const viewport = page.getViewport({ scale: 1 });
              const canvas = document.createElement("canvas");
              canvas.width = viewport.width; canvas.height = viewport.height;
              const ctx = canvas.getContext("2d");
              await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
              const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let ink = 0;
              for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] < 128) ink += 1;
              await task.destroy();
              return ink;
            };`,
          resolveDir: join(process.cwd(), "apps/webapp/app/components"), loader: "ts", sourcefile: "rig.ts",
        },
        bundle: true, format: "esm", platform: "browser", target: ["es2022"], outfile: join(dir, "rig.js"),
        external: ["/pdf.min.mjs"], logLevel: "warning",
      });
      rig = readFileSync(join(dir, "rig.js"), "utf8");
      const files: Record<string, string> = {
        "/pdf.min.mjs": join(pkg, "build", "pdf.min.mjs"),
        "/pdf.worker.min.mjs": fileURLToPath(new URL("../public/pdf.worker.min.mjs", import.meta.url)),
      };
      server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/") {
          res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'; connect-src 'self'; worker-src 'self'" });
          res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/rig.js"></script>');
        } else if (path === "/rig.js" || files[path]) {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(path === "/rig.js" ? rig : readFileSync(files[path]!));
        } else if (path.startsWith("/pdfjs/standard_fonts/") && existsSync(join(ours, basename(path)))) {
          fontsAsked.push(basename(path));
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(readFileSync(join(ours, basename(path))));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
      const address = server.address();
      origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const conf = join(dir, "fonts.conf");
      writeFileSync(conf, '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig></fontconfig>\n');
      const { chromium } = createRequire(join(process.cwd(), "package.json"))("@playwright/test") as typeof import("@playwright/test");
      browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: conf } });
    }, 120_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("a page in unembedded Helvetica, Times and Courier draws its words; left to the machine it draws none", async () => {
      const page = await browser!.newPage();
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => typeof (window as unknown as { ink?: unknown }).ink === "function");
      for (const font of ["Helvetica", "Times-Roman", "Courier"]) {
        const b64 = textPdf(font).toString("base64");
        const ink = (fonts: boolean) => page.evaluate(([b, f]) => (window as unknown as { ink: (b: string, f: boolean) => Promise<number> }).ink(b as string, f as boolean), [b64, fonts] as const);
        expect(await ink(false), `${font}: the instrument sees words with no font to draw them`).toBe(0);
        expect(await ink(true), `${font}: the preview drew no words`).toBeGreaterThan(200);
      }
      expect(fontsAsked).toEqual(["LiberationSans-Regular.ttf", "FoxitSerif.pfb", "FoxitFixed.pfb"]);
      await page.close();
    }, 60_000);
  });
});

/** A one-page PDF with one line of text in an unembedded base-14 font. */
function textPdf(font: string): Buffer {
  const content = "BT /F1 36 Tf 20 100 Td (Hello World) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
