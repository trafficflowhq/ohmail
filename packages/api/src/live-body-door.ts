import { epochOf, isRefusedCommand, parseRef, sameEpoch } from "@trafficflow/core/adapters/imap";
import type { LiveBodyPlace, LiveBodyRead } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";
import { withinDoorBudget } from "./imap-door.js";

/**
 * LOAD IT NOW's read of the mail server: one admitted connection under the door's one budget, the
 * letter's places in the order given, each a `BODY.PEEK` fetch of one UID under the size ceiling.
 * A place under another epoch, or one the server no longer holds, passes to the next; a place the
 * server refused passes too, and its refusal is the answer when no place held the letter. Reads only.
 */
export function liveBodyReader(deps: ApiDeps) {
  return (mailboxId: string, places: readonly LiveBodyPlace[], maxBytes: number): Promise<LiveBodyRead> =>
    withinDoorBudget(deps, mailboxId, async (adapter) => {
      let refused: unknown = null;
      for (const p of places) {
        let found: Awaited<ReturnType<typeof adapter.fetchByUid>>;
        try {
          found = await adapter.fetchByUid(p.folder, [p.uid], { maxBytes });
        } catch (err) {
          // A folder gone or refused (a tagged NO or BAD) leaves the connection usable.
          if (!isRefusedCommand(err)) throw err;
          refused = err;
          continue;
        }
        if (!sameEpoch(epochOf(found.uidValidity), epochOf(p.uidvalidity))) continue;
        if (found.oversize.includes(p.uid)) return { oversize: true };
        const raw = found.creates.find((c) => parseRef(c.locator.ref).uid === p.uid)?.raw;
        if (raw !== undefined) return { raw };
      }
      if (refused !== null) throw refused;
      return { gone: true };
    });
}
