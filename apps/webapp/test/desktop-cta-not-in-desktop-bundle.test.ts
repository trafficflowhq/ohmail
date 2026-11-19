import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

/** The signed-in browser offers the latest release. The native entry must omit that
 * address from its shipped bundle, including any lazily loaded app modules. */
const WEB_ENTRY = resolve(__dirname, "../app/(product)/mailbox/CloudShell.tsx");
const DESKTOP_ENTRY = resolve(__dirname, "../../desktop/src/main.tsx");
const RELEASE_PAGE = "github.com/trafficflowhq/ohmail/releases/latest";

/** The app's own relative graph; every package stays external (as in first-load-defers-editor). */
const appGraph: Plugin = {
  name: "app-graph",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (/\.(css|json|svg|png|webp|ico)$/.test(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith(".")) {
        const base = resolve(dirname(args.importer), args.path.replace(/\.js$/, ""));
        for (const c of [`${base}.tsx`, `${base}.ts`, base, `${base}/index.ts`, `${base}/index.tsx`]) {
          if (existsSync(c) && /\.(tsx?|jsx?|mjs)$/.test(c)) return { path: c };
        }
      }
      return { path: args.path, external: true };
    });
  },
};

async function bundleText(desktop: boolean): Promise<string> {
  const out = await build({
    entryPoints: [desktop ? DESKTOP_ENTRY : WEB_ENTRY],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    outdir: resolve(__dirname, "__desktop_cta__"),
    write: false,
    minify: true,
    logLevel: "silent",
    jsx: "automatic",
    loader: { ".ts": "ts", ".tsx": "tsx" },
    define: desktop ? { "process.env.NEXT_PUBLIC_DESKTOP": JSON.stringify("1") } : {},
    plugins: [appGraph],
  });
  return (out.outputFiles ?? []).map((f) => f.text).join("\n");
}

describe("the desktop prompt's release-page address stays out of the desktop build", () => {
  it("the web build carries it (the control: the prompt still has somewhere to go)", async () => {
    expect((await bundleText(false)).includes(RELEASE_PAGE), "the web build lost the release page").toBe(true);
  }, 120_000);

  it("the desktop window build does not", async () => {
    const text = await bundleText(true);
    expect(text.length, "the build emitted nothing").toBeGreaterThan(10_000);
    expect(text.includes(RELEASE_PAGE), "the desktop build carries the release page").toBe(false);
  }, 120_000);
});
