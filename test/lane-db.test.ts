// @services: none — lane-db.sh against a closed port; the box is never contacted
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LANE_DB_NAME_RE, assertLaneDbName, assertWorkerDbName, baseUrlFrom, databaseOf, decide, doorOfDb,
  isolatedLogicalsIn, laneDbName, parseLaneEnv, withDatabase, workerDbsOf,
  BOX_ROLE_DEADLINES_RC, LANE_ROLE_RE, assertLaneRoleName, boxRoleCheckVerdict, classifyEnv, deadlineKeysOf, roleDeadlinesVerdict,
  keptPassword, laneRoleDropPlan, laneRoleHostVerdict, laneRoleOf, laneRoleVerdict, laneUrl, maintenanceUrlFor,
} from "../scripts/lane-db.mjs";
import { pgTestUrlFrom } from "@trafficflow/db/testing";

/**
 * A DATABASE PER WORKTREE, AND THE THREE STATES IT CAN FIND ONE IN.
 *
 * `scripts/lane-db.sh` is what lets two lanes run pg suites at once, so its decisions are the
 * rule: which database a worktree owns, when that database may be reused, and when it must be
 * refused rather than rebuilt. The refusal is the one that matters most — a database AHEAD of the
 * tree records every migration the tree adds as applied WITHOUT RUNNING it and raises nothing.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SH = join(REPO, "scripts", "lane-db.sh");
const BOX = "postgres://tf:tf@localhost:5433/trafficflow_test";
/* A fixture URL at a host that is not loopback interpolates its userinfo: the push gate reads a whole
 * `user:password@host` literal there as a credential, and it reads a `+` split joined. */
const BOX_ROLE = "tf";
const FIXTURE_USER = "u";

const maxima = (mail: [number, number], cloud: [number, number]) => [
  { name: "mail", tree: mail[0], db: mail[1] },
  { name: "cloud", tree: cloud[0], db: cloud[1] },
];

/** The cases that run lane-db.sh to its lock: it needs flock, sha256sum and `realpath -m`, which a Mac or Windows host lacks. */
const onLinux = it.skipIf(process.platform !== "linux");

describe("the lane database's name", () => {
  it("is the same for one path and different for two", () => {
    expect(laneDbName("/a/b/wt-one")).toBe(laneDbName("/a/b/wt-one"));
    expect(laneDbName("/a/b/wt-one")).not.toBe(laneDbName("/a/b/wt-two"));
  });

  it("is the ABSOLUTE path's hash, so two spellings of one worktree agree", () => {
    expect(laneDbName("/a/b/wt")).toBe(laneDbName("/a/b/./wt"));
  });

  it("carries a prefix no other database on this server uses", () => {
    for (const p of ["/x/one", "/y/two", "/z/three"]) {
      expect(laneDbName(p)).toMatch(LANE_DB_NAME_RE);
      expect(laneDbName(p).startsWith("trafficflow_test")).toBe(false);
      expect(laneDbName(p).startsWith("trafficflow_worker_")).toBe(false);
    }
  });

  /* The hard stop: this tool may drop its own databases and nothing else. */
  it("refuses to touch anything that is not one of its own", () => {
    for (const bad of ["trafficflow_test", "trafficflow_worker_roster", "postgres",
                       "trafficflow_l_NOTHEX0000", "trafficflow_l_abc"]) {
      expect(() => assertLaneDbName(bad), bad).toThrow(/refusing to touch/);
    }
    expect(assertLaneDbName(laneDbName("/a/b/wt"))).toBe(laneDbName("/a/b/wt"));
  });
});

describe("what to do with a database that already exists", () => {
  it("creates when there is none", () => {
    expect(decide({ exists: false, drift: null, maxima: maxima([9, 0], [4, 0]) }).action)
      .toBe("create");
  });

  it("reuses when both journals match", () => {
    expect(decide({ exists: true, drift: null, maxima: maxima([9, 9], [4, 4]) }).action)
      .toBe("reuse");
  });

  it("rebuilds from empty when the TREE is ahead, in either journal", () => {
    expect(decide({ exists: true, drift: null, maxima: maxima([9, 8], [4, 4]) }).action)
      .toBe("recreate");
    expect(decide({ exists: true, drift: null, maxima: maxima([9, 9], [4, 3]) }).action)
      .toBe("recreate");
  });

  it("rebuilds when a migration was edited in place — same maxima, different content", () => {
    const v = decide({ exists: true, drift: "mail: the migration applied at 9 has been edited",
                       maxima: maxima([9, 9], [4, 4]) });
    expect(v.action).toBe("recreate");
    expect(v.reason).toContain("edited");
  });

  it("REFUSES when the database is ahead, and prints both maxima", () => {
    const v = decide({ exists: true, drift: null, maxima: maxima([9, 10], [4, 4]) });
    expect(v.action).toBe("refuse");
    expect(v.reason).toContain("db 10 > tree 9");
    expect(v.reason).toContain("without");           // "...applied without running"
  });

  /* A database ahead is ALSO drift, and the two policies differ: refuse, never rebuild. Nothing
   * else in the file distinguishes the order these two arms are asked in. */
  it("refuses an AHEAD database even though drift also describes it", () => {
    expect(decide({
      exists: true,
      drift: "mail: this database records a migration applied at 10 that this tree does not declare",
      maxima: maxima([9, 10], [4, 4]),
    }).action).toBe("refuse");
  });
});

describe("the pointer file and the base URL", () => {
  it("reads PG_TEST_URL out of a .lane-db.env body and ignores the rest", () => {
    expect(parseLaneEnv(`# a note\nPG_TEST_URL=postgres://${FIXTURE_USER}:p@h:1/db\n`)).toBe(`postgres://${FIXTURE_USER}:p@h:1/db`);
    expect(parseLaneEnv("OTHER=1\n")).toBeNull();
    expect(parseLaneEnv("")).toBeNull();
  });

  it("names the database without the credentials in front of it", () => {
    expect(databaseOf(`postgres://${FIXTURE_USER}:secret@h:5433/trafficflow_l_0123456789ab`))
      .toBe("trafficflow_l_0123456789ab");
    expect(withDatabase(BOX, "trafficflow_l_0123456789ab"))
      .toBe("postgres://tf:tf@localhost:5433/trafficflow_l_0123456789ab");
  });

  it("takes the base from the environment the tests read, in their order", () => {
    expect(baseUrlFrom({})).toBe(BOX);
    expect(baseUrlFrom({ DATABASE_URL: "postgres://h/three" })).toBe("postgres://h/three");
    expect(baseUrlFrom({ DATABASE_URL: "postgres://h/three", DATABASE_URL_SESSION: "postgres://h/two" }))
      .toBe("postgres://h/two");
    expect(baseUrlFrom({ DATABASE_URL_SESSION: "postgres://h/two", DATABASE_URL_PG_TEST: "postgres://h/one" }))
      .toBe("postgres://h/one");
  });
});

/**
 * THE RESOLVER EVERY PG-TOUCHING TEST GOES THROUGH.
 *
 * With no lane database the answer is byte-identical to what it was before lane databases existed;
 * with one, the FILE wins over the environment, because box files in such a worktree run without
 * the Postgres lock and an environment variable pointing them back at the shared box is exactly
 * the unlocked shared write this removes.
 */
describe("PG_TEST_URL", () => {
  const LANE = "postgres://tf:tf@localhost:5433/trafficflow_l_0123456789ab";

  it("falls back to the environment, then to the compose service, with no lane database", () => {
    expect(pgTestUrlFrom({}, null)).toBe(BOX);
    expect(pgTestUrlFrom({ DATABASE_URL: "postgres://h/three" }, null)).toBe("postgres://h/three");
    expect(pgTestUrlFrom({ DATABASE_URL_PG_TEST: "postgres://h/one", DATABASE_URL: "postgres://h/three" }, null))
      .toBe("postgres://h/one");
  });

  it("takes the lane database over the environment", () => {
    expect(pgTestUrlFrom({}, LANE)).toBe(LANE);
    expect(pgTestUrlFrom({ DATABASE_URL_SESSION: BOX }, LANE)).toBe(LANE);
    expect(pgTestUrlFrom({ DATABASE_URL_PG_TEST: BOX }, LANE)).toBe(LANE);
  });
});

describe("what the tool refuses before it opens a connection", () => {
  const run = (args: string[], cwd = REPO) =>
    spawnSync("bash", [SH, ...args], { cwd, encoding: "utf8" });

  it("wants exactly one worktree", () => {
    expect(run([]).status).toBe(2);
    expect(run([]).stderr).toContain("accepted");
    const two = run([".", "packages"]);
    expect(two.status).toBe(2);
    expect(two.stderr).toContain("one worktree at a time");
  });

  it("says which directory it could not find", () => {
    const r = run(["/no/such/worktree"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("/no/such/worktree");
  });

  /* --list-invalid reads the whole server and drops nothing, so it takes nothing beside it. */
  onLinux("takes --list-invalid alone, refusing a worktree or another flag beside it (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    for (const args of [["--list-invalid", "."], ["--list-invalid", "--drop"], ["--check", "--list-invalid", "."]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("--list-invalid alone");
    }
  });

  it("names the door of each database --list-invalid reads", () => {
    expect(doorOfDb("trafficflow_l_0123456789ab")).toBe("lane-db");
    expect(doorOfDb("trafficflow_worker_runslot_0123456789ab")).toBe("worker");
    expect(doorOfDb("ohmail_trgm_probe_0a1b2c3d")).toBe("other");
    expect(doorOfDb("trafficflow_test")).toBe("other");
  });

  onLinux("refuses a flag it does not know rather than reading it as a path (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    const r = run(["--drops", "."]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--drops");
  });

  /* A DROP MIGRATES NOTHING, so a worktree that is already gone is the ordinary case of a cleanup
   * done in the wrong order — and refusing it is how a database is left on :5433 with nothing that
   * can ever name it again. 567 leftovers were measured there on 2026-09-13, and this refusal is
   * one of the roads in. The base URL points at a closed port throughout, so these cases prove the
   * RESOLUTION and the fence without contacting the box: everything asserted below is printed
   * before the first connection is opened. */
  const DEAD = "postgres://tf:tf@127.0.0.1:1/trafficflow_test";
  const runDead = (args: string[]) =>
    spawnSync("bash", [SH, ...args], {
      cwd: REPO, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_URL_PG_TEST: DEAD },
    });

  onLinux("drops the database of a worktree that has already been removed (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    const gone = join(tmpdir(), `lane-db-vanished-${process.pid}`);
    const r = runDead(["--drop", gone]);
    expect(r.stderr, "the create-path refusal fired on a drop").not.toContain("no such directory");
    expect(r.stderr).toContain("is gone");
    // The key is unchanged: the sha256 of the path, so the name is the one the worktree owned.
    expect(r.stderr).toContain(laneDbName(gone));
    // And it answers from THIS checkout, said out loud rather than guessed at.
    expect(r.stderr).toContain(REPO);
  }, 60_000);

  it("still refuses a MISSING worktree when it is not a drop", () => {
    const r = runDead([join(tmpdir(), `lane-db-vanished-${process.pid}`)]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no such directory");
  }, 60_000);

  it("drops one named database with no worktree at all, and fences the name first", () => {
    // The fence runs before any connection: a name outside trafficflow_l_<12 hex> never reaches the
    // server, which is what makes `--name` safe to drive from a census list.
    const refused = runDead(["--drop", "--name", "trafficflow_test"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refusing to touch "trafficflow_test"');
    expect(refused.stderr, "the fence let it reach the server").not.toContain("ECONNREFUSED");

    // POSITIVE CONTROL: a well-formed lane name passes the fence and reaches the connection, which
    // is how we know the refusal above is about the NAME and not about the flag.
    const admitted = runDead(["--drop", "--name", "trafficflow_l_0123456789ab"]);
    expect(admitted.stderr).toContain("trafficflow_l_0123456789ab (from --name)");
    expect(admitted.status, admitted.stderr.slice(-200)).toBe(1);
  }, 60_000);

  onLinux("refuses --name beside a worktree, and --name without --drop (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    const both = runDead(["--drop", "--name", "trafficflow_l_0123456789ab", REPO]);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("takes no worktree");

    const noDrop = runDead(["--name", "trafficflow_l_0123456789ab"]);
    expect(noDrop.status).toBe(2);
    expect(noDrop.stderr).toContain("--drop");
  }, 60_000);

  /* It migrates the tree it is GIVEN — a directory with no `packages/db` is not one. */
  it("refuses a directory that is not this workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-db-"));
    try {
      const r = spawnSync(join(REPO, "node_modules/.bin/tsx"),
        ["--conditions=ohmail-source", join(REPO, "scripts", "lane-db.mjs"), dir], { cwd: REPO, encoding: "utf8" });
      // Name a missing tsx rather than reporting it as the refusal not firing.
      expect(r.error, "tsx did not run — is this tree installed?").toBeUndefined();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("packages/db/src/admin.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * THE WORKER'S PER-FILE DATABASES GO WITH THE LANE DATABASE.
 *
 * `prepareIsolatedDb` names one database per worker test file per checkout, and a drop used to take
 * the lane database and leave every one of them: thousands of them stood on :5433 against a few lane
 * databases on 2026-09-17, with nothing left that could name them. Both namespaces are keyed by one
 * derivation, `checkoutKeyOf`, so the names below come from the FIXTURE'S OWN producer and meet the
 * drop's selector with nothing re-spelled in between — a second spelling of the rule is how the two
 * would drift apart again.
 */
describe("the worker databases a drop takes with it", () => {
  const TSX = join(REPO, "node_modules/.bin/tsx");
  const NAMING = pathToFileURL(join(REPO, "apps/worker/test/_isolateddb-name.ts")).href;

  const produced = (lane: string, root: string, logicals: string[]) => {
    const script =
      `import(${JSON.stringify(NAMING)}).then((m) => {` +
      `const key = m.checkoutKeyOf(${JSON.stringify(lane)}, ${JSON.stringify(root)});` +
      `console.log(JSON.stringify({ key,` +
      ` pathKey: m.checkoutKeyOf("trafficflow_test", ${JSON.stringify(root)}),` +
      ` names: ${JSON.stringify(logicals)}.map((l) => m.isolatedDbName(l, key)) }));` +
      `})`;
    const r = spawnSync(TSX, ["--conditions=ohmail-source", "-e", script], { cwd: REPO, encoding: "utf8" });
    expect(r.error, "tsx did not run — is this tree installed?").toBeUndefined();
    expect(r.status, String(r.stderr).slice(-300)).toBe(0);
    return JSON.parse(r.stdout) as { key: string; pathKey: string; names: string[] };
  };

  const LOGICAL = ["trafficflow_worker_lease_a", "trafficflow_worker_roster"];

  it("takes this checkout's two and leaves the other checkout's alone", () => {
    const a = produced("trafficflow_l_aaaaaaaaaaaa", "/checkouts/a", LOGICAL);
    const b = produced("trafficflow_l_bbbbbbbbbbbb", "/checkouts/b", LOGICAL);
    expect(a.key).not.toEqual(b.key);
    const onTheServer = [...a.names, ...b.names, "trafficflow_l_aaaaaaaaaaaa", "trafficflow_test"];
    expect(workerDbsOf(onTheServer, [a.key])).toEqual(a.names);
    expect(workerDbsOf(onTheServer, [b.key])).toEqual(b.names);
  });

  /* A concurrent run of one checkout gets a slot name (`<logical>_run<n>`, spelled in `_isolateddb.ts`
   * and pinned by `isolated-db-naming.test.ts`); its key still ends the name, so the drop takes it. */
  it("takes the run-slot databases a second run of this checkout made", () => {
    const a = produced("trafficflow_l_aaaaaaaaaaaa", "/checkouts/a",
      ["trafficflow_worker_roster", "trafficflow_worker_roster_run1", "trafficflow_worker_roster_run7"]);
    expect(workerDbsOf([...a.names, "trafficflow_test"], [a.key])).toEqual(a.names);
    for (const n of a.names) expect(assertWorkerDbName(n)).toBe(n);
  });

  /* The key alone does not fence: the lane database being dropped ends in it, and so does anybody
   * else's twin whose name happens to. Both were on :5433 when this was written. */
  it("never takes the lane database itself, nor a foreign name ending in the same twelve hex", () => {
    const alsoEndsInTheKey = [
      "trafficflow_l_aaaaaaaaaaaa", "plane_t_aaaaaaaaaaaa", "ohmail_ledger31_aaaaaaaaaaaa",
      "trafficflow_kek_rewrap_aaaaaaaaaaaa",
    ];
    expect(workerDbsOf(alsoEndsInTheKey, ["aaaaaaaaaaaa"])).toEqual([]);
    expect(() => assertWorkerDbName("trafficflow_l_aaaaaaaaaaaa")).toThrow(/refusing to touch/);
    // POSITIVE CONTROL, so the refusal above is about the NAME and not about the call.
    expect(assertWorkerDbName("trafficflow_worker_roster_aaaaaaaaaaaa"))
      .toBe("trafficflow_worker_roster_aaaaaaaaaaaa");
  });

  /* THE PER-FILE DATABASES THE TREE NAMES (MATURITY-026): `prepareIsolatedDb("<logical>")` makes
   * `<logical>_<key>`, and a drop took only `trafficflow_worker_*`, leaving four per clone. A logical is
   * read from the tree's own call sites; the same name with no such call site stays foreign. */
  it("takes a per-file database the tree's own call sites name, with this checkout's key, and nothing else", () => {
    // Spelled through DOOR, as isolated-db-naming.test.ts does, so this file's own text opens nothing.
    const DOOR = "prepareIsolatedDb";
    const logicals = isolatedLogicalsIn([
      `const url = await ${DOOR}("trafficflow_kek_rewrap");`,
      `const DB_NAME = "trafficflow_away_mark_dto";\nconst url = await ${DOOR}(DB_NAME);`,
      `${DOOR}("trafficflow_worker_roster");`,
    ]);
    expect(logicals).toEqual(["trafficflow_away_mark_dto", "trafficflow_kek_rewrap"]);
    const onTheServer = [
      "trafficflow_kek_rewrap_aaaaaaaaaaaa", "trafficflow_away_mark_dto_aaaaaaaaaaaa", "trafficflow_kek_rewrap_bbbbbbbbbbbb",
      "trafficflow_l_aaaaaaaaaaaa", "trafficflow_tpl_aaaaaaaaaaaa", "trafficflow_new_for_you_aaaaaaaaaaaa",
    ];
    expect(workerDbsOf(onTheServer, ["aaaaaaaaaaaa"], logicals)).toEqual(["trafficflow_kek_rewrap_aaaaaaaaaaaa", "trafficflow_away_mark_dto_aaaaaaaaaaaa"]);
    expect(workerDbsOf(onTheServer, ["aaaaaaaaaaaa"])).toEqual([]);
    expect(assertWorkerDbName("trafficflow_kek_rewrap_aaaaaaaaaaaa", logicals)).toBe("trafficflow_kek_rewrap_aaaaaaaaaaaa");
    expect(() => assertWorkerDbName("trafficflow_l_aaaaaaaaaaaa", logicals)).toThrow(/refusing to touch/);
  });

  /* A checkout has TWO keys over its life: its lane database's hex, and the path hash it used for
   * any worker run made before `lane-db.sh` gave it one. Both are printed BEFORE a connection is
   * opened, so this reads them against a closed port. */
  const DEAD_URL = "postgres://tf:tf@127.0.0.1:1/trafficflow_test";
  const drive = (args: string[]) =>
    spawnSync("bash", [SH, ...args], {
      cwd: REPO, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_URL_PG_TEST: DEAD_URL },
    });

  /* An ordinary checkout has ONE key, not two: `laneDbName` IS the path hash, so the lane
   * database's own hex and the path hash are the same twelve characters. The second key exists for
   * a worktree whose pointer file names a database written for another path — the moved-worktree
   * case — which is why the drop derives both and prints what it deduped to. */
  it("has one key for an ordinary checkout and two only for a moved one", () => {
    const here = join(tmpdir(), `lane-db-keys-${process.pid}`);
    const elsewhere = join(tmpdir(), `lane-db-moved-${process.pid}`);
    const ordinary = produced(laneDbName(here), here, []);
    expect(ordinary.key).toEqual(ordinary.pathKey);
    const moved = produced(laneDbName(elsewhere), here, []);
    expect(moved.key).not.toEqual(moved.pathKey);
    expect(moved.key).toEqual(laneDbName(elsewhere).replace("trafficflow_l_", ""));
  }, 60_000);

  onLinux("prints the key it will use before it opens a connection (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    const gone = join(tmpdir(), `lane-db-keys-${process.pid}`);
    const { key } = produced(laneDbName(gone), gone, []);
    expect(drive(["--drop", gone]).stderr).toContain(`checkout keys ${key}`);
  }, 60_000);

  it("has only the lane key when it is given a name and no worktree, and says so", () => {
    const r = drive(["--drop", "--name", "trafficflow_l_012345678901"]);
    expect(r.stderr).toContain("checkout keys 012345678901 (no worktree");
    expect(r.stderr).not.toContain("checkout keys 012345678901 b");
  }, 60_000);
});


/**
 * A LANE DIALS AS ITS OWN ROLE.
 *
 * setupProdDatabase ALTERs the role it connects as, role-wide; a rig that booted the self-host
 * server from a lane env written as `tf` put three deadlines on every connection to the box. Each
 * lane database is dialled as `tf_l_<its 12 hex>`, so that ALTER reaches one lane. Everything below
 * is pure or offline: the live arms are a control kept with the landing kit.
 */
describe("the lane role", () => {
  const DB = "trafficflow_l_0123456789ab";
  const PW = "0123456789abcdef0123456789abcdef";

  it("is the database's own twelve hex, and nothing else is a lane role", () => {
    expect(laneRoleOf(DB)).toBe("tf_l_0123456789ab");
    expect(laneRoleOf(DB)).toMatch(LANE_ROLE_RE);
    for (const bad of ["tf", "postgres", "tf_l_NOTHEX000000", "tf_l_0123", "ohmail_setup_role_0123456789ab", "tf_l_0123456789ab_x"]) {
      expect(() => assertLaneRoleName(bad), bad).toThrow(/refusing to touch role/);
    }
    expect(() => laneRoleOf("trafficflow_test")).toThrow(/refusing to touch/);
  });

  it("is made on the local :5433 box only, or a throwaway port named by its variable", () => {
    expect(laneRoleHostVerdict("postgres://tf:tf@localhost:5433/x").ok).toBe(true);
    expect(laneRoleHostVerdict("postgres://tf:tf@127.0.0.1:5433/x").ok).toBe(true);
    const remote = laneRoleHostVerdict(`postgres://${BOX_ROLE}:${BOX_ROLE}@db.example.com:5433/x`);
    expect(remote.ok).toBe(false);
    expect(remote.say).toContain("db.example.com");
    expect(laneRoleHostVerdict("postgres://tf:tf@127.0.0.1:47533/x").ok).toBe(false);
    expect(laneRoleHostVerdict("postgres://tf:tf@127.0.0.1:47533/x", { OHMAIL_LANE_DB_THROWAWAY_PORT: "47533" }).ok).toBe(true);
    expect(laneRoleHostVerdict("postgres://tf:tf@127.0.0.1:47533/x", { OHMAIL_LANE_DB_THROWAWAY_PORT: "47534" }).ok).toBe(false);
    expect(laneRoleHostVerdict(`postgres://${BOX_ROLE}:${BOX_ROLE}@db.example.com:47533/x`, { OHMAIL_LANE_DB_THROWAWAY_PORT: "47533" }).ok).toBe(false);
  });

  it("writes the box's host and database with the lane role's credentials", () => {
    const u = new URL(laneUrl("postgres://tf:tf@localhost:5433/trafficflow_test", DB, PW));
    expect([u.username, u.password, u.hostname, u.port, u.pathname]).toEqual(["tf_l_0123456789ab", PW, "localhost", "5433", `/${DB}`]);
    expect(() => laneUrl("postgres://tf:tf@localhost:5433/x", DB, "tf")).toThrow(/32 hex/);
  });

  it("keeps a password only from an env that already dials as that role", () => {
    expect(keptPassword(`PG_TEST_URL=postgres://tf_l_0123456789ab:${PW}@localhost:5433/${DB}\n`, "tf_l_0123456789ab")).toBe(PW);
    expect(keptPassword(`PG_TEST_URL=postgres://tf:tf@localhost:5433/${DB}\n`, "tf_l_0123456789ab")).toBeNull();
    expect(keptPassword(`PG_TEST_URL=postgres://tf_l_aaaaaaaaaaaa:${PW}@localhost:5433/${DB}\n`, "tf_l_0123456789ab")).toBeNull();
    expect(keptPassword(null, "tf_l_0123456789ab")).toBeNull();
  });

  it("reads the deadline keys a role carries, by scope, and nothing else", () => {
    expect(deadlineKeysOf([
      { setdatabase: 0, datname: null, setconfig: ["lock_timeout=30000ms", "search_path=public", "statement_timeout=55000ms"] },
      { setdatabase: 16384, datname: DB, setconfig: ["idle_in_transaction_session_timeout=60000ms"] },
    ])).toEqual([{ key: "lock_timeout", db: null }, { key: "statement_timeout", db: null }, { key: "idle_in_transaction_session_timeout", db: DB }]);
  });

  /* THE DROP'S SELECTOR: the role goes last, templates it built are handed over, anything else keeps
   * it — and a role that is not the dropped database's own is refused before any of it. */
  it("drops only the dropped database's role, handing templates over and keeping it for anything else", () => {
    const role = "tf_l_0123456789ab";
    expect(laneRoleDropPlan({ dbName: DB, role, owned: [] })).toEqual({ handOver: [], blocking: [], dropRole: true });
    expect(laneRoleDropPlan({ dbName: DB, role, owned: ["trafficflow_tpl_0123456789abcdef"] }))
      .toEqual({ handOver: ["trafficflow_tpl_0123456789abcdef"], blocking: [], dropRole: true });
    expect(laneRoleDropPlan({ dbName: DB, role, owned: ["trafficflow_tpl_0123456789abcdef", "trafficflow_l_aaaaaaaaaaaa", "mine"] }))
      .toEqual({ handOver: ["trafficflow_tpl_0123456789abcdef"], blocking: ["trafficflow_l_aaaaaaaaaaaa", "mine"], dropRole: false });
    // B then A: dropping lane B never names lane A's role, and never the box role.
    expect(() => laneRoleDropPlan({ dbName: "trafficflow_l_bbbbbbbbbbbb", role: "tf_l_aaaaaaaaaaaa", owned: [] })).toThrow(/refusing to drop role/);
    expect(() => laneRoleDropPlan({ dbName: DB, role: "tf", owned: [] })).toThrow(/refusing to drop role/);
  });

  /* --check reads the role in this tree (the kit reader it once spawned left with the monorepo). */
  it("reads a role's deadlines: each named with its scope rc 3, other settings CLEAN, no anchor rc 2", () => {
    const wide = roleDeadlinesVerdict({ role: "tf", anchor: 1, rows: [
      { rolname: "tf", setdatabase: 0, datname: null, setconfig: ["lock_timeout=30s", "statement_timeout=55s", "idle_in_transaction_session_timeout=60s"] },
    ] });
    expect(wide.rc).toBe(3);
    expect(wide.line).toMatch(/^BOX_ROLE_DEADLINES REFUSED role=tf lock_timeout=30s@role-wide statement_timeout=55s@role-wide idle_in_transaction_session_timeout=60s@role-wide — /);
    const scoped = roleDeadlinesVerdict({ role: "tf", anchor: 1, rows: [
      { rolname: "tf", setdatabase: 16384, datname: "rig_db", setconfig: ["statement_timeout=55s"] },
    ] });
    expect([scoped.rc, scoped.line.split(" — ")[0]]).toEqual([3, "BOX_ROLE_DEADLINES REFUSED role=tf statement_timeout=55s@db:rig_db"]);
    // A non-deadline setting on the role, and another role's deadlines, are not this role's.
    const clean = roleDeadlinesVerdict({ role: "tf", anchor: 1, rows: [
      { rolname: "tf", setdatabase: 0, datname: null, setconfig: ["search_path=public"] },
      { rolname: "rig", setdatabase: 0, datname: null, setconfig: ["lock_timeout=30s"] },
    ] });
    expect(clean).toEqual({ rc: 0, line: "BOX_ROLE_DEADLINES CLEAN role=tf setting-rows=1 deadline-keys=0 (anchor pg_roles tf=1)" });
    const none = roleDeadlinesVerdict({ role: "tf", anchor: 0, rows: [] });
    expect(none.rc).toBe(2);
    expect(none.line).toMatch(/^BOX_ROLE_DEADLINES UNREADABLE role=tf — /);
    // Each verdict maps through the check's own table to rc 0, 4 and 2.
    expect([clean, wide, none].map((v) => boxRoleCheckVerdict(v.rc, v.line).rc)).toEqual([0, 4, 2]);
  });

  it("maps the box role reading to rc 0, rc 4 BOX_ROLE_DEADLINES or rc 2 UNREADABLE, each by name", () => {
    expect(BOX_ROLE_DEADLINES_RC).toBe(4);
    expect(boxRoleCheckVerdict(0, "BOX_ROLE_DEADLINES CLEAN role=tf setting-rows=0 deadline-keys=0 (anchor pg_roles tf=1)").rc).toBe(0);
    const refused = boxRoleCheckVerdict(3, "BOX_ROLE_DEADLINES REFUSED role=tf lock_timeout=30000ms@role-wide — every later connection");
    expect([refused.rc, refused.verdict]).toEqual([4, "BOX_ROLE_DEADLINES"]);
    const unread = boxRoleCheckVerdict(2, "BOX_ROLE_DEADLINES UNREADABLE role=tf — the catalog could not be read (ECONNREFUSED)");
    expect([unread.rc, unread.verdict]).toEqual([2, "UNREADABLE"]);
    // A reader rc this table did not write is never green and never ABSENT.
    for (const [rc, line] of [[3, "something else"], [1, "Error: boom"], [null, ""], [0, "garbage"]] as const) {
      expect(boxRoleCheckVerdict(rc, line).rc, `${rc} ${line}`).toBe(2);
    }
  });

  it("names the lane role's own deadlines apart from tf's, rc 4 both", () => {
    const lane = boxRoleCheckVerdict(3, "BOX_ROLE_DEADLINES REFUSED role=tf_l_0123456789ab lock_timeout=30000ms@role-wide", "LANE_ROLE_DEADLINES");
    expect([lane.rc, lane.verdict]).toEqual([4, "LANE_ROLE_DEADLINES"]);
    expect(lane.say).toContain("lane-db.sh <worktree> resets it");
    // The reader's whole line carries tf's remedy; the lane role's line names the lane's remedy only.
    const said = (role: string) => `BOX_ROLE_DEADLINES REFUSED role=${role} lock_timeout=30000ms@role-wide — every later connection as ${role} inherits these; a rig booted setup-prod or the self-host server as the box role. Ask the dispatcher, who resets them (ALTER ROLE ${role} RESET <key>) and reads them back`;
    const own = boxRoleCheckVerdict(3, said("tf_l_0123456789ab"), "LANE_ROLE_DEADLINES").say;
    expect(own).toContain("BOX_ROLE_DEADLINES REFUSED role=tf_l_0123456789ab lock_timeout=30000ms@role-wide");
    expect(own).toContain("lane-db.sh <worktree> resets it");
    expect(own).not.toMatch(/Ask the dispatcher|as the box role/);
    expect(boxRoleCheckVerdict(3, said("tf")).say, "tf's line keeps the reader's remedy").toContain("Ask the dispatcher");
  });

  /* After a box loss the lane role is gone with the cluster: dialling as it read 28P01, UNREADABLE,
   * and the drivers owed the box half for ever. --check reads as the maintenance role instead. */
  it("reads --check on the env's server with the maintenance role's credentials", () => {
    const m = new URL(maintenanceUrlFor(`postgres://tf_l_0123456789ab:${PW}@127.0.0.1:5399/${DB}`, "postgres://tf:boxpw@localhost:5433/trafficflow_test"));
    expect([m.username, m.password, m.hostname, m.port, m.pathname]).toEqual(["tf", "boxpw", "127.0.0.1", "5399", "/postgres"]);
  });

  it("answers the lane role's half: ROLE_ABSENT and LOGIN_REFUSED are rebuilds (rc 3), a legacy tf env passes", () => {
    const v = (role: string, roleExists: boolean, login: string) => laneRoleVerdict({ role, roleExists, login });
    expect([v("tf_l_0123456789ab", false, "not tried").rc, v("tf_l_0123456789ab", false, "not tried").verdict]).toEqual([3, "ROLE_ABSENT"]);
    expect([v("tf_l_0123456789ab", true, "refused").rc, v("tf_l_0123456789ab", true, "refused").verdict]).toEqual([3, "LOGIN_REFUSED"]);
    expect(v("tf_l_0123456789ab", true, "ok").rc).toBe(0);
    expect(v("tf_l_0123456789ab", true, "ECONNRESET").rc).toBe(2);
    expect(v("tf", true, "not tried").verdict).toBe("LEGACY_ROLE");
    expect(v("someone", true, "not tried").rc).toBe(3);
  });

  it("git-ignores the env's write-then-rename temp, which carries the password", () => {
    const r = spawnSync("git", ["check-ignore", "-q", ".lane-db.env.tmp-12345"], { cwd: REPO });
    expect(r.status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", "lane-db.env.tmp-12345"], { cwd: REPO }).status).toBe(1);
  });

  it("git-ignores env files, keys and the credential files by name anywhere, and hides no tracked file", () => {
    // The rules alone (--no-index), and the credential files only under a directory that does not exist.
    const ignored = (p: string): number | null => spawnSync("git", ["check-ignore", "--no-index", "-q", p], { cwd: REPO }).status;
    const absent = `no-such-dir-${process.pid}`;
    for (const p of [".env", ".env.local", "deploy/selfhost/.env", ".vercel/project.json", "apps/api-vercel/.vercel/project.json",
      "release.pem", `${absent}/.access-tokens`, `${absent}/.testmailaccounts`]) expect(ignored(p), p).toBe(0);
    for (const p of ["deploy/selfhost/.env.example", `${absent}/.env.example`, "docs/env.md"]) expect(ignored(p), p).toBe(1);
    const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
    const hidden = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], { cwd: REPO, input: tracked, encoding: "utf8" });
    expect([hidden.status, hidden.stdout.split("\0").filter(Boolean)]).toEqual([1, []]);
  });

  it("classifies an env file by the role it dials as, legacy tf apart", () => {
    expect(classifyEnv(`PG_TEST_URL=postgres://tf:tf@localhost:5433/${DB}\n`).kind).toBe("legacy");
    expect(classifyEnv(`PG_TEST_URL=postgres://tf_l_0123456789ab:${PW}@localhost:5433/${DB}\n`).kind).toBe("lane-role");
    expect(classifyEnv("PG_TEST_URL=postgres://someone:x@localhost:5433/x\n").kind).toBe("other");
    expect(classifyEnv("DB_URL=x\n").kind).toBe("unreadable");
  });

  const runOffline = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [SH, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

  it("counts the legacy env files under a root, beside its planted control, and prints no credential", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-db-legacy-"));
    try {
      for (const [d, body] of [
        ["old", `PG_TEST_URL=postgres://tf:tf@localhost:5433/${DB}\n`],
        ["new/deeper", `PG_TEST_URL=postgres://tf_l_0123456789ab:${PW}@localhost:5433/${DB}\n`],
        ["node_modules/x", `PG_TEST_URL=postgres://tf:tf@localhost:5433/${DB}\n`],
      ]) { mkdirSync(join(root, d), { recursive: true }); writeFileSync(join(root, d, ".lane-db.env"), body); }
      const r = runOffline(["--list-legacy", "--root", root]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`LEGACY ${join(root, "old", ".lane-db.env")} role=tf localhost:5433/${DB}`);
      expect(r.stdout).toContain("LANE_DB_LEGACY legacy=1 lane-role=1 other=0 unreadable=0 scanned=2 control=legacy");
      expect(r.stderr).toContain("skipped by name: node_modules");
      expect(`${r.stdout}${r.stderr}`).not.toContain(PW);
      expect(runOffline(["--list-legacy", "--root", join(root, "no-such")]).status).toBe(2);
      expect(runOffline(["--list-legacy", "--drop"]).status).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  /* The host fence runs before any connection and before the env file is written. */
  onLinux("refuses to make a lane role anywhere but the local box, before it connects (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", () => {
    for (const base of [`postgres://${BOX_ROLE}:${BOX_ROLE}@db.example.com:5433/trafficflow_test`, `postgres://${BOX_ROLE}:${BOX_ROLE}@127.0.0.1:1/trafficflow_test`]) {
      const r = runOffline([REPO], { DATABASE_URL_PG_TEST: base });
      expect(r.status, base).toBe(1);
      expect(r.stderr, base).toContain("REFUSED:");
      expect(r.stderr, base).not.toContain("ECONNREFUSED");
    }
  }, 60_000);

  /* --check dials with the box's credentials at the host the env file names, so it asks the
   * create's host verdict first: an env naming another server is refused before any dial. */
  it("refuses a --check whose env names a server other than the local box, before it dials", () => {
    const wt = mkdtempSync(join(tmpdir(), "lane-db-foreign-"));
    const base = "postgres://tf:not-a-secret@127.0.0.1:1/trafficflow_test";
    const env = (where: string) => writeFileSync(join(wt, ".lane-db.env"), `PG_TEST_URL=postgres://tf_l_0123456789ab:${PW}@${where}/${DB}\n`);
    try {
      for (const where of ["db.example.com:5433", "127.0.0.1:5399"]) {
        env(where);
        const r = runOffline(["--check", wt], { DATABASE_URL_PG_TEST: base });
        expect(r.status, `${where} ${r.stderr.slice(-300)}`).toBe(3);
        expect(r.stderr, where).toContain("nothing was dialled");
        expect(r.stderr, where).not.toMatch(/UNREADABLE|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/);
      }
      // POSITIVE CONTROL: the same port named as a throwaway passes the fence and is dialled, and a
      // port nothing listens on then reads UNREADABLE, so the refusal above is the fence's.
      env("127.0.0.1:5399");
      const dialled = runOffline(["--check", wt], { DATABASE_URL_PG_TEST: base, OHMAIL_LANE_DB_THROWAWAY_PORT: "5399" });
      expect(dialled.status, dialled.stderr.slice(-300)).toBe(2);
      expect(dialled.stderr).toContain("UNREADABLE");
      expect(dialled.stderr).not.toContain("nothing was dialled");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);

  /* A drop takes the database and the env, so it shares the create's per-worktree lock. */
  onLinux("refuses a --drop rc 75 while another lane-db.sh holds the worktree's lock (lane-db.sh is Linux-only: flock, sha256sum, realpath -m)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "lane-db-droplock-"));
    const key = spawnSync("bash", ["-c", 'cd "$1" && printf %s "$(pwd)" | sha256sum | cut -c1-16', "_", wt], { encoding: "utf8" }).stdout.trim();
    const lock = `/tmp/ohmail-lane-db-${key}.lock`;
    const base = "postgres://tf:not-a-secret@127.0.0.1:1/trafficflow_test";
    const holder = spawn("bash", ["-c", 'exec 9>"$1"; flock 9; echo held; exec sleep 60', "_", lock], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((res, rej) => {
        holder.stdout!.on("data", (b) => { if (String(b).includes("held")) res(); });
        holder.on("exit", () => rej(new Error("the lock holder exited before it held the lock")));
      });
      const held = runOffline(["--drop", wt], { DATABASE_URL_PG_TEST: base });
      expect(held.status, held.stderr.slice(-300)).toBe(75);
      expect(held.stderr).toContain("REFUSED rc 75 — another lane-db.sh is creating, re-keying or dropping");
    } finally {
      holder.kill("SIGKILL");
      await new Promise((r) => (holder.exitCode !== null || holder.signalCode !== null ? r(null) : holder.once("exit", r)));
    }
    try {
      // POSITIVE CONTROL: with the lock released the same drop runs and reaches lane-db.mjs, which
      // answers for this directory (not a workspace) by its own refusal, never rc 75.
      const free = runOffline(["--drop", wt], { DATABASE_URL_PG_TEST: base });
      expect(free.status, free.stderr.slice(-300)).not.toBe(75);
      expect(free.stderr).not.toContain("rc 75");
      expect(free.stderr).toContain("this tool migrates the tree it is given");
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(lock, { force: true });
    }
  }, 60_000);
});
