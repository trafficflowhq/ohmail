/**
 * WHICH MAILBOX A DRAFT OPENED FROM DRAFTS LEAVES FROM. A draft kept from a removed mailbox still
 * names it, and the server refuses to send from a `disabled` row, so Send would fail for ever.
 * The web compose's rule (`compose-from.ts`): a sendable row with the same address is the same
 * identity, taken silently; otherwise the fallback, or the first row that can send, and the sheet
 * says so. Only Send writes the new sender; keeps name the row's own mailbox, which is no move.
 */
export interface SenderRow {
  id: string;
  address: string;
  status: string | null;
}

export interface ComposeSender {
  sendFrom: string | null;
  /** The bound mailbox cannot send and `sendFrom` is another identity. */
  substituted: boolean;
  /** The bound mailbox's address, where the roster still lists it. */
  was: string | null;
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
