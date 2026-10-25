import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pressReaderSites } from "../../../scripts/lib/press-readers.mjs";

/**
 * EVERY PRESS READER ON THE PHONE, CLASSIFIED. A press a newer one replaced settles `superseded`
 * and must say nothing; a reader that says "done" for whatever is not a refusal says it over the
 * newer press. Each `mutate(`/`dispatch(` call whose result's status meets a literal is a site,
 * in file order: `says-done` sites must carry a `superseded` arm, `via-pressVerdict` sites read
 * the one reading, `refusal-only` sites speak only for a refusal. A new site is classified here.
 */
const ROOT = resolve(__dirname, "..");
const SITES: Record<string, ReadonlyArray<"refusal-only" | "says-done" | "via-pressVerdict">> = {
  "src/state/live.ts": [
    "says-done",        // dispatchHeldRouting — "nothing" when every answer was replaced
    "says-done",        // dispatchDecideCommit — the decision's own answers, "nothing" when replaced
    "via-pressVerdict", // the press dispatcher's one reading
    "says-done",        // moveMessage — toastMoved
    "says-done",        // deleteMessage — toastDeleted
    "says-done",        // cancelSchedule — scheduleCancelled / liveSaveFailed
    "says-done",        // draftResolve — draftsResolveFailed
    "refusal-only",     // keepChangedWords — the words a changed row refused, kept as a new row; `null` on a refusal
    "says-done",        // compose keep — composeKept
  ],
  "src/state/sender-stayed.ts": [
    "says-done",        // moveStayedInBatches — the moved count
  ],
};

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (n === "node_modules") return [];
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
});

describe("the phone's press readers", () => {
  it("every site is classified, in order, and every says-done site carries a superseded arm", () => {
    const found: Record<string, string[]> = {};
    for (const f of walk(join(ROOT, "src"))) {
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

  /** THE CONTROL: deleteMessage's shape before the fix — a sentence for every non-refusal. */
  it("reads the old deleteMessage as a says-done site with no superseded arm", () => {
    const before = `const deleteMessage = async (messageId) => {
      const res = await inMessageOrder(gone, () => engine.mutate(gone).catch(() => null));
      if (res?.status === "awaiting_organizer") { toast(refuse("toastDeleteQueued")); return true; }
      if (!res || res.status === "rolled_back") { toast(refuse("deleteFailed")); return false; }
      if (!opts?.quiet) toast(refuse("toastDeleted"));
      return true;
    };`;
    expect(pressReaderSites(before)).toEqual([{ line: 2, superseded: false, viaVerdict: false }]);
    expect(pressReaderSites(`function mutate(m) { return m.status === "x"; }`)).toEqual([]);
  });
});
