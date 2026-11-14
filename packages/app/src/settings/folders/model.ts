/**
 * Folders' model: "Use folders" as the server's consent row answers it, and each mailbox's own switch. The shell
 * builds it from the one consent instance, because the rail's folders read the same answer.
 */
export interface FoldersMailbox {
  readonly id: string;
  readonly address: string;
  /** On exactly when the server holds no exception for it. */
  readonly on: boolean;
}

export interface FoldersModel {
  readonly on: boolean;
  set(enabled: boolean): Promise<unknown>;
  /** Each mailbox's switch, or null where the list is withheld (see `foldersMailboxes`). */
  readonly mailboxes: readonly FoldersMailbox[] | null;
  setMailbox(mailboxId: string, enabled: boolean): Promise<unknown>;
}

/**
 * The mailboxes' list, or null. It stands only while folders are on, once the server's exceptions are known, where
 * the shell can write one, and with a second mailbox: with one, the master IS the mailbox's switch.
 */
export function foldersMailboxes(at: {
  readonly on: boolean;
  readonly known: boolean;
  readonly settable: boolean;
  readonly mailboxes: readonly { readonly id: string; readonly address: string }[] | null;
  readonly off: Readonly<Record<string, string>>;
}): FoldersMailbox[] | null {
  const { on, known, settable, mailboxes, off } = at;
  if (!on || !known || !settable || !mailboxes || mailboxes.length < 2) return null;
  return mailboxes.map((mb) => ({ id: mb.id, address: mb.address, on: (off[mb.id] ?? null) === null }));
}

/**
 * A folders write that pulls the change at once: the flip rides the delta, so without a pull the rail answers on
 * the wake stream's schedule. One pull per CONFIRMED write, after its answer; a refused write pulls nothing and is
 * thrown on, so the pane says it.
 */
export function pullAfter<A extends unknown[], R>(
  write: (...args: A) => Promise<R>,
  pull: () => Promise<unknown>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    const answer = await write(...args);
    void pull().catch(() => undefined);
    return answer;
  };
}
