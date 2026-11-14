import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalEntry, JournalSpec } from "./baseline.js";

/** A journal as it stood at one entry, in a folder of its own; `dispose` removes the folder. */
export interface CutJournal {
  readonly spec: JournalSpec;
  dispose(): void;
}

/**
 * TEST SUPPORT, and a rehearsal's: nothing a deployment runs writes this folder (the migrator walks
 * the 1.0 road from the journal's own files, `migrate.ts`).
 *
 * `spec`'s journal CUT AT `when`: a temporary folder holding `meta/_journal.json` with the entries
 * stamped at or below `when` and exactly their `.sql` files, byte for byte. drizzle's own
 * `migrate` over it is the old road with the real hashes, so a store walked along it records what
 * a store of that release records. The files are copied, never linked: the migrator hashes what
 * it reads, and a folder that follows the tree is not a journal as it stood.
 */
export function journalThrough(spec: JournalSpec, when: number): CutJournal {
  const meta = JSON.parse(readFileSync(join(spec.dir, "meta", "_journal.json"), "utf8")) as
    Record<string, unknown> & { entries?: JournalEntry[] };
  const entries = (meta.entries ?? []).filter((e) => e.when <= when);
  if (entries.length === 0) throw new Error(`the ${spec.name} journal holds no entry at or below ${when}`);
  const dir = mkdtempSync(join(tmpdir(), `ohmail-journal-${spec.name}-`));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...meta, entries }));
  for (const e of entries) copyFileSync(join(spec.dir, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return {
    spec: { name: spec.name, dir, migrationsSchema: spec.migrationsSchema },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
