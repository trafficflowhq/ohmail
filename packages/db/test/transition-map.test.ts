import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { WRAPPED_SECRET_SITES } from "../src/kek-rewrap.js";
import * as mailSchema from "../src/schema-mail.js";
import * as cloudSchema from "../src/schema-cloud.js";
import { MAP_2_0, SEALED_SITES, accountTablesOf, tablesOf } from "../src/transition/index.js";

/**
 * THE TRANSITION'S MAP IS THE SCHEMA'S. The transition runs in a desktop's engine, which does not
 * carry the Cloud's schema, so it holds its own list of the tables a 2.0 store has, which journal
 * makes each, which carry the account and where a sealed value stands. Held here to the two
 * schema files and to the key ring's registry, both ways: a table added to either and not to the
 * map is a table the transition would call a stranger's.
 */
/** Every table a schema file exports, by its name in the store: the file's exports, not a list it keeps. */
const tablesIn = (schema: Record<string, unknown>): Map<string, PgTable> => {
  const out = new Map<string, PgTable>();
  for (const t of Object.values(schema)) if (is(t, PgTable)) out.set(getTableConfig(t).name, t);
  return out;
};
const MAIL = tablesIn(mailSchema);
const CLOUD = tablesIn(cloudSchema);
const carriesAccount = (t: PgTable): boolean => getTableConfig(t).columns.some((c) => c.name === "account_id");

describe("the transition's map", () => {
  it("names every table of the two schema files under its own journal, and one table of a desktop's engine", () => {
    const mapped = (journal: string): string[] => Object.keys(MAP_2_0).filter((t) => MAP_2_0[t]!.journal === journal).sort();
    expect(mapped("mail")).toEqual([...MAIL.keys()].sort());
    expect(mapped("cloud")).toEqual([...CLOUD.keys()].sort());
    expect(mapped("desktop")).toEqual(["local_store_flush"]);
    expect(tablesOf("server")).toHaveLength(MAIL.size + CLOUD.size);
    expect(tablesOf("cloud")).toEqual(tablesOf("server"));
    expect(tablesOf("desktop")).toHaveLength(MAIL.size + 1);
  });

  it("says a table carries the account exactly where its schema declares the column", () => {
    const declared = [...MAIL, ...CLOUD].filter(([, t]) => carriesAccount(t)).map(([name]) => name).sort();
    expect(accountTablesOf("server")).toEqual(declared);
    expect(accountTablesOf("desktop")).toEqual([...MAIL].filter(([, t]) => carriesAccount(t)).map(([name]) => name).sort());
  });

  it("expects a table the 2.0 window makes to be empty or to hold what an entry moves into it, and every other to keep its rows", () => {
    const formula = (t: string): string => { const r = MAP_2_0[t]!.rows; return typeof r === "string" ? r : "a formula"; };
    const moved = Object.keys(MAP_2_0).filter((t) => formula(t) === "a formula").sort();
    expect(moved).toEqual(["account_counters", "auth_throttle", "pass_progress"]);
    const empty = Object.keys(MAP_2_0).filter((t) => formula(t) === "empty").sort();
    expect(empty).toEqual(["account_closures", "cal_alarms", "cal_attendees", "cal_calendars", "cal_connections", "cal_credentials",
      "cal_events", "cal_links", "cal_push_channels", "cal_settings", "cal_suggestions", "cal_writes", "message_invitations"]);
  });
});

describe("the places a sealed value stands", () => {
  it("are the key ring's registry, in the store's own column names, key columns included", () => {
    const registry = WRAPPED_SECRET_SITES.map((s) => {
      const config = getTableConfig(s.table);
      const sqlName = (property: string): string => (s.table as unknown as Record<string, { name: string }>)[property]!.name;
      return {
        site: s.site, table: config.name, ciphertext: sqlName(s.ciphertext), keyVersion: sqlName(s.keyVersion),
        key: s.key.map(sqlName), journal: MAIL.has(config.name) ? "mail" : "cloud",
      };
    });
    const byName = <T extends { site: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.site.localeCompare(b.site));
    expect(byName(SEALED_SITES.map((s) => ({ site: s.site, table: s.table, ciphertext: s.ciphertext, keyVersion: s.keyVersion, key: [...s.key], journal: s.journal }))))
      .toEqual(byName(registry));
    expect(SEALED_SITES.length).toBeGreaterThanOrEqual(10);
  });
});
