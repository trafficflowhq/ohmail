/**
 * THE PUBLISHED TREE CARRIES NO PLANE STAFF VOCABULARY. The operator console's join with the
 * billing plane is managed-service administration: it lives in the plane and in the console,
 * never in a file the public repository carries. Every tracked source outside the console is
 * read (code, SQL with the migrations among it, shell and config), and a planted file under
 * `packages/api/src/` proves the scan bites. A file the public test set keeps out as MANAGED
 * (`support/test-scrub-exclusions.tsv`, where the checkout carries it) is the managed side's
 * by that row and nothing else. `credit` and `plan` alone are not in the set: the open
 * entitlements port uses both.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_APPS } from "./support/published-roots.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split("\\").join("/");
/* Sources: code, SQL, shell and the config kinds. Prose documents are not read here. */
const EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|sql|sh|json|yml|yaml|toml)$/;
const SKIP = new Set(["node_modules", "dist", "build", ".next", ".turbo", ".git"]);
const EXCLUSIONS = join(ROOT, "test/support/test-scrub-exclusions.tsv");

/** The plane's staff surface, its secret, the Dashboard, and every mismatch class name. */
const FORBIDDEN = [
  "/staff/v1", "PLANE_STAFF_SECRET", "STAFF_ASSERTION_PUBLIC_KEYS", "ADMIN_PLANE_ORIGIN", "ohmail-plane-staff",
  "x-staff-assertion", "dashboard.stripe.com", "stripeReadAt",
  "paid_but_walled", "erasure_at_risk", "failed_billing_event", "paid_invoice_without_grant", "stripe_mirror_drift",
  "trial_ended_but_open", "open_but_parked", "reopened_not_resumed", "closed_but_syncing", "suspended_unreviewed",
  "plane_unknown", "erased_but_billing", "duplicate_subscription",
];

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) if (!SKIP.has(entry)) walk(join(path, entry), out);
  } else out.push(path);
}

/** Every file the checkout tracks (git's own list), or the tree on disk where there is no git. */
function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 })
      .split("\0").filter(Boolean);
  } catch {
    const out: string[] = [];
    walk(ROOT, out);
    return out.map((f) => relative(ROOT, f).split("\\").join("/"));
  }
}

/** The MANAGED rows of the test set's exclusions, where the checkout carries the table. */
function managedRows(): Set<string> {
  if (!existsSync(EXCLUSIONS)) return new Set();
  return new Set(readFileSync(EXCLUSIONS, "utf8").split("\n").map((l) => l.split("\t"))
    .filter((c) => c.length === 3 && c[1] === "MANAGED").map((c) => c[0]));
}

function scan(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const word of FORBIDDEN) {
        if (lower.includes(word.toLowerCase())) hits.push(`${relative(ROOT, file)}:${i + 1} [${word}]`);
      }
    });
  }
  return hits;
}

describe("no published file names the plane's staff surface", () => {
  const managed = managedRows();
  const inPrivateApp = (rel: string) => PRIVATE_APPS.some((a) => rel.startsWith(`apps/${a}/`));
  const sources = trackedFiles().filter((rel) => EXT.test(rel) && !inPrivateApp(rel) && rel !== SELF
    && existsSync(join(ROOT, rel)));
  const files = sources.filter((rel) => !managed.has(rel)).map((rel) => join(ROOT, rel));

  it("the walk is every tracked source outside the console: the migrations, the scripts and the tests too", () => {
    const rels = files.map((f) => relative(ROOT, f).split("\\").join("/"));
    expect(rels.length).toBeGreaterThanOrEqual(2000);
    for (const dir of ["packages/db-mail/drizzle/", "packages/db/drizzle/", "packages/api/src/", "apps/worker/src/", "packages/organizer/src/"]) {
      expect(rels.some((r) => r.startsWith(dir) && r.endsWith(dir.includes("drizzle") ? ".sql" : ".ts")), dir).toBe(true);
    }
    expect(rels.some(inPrivateApp)).toBe(false);
    /* A MANAGED row covers exactly what it names, never a directory. */
    for (const m of managed) expect(m.endsWith("/"), m).toBe(false);
  });

  it("no tracked source outside the console carries a plane staff word", () => {
    expect(scan(files)).toEqual([]);
  });

  /* Planted in a TEMP tree of the same shape: a probe in the real packages/api/src is read by
     every other suite walking that root while this one runs. */
  it("POSITIVE CONTROL: a planted file under packages/api/src/ is caught by file and line", () => {
    const away = mkdtempSync(join(tmpdir(), "plane-staff-census-"));
    const probe = join(away, "packages/api/src", "__plane-staff-census-probe.ts");
    try {
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, 'export const probe = 1;\nexport const url = "/staff/v1/overview";\n');
      const planted: string[] = [];
      walk(join(away, "packages/api/src"), planted);
      expect(planted).toEqual([probe]);
      expect(scan(planted)).toEqual([`${relative(ROOT, probe)}:2 [/staff/v1]`]);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
    expect(existsSync(probe)).toBe(false);
  });

  it("CONTROL: a MANAGED row is the only way out — the file it names does carry the words", () => {
    for (const rel of managed) {
      if (!existsSync(join(ROOT, rel))) continue;
      expect(sources).toContain(rel);
    }
    if (managed.has("test/fixtures/staff-assertion.json") && existsSync(join(ROOT, "test/fixtures/staff-assertion.json"))) {
      expect(scan([join(ROOT, "test/fixtures/staff-assertion.json")]).length).toBeGreaterThan(0);
    }
  });

  it("NEGATIVE CONTROL: the open entitlements port, which names credits and plans, is not a hit", () => {
    const port = join(ROOT, "packages/db/src/entitlements-port.ts");
    expect(readFileSync(port, "utf8")).toMatch(/credit/i);
    expect(readFileSync(port, "utf8")).toMatch(/\bplan\b/);
    expect(scan([port])).toEqual([]);
    for (const word of ["credit", "plan", "entitlements"]) expect(FORBIDDEN).not.toContain(word);
  });
});
