import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * NO SURFACE DECIDES PLACEMENT (owner 2026-10-07). An open read is `mark_seen.openRead`, and
 * `Engine.enrich` alone sets it — from the held row and the ids' conversations. A surface that put
 * the flag on its own literal would place rows by its own rule, which is the device-dependent order
 * the 2026-09-18 ruling ended. Parsed for the CALL: every object literal carrying
 * `kind: "mark_seen"` under the app sources and the engine's own `src`, `engine.ts` excepted, is
 * walked by brace and refused if it names `openRead`. (`enrich` also strips a passed flag.)
 */
const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const ROOTS = [
  "apps/webapp/app", "packages/app-logic/src", "apps/mobile/src", "apps/desktop/src", "apps/sidecar/src", "packages/client-engine/src", "packages/ui/src",
];
const EXEMPT = new Set(["packages/client-engine/src/engine.ts"]);

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) sources(p, into);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) into.push(p);
  }
  return into;
}

/** Every `{ … kind: "mark_seen" … }` literal in `src` that names `openRead`, as `line` numbers; and the count read. */
function flaggedMarkSeen(src: string): { literals: number; flagged: number[] } {
  const text = withoutComments(src);
  const blank = withoutCommentsAndLiterals(src);
  const out: number[] = [];
  let literals = 0;
  const re = /\bkind\s*:\s*"mark_seen"\s*[,}]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 0;
    let open = -1;
    for (let j = m.index - 1; j >= 0; j--) {
      if (blank[j] === "}") depth++;
      else if (blank[j] === "{") { if (depth === 0) { open = j; break; } depth--; }
    }
    if (open < 0) continue;
    const s = bracketSpan(blank, open, "{", "}");
    literals++;
    if (/\bopenRead\b/.test(text.slice(s.start, s.end))) out.push(lineOf(src, m.index));
  }
  return { literals, flagged: out };
}

describe("no surface passes the open-read flag", () => {
  it("the planted controls: a flagged literal is refused, a plain one and a comment are not", () => {
    expect(flaggedMarkSeen(`void e.mutate({ kind: "mark_seen", messageIds: ids, unread: false, openRead: true });`).flagged).toEqual([1]);
    expect(flaggedMarkSeen(`const m = {\n  kind: "mark_seen",\n  ...base,\n  openRead: true,\n};`).flagged).toEqual([2]);
    expect(flaggedMarkSeen(`void e.mutate({ kind: "mark_seen", messageIds: ids, unread: false, via: "glance" });`)).toEqual({ literals: 1, flagged: [] });
    expect(flaggedMarkSeen(`// { kind: "mark_seen", openRead: true }\nconst x = 1;`)).toEqual({ literals: 0, flagged: [] });
  });

  it("every mark_seen literal outside engine.ts carries no openRead — and the scan found them", () => {
    let literals = 0;
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(join(REPO, root))) {
        const rel = relative(REPO, file);
        if (EXEMPT.has(rel)) continue;
        const r = flaggedMarkSeen(readFileSync(file, "utf8"));
        literals += r.literals;
        for (const line of r.flagged) offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
    // The web shell, the phone, the read-all door, the screener and the undo all build one.
    expect(literals, "a scan that found no literal measured nothing").toBeGreaterThanOrEqual(6);
  });
});
