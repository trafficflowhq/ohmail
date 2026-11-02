/**
 * WHICH MAILBOX A NEW MAIL LEAVES FROM. With nothing picked it is the web's default (`defaultFrom`:
 * the oldest connected mailbox), else the engine's `sendingId`. A pick, or a draft opened from
 * Drafts, names its own; a draft kept from a removed mailbox cannot send from it, since the server
 * refuses a `disabled` row: a sendable row with the same address is the same identity, taken
 * silently; otherwise the fallback, or the first row that can send, and the sheet says so. Keeps
 * name the picked or bound mailbox, so a substitution is never a move.
 */
import { defaultFrom, optionsFromFacts, type FromOption } from "../state/live";

export interface SenderRow {
  id: string;
  address: string;
  status: string | null;
  createdAt?: string;
  smtpMaxSizeBytes?: number | null;
}

export interface ComposeSender {
  sendFrom: string | null;
  /** The bound mailbox cannot send and `sendFrom` is another identity. */
  substituted: boolean;
  /** The bound mailbox's address, where the roster still lists it. */
  was: string | null;
}

export interface ComposeFrom extends ComposeSender {
  /** The mailbox a keep names: the pick, else the bound row's own, else the sender. */
  keepFrom: string | null;
  /** What the From list offers, oldest first; sendable only. */
  choices: FromOption[];
}

export function composeSenderOf(o: {
  bound: string | null;
  fallback: string | null;
  known: boolean;
  rows: readonly SenderRow[];
}): ComposeSender {
  const keep: ComposeSender = { sendFrom: o.bound, substituted: false, was: null };
  if (o.bound === null || !o.known) return keep;
  const row = o.rows.find((r) => r.id === o.bound);
  if (row && row.status !== "disabled") return keep;
  const sendable = o.rows.filter((r) => r.status !== "disabled");
  if (sendable.length === 0) return keep;
  const fold = (a: string) => a.trim().toLowerCase();
  const same = row ? sendable.find((r) => fold(r.address) === fold(row.address)) : undefined;
  if (same) return { sendFrom: same.id, substituted: false, was: null };
  const pick = sendable.find((r) => r.id === o.fallback) ?? sendable[0]!;
  return { sendFrom: pick.id, substituted: true, was: row?.address ?? null };
}

/** A new mail's sender: the pick or the bound row, resolved as above, else the default. */
export function composeFromOf(o: {
  picked: string | null;
  bound: string | null;
  fallback: string | null;
  known: boolean;
  rows: readonly SenderRow[];
}): ComposeFrom {
  const options = o.known ? optionsFromFacts(o.rows) : [];
  const choices = options.filter((c) => c.sendable);
  const asked = o.picked ?? o.bound;
  const sender = asked !== null
    ? composeSenderOf({ bound: asked, fallback: o.fallback, known: o.known, rows: o.rows })
    : { sendFrom: defaultFrom(options)?.id ?? o.fallback, substituted: false, was: null };
  return { ...sender, keepFrom: asked ?? sender.sendFrom, choices };
}
