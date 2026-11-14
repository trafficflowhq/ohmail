/**
 * THE READER'S PARTS ON THE MAIL GROUND: what the reading column is handed on a host that hands the ground. The file
 * door and the picture door are the ground's two (`useDoors()`: one instance of each for the mounted frame, and no
 * door where the ground stands none: the reader then draws no tile, no picture and no control). The letter's
 * renderer and the one look at a file's bytes are the host's own, handed where the host makes its reader.
 *
 * The reply is Write's (`write-entry.ts`), over the one composer the ground stands. The invitation is the host's
 * presentation over the ground's file door. The note of a letter's copy in Sent is still `none`.
 *
 * A host makes its reader ONCE, at module scope (`mailReader`), so the column's component never changes identity
 * and never mounts again; the parts are read in each render, because a door changes identity while it fetches.
 */
import { useMemo } from "react";
import { useDoors } from "@ohmail/app-logic/reader/doors";
import type { ReaderEntry } from "../host/index.js";
import { readerEntryFrom, type ReaderBody, type ReaderParts } from "../reader/index.js";
import { WRITE } from "./write-entry.js";

/**
 * What a host supplies beside the mail ground: text and invitation presentation, a file preview, and the clipboard.
 */
export interface MailReaderHost {
  readonly body: ReaderBody;
  /** `none`: a press on a file saves it. */
  readonly look: ReaderParts["look"];
  readonly invitation?: ReaderParts["invitation"];
  /** The host's clipboard (a browser's own); left out: none, and a copy is not offered. */
  readonly copy?: ReaderParts["copy"];
}

/** The reader's parts over the ground's doors and the host's presentation. Throws where no ground stands above. */
export function useMailReaderParts(host: MailReaderHost): ReaderParts {
  const { files, pictures } = useDoors();
  const { body, look } = host;
  const copy = host.copy ?? "none";
  const invitation = host.invitation ?? "none";
  return useMemo(
    () => ({
      body,
      files: files ?? "none",
      pictures: pictures ?? "none",
      look,
      sentCopy: "none",
      reply: WRITE.reply,
      invitation,
      copy,
    }),
    [body, look, copy, files, pictures, invitation],
  );
}

/** The reader a host hands the frame over the mail ground. Made once per host, never in a render. */
export function mailReader(host: MailReaderHost): ReaderEntry {
  return readerEntryFrom(() => useMailReaderParts(host));
}
