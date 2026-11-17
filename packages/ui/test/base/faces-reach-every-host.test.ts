/**
 * THE DESIGN'S FACES COME WITH THE KIT. The kit's base door is the entry every host draws the new design through, so
 * bundling it brings the design's typefaces: each font file the tokens package registers, emitted beside the bundle
 * byte for byte and named by its stylesheet. The web (Next's webpack) and the phone's page (esbuild) resolve the font
 * sheet by the tokens package's exports and a `url()` inside it beside the sheet; the desktop's window and the paired
 * page (one Vite config) by the desktop's alias list, which the desktop's own shell test walks with the real config.
 * Without it every word is drawn in a fallback face: the app's `document.fonts` held 0 faces against the demo's 6.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
/** The tokens package's register of its font files (generated from its fonts source), each with its sha256. */
type Register = { fonts: { family: string; files: { file: string; sha256: string }[] }[] };
const registered = async () =>
  ((await import(resolve(ROOT, "packages/tokens/src/design/fonts.ts"))) as Register).fonts.flatMap(
    (face) => face.files,
  );
/** A bundled file's name without the hash the bundler gives it. */
const unhashed = (path: string) => basename(path).replace(/-[A-Z0-9]+\.woff2$/, ".woff2");

describe("the kit's base door brings the design's faces", () => {
  it("the font sheet resolves by the tokens package's exports, as the web's and the phone's bundlers resolve it", () => {
    const from = createRequire(resolve(ROOT, "packages/ui/package.json"));
    expect(realpathSync(from.resolve("@ohmail/tokens/design/fonts.css"))).toBe(
      resolve(ROOT, "packages/tokens/src/design/fonts.css"),
    );
  });

  it("bundled as the phone's page bundles it, the door emits every registered font file and its stylesheet names each", async () => {
    const files = await registered();
    const out = await build({
      entryPoints: [resolve(ROOT, "packages/ui/src/base/index.ts")],
      bundle: true,
      write: false,
      outdir: resolve(ROOT, "faces-out"),
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      conditions: ["ohmail-source"],
      external: ["react", "react-dom", "react/jsx-runtime"],
      loader: { ".woff2": "file" },
      assetNames: "assets/[name]-[hash]",
      logLevel: "silent",
    });
    const fonts = out.outputFiles.filter((f) => f.path.endsWith(".woff2"));
    const css = out.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("\n");
    expect(files).toHaveLength(6);
    expect(
      Object.fromEntries(
        fonts.map((f) => [unhashed(f.path), createHash("sha256").update(f.contents).digest("hex")]),
      ),
    ).toEqual(Object.fromEntries(files.map(({ file, sha256 }) => [file, sha256])));
    for (const font of fonts) expect(css, font.path).toContain(`./assets/${basename(font.path)}`);
  });
});
