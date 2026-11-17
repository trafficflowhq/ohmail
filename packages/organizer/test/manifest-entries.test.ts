/**
 * The worker's exports are the same set under the package's name (ruling:organizer-cut, C.2): the manifest names
 * the worker's 25 entries first, in the worker's order, then one entry for each module a staying file of the
 * worker imports, and every entry loads by its name.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, Record<string, string>>;
};

/** The 25 the worker exported, under their names and in their order. */
const FROM_THE_WORKER = [
  "sync",
  "lease",
  "profile",
  "entry",
  "classifier-fault",
  "bubble-up",
  "screener-auto-suggest",
  "screener-auto-act",
  "sender-name-backfill",
  "html-words-backfill",
  "thread-join-heal",
  "gone-letter-tidy",
  "inbound-quiet",
  "request-drain",
  "known-set",
  "rule-retro",
  "gap-catchup",
  "screener-correspondent-retro",
  "dead-letter",
  "sender-check-backfill",
  "list-address-backfill",
  "act-admission-retire",
  "screener-impersonation",
  "calendar-sync",
  "calendar-sync-pass",
];

const KEYS = Object.keys(manifest.exports).map((k) => k.replace(/^\.\//, ""));

describe("the organizer's manifest", () => {
  it("names the worker's 25 entries first, in their order, then the entries the worker's own files import, sorted and named by their path", () => {
    expect(KEYS.slice(0, FROM_THE_WORKER.length)).toEqual(FROM_THE_WORKER);
    const rest = KEYS.slice(FROM_THE_WORKER.length);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest).toEqual([...rest].sort());
    for (const k of rest) expect(manifest.exports[`./${k}`]!.types, k).toBe(`./src/${k}.ts`);
  });

  it("gives every entry the four conditions, the source for three and the build for node", () => {
    for (const [key, conditions] of Object.entries(manifest.exports)) {
      expect(Object.keys(conditions), key).toEqual(["types", "ohmail-source", "node", "default"]);
      expect(conditions.types, key).toMatch(/^\.\/src\/.+\.ts$/);
      expect(conditions["ohmail-source"], key).toBe(conditions.types);
      expect(conditions.default, key).toBe(conditions.types);
      expect(conditions.node, key).toBe(
        conditions.types.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js"),
      );
    }
  });

  it.each(KEYS)("@ohmail/organizer/%s loads by its name", async (name) => {
    const module: unknown = await import(/* @vite-ignore */ `@ohmail/organizer/${name}`);
    expect(module).toBeTypeOf("object");
  });
});
