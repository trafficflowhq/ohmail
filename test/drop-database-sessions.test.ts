import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bracketSpan, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";
import { invalidDbReading } from "../scripts/lib/invalid-dbs.mjs";

/*
 * A DROP THAT A TIMEOUT CANNOT HALF-DO. The role carries a 55 s
 * statement_timeout, and one that interrupts `DROP DATABASE` leaves `datconnlimit = -2`: the :5433
 * box read 54 INVALID databases at 2026-09-27T02:59Z and 39 at 03:40Z, every one named by a test
 * file that drops on a raw admin session. Every drop session clears its timeout, or is on RAW.
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
/* A call site is CODE (read with literals blanked, so a fixture string is none); its statement is read at the same place with them kept. */
const CALL = /([A-Za-z_$][\w$]*)\??\.unsafe\(/g;
const DROP_ARG = /^\s*[`'"][^`'"]*\bdrop\s+database\b/i;
const esc = (s: string) => s.replace(/[$]/g, "\\$");

/** The three session doors: the opener's own body clears both timeouts before it hands the session out. */
export const DOORS = [
  { file: "scripts/lane-db.mjs", opener: "async function maintenance(" },
  { file: "apps/worker/test/_isolateddb.ts", opener: "export async function openAdmin(" },
  { file: "packages/db/src/testing.ts", opener: "async function adminSession(" },
];

/** Files that drop on a session the role's timeout still reaches. Eighteen on 2026-09-27; every one
 * now opens its drop session with both timeouts cleared, so a raw one is refused. */
export const RAW: string[] = [];

/** Does `code` clear the timeout on session `v`: a SET on it, a startup `statement_timeout: 0`, or a door's hand-out? */
export function sessionClears(code: string, v: string): boolean {
  const n = esc(v);
  const set = new RegExp(`\\b${n}\\??(?:\\.unsafe\\()?\\s*[\`'"]\\s*set\\s+statement_timeout\\s*=\\s*0\\b`, "i");
  const boot = new RegExp(`\\b${n}\\s*=\\s*(?:await\\s+)?postgres\\([^;]*statement_timeout\\s*:\\s*0\\b`, "i");
  const door = new RegExp(`\\b${n}\\s*=\\s*await\\s+(?:openAdmin|adminSession)\\(`);
  return set.test(code) || boot.test(code) || door.test(code);
}

/** Every file whose code runs `DROP DATABASE` on a session, with the sessions that do not clear it. */
export function dropSessions(files: { file: string; src: string }[]): { file: string; raw: string[] }[] {
  const out: { file: string; raw: string[] }[] = [];
  for (const { file, src } of files) {
    const code = withoutComments(src);
    const bare = withoutCommentsAndLiterals(src);
    const vars = [...new Set([...bare.matchAll(CALL)].filter((m) => DROP_ARG.test(code.slice(m.index + m[0].length, m.index + m[0].length + 240))).map((m) => m[1]))];
    if (vars.length === 0) continue;
    out.push({ file, raw: vars.filter((v) => !sessionClears(code, v)) });
  }
  return out;
}

/** The opener's body, walked with literals blanked and read with them kept; "" when it does not close. */
function openerBody(src: string, opener: string): string {
  const code = withoutComments(src);
  const bare = withoutCommentsAndLiterals(src);
  const at = code.indexOf(opener);
  if (at < 0) return "";
  const s = bracketSpan(bare, bare.indexOf("{", bare.indexOf(")", at)), "{", "}");
  return s.closed ? code.slice(s.start, s.end) : "";
}

const tracked = () => execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", "apps", "packages", "scripts", "test"], { encoding: "utf8" })
  .split("\0").filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.includes("/node_modules/"));

/** Which of the two timeouts the door's opener clears in its own body; `found` false when there is no opener. */
export function doorClears(src: string, opener: string): { found: boolean; statement: boolean; lock: boolean } {
  const body = openerBody(src, opener);
  return { found: body.length > 0, statement: /set\s+statement_timeout\s*=\s*0\b/.test(body), lock: /set\s+lock_timeout\s*=\s*0\b/.test(body) };
}

describe("every DROP DATABASE runs on a session with no statement timeout", () => {
  it("each door's opener clears statement_timeout and lock_timeout itself", () => {
    for (const d of DOORS) {
      expect(doorClears(readFileSync(`${REPO}/${d.file}`, "utf8"), d.opener), `${d.file} ${d.opener}`)
        .toEqual({ found: true, statement: true, lock: true });
    }
  });

  it("refuses a door whose opener lost a SET, even where another function in the file keeps one", () => {
    /* In process, never on disk: lane-db.mjs is a destructive tool. Its check() keeps its own
     * `set statement_timeout = 0`, so a file-wide read would still pass the cut opener. */
    const src = readFileSync(`${REPO}/scripts/lane-db.mjs`, "utf8");
    const cut = src.replace("    await sql`set statement_timeout = 0`;\n    await sql`set lock_timeout = 0`;\n    return await fn(sql);",
      "    await sql`set lock_timeout = 0`;\n    return await fn(sql);");
    expect(cut, "the mutation found no opener line to cut").not.toBe(src);
    expect(withoutComments(cut)).toMatch(/set\s+statement_timeout\s*=\s*0\b/);
    expect(doorClears(cut, "async function maintenance(")).toEqual({ found: true, statement: false, lock: true });
    expect(doorClears(src, "async function maintenanceX(")).toEqual({ found: false, statement: false, lock: false });
  });

  it("a file that drops on a raw admin session is on RAW, and RAW only falls", () => {
    const census = dropSessions(tracked().map((file) => ({ file, src: readFileSync(`${REPO}/${file}`, "utf8") })));
    /* The positive control: the census reads the doors' own sites as sessions, and clean. */
    for (const d of DOORS) expect(census.find((c) => c.file === d.file), `${d.file}'s drop was not read`).toEqual({ file: d.file, raw: [] });
    const raw = census.filter((c) => c.raw.length > 0).map((c) => c.file).sort();
    expect(raw.filter((f) => !RAW.includes(f)), "a new file drops on a session the role's timeout reaches: take the testing door's throwaway database, or clear both timeouts").toEqual([]);
    expect(RAW.filter((f) => !raw.includes(f)), "a RAW file now clears its timeout or drops nothing: take it off RAW").toEqual([]);
    // A synchronous read of every tracked source, no wait of its own: up to 3.9 s on the CI VMs, 94 s
    // under 10% of a CPU.
  }, 180_000);

  it("reads the three session shapes a file clears by, and the raw one", () => {
    const [clears, raw] = [
      "const admin = postgres(u, { max: 1 });\nawait admin`set statement_timeout = 0`;\nawait admin.unsafe(`DROP DATABASE \"x\"`);\n"
        + "const b = postgres(u, { connection: { statement_timeout: 0 } });\nawait b.unsafe(`drop database if exists \"y\"`);\n"
        + "const c = await openAdmin();\nawait c?.unsafe(`DROP DATABASE \"z\"`);\n",
      "const admin = postgres(u, { max: 1 });\nconst holder = postgres(u);\nawait holder.unsafe(`set statement_timeout = 0`);\n"
        + "// admin`set statement_timeout = 0` in a comment is no SET\nawait admin?.unsafe(`DROP DATABASE IF EXISTS \"w\"`).catch(() => {});\n",
    ];
    expect(dropSessions([{ file: "a.ts", src: clears }])).toEqual([{ file: "a.ts", raw: [] }]);
    expect(dropSessions([{ file: "b.ts", src: raw }])).toEqual([{ file: "b.ts", raw: ["admin"] }]);
    expect(dropSessions([{ file: "c.ts", src: "refuseName('x\"; drop database \"postgres')" }])).toEqual([]);
    /* A fixture STRING holding a whole drop call is no site: the call is not code. */
    expect(dropSessions([{ file: "d.ts", src: "const f = \"a.unsafe(`DROP DATABASE \\\"x\\\"`)\";\n" }])).toEqual([]);
  });
});

describe("lane-db.sh --list-invalid reads the half-done drops and drops nothing", () => {
  const doorOf = (n: string) => (n.startsWith("trafficflow_l_") ? "lane-db" : n.startsWith("trafficflow_worker_") ? "worker" : "other");
  const row = (datname: string, datconnlimit: number | string) => ({ datname, datconnlimit });

  it("names each INVALID database with its door and counts them per door", () => {
    const r = invalidDbReading({ doorOf, rows: [row("postgres", -1), row("tf_away_piles_0a1b2c", -2), row("trafficflow_l_0123456789ab", "-2"),
      row("ohmail_adopt_ffee", -2), row("tf_other", -1), row("tf_live_0c0c", 5)] });
    expect(r.rc).toBe(0);
    expect(r.lines).toEqual(["INVALID ohmail_adopt_ffee (other)", "INVALID tf_away_piles_0a1b2c (other)", "INVALID trafficflow_l_0123456789ab (lane-db)",
      "LIST_INVALID 3 of 6 database(s) · lane-db 1 · other 2 · anchor postgres present · nothing dropped"]);
  });

  it("reads zero as zero only beside its anchor, and as UNREADABLE without it", () => {
    expect(invalidDbReading({ doorOf, rows: [row("postgres", -1), row("tf_other", -1)] }).lines)
      .toEqual(["LIST_INVALID 0 of 2 database(s) · anchor postgres present · nothing dropped"]);
    const blind = invalidDbReading({ doorOf, rows: [] });
    expect(blind.rc).toBe(2);
    expect(blind.lines[0]).toMatch(/^UNREADABLE: 0 database row\(s\) and no `postgres` among them/);
    expect(invalidDbReading({ doorOf, rows: [row("trafficflow_x", -2)] }).rc, "an INVALID row without the anchor is still no reading").toBe(2);
  });
});

