import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readJournalOf, type JournalSpec } from "../src/baseline.js";
import { CLOUD_JOURNAL, MAIL_JOURNAL } from "../src/journal-specs.js";
import { allowanceFor } from "../src/migration-allowances.js";
import {
  PRE_PUBLICATION, PRE_PUBLICATION_VERSIONS, type PrePublicationVersion,
} from "../src/migration-provenance-record.js";
import { normalizeSql } from "../src/sql-normalize.js";

/**
 * THE PROVENANCE RECORD IS A TRUST ANCHOR, SO EVERY ROW IS PINNED.
 *
 * A row lets the setup identify a version this repository's history never carried. The misuse is
 * the obvious one: a row naming the hash a DRIFTED database records, with the shipped file's
 * executable SQL, would make the setup read comment-only drift and deploy over SQL that never ran.
 * So the record is held to what it says it is, here, in every checkout:
 *
 *   (a) its shape is exact — nothing wildcard, nothing extra, nothing it does not spell out in full;
 *   (b) no row names the hash of a file either journal ships — the shape a `when` collision leaves;
 *   (c) each row earns its verdict against the file this tree ships: the same executable SQL, or
 *       an allowance naming that exact pair — a row can never carry an executable drift nothing names;
 *   (d) no row names a version this repository's history holds — git identifies those itself, and a
 *       row for another file's version is the collision shape again;
 *   (e) the set is CLOSED: the history the rows come from is frozen, and every version written since
 *       is in this repository's history, so a new row is one nothing can back.
 *
 * What a published tree cannot check — that each recorded hash really is a version that history
 * held, with that executable SQL, introduced by that commit — is the store arm at the end: it runs
 * where the frozen repository is named, and reads its object store only.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROWS: readonly PrePublicationVersion[] = PRE_PUBLICATION_VERSIONS;
const SPECS: Record<PrePublicationVersion["journal"], JournalSpec> = { mail: MAIL_JOURNAL, cloud: CLOUD_JOURNAL };

/** The hash drizzle records: the file, decoded utf8, sha256 — the one definition every row uses. */
const sha256Utf8 = (s: string): string => createHash("sha256").update(s).digest("hex");
const shippedOf = (r: PrePublicationVersion): string =>
  readFileSync(join(SPECS[r.journal].dir, `${r.tag}.sql`), "utf8");

/** git, with the hook-exported variables that would redirect `-C` stripped (see migration-provenance.ts). */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[k];
  return env;
};
const git = (cwd: string, args: string[], input?: string): Buffer =>
  execFileSync("git", ["-C", cwd, ...args], {
    maxBuffer: 1 << 28, timeout: 120_000, env: gitEnv(), input, stdio: ["pipe", "pipe", "pipe"],
  });

/** One line per row, every field, sorted: what the closed set's digest is taken over. */
const canonical = (rows: readonly PrePublicationVersion[]): string[] =>
  rows.map((r) => [r.journal, r.tag, r.recorded, r.executable, r.introducedBy, r.label].join("\t")).sort();

/**
 * THE CLOSED SET. Changing it is never a routine edit: there is no history left that a new row
 * could come from. A removal (a migration file deleted, a row git now identifies) is a decision a
 * reviewer makes with this pin in front of them.
 */
const CLOSED_SET = {
  rows: 20,
  sha256: "ada3d8cb6bd507420d00af5de8ca3b859f62f47e6bb344a0e4d36fddc516435f",
} as const;

describe("the provenance record holds exactly what it says it holds", () => {
  it("(a) every row is exact: six fields, a known journal, a tag of THAT journal, full-length hashes", () => {
    const tags = {
      mail: new Set(readJournalOf(MAIL_JOURNAL).map((e) => e.tag)),
      cloud: new Set(readJournalOf(CLOUD_JOURNAL).map((e) => e.tag)),
    };
    for (const r of ROWS) {
      const at = `${r.journal} ${r.tag}`;
      expect(Object.keys(r).sort(), `${at}: a field the lookup does not read is a field nobody checks`)
        .toEqual(["executable", "introducedBy", "journal", "label", "recorded", "tag"]);
      expect(["mail", "cloud"], `${at}: no such journal`).toContain(r.journal);
      expect(tags[r.journal]?.has(r.tag), `${at}: not an entry of the ${r.journal} journal`).toBe(true);
      expect(r.recorded, `${at}: recorded is not a full sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(r.executable, `${at}: executable is not a full sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(r.introducedBy, `${at}: introducedBy is not a full commit id`).toMatch(/^[0-9a-f]{40}$/);
      expect(r.label, `${at}: the record names one kind of version`).toBe(PRE_PUBLICATION);
    }
    const keys = ROWS.map((r) => `${r.journal}\t${r.tag}\t${r.recorded}`);
    expect(new Set(keys).size, "two rows answer for the same (journal, tag, recorded)").toBe(keys.length);
  });

  it("(b) no row names the hash of a file either journal ships", () => {
    const shipped = new Map<string, string>();
    for (const spec of [MAIL_JOURNAL, CLOUD_JOURNAL]) {
      for (const e of readJournalOf(spec)) {
        shipped.set(sha256Utf8(readFileSync(join(spec.dir, `${e.tag}.sql`), "utf8")), `${spec.name} ${e.tag}`);
      }
    }
    const named = ROWS.filter((r) => shipped.has(r.recorded))
      .map((r) => `${r.journal} ${r.tag} names the shipped ${shipped.get(r.recorded)}`);
    expect(named, "a row naming shipped SQL identifies nothing, or another entry's SQL").toEqual([]);
  });

  it("(c) each row earns its verdict against the file this tree ships", () => {
    const unearned = ROWS.filter((r) => {
      const shipped = shippedOf(r);
      if (r.executable === sha256Utf8(normalizeSql(shipped))) return false; // the same program
      return allowanceFor(r.journal, r.tag, r.recorded, sha256Utf8(shipped)) === null;
    }).map((r) => `${r.journal} ${r.tag}`);
    expect(unearned, "a row whose executable SQL differs from the shipped file's with no allowance").toEqual([]);
  });

  /**
   * Every version of every `.sql` file this repository's history holds, by the hash drizzle records:
   * read once (`git log -m --raw`, then one `cat-file --batch`), not per file. `--root` names the
   * first commit's files whatever `log.showRoot` says. A shallow checkout — CI's is one commit deep
   * — holds the tip only, and that is said, not hidden.
   */
  it("(d) no row names a version this repository's history holds", () => {
    const top = git(HERE, ["rev-parse", "--show-toplevel"]).toString().trim();
    const shallow = git(top, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true";
    const blobs = new Map<string, string>();
    for (const line of git(top, [
      "log", "--full-history", "-m", "--root", "--raw", "--no-abbrev", "--no-renames", "--format=", "--",
      ":(glob)**/*.sql",
    ]).toString().split("\n")) {
      const m = /^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) \S+\t(.+)$/.exec(line);
      if (!m) continue;
      for (const id of [m[1]!, m[2]!]) if (!/^0+$/.test(id)) blobs.set(id, m[3]!);
    }
    expect(blobs.size, "the history read found no .sql file at all — the arm below would prove nothing")
      .toBeGreaterThan(0);
    const out = git(top, ["cat-file", "--batch"], [...blobs.keys()].join("\n") + "\n");
    const versions = new Map<string, string>();
    for (let at = 0; at < out.length;) {
      const nl = out.indexOf(0x0a, at);
      const [id, type, size] = out.subarray(at, nl).toString().split(" ");
      expect(type, `${id} is not a blob`).toBe("blob");
      const body = out.subarray(nl + 1, nl + 1 + Number(size));
      versions.set(sha256Utf8(body.toString("utf8")), blobs.get(id!)!);
      at = nl + 1 + Number(size) + 1;
    }
    const held = ROWS.filter((r) => versions.has(r.recorded))
      .map((r) => `${r.journal} ${r.tag}: history holds it at ${versions.get(r.recorded)}`);
    expect(held, `a row git can identify, or another file's version${shallow ? " (shallow: the tip only)" : ""}`)
      .toEqual([]);
  });

  it("(e) the set is closed: twenty rows, pinned", () => {
    const lines = canonical(ROWS);
    expect(
      { rows: lines.length, sha256: sha256Utf8(lines.join("\n")) },
      "the provenance record changed. Nothing can back a new row — the history it names is frozen and " +
        "every later version is in this repository's history — so a change here is a decision, not a " +
        `fix. The set now reads:\n${lines.join("\n")}`,
    ).toEqual(CLOSED_SET);
  });
});

/**
 * THE STORE ARM: each row against the frozen history itself. `OHMAIL_PRE_PUBLICATION_HISTORY`
 * names that repository; it is read through its object store only (`cat-file`, `show`, `log`,
 * `merge-base`), at the commit it was frozen at. Unset — every published checkout — the arm is
 * skipped and says why; named but unusable, it fails.
 */
const STORE = process.env["OHMAIL_PRE_PUBLICATION_HISTORY"]?.trim() || null;
const FROZEN_AT = "4526d7e44f1e6e37ba32a620c6b6efc0f9f1e502";
const STORE_DIRS: Record<PrePublicationVersion["journal"], string> = {
  mail: "packages/db-mail/drizzle",
  cloud: "packages/db/drizzle-cloud",
};

describe("the provenance record, against the frozen history", () => {
  it.skipIf(STORE !== null)("is not checked here: OHMAIL_PRE_PUBLICATION_HISTORY names no repository", () => {
    expect(STORE).toBeNull();
  });

  it.skipIf(STORE === null)("every row is a version that history held, introduced by the commit it names", () => {
    const store = STORE!;
    expect(git(store, ["cat-file", "-t", FROZEN_AT]).toString().trim(), "the frozen commit is not in that store")
      .toBe("commit");
    const wrong: string[] = [];
    for (const r of ROWS) {
      const path = `${STORE_DIRS[r.journal]}/${r.tag}.sql`;
      const at = `${r.journal} ${r.tag}`;
      try {
        git(store, ["merge-base", "--is-ancestor", r.introducedBy, FROZEN_AT]);
      } catch {
        wrong.push(`${at}: ${r.introducedBy} is not in the frozen history`);
        continue;
      }
      const text = git(store, ["show", `${r.introducedBy}:${path}`]).toString("utf8");
      if (sha256Utf8(text) !== r.recorded) wrong.push(`${at}: the version at ${r.introducedBy} is not the recorded one`);
      if (sha256Utf8(normalizeSql(text)) !== r.executable) wrong.push(`${at}: its executable SQL is not the one named`);
      const blob = git(store, ["rev-parse", `${r.introducedBy}:${path}`]).toString().trim();
      const carriers = git(store, ["log", "--full-history", "--format=%H", FROZEN_AT, "--", path])
        .toString().split("\n").filter(Boolean)
        .filter((c) => {
          try { return git(store, ["rev-parse", `${c}:${path}`]).toString().trim() === blob; } catch { return false; }
        });
      if (carriers.length !== 1 || carriers[0] !== r.introducedBy) {
        wrong.push(`${at}: the version is carried by ${carriers.length} commits, not by ${r.introducedBy} alone`);
      }
    }
    expect(wrong, "a row the frozen history does not back").toEqual([]);
  }, 120_000);
});
