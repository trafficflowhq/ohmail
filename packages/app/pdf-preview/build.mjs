import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Script } from "node:vm";
import { join } from "node:path";

export const PDF_FRAME_PATH = "/pdf-preview.html";
export const PDF_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; font-src blob: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";

const hash = (source) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
const base64 = (root, ...file) => readFileSync(join(root, ...file)).toString("base64");

/** A self-contained document. No script, worker or font request leaves the renderer. */
export function buildPdfFrame(pdfjsRoot) {
  const library = readFileSync(join(pdfjsRoot, "build/pdf.min.mjs"), "utf8").replace(/\r\n/g, "\n");
  const moduleWorker = readFileSync(join(pdfjsRoot, "build/pdf.worker.min.mjs"), "utf8");
  // Opaque frames can start their own classic blob workers. The pinned build is self-contained;
  // the final export is unused and self.location supplies the classic worker's script URL.
  const unexported = moduleWorker.replace(
    /export\{[^{}]+\};?\s*(?:\/\/# sourceMappingURL=[^\r\n]*)?\s*$/,
    "",
  );
  if (unexported === moduleWorker) throw new Error("PDF worker export changed");
  const classicWorker = unexported.replaceAll("import.meta.url", "self.location.href");
  new Script(classicWorker);
  const worker = Buffer.from(classicWorker).toString("base64");
  const names = readdirSync(join(pdfjsRoot, "standard_fonts")).sort();
  const fonts = Object.fromEntries(
    names
      .filter((name) => /\.(pfb|ttf)$/.test(name))
      .map((name) => [name, base64(pdfjsRoot, "standard_fonts", name)]),
  );
  const licences = names
    .filter((name) => name.startsWith("LICENSE"))
    .map((name) => readFileSync(join(pdfjsRoot, "standard_fonts", name), "utf8"))
    .join("\n");
  const runner = readFileSync(new URL("./frame.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const script = `${runner}\nstartPdfFrame(window, ${JSON.stringify(worker)}, ${JSON.stringify(fonts)});`;
  const meta = PDF_FRAME_CSP.split("; ")
    .filter((part) => !/^(sandbox|frame-ancestors)\b/.test(part))
    .join("; ")
    .replace("'unsafe-inline'", `${hash(library)} ${hash(script)}`);
  if (/<\/script/i.test(library) || /<\/script/i.test(script)) throw new Error("Invalid PDF renderer script");
  return `<!doctype html><html><head><meta charset="utf-8"><title>PDF</title>
<meta http-equiv="Content-Security-Policy" content="${meta}">
<style>html,body{height:100%;margin:0}body{display:flex;justify-content:center;align-items:flex-start}canvas{display:block;max-width:100%;max-height:100%;object-fit:contain}</style>
</head><body><canvas></canvas><script type="module">${library}</script><script type="module">${script}</script>
<!-- ${licences.replace(/-->/g, "-- >")} --></body></html>`;
}
