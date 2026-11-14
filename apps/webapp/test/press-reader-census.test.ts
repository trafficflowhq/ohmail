import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pressReaderSites } from "../../../scripts/lib/press-readers.mjs";

/**
 * EVERY PRESS READER ON THE WEB, CLASSIFIED — the phone's census over this root. A press a newer
 * one replaced settles `superseded` and must say nothing: `says-done` sites carry a `superseded`
 * arm, `via-pressVerdict` sites read the one reading, `refusal-only` sites speak only for a
 * refusal. A new `mutate(`/`dispatch(` site whose status meets a literal is classified here.
 */
const ROOT = resolve(__dirname, "..");
const SITES: Record<string, ReadonlyArray<"refusal-only" | "says-done" | "via-pressVerdict">> = {
  "app/shell/compose-autosave.ts": ["refusal-only"],     // a refused save keeps the composer open
  "../../packages/app-logic/src/press/delete-undo.ts": ["refusal-only"],          // counts refusals and waits, says neither else
  "app/shell/mail-send.ts": ["refusal-only"],            // `absorb` reads the send's own outcome
  "../../packages/app-logic/src/press/press-verdict.ts": ["says-done"],           // moveInBatches — the moved count
  "app/shell/reply-autosave.ts": ["refusal-only"],       // a refused save ends the attempt
  "app/shell/screener-state.ts": [
    "via-pressVerdict", "via-pressVerdict",
    "refusal-only",     // the rule press's refusal capture
    "refusal-only",     // allowScreened — said at the press, refused after
    "refusal-only",     // not spam — said at the press, refused after
  ],
  "app/shell/shell-compose.ts": [
    "says-done",        // schedule cancel
    "says-done",        // resolve
    "says-done",        // resolve before a send again
    "via-pressVerdict", // discard
  ],
};

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (n === "node_modules") return [];
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
});

describe("the web's press readers", () => {
  it("every site is classified, in order, and every says-done site carries a superseded arm", () => {
    const found: Record<string, string[]> = {};
    for (const f of [...walk(join(ROOT, "app")), ...walk(join(ROOT, "../../packages/app-logic/src"))]) {
      const sites = pressReaderSites(readFileSync(f, "utf8"));
      if (sites.length === 0) continue;
      const rel = relative(ROOT, f);
      const table = SITES[rel] ?? [];
      found[rel] = sites.map((s, i) => {
        const cls = table[i] ?? "unclassified";
        if (cls === "says-done" && !s.superseded) return `${rel}:${s.line} says done with no superseded arm`;
        if (cls === "via-pressVerdict" && !s.viaVerdict) return `${rel}:${s.line} is not read through pressVerdict`;
        return cls;
      });
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, [...v]])));
  });

  /** THE CONTROL: moveInBatches before the fix counted a replaced move as moved. */
  it("reads the old moveInBatches as a says-done site with no superseded arm", () => {
    const before = `export async function moveInBatches(ids, folder, dispatch) {
      const outs = await Promise.all(ids.map((messageId) => dispatch({ kind: "move", messageId, folder })));
      for (const o of outs) {
        if (o.status === "rolled_back") tally.refused++;
        else tally.moved++;
      }
    }`;
    expect(pressReaderSites(before)).toEqual([{ line: 2, superseded: false, viaVerdict: false }]);
  });
});
