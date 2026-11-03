/**
 * WHICH ADDRESS A NEW MAIL LEAVES FROM — the options and the default every compose surface reads
 * (the web's `app/shell/compose-from.ts` re-exports these; the phone's composer imports them). A
 * fresh compose defaults to the OLDEST CONNECTED mailbox, derived every time, nothing stored.
 * Sendable is `!== "disabled"` (the server's own rule); the default still prefers `connected`.
 */

/** One mailbox, as a From line is entitled to know it. */
export interface FromOption {
  /** The selector's value. Never an address. */
  id: string;
  address: string;
  /** May this be the sender today? `status !== "disabled"`, matching `SendService.reserve`. */
  sendable: boolean;
  /** Healthy. The fresh-compose default prefers these. */
  connected: boolean;
  /**
   * The biggest message THIS mailbox's submission server said it will accept, in bytes, or `null`
   * when it announced none. Per mailbox: the one that applies is the one the mail leaves from. It is
   * NOT the cap on its own — see `composeAttachCap`.
   */
  maxMessageBytes: number | null;
}

/** The mailbox facts this module reads (`GET /mailboxes`). */
export interface FromFacts {
  id: string;
  address: string;
  status: string | null;
  /** NOT NULL server-side; a row without one (an older wire) sorts after every dated row. */
  createdAt?: string;
  smtpMaxSizeBytes?: number | null;
}

const byAge = (a: FromFacts, b: FromFacts): number => {
  const x = a.createdAt;
  const y = b.createdAt;
  if (x !== undefined && y === undefined) return -1;
  if (x === undefined && y !== undefined) return 1;
  if (x !== undefined && y !== undefined && x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * The facts → the options, **oldest first**. The order is the rule: "the oldest connected mailbox"
 * is the default, and sorting here lets every consumer say "the first sendable one". Ties fall back
 * to the id so the order is total between renders.
 */
export function optionsFromFacts(facts: readonly FromFacts[]): FromOption[] {
  return [...facts].sort(byAge).map((m) => ({
    id: m.id,
    address: m.address,
    sendable: m.status !== "disabled",
    connected: m.status === "connected",
    // "No column" and "no announcement" both mean no measured ceiling for this mailbox.
    maxMessageBytes: m.smtpMaxSizeBytes ?? null,
  }));
}

/**
 * The default sender: the oldest CONNECTED mailbox, else the oldest that can send at all.
 *
 * `options` must already be oldest-first — see {@link optionsFromFacts}.
 */
export function defaultFrom(options: readonly FromOption[]): FromOption | null {
  return options.find((o) => o.connected && o.sendable) ?? options.find((o) => o.sendable) ?? null;
}
