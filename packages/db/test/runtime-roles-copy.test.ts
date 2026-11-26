import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_LOGINS } from "../src/row-security/names.js";
import { STAFF_TABLES, policyList, type PolicyVerb } from "../src/row-security/policies.js";
import { ROLE_DEADLINES } from "../src/row-security/deadlines.js";
import { ACCOUNT_VIEWS, viewName } from "../src/row-security/views.js";
import { READER_SCHEMA } from "../src/row-security/logins.js";

/**
 * THE RUNTIME ROLES' SCRIPT IS A VERBATIM COPY. Its one home is the deploy kit, which makes the two
 * logins on the Cloud; the copy here is what the setup's lock step reads (its read-only check) and
 * what the proofs on a real Postgres make their roles with. The kit's own test holds the other end:
 * a copy at a pinned tag must be its file byte for byte. So the bytes are pinned here, and a change
 * replaces the bytes and these pins in one commit, never edits the copy. The rule the script writes
 * is held against the lock's list: a policy names a login only on a verb the rule grants it.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "harden-runtime-roles.sql"));
const RULE = readFileSync(join(ROOT, "scripts", "runtime-roles.tsv"));

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The kit's rows, `kind role subject value`, comments and the header left out. */
const rows = RULE.toString("utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#")).slice(1).map((l) => l.split("\t"));

/** The verbs the rule grants `role` on `table`: its narrowed row, else the rule for every table. */
function granted(role: string, table: string): Set<string> {
  const narrowed = rows.find((r) => r[0] === "verbs" && r[1] === role && r[2] === table);
  const rule = narrowed ?? rows.find((r) => r[0] === "verbs" && r[1] === role && r[2] === "*");
  const value = rule?.[3] ?? "-";
  return new Set(value === "-" ? [] : value.split(" "));
}

const COVERS: Record<PolicyVerb, readonly string[]> = {
  ALL: ["SELECT", "INSERT", "UPDATE", "DELETE"], SELECT: ["SELECT"], INSERT: ["INSERT"], UPDATE: ["UPDATE"], DELETE: ["DELETE"],
};

describe("the copied roles' script", () => {
  it("is the kit's file and data, byte for byte", () => {
    expect(sha256(SCRIPT)).toBe("6f01de0d77e6a126379deea606804751b784ffe47f2a3995812ab58c96bf6933");
    expect(sha256(RULE)).toBe("8b1433f718c5deb9e9a3bfbeb4fef756599f9c6360c979bffc7e1233cc850d59");
  });

  it("carries the four markers its sections are cut by, once each and in order", () => {
    const lines = SCRIPT.toString("utf8").split("\n");
    const at = ["-- @shape", "-- @provision", "-- @census", "-- @commit"].map((m) => {
      const hits = lines.flatMap((l, i) => (l === m ? [i] : []));
      expect(hits, m).toHaveLength(1);
      return hits[0]!;
    });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("the rule the script writes, against the lock's list", () => {
  it("names the same two logins", () => {
    expect(rows.filter((r) => r[0] === "login").map((r) => r[1])).toEqual([...RUNTIME_LOGINS]);
  });

  it("grants exactly the lock's three views, to exactly the two logins, to read, and USAGE on their schema", () => {
    const views = rows.filter((r) => r[0] === "view").map((r) => `${r[1]} ${r[2]} ${r[3]}`).sort();
    expect(views).toEqual(RUNTIME_LOGINS.flatMap((l) => ACCOUNT_VIEWS.map((v) => `${l} ${viewName(v)} SELECT`)).sort());
    expect(rows.filter((r) => r[0] === "schema" && r[2] === READER_SCHEMA).map((r) => `${r[1]} ${r[3]}`)).toEqual(RUNTIME_LOGINS.map((l) => `${l} USAGE`));
  });

  it("a policy names a login only on a table and verb the rule grants it", () => {
    for (const p of policyList()) {
      for (const role of p.roles.filter((r) => (RUNTIME_LOGINS as readonly string[]).includes(r))) {
        const held = granted(role, p.table);
        expect(COVERS[p.verb].some((v) => held.has(v)), `${p.table}.${p.name} names ${role}, which holds ${[...held].join(" ") || "nothing"}`).toBe(true);
      }
    }
  });

  it("the worker holds nothing on the staff tables but the sessions it prunes, and nothing on the waitlist", () => {
    for (const t of STAFF_TABLES) expect(granted("ohmail_worker", t).size > 0, t).toBe(t === "staff_sessions");
    expect(granted("ohmail_worker", "waitlist").size).toBe(0);
  });

  it("lets runtime readers see the topology marker without changing the fleet width", () => {
    expect([...granted("ohmail_worker", "worker_topology")]).toEqual(["SELECT"]);
    expect([...granted("ohmail_api", "worker_topology")]).toEqual(["SELECT"]);
  });

  it("the deadlines by role are the setup's table, cell for cell", () => {
    const fromRule: Record<string, Record<string, number>> = {};
    for (const [kind, role, guc, ms] of rows) if (kind === "deadline") (fromRule[role!] ??= {})[guc!] = Number(ms);
    expect(fromRule).toEqual(Object.fromEntries(Object.entries(ROLE_DEADLINES).map(([role, cell]) => [role, { ...cell }])));
  });
});
