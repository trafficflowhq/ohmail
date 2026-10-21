import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { readRoleDeadlines } from "../scripts/lane-db.mjs";

/**
 * `lane-db.sh --check` reads a role's deadlines through `readRoleDeadlines`. The positive control,
 * on a real server: a throwaway NOLOGIN role (never tf, never the lane role) given a role-wide
 * `lock_timeout` reads REFUSED, and CLEAN after RESET. The prefix and stamp are `_setup-role.ts`'s,
 * so a killed run's leftover is swept by age. Skips without Postgres; `TF_REQUIRE_PG=1` fails instead.
 */
const PG_URL = pgTestUrl("test/lane-db-role-deadlines.pg.test.ts");
const ROLE = `ohmail_setup_role_${randomBytes(6).toString("hex")}`;

describe("lane-db reads a role's deadlines from the catalog (real Postgres)", () => {
  const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
  let up = false;

  beforeAll(async () => {
    up = await realPgAvailable(PG_URL);
    if (!up) return;
    await sql.unsafe(`create role "${ROLE}" nologin`);
    await sql.unsafe(`comment on role "${ROLE}" is 'ohmail-test-role created=${Date.now()}'`);
  });

  afterAll(async () => {
    try { if (up) await sql.unsafe(`drop role if exists "${ROLE}"`); }
    finally { await sql.end({ timeout: 5 }); }
  });

  it("REFUSED with the key and its scope, then CLEAN after RESET", async (ctx) => {
    if (!up) ctx.skip();
    const before = await readRoleDeadlines(sql, ROLE);
    expect(before).toEqual({ rc: 0, line: `BOX_ROLE_DEADLINES CLEAN role=${ROLE} setting-rows=0 deadline-keys=0 (anchor pg_roles ${ROLE}=1)` });
    await sql.unsafe(`alter role "${ROLE}" set lock_timeout = '30s'`);
    const set = await readRoleDeadlines(sql, ROLE);
    expect(set.rc).toBe(3);
    expect(set.line).toMatch(new RegExp(`^BOX_ROLE_DEADLINES REFUSED role=${ROLE} lock_timeout=30s@role-wide — `));
    await sql.unsafe(`alter role "${ROLE}" reset lock_timeout`);
    expect((await readRoleDeadlines(sql, ROLE)).rc).toBe(0);
  });

  it("a role the server does not have is UNREADABLE, never CLEAN", async (ctx) => {
    if (!up) ctx.skip();
    const absent = await readRoleDeadlines(sql, `${ROLE}_absent`);
    expect(absent.rc).toBe(2);
    expect(absent.line).toMatch(/^BOX_ROLE_DEADLINES UNREADABLE /);
  });
});
