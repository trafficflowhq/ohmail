/**
 * EVERY PRODUCTION `postgres()` CLIENT MUST HANDLE NOTICES.
 *
 * postgres.js defaults `onnotice` to console, so a client that does not pass one writes the driver's
 * raw notice OBJECT to stdout — bypassing the hardened logger completely. Observed in the live
 * worker drain 2026-08-04:
 *
 *   { severity: 'NOTICE', code: '54000', message: 'word is too long to be indexed',
 *     detail: 'Words longer than 2047 characters are ignored.', file: 'ts_parse.c' }
 *
 * No `ts=`, no `service=`, no `event=`. An earlier change established that the drain is a CONTROLLED surface
 * precisely because hostile input can choose what lands in it; a Postgres notice can carry row
 * values (constraint text, any `RAISE NOTICE`), so this is an uncontrolled path into it. Same class
 * as that change.
 *
 * WHY A SOURCE CENSUS AND NOT A DB TEST. The defect is "a construction site forgot an option",
 * which is a property of the source, not of a session. A DB test would also have to share the one
 * Postgres behind the pg suite's global advisory lock — and it would prove nothing about the OTHER
 * construction sites, which is the whole point. This is the `staff-grants.ts` / `legacy-domains.mjs`
 * pattern.
 *
 * A NOTE THAT USED TO SAY THIS FILE'S ASSERTION DISAGREED WITH PRODUCTION. IT WAS WRONG.
 *
 * `expect(Object.keys(lines[0]!.fields).sort()).toEqual(["code", "severity"])` below passes, and for a
 * few hours I believed production contradicted it, because `railway logs`' default rendering showed
 * `code="54000"` and no `severity`. **The assertion was right.** `railway logs --json` returns
 * `"severity":"NOTICE"` — the field was always in the payload; the plain view just does not print every
 * attribute. I doubted a correct test because of a lossy reader, then spent three passes eliminating
 * build staleness and pooler stripping to explain a symptom my instrument had invented.
 *
 * The asymmetry I should have applied, and the reason it is written here: **a lossy viewer cannot show
 * content that was never emitted, but it CAN hide content that was.** So an ABSENCE observed through it
 * (zero raw notice dumps, zero driver prose — the actual privacy claim) is sound evidence, while a
 * MISSING FIELD observed through it proves nothing at all.
 *
 * The real limitation of these tests stands, and is smaller than I claimed: they inject a fake logger,
 * so they prove what the sink HANDS OVER, not what gets EMITTED. That gap caused no divergence here —
 * driving the real `createLogger` produces
 * `{"event":"pg_notice","severity":"NOTICE","code":"54000",…}` — but it is still the honest place to
 * strengthen: assert on the real logger's emitted bytes rather than on a captured `fields` object.
 *
 * WHAT THIS CENSUS DOES NOT PROVE — read this before trusting it.
 *
 * It proves a handler is PASSED. It does not prove the handler is SAFE, and two sites in the tree
 * pass handlers that forward exactly the fields `onNotice` refuses:
 *
 *   provision-staff-role.ts:85  onnotice: (n) => notices.push(`${n.severity}: ${n.message}…${n.detail}`)
 *   the Data API lockdown:191   onnotice: (n) => notices.push(`${n.severity}: ${n.message}`)
 *
 * Both are operator-run provisioning scripts collecting into a local array for terminal output, which
 * is a deliberate allow — but the census cannot distinguish that from a leak, so **"the census is
 * green" must never be read as "no site forwards notice prose."** The safety property is carried only
 * by the separate `onNotice`/`noticeSinkFor` tests below, and only for the sites that use them. If a
 * future site hand-rolls a handler that ships `message` to the DRAIN rather than a terminal, nothing
 * here fails.
 *
 * WHY THE TESTS THEMSELVES ARE EXEMPT, AND WHY THAT IS THE SHARP PART. Every pg test already passes
 * `onnotice: () => {}`. So the channel was silenced in exactly the place it is harmless and left open
 * in exactly the place it is not — which is why no test could ever have caught this, and why the
 * census has to read production source rather than trust a passing suite.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  noticeSinkFor, noticeSinkInstalled, onNotice, setNoticeSink,
  type PgNoticeFacts,
} from "../src/notices.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// ONE scanner, so a `//` inside a string is never read as a comment — the quoted glob in
// packages/services/src/mailbox-service.ts opened one, and a bracket walk ran off the file.
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "../../../apps/worker/test/_start-function.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Directories holding PRODUCTION database clients. Tests are deliberately not scanned.
 *
 * EXCLUDED, AND NAMED HERE RATHER THAN LEFT IMPLICIT: `scripts/**` (`undo-runaway-reads`,
 * `seed-test-mailbox`, `ux-suite/lib/sql.ts`, `verify-p17-live`) are interactive operator terminals
 * where a notice printed plainly IS the wanted output. A silent exclusion is how a census quietly
 * stops covering half the repo, so the reason lives in the guard, not in a commit message.
 */
const ROOTS = ["packages/db/src", "apps/worker/src", "apps/api-vercel/src", "apps/admin/src"];

/**
 * Comments are stripped BEFORE scanning, and that is load-bearing rather than tidiness:
 * `migrate.ts` documents `postgres(url, { max: 1 })` in a doc comment. A census that counted it
 * would report a violation nobody can fix and would be abandoned as noise — the failure mode where
 * a guard is technically right and practically dead.
 */
function stripComments(src: string): string {
  // LENGTH-PRESERVING, and the first version of this guard was not — it deleted comments outright,
  // which shifted every byte offset and made the reported `file:line` point at the wrong line. A
  // guard that names the wrong line sends the reader somewhere innocent, so blank the comment out
  // in place (newlines kept) instead of removing it.
  // And it is the SHARED SCANNER, which knows a string from a comment: the whole-line rule above
  // was the guard against blanking a `https://…` inside a literal, and it let the other direction
  // through — a `/*` inside a string opening a comment that closes at a real one far below.
  return scan.withoutComments(src);
}

function tsFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === "test") continue;
      out = out.concat(tsFiles(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** The argument text of each `postgres(...)` call, found by balancing parens from the call site. */
function postgresCallSites(src: string): { args: string; line: number }[] {
  const out: { args: string; line: number }[] = [];
  const re = /\bpostgres\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push({
      args: src.slice(m.index + m[0].length, i - 1),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

describe("production Postgres clients must not leak raw notices", () => {
  const sites = ROOTS.flatMap((r) =>
    tsFiles(join(REPO, r)).flatMap((f) =>
      postgresCallSites(stripComments(readSource(f)))
        .map((s) => ({ ...s, file: f.slice(REPO.length) })),
    ),
  );

  it("finds the construction sites at all — a census that scans nothing passes vacuously", () => {
    // The anti-vacuity control, and it names a FILE as well as a count: a walker that resolves
    // `dist/` or an empty glob would otherwise report safety over nothing scanned. Precedent:
    // `no-drizzle-kit.test.ts`, which self-tests that it found the manifests it means to check.
    expect(sites.length, "too few `postgres(` call sites — the census is scanning the wrong tree")
      .toBeGreaterThanOrEqual(8);
    expect(
      sites.some((s) => s.file.endsWith("packages/db/src/client.ts")),
      "the census did not reach client.ts, which holds three of the constructions",
    ).toBe(true);
  });

  it("passes a notice handler at every site", () => {
    const missing = sites
      .filter((s) => !/\bonnotice\b/.test(s.args))
      .map((s) => `${s.file}:${s.line}`);
    expect(
      missing,
      `these clients let postgres.js write raw notice objects to the drain, bypassing the ` +
      `hardened logger: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * A DROPPED CHANNEL IS SAFE AND USELESS, SO SOMEBODY MUST LIGHT IT.
 *
 * `packages/db` drops notices until a host installs a sink. That is the right default for a library,
 * but it means the fix has TWO halves and only one of them is visible in the census above: with no
 * host installing a sink, every `onnotice` in the tree is wired to a black hole and the drain is
 * silent. Nothing else in the suite notices, because dropping is indistinguishable from working
 * unless you look for the emitted line.
 *
 * The worker is asserted BY NAME rather than "some host", because the worker's drain is the one the
 * raw notice objects were actually observed in.
 */
describe("a host must install the sink, or the channel is wired to nothing", () => {
  /**
   * The hosts whose drains are expected to carry structured notices. A LIST rather than one test
   * each, so wiring the four crons later is a one-line change here — and so a host that is wired in
   * code but missing from this list is the only remaining way to regress silently.
   *
   * `apps/worker/src/cron-log.ts` joined the list with that change, which is the composition root
   * all four crons now delegate their CLI bottom to — so one entry covers four processes, and adding a
   * fifth cron cannot bypass it without also bypassing the logger.
   *
   * **This comment used to say the four crons were "NOT listed, and deliberately" because they "do not
   * install a sink yet". The cron change made that false, and the change that did it left this file out of its
   * path list, so the stale sentence stood until a later read caught the contradiction.**
   * Recorded because it is the failure mode this file is about: a census that under-claims is a census
   * whose green means less than it looks like.
   *
   * Still NOT listed, and still deliberately: `admin-db.ts` and `invite-cli.ts` install no sink.
   * Naming a host before it is wired would make this guard red by design, and a permanently red guard
   * gets disabled — worse than the honest gap row in the project's design notes.
   */
  const HOSTS = [
    "apps/worker/src/index.ts",
    "apps/api-vercel/src/deps.ts",
    "apps/worker/src/cron-log.ts",
  ];

  for (const host of HOSTS) {
    it(`${host} installs a notice sink`, () => {
      const src = stripComments(readSource(join(REPO, host)));
      expect(
        /setNoticeSink\s*\(/.test(src),
        `${host} never calls setNoticeSink, so every notice from this host is dropped — safe, but ` +
        `the drain is silent and the code=54000 count is unobtainable`,
      ).toBe(true);
      expect(
        /noticeSinkFor\s*\(/.test(src),
        `${host} installs a sink but not via \`noticeSinkFor\`, so it is hand-rolling the field ` +
        `mapping — the hand-rolled shape, and the privacy boundary stops being in one place`,
      ).toBe(true);
    });
  }
});

/**
 * THE CENSUS ABOVE IS NOT ENOUGH, AND THAT IS THE POINT OF THIS BLOCK.
 *
 * It proves a handler is *passed*. It cannot prove the handler is *safe* — a site could pass one that
 * spreads the whole notice, satisfying the census while emitting exactly the content the slice exists
 * to keep out. `detail` is on the logger's `ALLOWED_FIELDS` (it exists for author-written sentences),
 * so a `{...notice}` spread emits the driver's prose verbatim while the line still LOOKS hardened.
 * That is the most likely way this fix silently un-fixes itself, so it gets its own mutation.
 */
describe("the handler forwards facts about a notice, never content from it", () => {
  afterEach(() => { setNoticeSink(null); });

  /** Markers chosen so a failure names WHICH field leaked, not merely that something did. */
  const MSG_MARKER = "MARKER_FROM_MESSAGE_ff01";
  const DETAIL_MARKER = "MARKER_FROM_DETAIL_ff02";
  const HINT_MARKER = "MARKER_FROM_HINT_ff03";

  const rawNotice = {
    severity: "WARNING",
    severity_local: "WARNING",
    code: "54000",
    message: `duplicate key value violates unique constraint (subject)=(${MSG_MARKER})`,
    detail: DETAIL_MARKER,
    hint: HINT_MARKER,
    file: "ts_parse.c",
    line: "385",
    routine: "parsetext",
  };

  it("drops by default — a library must not print because the host forgot to inject", () => {
    expect(noticeSinkInstalled(), "a sink was installed before any test asked for one").toBe(false);
    expect(() => { onNotice(rawNotice); }).not.toThrow();
  });

  it("forwards severity and code, and NO field the driver filled with prose", () => {
    const seen: PgNoticeFacts[] = [];
    setNoticeSink((f) => { seen.push(f); });
    onNotice(rawNotice);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.severity).toBe("WARNING");
    expect(seen[0]?.code).toBe("54000");

    // Asserted over the SERIALISED bytes, not field by field: a future field added to the facts
    // object would otherwise carry a marker straight past a per-field assertion.
    const bytes = JSON.stringify(seen);
    for (const [name, marker] of [["message", MSG_MARKER], ["detail", DETAIL_MARKER], ["hint", HINT_MARKER]] as const) {
      expect(bytes.includes(marker), `the driver's \`${name}\` reached the sink: ${bytes}`).toBe(false);
    }
    // The row values a constraint notice embeds are the reason this matters at all.
    expect(bytes.includes("subject"), "constraint prose naming a column reached the sink").toBe(false);
  });

  it("a throwing sink cannot become a database error", () => {
    setNoticeSink(() => { throw new Error("sink is broken"); });
    expect(() => { onNotice(rawNotice); }).not.toThrow();
  });

  it("noticeSinkFor emits one structured event, severity-routed", () => {
    const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    const log = {
      warn: (event: string, fields: Record<string, unknown>) => lines.push({ level: "warn", event, fields }),
      info: (event: string, fields: Record<string, unknown>) => lines.push({ level: "info", event, fields }),
    };
    setNoticeSink(noticeSinkFor(log));

    onNotice(rawNotice);
    onNotice({ ...rawNotice, severity: "NOTICE", severity_local: "NOTICE" });

    expect(lines.map((l) => `${l.level}:${l.event}`)).toEqual(["warn:pg_notice", "info:pg_notice"]);
    expect(Object.keys(lines[0]!.fields).sort()).toEqual(["code", "severity"]);
    expect(JSON.stringify(lines).includes(DETAIL_MARKER)).toBe(false);
  });
});
