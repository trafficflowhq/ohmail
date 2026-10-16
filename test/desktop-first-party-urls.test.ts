/**
 * FOUR LISTS OF THE SAME ADDRESSES, AND NOTHING MADE THEM AGREE.
 *
 * The desktop binary may hand exactly one of a fixed set of web pages to the user's own browser.
 * That set is decided in ONE place — the `LINKS` table in `apps/desktop/src-tauri/src/engine.rs`,
 * which exists so that a value from the webview can never name a host — and it is then written
 * down again, twice, for reasons that are good on their own:
 *
 *   1. `public/ohmail/github/workflows/build.yml` greps every URL out of the shipped binary and
 *      fails the release build on any first-party address it was not told to expect. That
 *      allow-list is duplicated in FOUR inspecting jobs (`windows`, `linux`, `linux-arm64`,
 *      `macos`), because each inspects a different artifact. macOS inspected nothing at all
 *      until 0.17; the fourth copy arrived with the check.
 *   2. `apps/desktop/README.md` enumerates the same addresses for a reader deciding whether to
 *      trust the binary — and the workflow step itself prints "reconcile with the README
 *      enumeration", which until now was advice to a human rather than a check.
 *
 * So one line added to the Rust table has to land in five more places, and a miss is invisible
 * until the release build fails at "Inspect what was produced" — which is exactly what happened
 * when the Settings → Devices hand-off was added: the Rust table and its own Rust guard were
 * updated, the workflow allow-lists and the README were not, and both Linux jobs failed.
 * Windows would have failed the same way; macOS could not, because it inspected nothing.
 *
 * WHY EQUALITY AND NOT CONTAINMENT. A subset check in either direction fails to see one of the
 * two ways these drift apart. If the allow-list may hold more than the table, it can admit an
 * address the app no longer opens — the permission outliving the feature, which is the thing the
 * release check exists to catch. If the table may hold more than the allow-list, the build breaks.
 * Both are drift, so all three sets must be EQUAL.
 *
 * Every case below reads the real files, so this is the guard that turns red on the next line
 * added to the table rather than a description of one. The parsers assert their own catch — the
 * table's declared arity, the sentinel arm that identifies an allow-list, exactly one README row
 * — because a parser that quietly finds nothing makes three empty sets equal and reports success.
 *
 * NOTE: the root `test/` directory is in no tsconfig project, so `pnpm typecheck` says nothing
 * about this file (CLAUDE.md). It was checked with an explicit `tsc --noEmit` when it landed.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicRel } from "./support/public-root.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_RS = join(ROOT, "apps/desktop/src-tauri/src/engine.rs");
const WORKFLOW = join(ROOT, publicRel("github/workflows/build.yml"));
const README = join(ROOT, "apps/desktop/README.md");

/** The one host the three lists are keyed on. See `engineTableUrls` for why that is asserted. */
const HOST_PREFIX = "https://ohmail.app/";

/**
 * The distinct addresses in the Rust `LINKS` table, in first-appearance order.
 *
 * Several keys share an address (`account`, `security` and `billing` all open the Settings view),
 * so the table has more entries than addresses and the comparison is over the addresses.
 *
 * The declared arity is checked against the number of pairs parsed. That is the parser's own
 * watched failure: the table is heavily commented, and a regex that skipped a line would
 * otherwise shrink this set silently and take the assertions below with it.
 */
function engineTableUrls(): string[] {
  const src = readFileSync(ENGINE_RS, "utf8");
  const open = /const LINKS: \[\(&str, &str\); (\d+)\] = \[\n/.exec(src);
  if (!open) throw new Error("engine.rs: no LINKS table found");
  const declared = Number(open[1]);
  const bodyStart = open.index + open[0].length;
  const bodyEnd = src.indexOf("\n];", bodyStart);
  if (bodyEnd < 0) throw new Error("engine.rs: the LINKS table is not closed");
  const body = src.slice(bodyStart, bodyEnd);

  const pairs = [...body.matchAll(/^\s*\("([^"]+)", "([^"]+)"\),\s*$/gm)];
  if (pairs.length !== declared) {
    throw new Error(
      `engine.rs: the LINKS table declares ${declared} entries and ${pairs.length} were parsed`,
    );
  }
  const urls = pairs.map((m) => m[2]);
  const offHost = urls.filter((u) => !u.startsWith(HOST_PREFIX));
  if (offHost.length > 0) {
    throw new Error(
      `engine.rs: the LINKS table names a host this guard does not compare (${offHost.join(", ")}). ` +
        `The workflow allow-lists and the README row are matched on ${HOST_PREFIX}; extend all four together.`,
    );
  }
  return [...new Set(urls)];
}

/**
 * Each inspecting job's first-party allow-list, keyed by job id.
 *
 * A block counts as an allow-list only if it carries the sentinel arm that fails the build, which
 * is what tells it apart from the other `case` statements in the workflow. The job id comes from
 * the nearest preceding top-level `jobs:` key, so a failure below names the job whose list is
 * wrong rather than a line number in a file thousands of lines long.
 */
function workflowAllowLists(): Map<string, string[]> {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const found = new Map<string, string[]>();
  let job: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const jobKey = /^ {2}([A-Za-z0-9_-]+):$/.exec(lines[i]);
    if (jobKey) job = jobKey[1];
    if (!/^\s*case "\$u" in\s*$/.test(lines[i])) continue;

    let end = i + 1;
    while (end < lines.length && !/^\s*esac\s*$/.test(lines[end])) end++;
    const block = lines.slice(i + 1, end);
    if (!block.some((l) => l.includes("unexpected first-party URL"))) continue;
    if (job === null) throw new Error(`build.yml:${i + 1}: an allow-list outside any job`);

    const urls = block
      .map((l) => /^\s*'([^']+)'\*\) : ;;\s*$/.exec(l)?.[1])
      .filter((u): u is string => u !== undefined && u.startsWith(HOST_PREFIX));
    if (found.has(job)) throw new Error(`build.yml: job ${job} carries two first-party allow-lists`);
    found.set(job, urls);
  }
  return found;
}

/**
 * The addresses named in the README's enumeration of the link table.
 *
 * The row is found by the file it cites rather than by position, and there must be exactly one of
 * it — two rows citing the table would mean a reader could be told two different things.
 */
function readmeEnumeratedUrls(): string[] {
  const rows = readFileSync(README, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("|") && l.includes("src-tauri/src/engine.rs"));
  if (rows.length !== 1) {
    throw new Error(`README.md: expected 1 row citing the link table, found ${rows.length}`);
  }
  return [...rows[0].matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(HOST_PREFIX));
}

const engine = engineTableUrls();
const allowLists = workflowAllowLists();
const readme = readmeEnumeratedUrls();

describe("the desktop's first-party addresses are written down identically in four places", () => {
  // ── The parsers found something, asserted before anything is compared ──────────────────────
  //
  // Three empty sets are equal. Without this case, a parser broken by a reformat would report
  // that the lists agree, which is the failure this whole file exists to prevent, wearing the
  // clothes of a pass.
  it("the Rust table is the non-empty source of the other two", () => {
    expect(engine.length).toBeGreaterThanOrEqual(6);
    expect(engine).toContain("https://ohmail.app/mailbox#/settings");
    expect(engine).toContain("https://ohmail.app/mailbox?settings=mailboxes#/settings");
    expect(engine).toContain("https://ohmail.app/mailbox?settings=devices#/settings");
  });

  it("every job that inspects an artifact carries a first-party allow-list", () => {
    expect([...allowLists.keys()].sort()).toEqual(["linux", "linux-arm64", "macos", "windows"]);
  });

  // ── The comparison, one case per job so a red names the job ─────────────────────────────────
  for (const job of ["windows", "linux", "linux-arm64"]) {
    it(`the ${job} job's allow-list is exactly the Rust link table`, () => {
      const urls = allowLists.get(job);
      expect(urls, `build.yml has no first-party allow-list in the ${job} job`).toBeDefined();
      expect([...(urls ?? [])].sort(), `the ${job} job's allow-list has drifted from engine.rs`) //
        .toEqual([...engine].sort());
    });
  }

  // Order too, and only here: the README says it lists them "in the order that table lists them",
  // which makes the order a claim in published prose rather than an incidental. The workflow arms
  // sit among unrelated ones and their order carries nothing, so those are compared as sets.
  it("the README enumeration is exactly the Rust link table, in the table's order", () => {
    expect(readme).toEqual(engine);
  });
});
