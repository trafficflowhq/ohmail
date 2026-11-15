import { readMigrationFiles } from "drizzle-orm/migrator";
import { readJournalOf, type JournalSpec } from "../baseline.js";
import { CLOUD_JOURNAL, MAIL_JOURNAL } from "../journal-specs.js";
import {
  LINE_2_0_START, OLD_HEADS, TRANSITION_WINDOW, entryNumber, windowEntries, type ServerJournal,
} from "../journal-heads.js";

/** One entry the transition applies: its statements as the migrator splits them, its ledger row. */
export interface WindowEntry {
  readonly journal: ServerJournal;
  readonly tag: string;
  /** The journal's stamp: the ledger row's `created_at`. */
  readonly when: number;
  /** drizzle's own hash of the file: the ledger row's `hash`. */
  readonly hash: string;
  readonly statements: readonly string[];
}

/** The two journals a transition reads. A test hands copies; a deployment has no reason to. */
export interface TransitionJournals { readonly mail: JournalSpec; readonly cloud: JournalSpec }

export const SHIPPED_JOURNALS: TransitionJournals = { mail: MAIL_JOURNAL, cloud: CLOUD_JOURNAL };

/** How many entries each journal's window holds. The transition applies that list and nothing else. */
export const WINDOW_LENGTH = 6;

/** The window is not the six entries, in order, that the transition was written for. */
export class WindowMalformed extends Error {
  constructor(journal: string, why: string) {
    super(`the ${journal} journal's 2.0 window is not what the transition applies: ${why}`);
    this.name = "WindowMalformed";
  }
}

/**
 * The entries of `journal`'s window, read from the journal itself: the tags and stamps from
 * `meta/_journal.json`, the statements and the hash from drizzle's own reader, so what runs here
 * is what the ordinary migrator would run and what is recorded is what it would record.
 *
 * Refuses a window that is not {@link WINDOW_LENGTH} entries numbered one after another from the
 * line's start through `TRANSITION_WINDOW`'s last, each stamped above the old head and above its
 * predecessor.
 */
export function readWindow(journal: ServerJournal, spec: JournalSpec = SHIPPED_JOURNALS[journal]): WindowEntry[] {
  const entries = windowEntries(journal, readJournalOf(spec));
  const start = LINE_2_0_START[journal];
  if (entries.length !== WINDOW_LENGTH) {
    throw new WindowMalformed(journal, `it holds ${entries.length} entries, not ${WINDOW_LENGTH}`);
  }
  entries.forEach((e, i) => {
    if (entryNumber(e.tag) !== start + i) throw new WindowMalformed(journal, `entry ${i + 1} is ${e.tag}, not number ${start + i}`);
  });
  if (entries.at(-1)!.tag !== TRANSITION_WINDOW[journal].last) {
    throw new WindowMalformed(journal, `it ends at ${entries.at(-1)!.tag}, not ${TRANSITION_WINDOW[journal].last}`);
  }
  let floor: number = OLD_HEADS[journal].when;
  for (const e of entries) {
    if (e.when <= floor) throw new WindowMalformed(journal, `${e.tag} is stamped at or below what precedes it`);
    floor = e.when;
  }
  const files = new Map(readMigrationFiles({ migrationsFolder: spec.dir }).map((m) => [m.folderMillis, m]));
  return entries.map((e) => {
    const file = files.get(e.when);
    if (!file) throw new WindowMalformed(journal, `${e.tag} has no file the migrator reads`);
    return { journal, tag: e.tag, when: e.when, hash: file.hash, statements: file.sql };
  });
}

/** The 1.0 road of `journal`: its entries stamped at or below the old head, as the file lists them. */
export function oldRoad(journal: ServerJournal, spec: JournalSpec = SHIPPED_JOURNALS[journal]): { tag: string; when: number }[] {
  return readJournalOf(spec).filter((e) => e.when <= OLD_HEADS[journal].when).map((e) => ({ tag: e.tag, when: e.when }));
}
