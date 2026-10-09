/**
 * A FILE LIST THE WIRE FAILED IS ASKED AGAIN WHEN THE SERVER ANSWERS A DRAIN — one door for every
 * surface that holds lists (the web's attachments seam, the phone's reader). The store reads' policy
 * ({@link wireFailed}, at most {@link REASK_MAX} re-asks per id while the list stays wire-failed,
 * reset once it answers), and the re-ask goes through `reaskAttachments`, so an open letter's
 * pictures draw in place when the list arrives. Returns the unsubscribe.
 */
import type { OhmailEngine } from "./engine.js";
import { REASK_MAX, wireFailed } from "./wire-reask.js";

export function watchWireFailedLists(
  engine: Pick<OhmailEngine, "subscribe" | "drainsCompleted" | "attachmentsOf" | "reaskAttachments">,
  held: () => Iterable<string>,
  /** The surface's own re-ask, when an answer owes it more than the list (the web's calendar pass). */
  reask: (id: string) => void = (id) => void engine.reaskAttachments(id),
): () => void {
  const asks = new Map<string, number>();
  let seen = engine.drainsCompleted();
  return engine.subscribe(() => {
    const n = engine.drainsCompleted();
    if (n <= seen) return;
    seen = n;
    for (const id of [...held()]) {
      const list = engine.attachmentsOf(id);
      if (list.state !== "failed" || !wireFailed(list.code)) { asks.delete(id); continue; }
      const k = asks.get(id) ?? 0;
      if (k >= REASK_MAX) continue;
      asks.set(id, k + 1);
      reask(id);
    }
  });
}
