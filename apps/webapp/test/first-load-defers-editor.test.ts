import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

/**
 * ═══ THE EDITOR IS NOT IN THE MAILBOX PAGE'S FIRST LOAD ══════════════════════════════════════
 *
 * TipTap and ProseMirror are the heaviest thing the mail client compiles, and nobody sees them at
 * first paint: the composer, the inline reply, the Reply Run and the two signature surfaces are
 * each opened by a press. `RichEditorLazy.tsx` is the one door to them, and with it in place the
 * `/mailbox` route's first load measured 560 kB → 434 kB.
 *
 * ── MEASURED ON A BUILD'S OWN MANIFEST, NEVER ON THE SOURCE ─────────────────────────────────
 *
 * A source walk answers "does this file name that one", which is not the question — webpack can
 * hoist a module into the entry for reasons no import line states. So this builds the shell with
 * code splitting and reads the MANIFEST (esbuild's metafile): the entry chunk plus every chunk it
 * reaches by an `import-statement`, which is exactly what a browser must have before first paint.
 * A `dynamic-import` edge is deliberately not followed — it IS the seam. The build is in memory
 * (`write: false`), so nothing on disk is read or disturbed.
 *
 * ── AND THE CONTROL IS THE SPLIT REVERTED, IN MEMORY ────────────────────────────────────────
 *
 * A guard for an absence goes green when the thing it watches is deleted, so the last case builds
 * the SAME entry with one line transformed into `AppShell.tsx` — a static import of the editor —
 * and asserts the refusal goes red. The injection is a load hook and never touches the tree,
 * because a mutation written to a source file under a running suite is both a false red across
 * the run and a file somebody else may commit.
 */

/*
 * RE-POINTED TO THE NEW SHELL (RULING-NEW-SHELL-FIRST D (3)): every browser host mounts ONE component, `MailFrame`
 * of `shell/browser-mail.tsx`, so the build starts there, and the workspace's own packages are bundled from their
 * source (`ohmail-source`, as the hosts' bundlers read them): the new shell's parts live in `packages/`, where
 * today's lived in this app. The editor is Write's (`packages/app/src/write/editor/`), the panes Settings' place
 * and Write's letter.
 */
const APP = resolve(__dirname, "../app");
const REPO = resolve(__dirname, "../../..");
const ENTRY = resolve(APP, "shell/browser-mail.tsx");

/** The editor's own modules, and the packages only they can pull in. */
const EDITOR = [
  /[/\\]packages[/\\]app[/\\]src[/\\]write[/\\]editor[/\\]RichEditor\.tsx$/,
  /@tiptap[+/]/,
  /[/\\]prosemirror-[a-z-]+[/\\]/,
];

/**
 * The app's own graph, and the editor's packages inside it. Everything else is external: a shell
 * that imports React or the design system says nothing about where the editor lands, and bundling
 * them would measure the wrong tree. `.js` specifiers are this repo's NodeNext spelling of `.ts`
 * sources, mapped here the way the bundler's own config maps them.
 */
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
        return { path: args.path, external: true };
      }
      if (/^@tiptap\//.test(args.path) || /^prosemirror-/.test(args.path)) return null;
      /* The workspace's own packages are the new shell: bundled from source, by their manifests' exports. */
      if (/^@ohmail\//.test(args.path)) return null;
      if (args.path.startsWith("@/")) {
        const base = resolve(REPO, "apps/webapp", args.path.slice(2).replace(/\.js$/, ""));
        for (const c of [`${base}.tsx`, `${base}.ts`, `${base}/index.ts`, `${base}/index.tsx`]) {
          if (existsSync(c)) return { path: c };
        }
      }
      return { path: args.path, external: true };
    });
  },
};

/** One in-memory build of the shell. `inject` adds a static editor import — the control's mutation. */
async function manifest(inject: boolean): Promise<{ statics: string[]; all: string[] }> {
  const plugins: Plugin[] = [appGraph];
  if (inject) {
    plugins.unshift({
      name: "inject-static-editor",
      setup(b) {
        b.onLoad({ filter: /browser-mail\.tsx$/ }, (args) => ({
          contents: `${readFileSync(args.path, "utf8")}\nimport "@ohmail/app/write/editor";\n`,
          loader: "tsx",
        }));
      },
    });
  }
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    outdir: resolve(__dirname, "__manifest__"),
    write: false,
    metafile: true,
    logLevel: "silent",
    jsx: "automatic",
    loader: { ".ts": "ts", ".tsx": "tsx" },
    conditions: ["ohmail-source"],
    plugins,
  });
  const outputs = out.metafile.outputs;
  const entry = Object.keys(outputs).find((k) => outputs[k]!.entryPoint === ENTRY.replace(/\\/g, "/")
    || outputs[k]!.entryPoint?.endsWith("app/shell/browser-mail.tsx"));
  if (entry === undefined) throw new Error("the build emitted no entry chunk for browser-mail.tsx");
  // The chunks a browser must have before first paint: the entry, and everything it reaches by a
  // plain import. `dynamic-import` edges are the seam and stop the walk.
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const imp of outputs[queue.pop()!]!.imports) {
      // An external import names a package, not a chunk — `react` has no output to walk into.
      if (imp.external === true || imp.kind !== "import-statement") continue;
      if (outputs[imp.path] === undefined || seen.has(imp.path)) continue;
      seen.add(imp.path);
      queue.push(imp.path);
    }
  }
  const statics = new Set<string>();
  for (const chunk of seen) for (const input of Object.keys(outputs[chunk]!.inputs)) statics.add(input);
  const all = new Set<string>();
  for (const chunk of Object.keys(outputs)) for (const input of Object.keys(outputs[chunk]!.inputs)) all.add(input);
  return { statics: [...statics], all: [...all] };
}

const hits = (inputs: string[]): string[] => inputs.filter((i) => EDITOR.some((re) => re.test(i)));

describe("the mailbox shell's first load carries no editor", () => {
  let shipped: { statics: string[]; all: string[] };
  beforeAll(async () => { shipped = await manifest(false); }, 120_000);

  it("reads: the statically mounted ScreenerView is in the first-load chunks", () => {
    // Without this the refusals below could pass on an empty or broken manifest. Re-pointed: the place every host
    // draws at once is the Ohbox's seat.
    expect(shipped.statics.some((i) => i.endsWith("packages/app/src/ohbox/Seat.tsx"))).toBe(true);
    expect(shipped.statics.length).toBeGreaterThan(100);
  });

  it("reads: the editor WAS built — it is in the manifest, in a chunk nothing static reaches", () => {
    expect(hits(shipped.all).length).toBeGreaterThan(0);
    expect(shipped.all.some((i) => i.endsWith("packages/app/src/write/editor/RichEditor.tsx"))).toBe(true);
  });

  it("no editor module is in the first-load chunks", () => {
    expect(hits(shipped.statics)).toEqual([]);
  });

  it("neither deferred pane is in the first-load chunks either", () => {
    expect(shipped.statics.some((i) => i.endsWith("packages/app/src/write/Letter.tsx"))).toBe(false);
    expect(shipped.statics.some((i) => i.endsWith("packages/app/src/settings/place.tsx"))).toBe(false);
  });

  it("control: a static editor import in the shell puts it back, and this guard reds", async () => {
    const reverted = await manifest(true);
    expect(hits(reverted.statics).length).toBeGreaterThan(0);
    expect(reverted.statics.some((i) => i.endsWith("packages/app/src/write/editor/RichEditor.tsx"))).toBe(true);
  }, 120_000);
});
