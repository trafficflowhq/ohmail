/**
 * THE FILES A FORWARD CARRIES, LISTED BEFORE IT GOES — the forward sheet's decision, away from the
 * markup. The server streams the original's parts onto the forward; once the person removes one, this
 * phone sends the ids kept (`forwardParts`), so a removed part never leaves. With nothing removed no
 * list goes, and the server sends every part. Until the server's answer is known the rows are read-only
 * and a choice made earlier still goes (the send-time check refuses it in words if the server cannot
 * honour it). Where the server said it cannot, every part goes, and a choice made earlier is said lost.
 *
 * The bounds are three, and the phone's 3.0 MB is not one of them for these files: they never ride
 * the phone's request. Files added here stay under the phone's cap (`admitPicked`), the kept parts
 * under the send's forwarded ceiling, and both together under what the mailbox takes.
 */
import { sizeLabel } from "../state/live";
import { refuse, type Refusal } from "../refusal";

export interface ForwardPart { id: string; filename: string; sizeBytes: number; inline: boolean }

export interface ForwardFilesInput {
  list: { state: "loading" | "ready" | "failed"; parts: readonly ForwardPart[] };
  /** The server sends only the named parts (`GET /hello` `features.forwardParts`): `null` is not known yet. */
  supported: boolean | null;
  /** The ids kept after a removal (`Letter.forwardKept`); `null` is nothing removed. */
  kept: readonly string[] | null;
  /** Bytes of the files added on this phone. */
  addedBytes: number;
  caps: { phone: number; forwarded: number; message: number };
}

export interface ForwardFilesPlan {
  rows: Array<ForwardPart & { removable: boolean }>;
  kept: string[];
  /** What the send carries: the kept ids once one was removed, else absent (every part). */
  wire: string[] | undefined;
  keptBytes: number;
  /** The sentence under the rows. */
  line: Refusal;
  /** Why Send cannot go now, said in place of sending. */
  refusal: Refusal | null;
}

export function forwardFilesPlan(o: ForwardFilesInput): ForwardFilesPlan {
  const more = sizeLabel(o.caps.phone);
  const chosen = o.supported === false ? null : o.kept;
  const lost = o.supported === false && o.kept !== null;
  if (o.list.state === "loading") {
    return { rows: [], kept: [], wire: undefined, keptBytes: 0, line: refuse("forwardFilesNone", more), refusal: refuse("forwardFilesReading") };
  }
  if (o.list.state === "failed") {
    // Unread here: a choice made earlier still goes; without one the server sends every part.
    return {
      rows: [], kept: chosen === null ? [] : [...chosen], wire: chosen === null ? undefined : [...chosen], keptBytes: 0,
      line: refuse(lost ? "forwardFilesUnreadRemovedGo" : chosen === null ? "forwardFilesUnreadAllGo" : "forwardFilesUnreadKept"), refusal: null,
    };
  }
  const all = o.list.parts.map((p) => ({ ...p, removable: o.supported === true }));
  const keptRows = chosen === null ? all : all.filter((r) => chosen.includes(r.id));
  // Not known yet: a part already removed stays out of the read-only list as it stays out of the send.
  const rows = o.supported === null ? keptRows : all;
  const kept = keptRows.map((r) => r.id);
  const keptBytes = keptRows.reduce((n, r) => n + r.sizeBytes, 0);
  const line = all.length === 0 ? refuse("forwardFilesNone", more)
    : o.supported === true || chosen !== null ? refuse("forwardFilesLine", sizeLabel(keptBytes), more)
      : refuse(lost ? "forwardFilesRemovedGo" : "forwardFilesAllGo", sizeLabel(keptBytes), more);
  const refusal = keptBytes > o.caps.forwarded ? refuse("forwardFilesTooLarge", sizeLabel(o.caps.forwarded))
    : keptBytes + o.addedBytes > o.caps.message ? refuse("forwardTotalTooLarge", sizeLabel(o.caps.message))
      : null;
  return { rows, kept, wire: chosen === null ? undefined : kept, keptBytes, line, refusal };
}
