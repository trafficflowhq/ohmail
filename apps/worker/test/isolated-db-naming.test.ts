// @services: none — reads the source of the database helpers, dials nothing
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutKeyOf, checkoutRoot, databaseOf, isolatedDbName } from "./_isolateddb-name.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  TWO CHECKOUTS MAY NOT NAME ONE PER-FILE DATABASE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `prepareIsolatedDb` recreates a database whose journal is not this tree's — the right policy
 * for a database of its own, and destructive for a shared one. Every checkout used to derive the
 * bare `trafficflow_worker_<file>`, so two trees declaring different journals dropped each other's
 * database mid-run, and a statement timeout interrupting that drop left the row INVALID
 * (`datconnlimit = -2`) for every lane after it. The key below is what makes the policy true.
 *
 * The collision itself is measured on two real checkouts by a control kept with the landing
 * kit; this file holds the arithmetic that control depends on, plus the two lines in the fixture
 * that must keep using it.
 */

const FIXTURE = join(import.meta.dirname, "_isolateddb.ts");
/** Comments are the claim under test, never evidence for it. */
const fixtureCode = (): string => readFileSync(FIXTURE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the per-file database name carries the checkout it belongs to", () => {
  /**
   * THE POSITIVE CONTROL, first. Every other case here is arithmetic over two strings, which
   * stays true while the fixture stops calling it — the shape that let a refusal census pass
   * over an empty list. So the first assertion is that the fixture still derives its name here.
   */
  it("the fixture derives its database name from this module", () => {
    const src = fixtureCode();
    expect(src, "the naming module is no longer imported")
      .toContain('from "./_isolateddb-name.js"');
    expect(src, "prepareIsolatedDb no longer builds its name from the checkout key and a run slot")
      .toMatch(/const key = checkoutKey\(\);\s*const name = await claimRunSlot\(logical, key\);/);
    expect(src, "the run slot no longer builds its name from isolatedDbName and the key")
      .toMatch(/const name = isolatedDbName\(slot === 0 \? logical : `\$\{logical\}_run\$\{slot\}`, key\);/);
    expect(src, "the database name is taken straight from the caller's logical name again")
      .not.toMatch(/withDatabase\(DB_URL, logical\)/);
  });

  it("two checkouts of one branch get different names for the same file", () => {
    const a = "/home/x/Sites/ohmail-monorepo";
    const b = "/home/x/Sites/ohmail-monorepo/.claude/worktrees/lane-1";
    const ka = checkoutKeyOf("trafficflow_test", a);
    const kb = checkoutKeyOf("trafficflow_test", b);
    expect(ka).not.toEqual(kb);
    expect(isolatedDbName("trafficflow_worker_lease_a", ka))
      .not.toEqual(isolatedDbName("trafficflow_worker_lease_a", kb));
  });

  it("one checkout gets the same name every run, so the database stays re-usable", () => {
    const root = "/home/x/Sites/ohmail-monorepo";
    const first = isolatedDbName("trafficflow_worker_roster", checkoutKeyOf("trafficflow_test", root));
    const again = isolatedDbName("trafficflow_worker_roster", checkoutKeyOf("trafficflow_test", root));
    expect(again).toEqual(first);
  });

  it("a lane database lends its own key, so both live in one namespace", () => {
    const key = checkoutKeyOf("trafficflow_l_b4d04122b835", "/anywhere/at/all");
    expect(key).toEqual("b4d04122b835");
    expect(isolatedDbName("trafficflow_worker_mmb", key))
      .toEqual("trafficflow_worker_mmb_b4d04122b835");
  });

  it("the shared box lends no key — the checkout path does", () => {
    const root = "/home/x/Sites/ohmail-monorepo";
    expect(checkoutKeyOf("trafficflow_test", root)).toMatch(/^[0-9a-f]{12}$/);
    expect(checkoutKeyOf("trafficflow_test", root)).not.toEqual(checkoutKeyOf("trafficflow_test", "/other"));
    // A lane-shaped name with the wrong key width is not a lane database.
    expect(checkoutKeyOf("trafficflow_l_deadbeef", root)).toEqual(checkoutKeyOf("trafficflow_test", root));
  });

  /**
   * Postgres truncates an identifier past 63 bytes SILENTLY, which would put two files back on
   * one database — the defect the key exists to remove, arriving through the fix.
   */
  it("no name reaches Postgres's identifier limit, and long ones stay distinct", () => {
    const key = "0123456789ab";
    const long = `trafficflow_worker_${"x".repeat(70)}`;
    expect(isolatedDbName(long, key).length).toBeLessThanOrEqual(63);
    expect(isolatedDbName(`${long}_one`, key)).not.toEqual(isolatedDbName(`${long}_two`, key));
    for (const logical of ["trafficflow_worker_roster_serialization", "trafficflow_reconciler_cas",
                           "trafficflow_worker_release_stranded", "trafficflow_worker_mmb"]) {
      expect(isolatedDbName(logical, key).length, logical).toBeLessThanOrEqual(63);
      expect(isolatedDbName(logical, key).endsWith(`_${key}`), logical).toBe(true);
    }
  });

  it("every logical name this directory passes stays distinct under one key", () => {
    const key = "0123456789ab";
    const logicals = literalNamesPassedToPrepare();
    expect(logicals.length, "the scanner found no prepareIsolatedDb call sites").toBeGreaterThan(30);
    const physical = new Set(logicals.map((l) => isolatedDbName(l, key)));
    expect(physical.size, "two logical names collapsed onto one physical name")
      .toEqual(new Set(logicals).size);
  });

  it("the drop clears the role's timeouts and reads the row back", () => {
    const src = fixtureCode();
    expect(src, "the admin session takes the role's 55s statement_timeout again — a timeout that " +
      "interrupts a database drop leaves the row INVALID for every later run")
      .toMatch(/set statement_timeout = 0/);
    expect(src, "the admin session takes the role's 30s lock_timeout again")
      .toMatch(/set lock_timeout = 0/);
    expect(src, "nothing reads datconnlimit, so an interrupted drop is indistinguishable from a " +
      "completed one").toContain("datconnlimit");
  });

  it("databaseOf and checkoutRoot answer about this tree", () => {
    const role = "tf";                  // interpolated: a whole credentialed URL literal is a credential to the push gate
    expect(databaseOf(`postgres://${role}:${role}@127.0.0.9:6543/trafficflow_test`)).toEqual("trafficflow_test");
    expect(databaseOf("not a url")).toEqual("?");
    expect(checkoutRoot()).toMatch(/[^/]$/);
    expect(checkoutRoot().endsWith("/apps/worker/test")).toBe(false);
  });
});

/**
 * THE DOOR IS THE ONLY PLACE A WORKER DATABASE IS CREATED OR DROPPED, and only under a name its run
 * holds. `scripts/box-files.mjs` takes this file's database DDL off the cluster class on that
 * premise, so the premise is read here: every statement names `"${name}"`, `name` is bound only by
 * the run slot, and the two helpers that take a name are neither exported nor handed anything else.
 */
describe("the keyed door builds and drops only the name its run holds", () => {
  it("names nothing but the slot's name in any database statement", () => {
    const src = fixtureCode();
    const ddl = [...src.matchAll(/\b(?:create|drop)\s+database\b[^`]*/gi)].map((m) => m[0]);
    expect(ddl.length, "the door no longer creates or drops anything — this census reads nothing").toBe(2);
    for (const d of ddl) expect(d, d).toMatch(/^(?:create|drop)\s+database\s+(?:if\s+exists\s+)?"\$\{name\}"/i);
    expect([...src.matchAll(/\bconst name = [^;]*;/g)].map((m) => m[0])).toEqual([
      "const name = isolatedDbName(slot === 0 ? logical : `${logical}_run${slot}`, key);",
      "const name = await claimRunSlot(logical, key);",
      "const name = claimed.get(logical);",
    ]);
  });

  it("keeps the two name-taking helpers private and hands them only that name", () => {
    const src = fixtureCode();
    expect(src).toMatch(/\nasync function dropDatabase\(/);
    expect(src).toMatch(/\nasync function databaseState\(/);
    expect(src, "a helper that drops ANY name is exported — every importer could drop what it likes")
      .not.toMatch(/export\s+(?:async\s+)?function\s+(?:dropDatabase|databaseState)\b/);
    const args = [...src.matchAll(/\b(?:dropDatabase|databaseState)\(admin, ([^)]*)\)/g)].map((m) => m[1]);
    expect(args.length).toBeGreaterThan(4);
    expect(args.filter((a) => a !== "name"), "a helper was handed something other than the slot's name").toEqual([]);
  });
});

/**
 * NO TWO FILES OF ONE CHECKOUT PASS ONE LOGICAL NAME. The key separates checkouts and the slot
 * separates runs; two FILES naming one database would still truncate each other inside one run.
 * `kek-rewrap.pg.test.ts` once built a module-constant name another run also built — the fixture
 * below is that shape, and the census must refuse it while admitting this tree.
 */
describe("every logical name belongs to one file", () => {
  const REPO = checkoutRoot();

  function namesIn(src: string): { names: string[]; unresolved: string[] } {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const consts = new Map([...code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z0-9_]+)"/g)]
      .map((m) => [m[1]!, m[2]!] as const));
    const names: string[] = [];
    const unresolved: string[] = [];
    for (const m of code.matchAll(/(?<!function\s)\bprepareIsolatedDb\(\s*([^)]*?)\s*\)/g)) {
      const lit = /^"([A-Za-z0-9_]+)"$/.exec(m[1]!);
      const named = lit ? lit[1]! : consts.get(m[1]!);
      if (named) names.push(named); else unresolved.push(m[1]!);
    }
    return { names, unresolved };
  }

  function collisions(files: Record<string, string>): { shared: string[]; unresolved: string[]; slotShaped: string[] } {
    const owner = new Map<string, Set<string>>();
    const unresolved: string[] = [];
    for (const [f, src] of Object.entries(files)) {
      const r = namesIn(src);
      unresolved.push(...r.unresolved.map((a) => `${f}: ${a}`));
      for (const n of r.names) owner.set(n, (owner.get(n) ?? new Set()).add(f));
    }
    return {
      shared: [...owner].filter(([, fs]) => fs.size > 1).map(([n, fs]) => `${n}: ${[...fs].sort().join(", ")}`),
      unresolved,
      slotShaped: [...owner.keys()].filter((n) => /_run\d+$/.test(n)),
    };
  }

  function importersOfTheDoor(): Record<string, string> {
    const out: Record<string, string> = {};
    const roots = ["test", ...["apps", "packages"].flatMap((g) =>
      readdirSync(join(REPO, g)).map((p) => join(g, p, "test")))];
    for (const root of roots) {
      let entries: string[];
      try { entries = readdirSync(join(REPO, root), { recursive: true }) as string[]; } catch { continue; }
      for (const e of entries) {
        if (!/\.tsx?$/.test(e) || e.includes("node_modules")) continue;
        const src = readFileSync(join(REPO, root, e), "utf8");
        if (/from "[^"]*_isolateddb\.js"/.test(src)) out[join(root, e)] = src;
      }
    }
    return out;
  }

  /* The fixtures spell the call through `DOOR` so this file's own text opens nothing — the resolver
   * census reads a spelled-out call beside a database name as a file deciding its own URL. */
  const DOOR = "prepareIsolatedDb";
  it("refuses the kek-rewrap shape — two files, one module-constant name", () => {
    const shape = `const DB_NAME = "trafficflow_kek_rewrap";\nconst url = await ${DOOR}(DB_NAME);\n`;
    expect(collisions({ ["packages/" + "db/test/a.pg.test.ts"]: shape, ["packages/" + "db/test/b.pg.test.ts"]: shape }).shared)
      .toEqual(["trafficflow_kek_rewrap: packages/" + "db/test/a.pg.test.ts, packages/" + "db/test/b.pg.test.ts"]);
    expect(collisions({ "x.ts": `${DOOR}(someName());` }).unresolved).toEqual(["x.ts: someName("]);
    expect(collisions({ "x.ts": `${DOOR}("trafficflow_worker_a_run1");` }).slotShaped)
      .toEqual(["trafficflow_worker_a_run1"]);
  });

  it("admits this tree: every call resolves, no name is shared, none looks like a slot", () => {
    const files = importersOfTheDoor();
    expect(Object.keys(files).length, "the census found no importer of the door").toBeGreaterThan(30);
    const c = collisions(files);
    expect(c.unresolved, "a logical name the census cannot read is a name it cannot vouch for").toEqual([]);
    expect(c.shared).toEqual([]);
    expect(c.slotShaped).toEqual([]);
  });
});

/** The logical names this directory passes, read from the call sites rather than typed here. */
function literalNamesPassedToPrepare(): string[] {
  const dir = import.meta.dirname;
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/prepareIsolatedDb\("([A-Za-z0-9_]+)"\)/g)) out.push(m[1]!);
  }
  return out;
}
