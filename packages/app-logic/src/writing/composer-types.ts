/**
 * WHAT THE COMPOSER NAMES OF THE SCREENS AROUND IT: three records a view draws or hands in, and the places it asks its
 * host to go to. They are declared here, beside the composer's other types, so that the composer reads no view and no
 * router; each view takes its type from this file.
 */

/** Where the composer sends the person: the compose form, the Drafts list, the Ohbox. Its host knows the way. */
export type ComposerPlace = "compose" | "drafts" | "ohbox";

/**
 * THE COMPOSER'S WORDS BESIDE THE CATALOGUE: what its host's text reader answers that is no sentence of the catalogue.
 * Handed in by whoever mounts the composer, as the send machine's words are (`MailSendText`). Each is a function,
 * asked when the composer says or sends something and never held: the reader's zone and language may change under
 * a mounted composer.
 */
export interface ComposerWords {
  /** How a time to come is written on the reader's clock: the hour a send later names. */
  scheduleLabel: (when: string, now: Date) => string;
  /** What a send line's sentence takes beside its key: the draft ceiling as the sentences name it (`{size}`). */
  sendLineValues: () => { size: string };
  /** The reader's clock now: a forward's quoted header names the original's date on it. */
  clock: () => { zone: string; locale: string };
}

/** The refusal a Discard came back with, rendered in its row — never a toast alone. */
export interface DiscardRefusal {
  draftId: string;
  why: "still-sending" | "unknown-jar" | "cancel-unknown";
  at: number;
}

/**
 * The MIRROR's `mailbox` entity shape. The shell lists these for the rail and the compose from-selector's fixture
 * fallback. `"mailbox"` is not a `/sync` entity, so only the fixture world ever holds one.
 */
export interface MailboxEntity {
  id: string;
  address: string;
  provider: string;
  protocol: string;
  status: string;
}

/** The new message Write to us opens. `diag` is the block, so the composer can offer to remove it. */
export interface SupportSeed {
  to: string;
  subject: string;
  body: string;
  diag: string;
}
