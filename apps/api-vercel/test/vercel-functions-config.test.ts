import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE FUNCTION OPTIONS VERCEL GIVES EACH ROUTE. @vercel/build-utils' getLambdaOptionsFromFunction (14.2.0)
 * walks vercel.json "functions" in key order and returns the FIRST pattern equal to or minimatching the
 * route's source file. /events frees its stream slot only when its request signal aborts on a client's
 * disconnect, which Vercel does only with supportsCancellation: an events entry after the catch-all glob
 * is never reached.
 */
type Fn = { memory?: number; supportsCancellation?: boolean };
const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { functions: Record<string, Fn> };

// minimatch for the shapes vercel.json uses: "**/" spans directories, "*" stays inside one, the rest is literal.
const toRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*)/)
      .map((part) => (part === "**/" ? "(?:[^/]+/)*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );

const optionsFor = (sourceFile: string): Fn => {
  for (const [pattern, fn] of Object.entries(config.functions)) {
    if (sourceFile === pattern || toRegExp(pattern).test(sourceFile)) return fn;
  }
  return {};
};

describe("vercel.json function options, first match wins", () => {
  const glob = config.functions["app/**/route.ts"];

  it("the events route gets request cancellation, with the catch-all's memory", () => {
    expect(optionsFor("app/events/route.ts")).toEqual({ memory: glob?.memory, supportsCancellation: true });
  });

  it("every other route keeps the catch-all's options", () => {
    expect(optionsFor("app/[[...path]]/route.ts")).toBe(glob);
    expect(glob).toEqual({ memory: 1024 });
  });
});
