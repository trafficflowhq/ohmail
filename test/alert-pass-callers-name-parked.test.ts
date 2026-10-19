import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * Every production alert pass names the roster's parked set. The worker's pass once omitted it
 * and paged hourly for three days about accounts the same worker had parked on purpose; the API
 * host forwarded a reader nobody composed. Scanned roots: every `apps/*` and `packages/*` src.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function productionSources(): string[] {
  const out: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, "src");
      try { if (statSync(src).isDirectory()) out.push(...sources(src)); } catch { /* no src */ }
    }
  }
  return out;
}

/** The argument text of every `<callee>(` CALL, comments blanked, literals kept. */
function callArguments(src: string, callee: string): string[] {
  const code = withoutCommentsAndLiterals(src);
  const kept = withoutComments(src);
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${callee}\\(`, "g");
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    let depth = 0;
    const open = m.index + callee.length;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) { out.push(kept.slice(open + 1, i)); break; }
    }
  }
  return out;
}

const namesParked = (args: string): boolean => /\bparkedAccounts\b\s*[:,}]/.test(args);

describe("every runAlertPass caller hands the pass the roster's parked set", () => {
  const calls = productionSources().flatMap((file) =>
    callArguments(readFileSync(file, "utf8"), "runAlertPass")
      .map((args) => ({ file: relative(ROOT, file), args })));

  it("finds the two production drivers — a census that finds none measured nothing", () => {
    expect(calls.map((c) => c.file).sort()).toEqual([
      "apps/worker/src/index.ts",
      "packages/api/src/routes/internal.ts",
    ]);
  });

  it("each call names parkedAccounts", () => {
    const missing = calls.filter((c) => !namesParked(c.args)).map((c) => c.file);
    expect(missing, "a pass without the parked set pages about parked accounts").toEqual([]);
  });

  it("each call names accountsAtCap — a pass without it reads the storage rule as unread", () => {
    const missing = calls.filter((c) => !/\baccountsAtCap\b\s*[:,}]/.test(c.args)).map((c) => c.file);
    expect(missing, "the at-cap reader is the drivers' to run").toEqual([]);
  });

  it("each call names planeOps — a pass without it reads the plane's own failures as unread", () => {
    const missing = calls.filter((c) => !/\bplaneOps\b\s*:/.test(c.args)).map((c) => c.file);
    expect(missing, "the plane's ops reader is the drivers' to run").toEqual([]);
    const worker = calls.find((c) => c.file === "apps/worker/src/index.ts")!;
    expect(worker.args, "shard 0 alone reads the plane: deployment-wide facts, one read a minute")
      .toMatch(/\bplaneOps\b\s*:\s*shardIndex === 0 \?/);
  });

  it("the console never dials the plane: it names no ops reader, and the managed host hands it none", () => {
    const board = withoutComments(readFileSync(join(ROOT, "packages/services/src/admin-service.ts"), "utf8"));
    expect(board).not.toMatch(/\bplaneOps\b/);
    const host = withoutComments(readFileSync(join(ROOT, "apps/api-vercel/src/deps.ts"), "utf8"));
    const start = host.indexOf("admin: cfg.admin");
    const block = host.slice(start, host.indexOf("adminDb:", start));
    expect(block, "the admin block was found").toContain("parkedAccounts");
    expect(block).not.toMatch(/\bplaneOps\b/);
  });

  it("the worker's call names apiCron — without it api_cron_stale is unread on every pass", () => {
    const worker = calls.filter((c) => c.file === "apps/worker/src/index.ts");
    expect(worker).toHaveLength(1);
    expect(worker[0]!.args, "the schedule the leader holds reaches the pass").toMatch(/\bapiCron\b\s*:/);
    const api = calls.filter((c) => c.file === "packages/api/src/routes/internal.ts");
    expect(api[0]!.args, "the API driver holds no schedule and hands none").not.toMatch(/\bapiCron\b\s*:/);
  });

  it("every host that arms the API's alert route composes the reader it forwards", () => {
    const hosts = productionSources().flatMap((file) => {
      const src = withoutComments(readFileSync(file, "utf8"));
      const start = src.indexOf("alerts: cfg.alerts");
      if (start < 0) return [];
      let depth = 0;
      let end = src.indexOf("?", start);
      for (let i = src.indexOf("{", start); i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) { end = i; break; }
      }
      return [{ file: relative(ROOT, file), block: src.slice(start, end + 1) }];
    });
    expect(hosts.map((h) => h.file).sort(), "the managed host and the self-hosted server")
      .toEqual(["apps/api-vercel/src/deps.ts", "apps/server/src/deps.ts"]);
    const missing = hosts.filter((h) => !namesParked(h.block)).map((h) => h.file);
    expect(missing, "the route forwards cfg.parkedAccounts; nothing else supplies it").toEqual([]);
    const noCap = hosts.filter((h) => !/\baccountsAtCap\b\s*:/.test(h.block)).map((h) => h.file);
    expect(noCap, "the route forwards cfg.accountsAtCap; a host that states none leaves the rule unread").toEqual([]);
    const noOps = hosts.filter((h) => !/\bplaneOps\b\s*:/.test(h.block)).map((h) => h.file);
    expect(noOps, "the route forwards cfg.planeOps; a host that states none leaves the plane rules unread").toEqual([]);
  });

  it("the managed host hands its console the SAME parked reader its alert route reads", () => {
    const src = withoutComments(readFileSync(join(ROOT, "apps/api-vercel/src/deps.ts"), "utf8"));
    const block = (from: string): string => {
      const start = src.indexOf(from);
      let depth = 0;
      for (let i = src.indexOf("{", start); i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
      }
      return "";
    };
    const one = "parkedAccounts: alertReadersFor(cfg).parkedAccounts";
    expect(block("alerts: cfg.alerts"), "the alert route reads the host's one bag").toContain(one);
    expect(block("admin: cfg.admin"), "the console reads the same instance, never a second construction").toContain(one);
    expect(block("admin: cfg.admin"), "and no at-cap reader: a console request is not a pass").not.toMatch(/accountsAtCap/);
  });

  it("the managed host's bag bounds both plane reads (the roster's reader stays unbounded elsewhere)", () => {
    const src = withoutComments(readFileSync(join(ROOT, "apps/api-vercel/src/deps.ts"), "utf8"));
    const bag = src.slice(src.indexOf("function alertReadersFor("), src.indexOf("function alertSinksFor("));
    expect(bag, "the bag was found").toContain("readersCache");
    expect(bag, "the parked reader takes the alert bound").toMatch(/parkedAccountsOf\(port\(\), ALERT_PARKED_READ_BOUND\)/);
    expect(bag, "the at-cap reader keeps its default bound: no second argument").toMatch(/accountsAtCapOf\(port\(\)\)/);
  });

  it("control: a call without the option is caught, one with it is admitted", () => {
    const bare = callArguments("await runAlertPass(db, { sinks, shards: [] });", "runAlertPass");
    const named = callArguments("await runAlertPass(db, { sinks, parkedAccounts: reader });", "runAlertPass");
    const commented = callArguments("await runAlertPass(db, { sinks /* parkedAccounts: r */ });", "runAlertPass");
    expect(bare.map(namesParked)).toEqual([false]);
    expect(named.map(namesParked)).toEqual([true]);
    expect(commented.map(namesParked), "a comment is not an argument").toEqual([false]);
  });
});
