import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * SETTINGS AND COMPOSE STAY OUT OF THE FIRST-PAINT BUNDLE. The /mailbox first
 * load measured 563 kB with both panes compiled in; they are `React.lazy` now, behind their
 * existing `effectiveView` seams. A byte pin shifts under every unrelated change, so the guard
 * is structural: on the STATIC import graph walked from `AppShell.tsx`, neither view module is
 * reachable — a dynamic `import()` is deliberately not an edge (it IS the seam), and type-only
 * imports are erased. The walker is proved on a subject that HAS the property: the statically
 * mounted `ScreenerView` must be REACHED, or the refusals below pass by blindness.
 * Mutation watch: turn either lazy factory back into a static import and this reds.
 */

/*
 * RE-POINTED TO THE NEW SHELL (RULING-NEW-SHELL-FIRST D (3)): every browser host mounts ONE component, `MailFrame` of
 * `shell/browser-mail.tsx`, and the panes it draws are the new tree's: the walk starts there and follows the
 * workspace's packages by their manifests' `ohmail-source` export as well as relative paths (today's shell lived
 * in this app alone, so its walk stopped at the app's border; the new shell's parts live in `packages/`). The
 * panes are Settings' columns and Write's letter
 * (`packages/app/src/write/Letter.tsx`); the editor is Write's (`packages/app/src/write/editor/RichEditor.tsx`).
 */
const APP = resolve(__dirname, "../app");
const REPO = resolve(__dirname, "../../..");
const ROOT = resolve(APP, "shell/browser-mail.tsx");
const APP_SRC = resolve(REPO, "packages/app/src");

/** Static value edges of one module: `import … from`, `import "x"`, `export … from`. */
function staticEdges(file: string): string[] {
  const src = withoutComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/g)) {
    if (/^type\s/.test(m[2]!.trim())) continue; // `import type` / `export type` — erased
    out.push(m[3]!);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/** The `import("x")` edges of one module: the seam itself, never followed by the first-paint walk. */
function dynamicEdges(file: string): string[] {
  const src = withoutComments(readFileSync(file, "utf8"));
  return [...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
}

/** A workspace package's folder by its name (`@ohmail/app` → `packages/app`), read from the manifests once. */
const PACKAGES = new Map<string, string>();
for (const top of ["packages", "apps"]) {
  for (const entry of readdirSync(resolve(REPO, top), { withFileTypes: true })) {
    const manifest = resolve(REPO, top, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
    if (name) PACKAGES.set(name, resolve(REPO, top, entry.name));
  }
}

/** Where a package's subpath export lands in its source (`ohmail-source`, else `default`), or null. */
function exportOf(spec: string): string | null {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const folder = PACKAGES.get(name);
  if (folder === undefined) return null; // a package from outside the workspace: not ours to walk
  const manifest = JSON.parse(readFileSync(resolve(folder, "package.json"), "utf8")) as { exports?: unknown };
  const sub = `.${spec.slice(name.length)}`;
  const entry = (manifest.exports as Record<string, unknown> | undefined)?.[sub];
  const target = typeof entry === "string"
    ? entry
    : (entry as Record<string, unknown> | undefined)?.["ohmail-source"] ?? (entry as Record<string, unknown> | undefined)?.default;
  return typeof target === "string" ? resolve(folder, target) : null;
}

/** A specifier's module file, or null for anything the walk does not follow. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (/\.(css|json|svg|png)$/.test(spec)) return null;
  let base: string | null;
  if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  else if (spec.startsWith("@/")) base = resolve(REPO, "apps/webapp", spec.slice(2).replace(/\.js$/, ""));
  else base = exportOf(spec);
  if (base === null || !base.startsWith(REPO)) return null;
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function reachable(): Set<string> {
  const seen = new Set<string>([ROOT]);
  const queue = [ROOT];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const spec of staticEdges(file)) {
      const next = resolveSpec(file, spec);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("the first-paint bundle defers the Settings and Compose panes and the editor", () => {
  const graph = reachable();

  it("walks: the statically mounted ScreenerView is reached (the walker's positive control)", () => {
    /* Re-pointed: the place every host draws at once is the Ohbox's seat. */
    expect(graph.has(resolve(APP_SRC, "ohbox/Seat.tsx"))).toBe(true);
    // A one-file graph would pass the two refusals below by blindness.
    expect(graph.size).toBeGreaterThan(50);
  });

  it("neither lazy pane is statically reachable from the shell", () => {
    expect(graph.has(resolve(APP_SRC, "settings/place.tsx"))).toBe(false);
    expect(graph.has(resolve(APP_SRC, "settings/SettingsList.tsx"))).toBe(false);
    expect(graph.has(resolve(APP_SRC, "settings/SettingsReading.tsx"))).toBe(false);
    expect(graph.has(resolve(APP_SRC, "write/Letter.tsx"))).toBe(false);
  });

  /* The editor is the third deferral, and the cheap reader of it: the editor's own module — and with it TipTap and
     ProseMirror — is reached by a dynamic import or not at all. Re-pointed: today's one door was
     the editor's former lazy entry. The shared Write entry is the module the walk reaches that imports the editor by
     `import()`. The manifest reader in `first-load-defers-editor.test.ts` is the one that measures the built chunks. */
  it("the editor is behind its door, not statically reachable from the shell", () => {
    const EDITOR = resolve(APP_SRC, "write/editor/RichEditor.tsx");
    const doors = [...graph].filter((file) => dynamicEdges(file).some((spec) => {
      const target = resolveSpec(file, spec);
      return target === EDITOR || target === resolve(APP_SRC, "write/editor/index.ts");
    }));
    expect(doors.length, "no module the first paint reaches opens the editor by import()").toBeGreaterThan(0);
    expect(graph.has(EDITOR)).toBe(false);
  });
});
