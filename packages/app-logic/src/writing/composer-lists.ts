"use client";

/**
 * THE THREE READINGS OF THE MIRROR THE COMPOSER IS HANDED, as whoever mounts it derives them, each read again only
 * when what is derived from the mirror moved:
 *
 * - `mailboxes`: the mirror's own mailbox rows, the From list's fallback where the account's facts cannot be seen.
 * - `drafts`: the drafts as a list shows them. A SEND STILL WAITING IS NOT INTERRUPTED: its own placeholder row is
 *   not listed (the send's line carries it). Never the mirror's raw draft rows: the composer picks a reply's row
 *   from this list, and a waiting send's placeholder would be offered as a held reply.
 * - `fallbackMailboxId`: the last-resort sending mailbox. It lists the mailboxes and falls through to the whole
 *   mirror's date order where the account has no seeded mailbox row, so it is never read in a render.
 */
import type { EngineDraft } from "@ohmail/wire";
import { useMemo } from "react";
import {
  NO_WAITING,
  draftsList,
  sendingMailboxId,
  type EntityReader,
  type OhmailEngine,
} from "@ohmail/client-engine";
import type { MailboxEntity } from "./composer-types.js";

export interface ComposerLists {
  readonly mailboxes: MailboxEntity[];
  readonly drafts: EngineDraft[];
  readonly fallbackMailboxId: string | null;
}

/** What was read of the mirror at this stamp of it. */
const at = <T>(_stamp: number, read: T): T => read;

/** `reader` is the mirror as it is (`engine.read()` of the same render), `derived` the stamp of what is derived from it. */
export function useComposerLists(engine: OhmailEngine, reader: EntityReader, derived: number): ComposerLists {
  /* The mirror's reader is one object while the engine stands: `derived` is what says its rows moved. Each list
     names the stamp it was read at, so that it is read again when the stamp moves and never in between. */
  const mailboxes = useMemo(() => at(derived, reader.list<MailboxEntity>("mailbox")), [reader, derived]);
  const fallbackMailboxId = useMemo(() => at(derived, sendingMailboxId(reader)), [reader, derived]);
  /* Optional-called: an engine double that never queues a send has no list to read. */
  const waiting = typeof engine.waitingSends === "function" ? engine.waitingSends() : NO_WAITING;
  const drafts = useMemo(() => {
    const paints = new Set(
      waiting.flatMap((w) => (w.paintId !== null && w.paintId !== w.draftId ? [w.paintId] : [])),
    );
    return at(
      derived,
      draftsList(reader).filter((d) => !paints.has(d.id)),
    );
  }, [reader, derived, waiting]);
  return useMemo(() => ({ mailboxes, drafts, fallbackMailboxId }), [mailboxes, drafts, fallbackMailboxId]);
}
