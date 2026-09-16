/**
 * WHAT ACTUALLY RAN, proved from history rather than assumed from bytes.
 *
 * drizzle records `sha256(<the .sql file>)` at apply time, so a row and the file this tree ships
 * disagree the moment anything edits that file — a comment rewrite included. This finds the
 * historical blob whose hash IS the recorded one and compares the two on executable SQL; no blob
 * carries it, or the SQL differs without a named allowance, and it refuses. Fail-closed: a path
 * that cannot answer refuses by name, because "the check could not run" is not "it passed".
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { allowanceFor, type MigrationAllowance } from "./migration-allowances.js";
import { normalizeSql } from "./sql-normalize.js";

/** One version this file has held, as the repository records it. */
export interface HistoricalSql {
  /** The 40-hex commit that introduced this content at this path. */
  commit: string;
  /** Its committer date, ISO-8601 — what an operator reads to recognise the campaign. */
  at: string;
  sql: string;
}

/** History for one migration file. Throws with a named reason when it cannot be read. */
export interface ProvenanceReader {
  history(dir: string, tag: string): HistoricalSql[];
}

export type DriftKind =
  /** The applied SQL and the shipped SQL are the same program; only comments or layout moved. */
  | "comment-only"
  /** Executable SQL differs and a named allowance admits exactly this pair. */
  | "allowed"
  /** Executable SQL differs and nothing admits it. */
  | "executable"
  /** No version this file ever held hashes to what the row records. */
  | "unknown-provenance"
  /** History could not be read at all (no repository, no git, a shallow clone). */
  | "unreadable"
  /** More than one row at this `when`, so there is no single recorded hash to resolve. */
  | "rows-collide";

export interface MigrationDrift {
  journal: string;
  tag: string;
  when: number;
  /** `sha256` of the SQL this tree ships for `tag`. */
  expected: string;
  /** What the row records, or null when the rows collide. */
  recorded: string | null;
  rowsAtWhen: number;
  kind: DriftKind;
  provenance: { commit: string; at: string } | null;
  /** The allowance's reason, or the reason history could not be read. */
  note: string | null;
}

/** The two kinds a deployment may proceed over. Everything else refuses. */
export function driftAdmitted(d: MigrationDrift): boolean {
  return d.kind === "comment-only" || d.kind === "allowed";
}

const sha256Utf8 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * git exports `GIT_DIR` and friends to every hook, and they silently OVERRIDE `git -C <path>` in
 * any child the hook runs — a pre-push audit once read its own scratch repo that way. Stripped
 * here so this reads the tree it was pointed at, whatever launched it.
 */
const GIT_ENV_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of GIT_ENV_OVERRIDES) delete env[k];
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  });
}

/**
 * The repository this migration folder lives in, read through git itself. The folder is `src/..`
 * under the test runner and `dist/..` after a build — both resolve to the same tracked directory,
 * so one lookup serves either.
 */
export function gitProvenanceReader(): ProvenanceReader {
  return {
    history(dir: string, tag: string): HistoricalSql[] {
      const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
      const rel = relative(top, join(dir, `${tag}.sql`)).split(sep).join("/");
      const listed = git(top, ["log", "--full-history", "--format=%H%x09%cI", "--", rel])
        .split("\n")
        .filter(Boolean)
        .reverse();
      const seen = new Set<string>();
      const out: HistoricalSql[] = [];
      for (const line of listed) {
        const [commit, at] = line.split("\t");
        if (!commit || !at) continue;
        let blob: string;
        try {
          blob = git(top, ["rev-parse", `${commit}:${rel}`]).trim();
        } catch {
          continue;
        }
        if (seen.has(blob)) continue;
        seen.add(blob);
        out.push({
          commit,
          at,
          sql: execFileSync("git", ["-C", top, "cat-file", "blob", blob], {
            encoding: "buffer",
            maxBuffer: 64 * 1024 * 1024,
            timeout: 120_000,
            env: gitEnv(),
          }).toString(),
        });
      }
      return out;
    },
  };
}

/** What `digestMismatches` found, before anything asks history about it. */
export interface ByteMismatch {
  tag: string;
  when: number;
  expected: string;
  recorded: string | null;
  rowsAtWhen: number;
}

/**
 * Resolve one byte-level mismatch to a verdict. `shippedSql` is the file this tree ships, passed
 * in rather than re-read so the caller's reading and this one cannot diverge.
 */
export function classifyDrift(
  journal: string,
  dir: string,
  m: ByteMismatch,
  shippedSql: string,
  reader: ProvenanceReader,
): MigrationDrift {
  const base = {
    journal, tag: m.tag, when: m.when, expected: m.expected,
    recorded: m.recorded, rowsAtWhen: m.rowsAtWhen,
    provenance: null, note: null,
  } satisfies Omit<MigrationDrift, "kind">;

  if (m.recorded === null || m.rowsAtWhen > 1) return { ...base, kind: "rows-collide" };

  let history: HistoricalSql[];
  try {
    history = reader.history(dir, m.tag);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ...base, kind: "unreadable", note: why ?? "git could not be run" };
  }

  const applied = history.find((h) => sha256Utf8(h.sql) === m.recorded);
  if (!applied) return { ...base, kind: "unknown-provenance" };

  const provenance = { commit: applied.commit, at: applied.at };
  if (normalizeSql(applied.sql) === normalizeSql(shippedSql)) {
    return { ...base, kind: "comment-only", provenance };
  }
  const allowance: MigrationAllowance | null = allowanceFor(journal, m.tag, m.recorded, m.expected);
  if (allowance) return { ...base, kind: "allowed", provenance, note: allowance.reason };
  return { ...base, kind: "executable", provenance };
}

/** The one-line record of an admitted drift, per tag, for the operator's log. */
export function driftSentence(d: MigrationDrift): string {
  const where = d.provenance ? `applied blob from ${d.provenance.commit} (${d.provenance.at})` : "no applied blob";
  if (d.kind === "comment-only") {
    return `${d.journal} ${d.tag}: comment-only drift, ${where} — executable SQL identical to the shipped file`;
  }
  if (d.kind === "allowed") {
    return `${d.journal} ${d.tag}: executable drift ADMITTED by a named allowance, ${where} — ${d.note}`;
  }
  return `${d.journal} ${d.tag}: ${d.kind}`;
}
