import { globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ROLE, PASS_ROSTERS, policyList } from "@trafficflow/db/cloud";
import { withoutComments, bracketSpan } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE STAFF STEP-UP TOKEN HAS ONE DOOR (review 020, BACKEND L1). `withStaffStepUp` reads the
 * token it judges from `body.sessionToken`; a staff WRITE handler reading its token anywhere
 * else — a header, another field — would still demand a live session while silently skipping the
 * step-up recency check, and nothing behavioural catches that because both paths answer 200.
 * So the read is `staffTokenOf` in `routes/admin-staff.ts`, and this census parses for the CALL:
 * every `resolveStaffSession(` in a file that mounts `withStaffStepUp` (and in the middleware
 * itself) takes `staffTokenOf(body…)` as its token argument, and the `body.sessionToken`
 * spelling exists nowhere else. Scans `packages/api/src` only — its own package.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const DOOR_FILE = "routes/admin-staff.ts";
const MIDDLEWARE_FILE = "staff-step-up.ts";

function sources(dir: string, into: { file: string; code: string }[] = []): { file: string; code: string }[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (extname(name) === ".ts") {
      into.push({ file: relative(SRC, p), code: withoutComments(readFileSync(p, "utf8")) as string });
    }
  }
  return into;
}

/** Top-level comma split of an argument list — never a regex over nesting. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
  }
  out.push(args.slice(start));
  return out.map((a) => a.trim());
}

/** Every `resolveStaffSession(…)` CALL in `code`, with its top-level argument texts. */
function staffResolutions(code: string): { at: number; args: string[] }[] {
  const out: { at: number; args: string[] }[] = [];
  const re = /\bresolveStaffSession\s*\(/g;
  for (const m of code.matchAll(re)) {
    // Skip the definition (`function resolveStaffSession(`) — a call has no `function` before it.
    if (/function\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const s = bracketSpan(code, open) as { start: number; end: number; closed: boolean };
    if (!s.closed) throw new Error("unclosed resolveStaffSession call — the scan is broken, not the code");
    out.push({ at: m.index, args: splitArgs(code.slice(s.start, s.end)) });
  }
  return out;
}

/** Does this file mount `withStaffStepUp` in a route middleware list? */
function mountsStepUp(code: string): boolean {
  return /middleware:\s*\[[^\]]*\bwithStaffStepUp\b/.test(code);
}

/**
 * The classifier under test, factored so the synthetic-offender arms drive the SAME code the
 * sweep runs: token arguments that are not a `staffTokenOf(` call are offenders, and so is a
 * `headers` read smuggled into the door's own argument.
 */
function offendersIn(file: string, code: string): string[] {
  const out: string[] = [];
  for (const r of staffResolutions(code)) {
    const token = r.args[1] ?? "";
    if (!/^staffTokenOf\s*\(/.test(token)) {
      out.push(`${file}: resolveStaffSession token argument is \`${token}\`, not staffTokenOf(…)`);
    } else if (/\bheaders\b/.test(token)) {
      out.push(`${file}: a header read smuggled into staffTokenOf's argument: \`${token}\``);
    }
  }
  return out;
}

describe("staff step-up token one-door census", () => {
  const files = sources(SRC);
  const stepUpFiles = files.filter((f) => mountsStepUp(f.code));
  const middleware = files.find((f) => f.file === MIDDLEWARE_FILE);
  const door = files.find((f) => f.file === DOOR_FILE);

  it("the door exists and is the only home of the body-field spelling", () => {
    expect(door, "routes/admin-staff.ts must exist").toBeTruthy();
    // The door reads the field once; a second `.sessionToken` read anywhere in the package is a
    // fork of the spelling `withStaffStepUp` judges.
    const spelling = /\.sessionToken\b|\[\s*["']sessionToken["']\s*\]/;
    const doorReads = (door!.code.match(/\.sessionToken\b/g) ?? []).length;
    expect(doorReads, "the door reads body.sessionToken exactly once").toBe(1);
    const elsewhere = files
      .filter((f) => f.file !== DOOR_FILE && spelling.test(f.code))
      .map((f) => f.file);
    expect(elsewhere, "files reading the sessionToken body field outside the door").toEqual([]);
  });

  it("every step-up-mounting file and the middleware resolve staff sessions through the door", () => {
    // Vacuity guards first: the census is real only if the set it sweeps is.
    expect(stepUpFiles.length, "files mounting withStaffStepUp").toBeGreaterThanOrEqual(2);
    expect(middleware, "staff-step-up.ts must exist").toBeTruthy();
    const swept = [...stepUpFiles, middleware!];
    const calls = swept.flatMap((f) => staffResolutions(f.code));
    expect(calls.length, "resolveStaffSession calls under the census").toBeGreaterThanOrEqual(3);

    const offenders = swept.flatMap((f) => offendersIn(f.file, f.code));
    expect(offenders, "step-up reads that bypass the one door").toEqual([]);
  });

  it("refuses the synthetic offenders and admits the real shape (positive control)", () => {
    const stepUpShaped = (bodyRead: string) => withoutComments(`
      ${"import"} { withStaffStepUp } from "../staff-step-up.js";
      const OPTIONS = { raw: true, middleware: [withStaffStepUp] } as const;
      async function handler(req: Request, deps: ApiDeps) {
        const body = (await req.json()) as Record<string, unknown>;
        const staff = await resolveStaffSession(deps.db, ${bodyRead}, deps.now());
        return staff;
      }
    `) as string;

    // A header-fed resolution — the exact drift L1 names — is refused.
    const header = stepUpShaped('req.headers.get("x-staff-session") ?? undefined');
    expect(mountsStepUp(header)).toBe(true);
    expect(offendersIn("synthetic.ts", header).length).toBeGreaterThan(0);

    // A hand-rolled body read (the pre-L1 spelling) is refused: one door, not one field.
    const handRolled = stepUpShaped("str(body.sessionToken) || undefined");
    expect(offendersIn("synthetic.ts", handRolled).length).toBeGreaterThan(0);

    // A header smuggled INTO the door's argument is refused.
    const smuggled = stepUpShaped('staffTokenOf({ sessionToken: req.headers.get("x") })');
    expect(offendersIn("synthetic.ts", smuggled).length).toBeGreaterThan(0);

    // The ordinary shape is admitted — a census that refuses everything measures nothing.
    const ok = stepUpShaped("staffTokenOf(body)");
    expect(offendersIn("synthetic.ts", ok)).toEqual([]);
  });
});

const binder = "packages/db/src/bound.ts";
const roster = "packages/db/src/roster-db.ts";
const policyBook = "packages/db/src/row-security/policies.ts";
const staff = "packages/api/src/staff-audit.ts";

it("mints reserved doors only at their entry points and never hands a keyed handle to a pass", () => {
  const sources = ["apps", "packages"].flatMap((dir) => globSync(`${dir}/*/src/**/*.ts`)).sort();
  const find = (pattern: RegExp) => sources.filter((path) => pattern.test(readFileSync(path, "utf8")));
  expect(find(/["']ohmail:passes["']/)).toEqual([binder]);
  expect(find(/\bPASS_DOOR_KEY\b/)).toEqual([binder, policyBook]);
  expect(find(/\bdoorKeyDb\b/)).toEqual([staff, binder, "packages/db/src/index.ts"]);
  expect(find(/\bdoorKeyDb\s+as\b/)).toEqual([]);
  expect(readFileSync(binder, "utf8").match(/\bdoorKeyDb\b/g)).toHaveLength(1);
  expect(readFileSync("packages/db/src/index.ts", "utf8").match(/\bdoorKeyDb\b/g)).toHaveLength(1);
  const staffSource = readFileSync(staff, "utf8");
  expect(staffSource.match(/\bdoorKeyDb\b/g)).toHaveLength(2);
  expect(staffSource).toContain('doorKeyDb(doorDb(deps), "staff")');
  expect(find(/\bexecutePassRosterRead\b/)).toEqual([binder, roster]);
  expect(readFileSync(roster, "utf8").match(/\bexecutePassRosterRead\b/g)).toHaveLength(2);
  const pass = /\brun(?:ScheduledSend|SendReconcile|OwedSentCopy|AwayResponder|AccountLifecycle|StorageMail)Pass\s*\(/;
  for (const path of find(pass)) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toMatch(/\bstaffDb\b/);
  }
  const starts = find(pass).filter((path) => path.startsWith("packages/services/src/")
    && /export async function run\w+Pass\(/.test(readFileSync(path, "utf8")));
  expect(starts).toHaveLength(6);
  for (const path of starts) {
    const source = readFileSync(path, "utf8");
    expect(source, path).toMatch(/export async function run\w+Pass\([^]*?\): Promise<[^>]+> \{\s*assertPassWalk\(walk\);/);
  }
});

it("the roster flight selects two identifiers and takes neither a lock nor a transaction", () => {
  const source = readFileSync(roster, "utf8");
  const query = source.match(/executePassRosterRead<PassRosterRow>\(walk, sql\x60([^\x60]+)\x60\)/)?.[1]?.trim().replace(/\s+/g, " ");
  expect(query).toBe('select ${sql.identifier(roster.account)} as "accountId", ${sql.identifier(roster.id)} as id '
    + 'from public.${sql.identifier(table)} order by ${sql.raw(order)} limit ${limit} offset ${offset}');
  expect(source.match(/\bexecutePassRosterRead<PassRosterRow>\(/g)).toHaveLength(1);
  for (const entry of Object.values(PASS_ROSTERS)) {
    expect(["id", "account_id"]).toContain(entry.account);
    expect(["id", "account_id", "send_id"]).toContain(entry.id);
  }
});

it("the roster policies are SELECT-only and require both the reserved door and the due condition", () => {
  const policies = policyList().filter(({ name }) => name === "lock_pass_roster");
  expect(policies.map(({ table }) => table)).toEqual(Object.keys(PASS_ROSTERS).sort());
  for (const policy of policies) {
    const entry = PASS_ROSTERS[policy.table as keyof typeof PASS_ROSTERS];
    expect(policy).toMatchObject({
      verb: "SELECT", roles: [API_ROLE], check: null,
      using: `ohmail.current_account() IS NULL AND ohmail.current_key() = 'ohmail:passes' AND (${entry.using})`,
    });
  }
});
