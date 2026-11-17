import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL_RANK_ORDER } from "@trafficflow/core/search-rank";

/**
 * THE CENSUS — every door that ranks a search calls the ONE rule, and nothing ranks in private.
 *
 * There are three surfaces that can put search results in an order in this product, and they
 * share no code at all: the client engine's in-memory index (TypeScript over a mirror), the
 * hosted service (SQL over Postgres), and the view that MERGES the two and therefore decides
 * the order the reader actually sees. A rule written out three times is three orders that agree
 * until the day one of them is tuned, and the tuning is invisible — a list is still a list.
 *
 * So the rule lives in `@trafficflow/core/search-rank` and this file is what makes "shared"
 * a fact rather than an intention. It is the same shape as
 * `packages/client-engine/test/drain-policy-census.test.ts`, for the same reason.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The one specifier every door must reach for. */
const RULE = "@trafficflow/core/search-rank";

/** Does `src` import the rule module in a real module-specifier position (not in prose)? */
function importsRule(src: string): boolean {
  return new RegExp(`(?:from|import|require\\s*\\()\\s*["']${RULE.replace(/[/@-]/g, "\\$&")}["']`).test(src);
}

describe("the search ranking rule is shared, not copied", () => {
  it("the CLIENT ENGINE's index calls the rule", () => {
    const src = read("packages/client-engine/src/search.ts");
    expect(importsRule(src), "packages/client-engine/src/search.ts must import the shared rule").toBe(true);
    // Not merely imported — the two decisions that make a tier a tier are taken from it.
    expect(src).toContain("showSimilar(");
    expect(src).toContain("MIN_FUZZY_TERM_LEN");
    expect(src).toContain("compareRanked(");
  });

  it("the HOSTED SERVICE calls the rule", () => {
    const src = read("packages/services/src/search-service.ts");
    expect(importsRule(src), "packages/services/src/search-service.ts must import the shared rule").toBe(true);
    expect(src).toContain("showSimilar(");
  });

  it("the VIEW that merges the two doors calls the rule", () => {
    const src = read("packages/app-logic/src/search/local-pass.ts");
    expect(importsRule(src), "packages/app-logic/src/search/local-pass.ts must import the shared rule").toBe(true);
    // The merged list is where the composition happens, and it is the only place that can:
    // neither door can see the other's tier.
    expect(src).toContain("showSimilar(");
  });

  /**
   * The SQL door cannot call the comparator — its ordering is evaluated by Postgres over rows
   * that never reach JavaScript — so what is held instead is the KEY SEQUENCE, derived from the
   * shared constant rather than typed out here. Change one side and this row goes red.
   */
  /**
   * PUNCTUATION IS ONE RULE TOO, and it is the half a census is most needed for: the client
   * SPLITS a compound into terms and the SQL door GATES a verbatim arm on the same class of
   * character, so the two look nothing like each other and are one decision. Written out twice
   * they would agree until somebody widened one separator set.
   */
  it("both doors take the punctuation rule from the shared module", () => {
    const client = read("packages/client-engine/src/search.ts");
    const service = read("packages/services/src/search-service.ts");
    // The client tokenizer expands compounds through the shared function…
    expect(client).toContain("compoundForms(");
    // …and never re-derives the separator set for itself.
    expect(client).not.toMatch(/\[-\.\]\+?\)\+/);
    // The SQL door's substring arm is gated by the shared predicate, not by a local regex, and the
    // web and the phone say that arm's reach through the same function.
    expect(service).toContain("substringOpen(");
    expect(service).not.toMatch(/function (substringOpen|exactAsked)\(/);
    expect(read("packages/app-logic/src/search/search-list.ts")).toContain("substringOpen(");
    expect(read("apps/mobile/src/state/search-count.ts")).toContain("substringOpen(");
  });

  it("the SQL order clause is the comparator's key sequence", () => {
    const src = read("packages/services/src/search-service.ts");
    // `SQL_RANK_ORDER` is written with a `{rank}` placeholder; the service spells it as a
    // template substitution. Derive the expected text so the two cannot drift.
    const expected = `order by ${SQL_RANK_ORDER.replace("{rank}", "${rank}")}`;
    expect(src).toContain(expected);
  });

  /**
   * NOTHING ELSE RANKS A SEARCH. The engine's `search()` is the only local entry point, and the
   * surfaces that call it are named here. The second one arrived in 0.22, which is what this row
   * was written to catch: the phone grew a search screen, and the question it forced is whether
   * that screen shares the ranking or ships a third ordering. It shares it — `live.ts` hands the
   * engine's answer through a filter and a projection and sorts nothing, and `search.tsx` spells
   * no ordering at all — so both are named and the ORDERING is what the arm now asserts. A third
   * caller still reds, and so does either of these growing a sort of its own.
   */
  it("every surface that calls the local index takes the engine's order, and they are named", () => {
    const callers: string[] = [];
    const skip = new Set(["node_modules", "dist", ".next", "build", ".git", "coverage", ".lane-logs"]);
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(ROOT, rel))) {
        if (skip.has(entry)) continue;
        const child = `${rel}/${entry}`;
        const st = statSync(join(ROOT, child));
        if (st.isDirectory()) walk(child);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          if (/\bengine\.search\(/.test(readFileSync(join(ROOT, child), "utf8"))) callers.push(child);
        }
      }
    };
    for (const root of ["apps", "packages", "scripts"]) walk(root);
    expect(callers.sort()).toEqual(["apps/mobile/src/state/live.ts", "packages/app-logic/src/search/local-pass.ts"]);
    /* AND NEITHER RE-ORDERS WHAT IT WAS GIVEN. The engine's answer is already ranked; a caller
       that sorted it would be the third ordering this file exists to prevent, and it would be
       invisible to the arm above. Asked over the call's own function body, not the whole file:
       both modules are large and sort other things for other reasons. */
    for (const caller of callers) {
      const src = readFileSync(join(ROOT, caller), "utf8");
      const at = src.indexOf("engine.search(");
      const body = src.slice(at, at + 600);
      expect(/\.sort\(|\.reverse\(/.test(body), `${caller} re-orders the engine's answer`).toBe(false);
    }
  });

  it("the mobile shell renders the engine's own order — it adds no ranking of its own", () => {
    /*
     * It forwards `searchServer` through its adapter in `boot.ts` and stops there — `copy.ts`
     * says "Arrives in a later update" on the More screen. So the whole of mobile's search
     * surface is one forwarding line, and this row states exactly that: the seam is allowed at
     * that one path and the RESULT SHAPES are allowed nowhere, because reading them is what a
     * renderer does. The day mobile grows a list it has to come here, and the rule is one
     * import away.
     */
    const FORWARDER = "apps/mobile/src/engine/boot.ts";
    const skip = new Set(["node_modules", "dist", ".expo", "build"]);
    const seam: string[] = [];
    const renderers: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(ROOT, rel))) {
        if (skip.has(entry)) continue;
        const child = `${rel}/${entry}`;
        const st = statSync(join(ROOT, child));
        if (st.isDirectory()) walk(child);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const src = readFileSync(join(ROOT, child), "utf8");
          if (/\bsearchServer\b/.test(src)) seam.push(child);
          // The shapes a result list has to read to exist.
          if (/\bLocalSearchResult\b|\bSearchHit\b|\.similar\b|\bsimilarHead\b/.test(src)) renderers.push(child);
        }
      }
    };
    walk("apps/mobile");
    /* ARCHIVE-024: the phone's Search asks the store through the engine's own list walker
       (`w.store.searchWalker`) — the forward alone, and no screen or door of the phone's. The
       other names are tests' fake stores answering the capability the walker reaches. */
    expect(seam.sort()).toEqual([
      FORWARDER, "apps/mobile/test/search-estimate.test.ts", "apps/mobile/test/search-first-sync-said.test.ts",
    ]);
    /* THE LIST ARRIVED, WHICH THIS ROW SAID IT WOULD. What is forbidden is not reading the result
       shapes — a screen that shows results must — but ORDERING them: the engine ranks, the phone
       renders. So the renderers are named, and each is asked whether it sorts. */
    expect(renderers.sort()).toEqual([
      "apps/mobile/app/search.tsx",
      "apps/mobile/src/state/live.ts",
      "apps/mobile/test/search-live.test.ts",
    ]);
    for (const r of renderers) {
      const src = readFileSync(join(ROOT, r), "utf8");
      expect(/\bLocalSearchResult\b[\s\S]{0,400}?\.sort\(/.test(src), `${r} sorts a result list`).toBe(false);
    }
  });
});
