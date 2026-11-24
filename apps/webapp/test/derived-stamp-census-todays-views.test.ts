import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Check body subscriptions on mounted surfaces and in any legacy readers still present. */

/** Read a repo file THROUGH A VARIABLE — a literal `new URL` is a Vite asset reference here. */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function legacySources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return legacySources(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/**
 * Source with its comments removed. A census that greps raw text answers about prose as well as
 * code — and prose is exactly where these types get NAMED, in the notes explaining the rule.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("every surface that draws a body subscribes to one", () => {
  const sources = "../../../packages/";
  const reader = "app-logic/src/reader/open-conversation.ts";
  const stream = "app-logic/src/streams/live.ts";
  const mounted = [
    ["app/src/reader/Letter.tsx", /useLetterBody\s*\(/, reader, /useBodyArrival\s*\(/],
    ["app/src/reader/entry.tsx", /useLetterBody\s*\(/, reader, /useBodyArrival\s*\(/],
    ["app/src/screener/held/HeldLetter.tsx", /useLetterBody\s*\(/, reader, /useBodyArrival\s*\(/],
    ["app/src/stream/Seat.tsx", /useStreamLive\s*\(/, stream, /useBodyStamp\s*\(/],
  ] as const;

  it("pairs every bodyOf draw with a body-slice hook", () => {
    const app = fileURLToPath(new URL("../app", import.meta.url));
    for (const root of readdirSync(app, { withFileTypes: true })) {
      if (!root.isDirectory() || (root.name !== "shell" && root.name !== "views")) continue;
      for (const file of legacySources(join(app, root.name))) {
        const src = code(readFileSync(file, "utf8"));
        if (!/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m.test(src)) continue;
        expect(src, `${file} draws a body and never subscribes to one`)
          .toMatch(/useBodyArrival\s*\(|useBodyStamp\s*\(/);
      }
    }

    const draws: string[] = [];
    for (const [surface, drawsBody, producer, subscribes] of mounted) {
      expect(code(read(sources + surface)), `${surface} no longer uses its body producer`).toMatch(drawsBody);
      const src = code(read(sources + producer));
      expect(src, `${producer} draws a body and never subscribes to one — it will show the snippet`)
        .toMatch(subscribes);
      expect(src, `${producer} lost its mirror body read`).toMatch(/readLetterBody\(engine, m(?:essage)?\)/);
      draws.push(surface);
    }
    expect(code(read(sources + reader)), "the shared body reader no longer reads the mirror")
      .toMatch(/bodyOf\(engine\.read\(\), message\)/);
    // The companion census walks both packages to catch new direct bodyOf calls.
    expect(draws.length, "no file was found drawing a body — the census matched nothing")
      .toBeGreaterThanOrEqual(4);
  });
});
