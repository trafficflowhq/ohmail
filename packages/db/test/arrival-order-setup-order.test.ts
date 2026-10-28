import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureWithheldProvenanceIndex } from "../src/search-setup.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * MAIL 0171's INDEX (0139's, on the new key) IS BUILT AHEAD OF THE MIGRATOR, NOT BY IT. A plain CREATE INDEX over `messages`
 * inside the migrator's transaction blocks every write for the build, so the setup command's
 * pre-migration session builds it CONCURRENTLY first (0071's and 0125's pattern) and 0139's
 * `if not exists` statement finds it there. Measured on this lane's own database with the real
 * `setupProdDatabase`: "messages_account_arrival_order_idx: building concurrently" is logged BEFORE
 * "migrating … journal entries", and the index reads valid. These pins hold the two halves of that
 * reading off-box: the pre-migration prebuild issues the concurrent build, and it runs before the
 * migrator. The residual is named, not hidden: a store below mail 0119 has no `arrived_at` yet, the
 * prebuild defers, and the journal builds the index blocking.
 */
const SETUP = fileURLToPath(new URL("../src/setup-prod.ts", import.meta.url));

function recorder(columnPresent: boolean) {
  const ran: string[] = [];
  const fake = {
    execute: async (q: unknown) => {
      const text = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q,
        (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));
      ran.push(text);
      if (text.includes("information_schema.tables")) return [{ present: true }];
      if (text.includes("information_schema.columns")) return [{ present: columnPresent }];
      return [];
    },
  };
  return { ran, fake };
}

describe("mail 0171's index is built ahead of the migrator", () => {
  it("the pre-migration prebuild builds it CONCURRENTLY on public.messages where arrived_at exists", async () => {
    const { ran, fake } = recorder(true);
    await ensureWithheldProvenanceIndex(fake);
    const mine = ran.filter((s) => s.includes("messages_account_arrival_key_idx"));
    expect(mine.some((s) => s.includes("create index concurrently if not exists")), "no concurrent build of the arrival index").toBe(true);
    expect(mine.join("\n")).toContain("on public.messages");
  });

  it("a store without arrived_at (below mail 0119) defers it: no DDL for this index", async () => {
    const { ran, fake } = recorder(false);
    await ensureWithheldProvenanceIndex(fake);
    expect(ran.filter((s) => s.includes("create index") && s.includes("messages_account_arrival_key_idx"))).toEqual([]);
  });

  it("setupProdDatabase runs that prebuild BEFORE the migrator", () => {
    const src = withoutComments(readFileSync(SETUP, "utf8"));
    const body = src.slice(src.indexOf("export async function setupProdDatabase("));
    const pre = body.indexOf("ensureWithheldProvenanceIndex(");
    const mig = body.indexOf("runMigrations(");
    expect(pre, "the prebuild is not called").toBeGreaterThanOrEqual(0);
    expect(mig, "the migrator is not called").toBeGreaterThanOrEqual(0);
    expect(pre, "the prebuild runs after the migrator has already built the index blocking").toBeLessThan(mig);
  });
});
