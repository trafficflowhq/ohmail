/**
 * THE STORAGE ESTIMATE — how much letter text an account's mailboxes need once every letter is in,
 * from facts a request reads without counting the mail tables: the folder counts the worker records
 * (`mailbox_folders.server_exists`), the worker's snapshot of what ohmail holds per mailbox
 * (`mailbox_storage_stats`), and each mailbox's first import. Pure: the request and the console read
 * their own facts and call this.
 *
 * Per mailbox, the server's letters are its folder counts summed, divided by how many places one
 * letter occupies there (instances per letter, once the mailbox holds {@link ESTIMATE_MEASURED_MIN_LETTERS}
 * letters; one below that). Expected is never fewer than the letters held, and exactly those once a
 * snapshot taken after the first import completed counts them. The average text of a letter is the
 * account's own once that many letters hold text, else {@link DEFAULT_LETTER_TEXT_BYTES}. `complete` is
 * false while the figure leans on folder counts and a folder has none.
 */

/** Letters a measured figure needs before it replaces the default. */
export const ESTIMATE_MEASURED_MIN_LETTERS = 1_000;

/** The text one letter is taken to hold until the account's own average is measured (the plans' figure). */
export const DEFAULT_LETTER_TEXT_BYTES = 25_000;

/** One mailbox's facts, as the reader found them. */
export interface EstimateMailbox {
  id: string;
  /** The folder counts the server stated, summed; null when no folder of the mailbox was counted. */
  serverLetters: number | null;
  /** The mailbox has folder rows and every one carries a count. */
  counted: boolean;
  /** Its first import completed, or ohmail no longer reads it: what it holds is all it will hold. */
  imported: boolean;
  /** The worker's snapshot, or null before the first one; `imported` when taken after the first import. */
  stats: { letters: number; textLetters: number; textBytes: number; instances: number; imported: boolean } | null;
}

export interface MailboxEstimate {
  id: string;
  /** Letters ohmail holds of this mailbox, as the snapshot counted them. */
  letters: number;
  expectedLetters: number;
  expectedBytes: number;
  complete: boolean;
}

export interface StorageEstimate {
  mailboxes: MailboxEstimate[];
  expectedLetters: number;
  expectedBytes: number;
  storedLetters: number;
  /** The text one letter holds, on average: measured, or the default. */
  avgLetterBytes: number;
  avgMeasured: boolean;
  complete: boolean;
}

/** The estimate over an account's mailboxes. An account with none expects nothing, completely. */
export function storageEstimateOf(mailboxes: readonly EstimateMailbox[]): StorageEstimate {
  let textBytes = 0;
  let textLetters = 0;
  for (const m of mailboxes) {
    if (m.stats === null) continue;
    textBytes += m.stats.textBytes;
    textLetters += m.stats.textLetters;
  }
  const avgMeasured = textLetters >= ESTIMATE_MEASURED_MIN_LETTERS;
  const avgLetterBytes = avgMeasured ? Math.round(textBytes / textLetters) : DEFAULT_LETTER_TEXT_BYTES;
  const out = mailboxes.map((m): MailboxEstimate => {
    const letters = m.stats?.letters ?? 0;
    const instances = m.stats?.instances ?? 0;
    const ratio = letters >= ESTIMATE_MEASURED_MIN_LETTERS && instances > 0 ? instances / letters : 1;
    const onServer = m.serverLetters === null ? 0 : Math.round(m.serverLetters / ratio);
    // A snapshot taken after the first import is the whole mailbox; before one, the server says.
    const whole = m.imported && m.stats?.imported === true;
    const expectedLetters = whole ? letters : Math.max(letters, onServer);
    return {
      id: m.id, letters, expectedLetters, expectedBytes: expectedLetters * avgLetterBytes,
      complete: whole || m.counted,
    };
  });
  return {
    mailboxes: out,
    expectedLetters: out.reduce((n, m) => n + m.expectedLetters, 0),
    expectedBytes: out.reduce((n, m) => n + m.expectedBytes, 0),
    storedLetters: out.reduce((n, m) => n + m.letters, 0),
    avgLetterBytes,
    avgMeasured,
    complete: out.every((m) => m.complete),
  };
}

/**
 * Each mailbox's share of the bytes stored, from the snapshot's text bytes and the live counter: the
 * counter is the truth for the whole, the snapshot only splits it. Shares round down, and the
 * remainder goes to the largest, so they sum to the counter.
 */
export function storageSharesOf(
  usedBytes: number, mailboxes: ReadonlyArray<{ id: string; textBytes: number }>,
): Map<string, number> {
  const total = mailboxes.reduce((n, m) => n + Math.max(0, m.textBytes), 0);
  const out = new Map<string, number>();
  if (total <= 0) {
    for (const m of mailboxes) out.set(m.id, 0);
    return out;
  }
  let given = 0;
  let largest: { id: string; textBytes: number } | null = null;
  for (const m of mailboxes) {
    const share = Math.floor(usedBytes * (Math.max(0, m.textBytes) / total));
    out.set(m.id, share);
    given += share;
    if (largest === null || m.textBytes > largest.textBytes) largest = m;
  }
  if (largest !== null) out.set(largest.id, out.get(largest.id)! + Math.max(0, usedBytes - given));
  return out;
}
