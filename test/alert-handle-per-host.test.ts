import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * WHICH HOST HANDS THE ALERT PASS ITS OWN HANDLE. `AlertsConfig.db` runs the pass and the reads
 * where no content-blind role exists: the self-host server, whose one role reads mail. The managed
 * host has the blind role (`deps.adminDb`) and its alert block must never name `db:` — the route
 * prefers the blind factory, but a `db:` there is one lost `DATABASE_URL_ADMIN` away from staff
 * reads on the handle that can read every account's mail.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The `alerts: cfg.alerts ? { … }` object of one composition, comments blanked; null if absent. */
function alertsBlock(src: string): string | null {
  const code = withoutComments(src) as string;
  const start = code.indexOf("alerts: cfg.alerts");
  if (start < 0) return null;
  let depth = 0;
  for (let i = code.indexOf("{", start); i >= 0 && i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

const namesHandle = (block: string): boolean => /(?<![\w$.])db\s*:/.test(block);
const blockOf = (path: string): string => {
  const block = alertsBlock(readFileSync(join(ROOT, path), "utf8"));
  expect(block, `${path} has no alerts: cfg.alerts block`).not.toBeNull();
  return block!;
};

describe("the alert pass's own handle belongs to the self-host server alone", () => {
  it("the managed host's alert block names no db: — its pass runs on the blind role", () => {
    // Red mutation: add `db: …` to apps/api-vercel's alerts block.
    expect(namesHandle(blockOf("apps/api-vercel/src/deps.ts"))).toBe(false);
  });

  it("the self-host server's alert block names db: — without it every /internal/alerts route answers 503", () => {
    // Red mutation: drop `db: rt.alertDb` from apps/server's alerts block.
    expect(namesHandle(blockOf("apps/server/src/deps.ts"))).toBe(true);
  });

  it("control: the scanner reads a synthetic block both ways", () => {
    const armed = "x({ alerts: cfg.alerts ? { secret: s, db: rt.alertDb } : undefined, adminDb: a })";
    const bare = "x({ alerts: cfg.alerts ? { secret: s } : undefined, adminDb: a, db: d })";
    const commented = "x({ alerts: cfg.alerts ? { secret: s /* db: h */ } : undefined })";
    expect(namesHandle(alertsBlock(armed)!)).toBe(true);
    expect(namesHandle(alertsBlock(bare)!), "a db: outside the block is not the block's").toBe(false);
    expect(namesHandle(alertsBlock(commented)!), "a comment is not a member").toBe(false);
    expect(namesHandle("{ admindb: a, staff_db: b, x.db: c }"), "a longer name ending in db is not db:").toBe(false);
  });
});
