import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { pgDialect, sqliteDialect, type Dialect } from "../src/dialect/index.js";
import {
  cutlineArms, heldClaimInsideSql, resolveCutline, senderHasHeldClaimSql, senderIsActiveSql, type ResolvedCutline,
} from "../src/screener-cutline.js";

/**
 * ONE CUTLINE PER MAILBOX, AND ONE CUTLINE IS TODAY'S STATEMENT (RULING-026). A map whose values
 * are all one cutline renders the single form byte for byte, on both stores; two distinct cutlines
 * weigh each message by its own mailbox's window, a per-mailbox CASE whose `else` admits, asked per
 * message rather than per group (`screener-reads-same-answer.test.ts` holds the two forms equal).
 * The rows are driven on both stores by `packages/services/test/screener-reader-queue-is-the-gate.test.ts`.
 */

const NOW = new Date("2026-10-12T00:00:00Z");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const THIRTY = resolveCutline({ baselineAt: new Date("2026-10-01T00:00:00Z"), dormancyDays: 30, now: NOW });
const WHOLE = resolveCutline({ now: NOW, scope: "all_time" });

const STORES: Array<[string, Dialect, (q: SQL) => { sql: string; params: unknown[] }]> = [
  ["pg", pgDialect(), (q) => new PgDialect().sqlToQuery(q)],
  ["sqlite", sqliteDialect(), (q) => new SQLiteSyncDialect().sqlToQuery(q)],
];

describe.each(STORES)("the cutline set on %s", (_name, d, render) => {
  const sender = sql`lower(r.from_address)`;
  const r = {
    folder: sql`f.desired_folder`, deletedAt: sql`m.deleted_at`, senderCheck: sql`m.sender_check`, by: sql`m.sender_check_by`,
    date: sql`m.date`, arrivedAt: sql`m.arrived_at`, recordedAt: sql`m.created_at`, mailboxId: sql`m.mailbox_id`,
  };

  it("a map of one cutline is the single form, byte for byte", () => {
    const single = render(senderIsActiveSql(d, ACCOUNT, sender, THIRTY));
    const mapped = render(senderIsActiveSql(d, ACCOUNT, sender, new Map([[A, THIRTY], [B, { ...THIRTY }]])));
    expect(mapped).toEqual(single);
    expect(single.sql).not.toContain("mc.mailbox_id");
    expect(render(senderHasHeldClaimSql(d, ACCOUNT, sender, new Map([[A, THIRTY]]), [])))
      .toEqual(render(senderHasHeldClaimSql(d, ACCOUNT, sender, THIRTY.cutoff, [])));
  });

  it("two cutlines weigh each message by its own mailbox's window", () => {
    const q = render(senderIsActiveSql(d, ACCOUNT, sender, new Map([[A, THIRTY], [B, WHOLE]])));
    expect(q.sql).not.toContain("group by");
    expect(q.sql).toMatch(/and \(case mc\.mailbox_id when .+ else \(true\) end\)/s);
    expect(q.params).toContain(A);
    expect(q.params).toContain(B);
  });

  it("an admitted claim is dated against no window, never every row", () => {
    const q = render(heldClaimInsideSql(d, r, new Map<string, ResolvedCutline>([[A, THIRTY], [B, WHOLE]])));
    // Two arms and the admitting `else`, each the whole claim test: three, and no bare `else (true)`.
    expect(q.sql.split("m.sender_check = 'impersonation'").length - 1).toBe(3);
    expect(q.sql).not.toContain("else (true)");
  });

  it("the arms are ordered by mailbox id, so the statement is one per set", () => {
    const ab = cutlineArms(new Map([[A, THIRTY], [B, WHOLE]]));
    const ba = cutlineArms(new Map([[B, WHOLE], [A, THIRTY]]));
    expect(ab).toEqual(ba);
  });
});
