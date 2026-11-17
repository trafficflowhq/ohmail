/**
 * WHERE THE 1.0 LINE ENDS AND 2.0 BEGINS, in each of the three journals. Data and three pure
 * readers: no driver, no file read, so the phone's migrator and the desktop engine import it as
 * they import `journal-specs.ts`.
 *
 * The 1.0 journals are closed and kept as the road every store walks to 2.0. 2.0's entries are
 * numbered above them with room (`LINE_2_0_START`) and stamped with the real time they land:
 * drizzle applies an entry only when its `when` is above the highest one a store records, so an
 * entry stamped at or below a recorded head is skipped for ever, without an error. The phone's
 * migrator goes by FILE NAME instead, which is why its head is a name.
 *
 * `OLD_HEADS` is edited by hand, and only after the transition (`./transition/`) has been read
 * again: it is written for exactly these heads. A 1.0 fix that adds a migration moves a head;
 * `journal-heads.test.ts` is red until this constant, the fix's entry (numbered below the start)
 * and every 2.0 entry not yet pinned (stamped again above it) agree.
 */
export const OLD_HEADS = {
  mail: { tag: "0185_sync_blocked_reason_mailbox_full", when: 1791602600086 },
  cloud: { tag: "0059_account_storage_holds_staff_grant", when: 1794175152143 },
  device: { name: "0184_account_settings_impersonation_filing.sql" },
} as const;

/** The first number a 2.0 entry may carry, per journal. Below it is the 1.0 line's alone. */
export const LINE_2_0_START = { mail: 200, cloud: 100, device: 200 } as const;

/**
 * The entries the transition applies itself, in one transaction: from each journal's start
 * through `last`, eight and six. An entry numbered above `last` is an ordinary migration again.
 * `skipped` names the numbers in that span a journal never used: mail 0206 is the phone's own
 * entry (`drizzle-sqlite/0206_device_unique_indexes.sql`), and the mail journal went on at 0207.
 * Mail 0207 and 0208 joined the window with 0208, the recipients' stored key, which rewrites
 * `messages` and so belongs in the closed window; drizzle records a store's head by stamp, so no
 * entry stamped below a window entry can stay outside it.
 */
export const TRANSITION_WINDOW: Readonly<Record<"mail" | "cloud", { readonly last: string; readonly skipped: readonly number[] }>> = {
  mail: { last: "0208_recipient_keys_column", skipped: [206] },
  cloud: { last: "0105_calendar_sign_in", skipped: [] },
};

/** The two journals a Postgres store runs. */
export type ServerJournal = keyof typeof TRANSITION_WINDOW;

/** `0185` of `0185_sync_blocked…`, of `0185.noop` or of a path ending in either; `null` otherwise. */
export function entryNumber(tagOrFile: string): number | null {
  const m = /(?:^|\/)(\d{4})[_.][^/]*$/.exec(tagOrFile);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** The numbers the window's entries carry, in order: the line's start through `last`, less what it skipped. */
export function windowNumbers(journal: ServerJournal): number[] {
  const last = entryNumber(TRANSITION_WINDOW[journal].last)!;
  const out: number[] = [];
  for (let n = LINE_2_0_START[journal]; n <= last; n++) if (!TRANSITION_WINDOW[journal].skipped.includes(n)) out.push(n);
  return out;
}

/** Is `tag` one of the entries the transition applies? By number, so a renamed entry stays inside. */
export function inTransitionWindow(journal: ServerJournal, tag: string): boolean {
  const n = entryNumber(tag);
  return n !== null && windowNumbers(journal).includes(n);
}

/**
 * Does this open owe the device journal's first entry of the 2.0 line? True when the journal's lowest
 * entry numbered at or above `start` is among `owed`: the first migration that crosses into 2.0 is
 * about to run, and a phone takes a copy of its store before it. A store that has crossed already, or
 * a journal with no 2.0 entry yet, owes no copy.
 */
export function owesFirstOfLine(
  owed: readonly string[],
  journalNames: readonly string[],
  start: number = LINE_2_0_START.device,
): boolean {
  let first: { name: string; n: number } | null = null;
  for (const name of journalNames) {
    const n = entryNumber(name);
    if (n !== null && n >= start && (first === null || n < first.n)) first = { name, n };
  }
  return first !== null && owed.includes(first.name);
}

/** The window's entries of one journal, in journal order. */
export function windowEntries<T extends { tag: string }>(journal: ServerJournal, entries: readonly T[]): T[] {
  return entries.filter((e) => inTransitionWindow(journal, e.tag));
}
