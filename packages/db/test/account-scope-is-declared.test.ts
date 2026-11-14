import { describe, expect, it } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as mail from "../src/schema-mail.js";
import * as cloud from "../src/schema-cloud.js";
import { SCOPED_THROUGH_A_PARENT, NO_ACCOUNT_SCOPE } from "../src/account-scope.js";

/**
 * EVERY TABLE EITHER CARRIES AN ACCOUNT OR SAYS WHOSE IT BORROWS.
 *
 * The composite keys hold a child's `account_id` to its parent's. A table without one cannot
 * disagree with its parent and is safe for that reason — but only while somebody has said so, and
 * only while it keeps a single-column key to a parent that has an account. Both facts are declared
 * in `account-scope.ts`; this file derives them again from the schemas, so a fourteenth table with
 * neither an account column nor a declaration is a red on the commit that adds it.
 */

/* Cast rather than a type predicate: drizzle's concrete `PgTableWithColumns<…>` is not assignable
   to `PgTable<TableConfig>`, so `v is PgTable` is an error and the parity twin casts for the same
   reason. `is()` is what decides; the cast only tells the compiler what `is()` already proved. */
const ALL = [...Object.values(mail), ...Object.values(cloud)]
  .filter((v) => is(v, PgTable))
  .map((v) => v as unknown as PgTable)
  .map((table) => ({ table, cfg: getTableConfig(table) }));

const byName = new Map(ALL.map((t) => [t.cfg.name, t]));
const hasAccount = (name: string): boolean =>
  (byName.get(name)?.cfg.columns ?? []).some((c) => c.name === "account_id");

/** Each table's keys as `{ from, to }`, resolved through the referenced table's own config. */
function keysOf(name: string): { from: string; to: string }[] {
  const t = byName.get(name);
  if (!t) return [];
  return t.cfg.foreignKeys.map((fk) => {
    const r = fk.reference();
    return {
      from: r.columns.map((c) => c.name).join(","),
      to: `${getTableConfig(r.foreignTable as unknown as PgTable).name}.` +
        `${r.foreignColumns.map((c) => c.name).join(",")}`,
    };
  });
}

/**
 * A reference a table carries by NAME where the schema declares no key — the one shape a key scan
 * cannot see, and the shape `invites` is deliberately in.
 */
const BY_CONVENTION: Record<string, string> = {
  consumed_by_user_id: "users", created_by_user_id: "users", user_id: "users",
  mailbox_id: "mailboxes", message_id: "messages", updated_by: "staff_users",
  staff_user_id: "staff_users",
};

/** Tables with no account column of their own that nonetheless hang off another table. */
const derived = ALL
  .filter(({ cfg }) => !cfg.columns.some((c) => c.name === "account_id"))
  .filter(({ cfg }) => cfg.name !== "accounts")
  .filter(({ cfg }) =>
    keysOf(cfg.name).length > 0 ||
    cfg.columns.some((c) => BY_CONVENTION[c.name] !== undefined))
  .map(({ cfg }) => cfg.name)
  .sort();

describe("a table without an account column has said whose it borrows", () => {
  it("declares every one of them, and declares nothing that is not one", () => {
    const declared = [
      ...SCOPED_THROUGH_A_PARENT.map((s) => s.table),
      ...NO_ACCOUNT_SCOPE.map((s) => s.table),
    ].sort();
    expect(declared).toEqual(derived);
  });

  it("keeps the two lists disjoint, and no table borrows its parent's account", () => {
    // The number is asserted because the list is what the census measures: a member quietly
    // added would answer "whose is this row" with a join again. The seven sign-in tables that
    // stood here carry their own account since cloud 0100, the six mail tables since mail 0201.
    expect(SCOPED_THROUGH_A_PARENT).toHaveLength(0);
    expect(SCOPED_THROUGH_A_PARENT.filter(
      (s) => NO_ACCOUNT_SCOPE.some((u) => u.table === s.table))).toEqual([]);
  });

  it.each(SCOPED_THROUGH_A_PARENT.map((s) => [s.table, s] as const))(
    "%s reaches an account-scoped parent through a single-column key",
    (_t, s) => {
      expect(byName.get(s.table), `${s.table} is declared and is in neither schema`).toBeDefined();
      expect(hasAccount(s.parent), `${s.parent} carries no account_id`).toBe(true);
      expect(keysOf(s.table), `${s.table} has no key on ${s.via}`)
        .toContainEqual({ from: s.via, to: `${s.parent}.id` });
    },
  );

  it("names a reason for every table that belongs to no account", () => {
    for (const u of NO_ACCOUNT_SCOPE) expect(u.why.length).toBeGreaterThan(20);
  });
});
