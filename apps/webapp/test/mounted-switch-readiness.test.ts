import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(path, "utf8");
/** The call, not the name: `beginSwitch()` and never `beginSwitch` in a comment or an import. */
function callsIn(body: string, fn: string): number {
  return [...body.matchAll(new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g"))].length;
}

it("every view the shell renders is named in the readiness table, or is pinned as its own content", () => {
  const registry = read("packages/app/src/mail/places.ts");
  const block = /^const SEATED: MailPlaces = \{([\s\S]*?)^\};/m.exec(registry);
  expect(block, "the mounted registry").not.toBeNull();
  const seated = block![1]!;
  const rendered = [...seated.matchAll(/^  (\w+):/gm)].map((match) => match[1]!);
  const ownContent = new Set(["address", "search", "write"]); // Settings is registered by its host.
  const owners: Record<string, string> = {
    drafts: "drafts/Seat.tsx",
    folder: "folder/Seat.tsx",
    history: "history/Seat.tsx",
    later: "piles/Seat.tsx",
    news: "stream/Seat.tsx",
    ohbox: "ohbox/Seat.tsx",
    parked: "piles/Seat.tsx",
    receipts: "stream/Seat.tsx",
    resurface: "piles/Seat.tsx",
    screener: "screener/ScreenerList.tsx",
    tags: "tags/Seat.tsx",
    trash: "trash/Seat.tsx",
  };
  expect(rendered.filter((id) => !ownContent.has(id)).sort()).toEqual(Object.keys(owners).sort());
  const unanswered = Object.entries(owners)
    .filter(([, path]) => callsIn(read(`packages/app/src/${path}`), "useSwitchEnded") !== 1)
    .map(([id]) => id);
  expect(unanswered, "places without one readiness-gated finish").toEqual([]);
});
