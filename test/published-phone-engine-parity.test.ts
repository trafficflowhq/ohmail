/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE ENGINE THE PUBLISHED TREE BUILDS IS THE ONE THIS TREE MEASURES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every census over the phone's bundle — the builtin census, the packaging census, the size
 * ceiling, the dialect census's phone arm — reads the artifact the bundler resolves through each
 * package's `exports`. The other resolution names every workspace subpath's source file directly
 * (`workspaceSourceAliases`), the table the publish manifests were once generated with. Two
 * resolutions, one entry point, and nothing had ever compared them: one could gain or lose a module
 * and every gate here would stay green.
 *
 * So the bundle is built both ways and the two are compared on the facts the censuses claim: the
 * workspace source files the graph reaches, what is left for the app's own bundler to resolve,
 * that no Node builtin survives either way, and that the two artifacts are the same size to within
 * a few per cent — which is what makes the ceiling measured on one a bound on the other.
 * Neither resolution reaches a built `dist/` copy, so neither depends on whether this tree ran
 * `npm run build` (`apps/mobile/test/no-node-builtins.test.ts` holds that).
 *
 * It lives at the root rather than beside the other bundle censuses because it is a question about
 * the PUBLISH, and because `apps/mobile`'s own privacy census forbids the workspace scope anywhere
 * under that app — the same refusal that put the alias table in the sidecar. An exemption would
 * have been the wrong answer to a rule that is right.
 *
 * ── WHAT IT DOES NOT CLAIM ────────────────────────────────────────────────────────────────
 *
 * Not byte equality: esbuild marks a CommonJS `require` wrapper by how its importer was resolved,
 * through a package's exports or through the source table, so a few bytes differ by construction.
 * And not the third-party half: both builds read this tree's one installed `node_modules`, so a
 * dependency that moved is the lockfile's question, outside what a second build here can see.
 *
 * ── THE ARTIFACT ON DISK IS NOT TOUCHED ───────────────────────────────────────────────────
 *
 * Both builds run with `write: false`. `apps/mobile/generated/phone-engine.js` is what ships and
 * what every other census reads; a probe that overwrote it with the other resolution's bytes would
 * quietly change what those censuses measure.
 */
import { describe, expect, it, beforeAll } from "vitest";

// @ts-expect-error — a plain .mjs build script, no declarations by design.
import { buildPhoneEngine, nodeSpecifiersIn } from "../apps/mobile/scripts/bundle-engine.mjs";
import { sourceForInput } from "../scripts/lib/engine-closure.mjs";

/** An input path that belongs to this workspace rather than to a dependency. */
const OWN_INPUT = /^(packages|apps)\/[^/]+\/(dist|src)\//;

interface Built {
  metafile: { inputs: Record<string, unknown> };
  text: string;
}

/**
 * The workspace SOURCE files a build reached, `dist/x.js` mapped back to `src/x.ts` by the same
 * reader the publish closure uses — so the two resolutions are compared in the one vocabulary
 * every census already speaks.
 */
const ownSources = (built: Built): string[] =>
  [...new Set(Object.keys(built.metafile.inputs)
    .filter((p) => OWN_INPUT.test(p))
    .map((p) => sourceForInput(p)))].sort();

/** Everything the bundle left for the app's own bundler, read from the ARTIFACT. */
const requiresIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!))].sort();

/**
 * THE ONE READING, so the control below refuses a planted difference through the same code the
 * case above passes through. A comparison that has only ever seen two equal lists has not been
 * shown to be able to see an unequal pair.
 */
function divergence(shippedFiles: string[], publishedFiles: string[]): string[] {
  const a = new Set(shippedFiles);
  const b = new Set(publishedFiles);
  return [
    ...shippedFiles.filter((f) => !b.has(f)).map((f) => `only this tree builds: ${f}`),
    ...publishedFiles.filter((f) => !a.has(f)).map((f) => `only the published tree builds: ${f}`),
  ].sort();
}

let shipped: Built;
let published: Built;

beforeAll(async () => {
  /* The published resolution BUILDING AT ALL is the first thing this file asserts, and it is
     asserted by running it: an export subpath whose source is missing, or an import the compiler
     resolves and the bundler does not, throws here — today that failure would reach nobody until
     the public Android job ran it. */
  shipped = await buildPhoneEngine({ write: false }) as Built;
  published = await buildPhoneEngine({ write: false, workspaceSources: true }) as Built;
}, 300_000);

describe("the two resolutions reach the same phone engine", () => {
  it("read a graph that is plausibly the engine, before anything is compared", () => {
    // The vacuous-green guard, first: every way of reading these metafiles wrongly ends in two
    // short lists that match each other perfectly.
    expect(ownSources(shipped).length).toBeGreaterThan(150);
    expect(ownSources(published).length).toBeGreaterThan(150);
    expect(ownSources(published)).toContain("packages/db/src/schema-mail-sqlite.ts");
    expect(ownSources(published)).toContain("apps/sidecar/src/phone/db.ts");
  });

  it("reach the same workspace source files", () => {
    const differences = divergence(ownSources(shipped), ownSources(published));
    expect(differences, "the published tree builds a different engine from the one measured here")
      .toEqual([]);
  });

  it("leave the same modules for the app's own bundler to resolve", () => {
    // Read from the ARTIFACT and not from the metafile: on a source-resolved graph esbuild records
    // an `external: true` edge for every TypeScript import statement it ELIDES, so the published
    // tree's metafile reports three specifiers the bundle does not leave — all of them type-only
    // import statements whose value twins resolve normally. The requires in the file are the fact.
    expect(requiresIn(published.text)).toEqual(requiresIn(shipped.text));
    expect(requiresIn(published.text))
      .toEqual(["react-native-quick-crypto", "react-native-tcp-socket"]);
  });

  it("carry no Node builtin either way", () => {
    expect(nodeSpecifiersIn(shipped.metafile)).toEqual([]);
    expect(nodeSpecifiersIn(published.metafile)).toEqual([]);
  });

  /**
   * THE SIZE CEILING IS MEASURED ON ONE AND HOLDS FOR THE OTHER.
   *
   * `apps/mobile/test/engine-packaging.test.ts` pins the artifact the bundler writes, so that pin
   * bounds the other resolution only while the two are close. A small bound, well above the
   * difference measured (15 bytes at this base: esbuild's interop flag on five `require` wrappers,
   * which follows how the importing module was resolved), narrow enough that a megabyte arriving
   * on one side only fires it.
   */
  it("are the same size to within three per cent", () => {
    const here = Buffer.byteLength(shipped.text, "utf8");
    const there = Buffer.byteLength(published.text, "utf8");
    expect(Math.abs(there - here) / here,
      `this tree ${here} bytes, the published tree ${there} bytes`).toBeLessThan(0.03);
  });

  it("REFUSES a difference, over the lists it just measured", () => {
    /* The positive control for the reading the case above makes, driven with the real measured
       list rather than two invented ones. Both arms, because a comparison written one-sided
       passes half the failures it exists for. */
    const measured = ownSources(published);
    const first = measured[0] ?? "";
    expect(divergence(measured, [...measured, "packages/" + "db/src/planted.ts"]))
      .toEqual(["only the published tree builds: packages/" + "db/src/planted.ts"]);
    expect(divergence(measured, measured.slice(1)))
      .toEqual([`only this tree builds: ${first}`]);
  });
});
