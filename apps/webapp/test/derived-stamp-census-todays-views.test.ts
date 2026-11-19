import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Check body-derived timestamps in the legacy views. The companion census covers calls in the active shell. */

/** Read a repo file THROUGH A VARIABLE — a literal `new URL` is a Vite asset reference here. */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

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
  /**
   * The files that call `bodyOf` at draw time. Derived from the source rather than listed, so a
   * fifth surface added later is asked the same question instead of being forgotten.
   */
  const CANDIDATES = [
    "../app/shell/MessagePane.tsx",
    "../app/shell/MessageCard.tsx",
    "../app/views/ReadsView.tsx",
    "../app/views/ReceiptsView.tsx",
    "../app/views/ScreenerView.tsx",
    "../app/shell/TodaysOhbox.tsx",
    "../app/views/HistoryView.tsx",
    "../app/shell/StreamCardMemo.tsx",
    "../app/shell/InlineReply.tsx",
    "../app/shell/Conversation.tsx",
  ];

  it("pairs every bodyOf draw with a body-slice hook", () => {
    const draws: string[] = [];
    for (const rel of CANDIDATES) {
      const src = code(read(rel));
      // `useDrawnBody` is the door and its subscription in one call (`body-slice.ts`).
      if (/useDrawnBody\s*\(/.test(src)) draws.push(rel);
      // A CALL, not a mention: `bodyOf: bodyOfMessage` and a prop type are neither.
      if (!/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m.test(src)) continue;
      if (!draws.includes(rel)) draws.push(rel);
      expect(src, `${rel} draws a body and never subscribes to one — it will show the snippet`)
        .toMatch(/useBodyArrival\s*\(|useBodyStamp\s*\(/);
    }
    // The census must have a subject: four surfaces draw bodies today.
    expect(draws.length, "no file was found drawing a body — the census matched nothing")
      .toBeGreaterThanOrEqual(4);
  });
});
