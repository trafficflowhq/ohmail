#!/usr/bin/env node
/**
 * build-shell.mjs — THE SHELL'S PAGE, from apps/mobile/web/ into apps/mobile/generated/shell/:
 * `index.html`, `shell.js` (one chunk, addressed relative to the page), `shell.css` when the page
 * imports styles, any file a style names, and `shell.manifest.json`: the page's policy and every
 * file by name and SHA-256. The native module serves only the files the manifest lists, with the
 * policy as a header, and the app's build refuses to package a shell that has no manifest
 * (`plugins/shell-assets.js`).
 *
 *   node apps/mobile/scripts/build-shell.mjs            the page every build ships
 *   node apps/mobile/scripts/build-shell.mjs --bench    with the emulator bench's door compiled in
 *
 * The bundler is the root's pinned esbuild; nothing is fetched. The page's policy has one source,
 * the meta in web/index.html, and the build refuses a page whose policy would let it reach the
 * network, run inline script or frame another page, and a page whose markup carries inline script.
 * A build without --bench refuses a bundle that carries the bench's marker.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, "..");
const WEB = join(MOBILE, "web");
const MESSAGES = join(MOBILE, "..", "..", "packages", "app", "messages");
export const SHELL_OUT = join(MOBILE, "generated", "shell");

/** The marker only the bench's door carries; a release bundle that holds it is refused. */
export const BENCH_MARKER = "ohmail-bench-door";

/**
 * The namespaces of the shared catalogue the page carries: the frame's own and the mailbox sentences its connection
 * line borrows. A place registered on the phone adds the namespaces it reads here, in the same change.
 */
export const PAGE_NAMESPACES = ["frame", "mailboxes"];
/** The module the build makes of the page's sentences from the catalogue's place files; it answers web/src's `./catalogue`. */
const CATALOGUE_MODULE = "ohmail-shell:catalogue";

/** The page's sentences in both languages, each namespace read from the place file that holds it. */
export function pageCatalogue(messages = MESSAGES) {
  const places = JSON.parse(readFileSync(join(messages, "places.json"), "utf8"));
  const out = { en: {}, de: {} };
  for (const ns of PAGE_NAMESPACES) {
    const place = Object.keys(places).find((p) => places[p].includes(ns));
    if (!place) throw new Error(`build-shell: the namespace "${ns}" is in no place of places.json`);
    for (const lang of ["en", "de"]) {
      const file = JSON.parse(readFileSync(join(messages, `${place}.${lang}.json`), "utf8"));
      if (typeof file[ns] !== "object") throw new Error(`build-shell: ${place}.${lang}.json holds no "${ns}"`);
      out[lang][ns] = file[ns];
    }
  }
  return out;
}

/** Answers the page's catalogue import with {@link pageCatalogue}, read at build time. */
const catalogue = {
  name: "shell-catalogue",
  setup(b) {
    b.onResolve({ filter: /^\.\/catalogue$/ }, (args) =>
      args.resolveDir === join(WEB, "src") ? { path: CATALOGUE_MODULE, namespace: "shell-catalogue" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "shell-catalogue" }, () => ({
      contents: `export default ${JSON.stringify(pageCatalogue())};`,
      loader: "js",
    }));
  },
};

/** What the page's policy must say, directive by directive, for the build to ship it. */
const REQUIRED = {
  "default-src": "'self'",
  "script-src": "'self'",
  "connect-src": "'none'",
  "worker-src": "'none'",
  "frame-src": "'none'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'none'",
};

/** The page's policy as web/index.html states it, held to {@link REQUIRED}. */
export function policyOf(html) {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi)];
  if (metas.length !== 1) throw new Error(`build-shell: the page states its policy ${metas.length} times; it must state it once`);
  const policy = metas[0][1].trim();
  const directives = new Map(
    policy.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name.toLowerCase(), values.join(" ")];
    }),
  );
  for (const [name, value] of Object.entries(REQUIRED)) {
    if (directives.get(name) !== value) {
      throw new Error(`build-shell: the page's policy must say "${name} ${value}", and it says "${name} ${directives.get(name) ?? "(nothing)"}"`);
    }
  }
  return policy;
}

/** Inline script in the markup: every <script> must name a file. */
function refuseInlineScript(html) {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc="[^"]+"/.test(m[1]) || m[2].trim() !== "") throw new Error("build-shell: the page carries inline script");
  }
  if (/\son[a-z]+\s*=/i.test(html)) throw new Error("build-shell: the page carries an inline handler");
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export async function buildShell({ out = SHELL_OUT, bench = false } = {}) {
  const template = readFileSync(join(WEB, "index.html"), "utf8");
  const csp = policyOf(template);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await build({
    entryPoints: [join(WEB, "src", "main.tsx")],
    outfile: join(out, "shell.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020", "chrome120", "safari15"],
    jsx: "automatic",
    conditions: ["ohmail-source"],
    define: { "process.env.NODE_ENV": '"production"', __OHMAIL_BENCH__: bench ? "true" : "false" },
    loader: { ".woff2": "file", ".png": "file", ".svg": "file", ".webp": "file" },
    assetNames: "assets/[name]-[hash]",
    minify: true,
    splitting: false,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
    plugins: [catalogue],
  });
  const js = readFileSync(join(out, "shell.js"), "utf8");
  if (!bench && js.includes(BENCH_MARKER)) throw new Error("build-shell: the bench's door is in a release page");
  const styled = Object.keys(result.metafile.outputs).some((f) => f.endsWith("shell.css"));
  const html = template.replace("<!--styles-->", styled ? '<link rel="stylesheet" href="./shell.css">' : "");
  refuseInlineScript(html);
  writeFileSync(join(out, "index.html"), html);
  const files = Object.fromEntries(
    filesUnder(out).map((path) => [relative(out, path).split("\\").join("/"), createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  const manifest = { csp, bench, files };
  writeFileSync(join(out, "shell.manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  /* What went into the bundle, for whoever builds it to read: the manifest ships, this does not. */
  const inputs = Object.keys(result.metafile.inputs).map((p) => relative(join(MOBILE, "..", ".."), p).split("\\").join("/"));
  return { ...manifest, inputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await buildShell({ bench: process.argv.includes("--bench") });
  console.log(`SHELL_BUILT ${Object.keys(manifest.files).length} files into ${relative(process.cwd(), SHELL_OUT) || SHELL_OUT}${manifest.bench ? " (bench)" : ""}`);
}
