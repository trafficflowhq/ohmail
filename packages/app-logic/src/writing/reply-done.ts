/**
 * THE REPLY THAT LAST SETTLED, as the one composer holds it: what the Ohbox reads for its one deliberate move, the
 * answered row sliding to Earlier. The mount that calls the composer provides it here; a place reads it with
 * `useReplyDone()` and never keeps one of its own.
 */
import { createContext, useContext, type Context } from "react";
import type { OhboxReplyDone } from "../ohbox/index.js";

/**
 * Filled by the composer's one mount, once per mounted frame. Read it with {@link useReplyDone}. `null` is the
 * composer's own answer (no reply has settled yet), so where nothing stands above the context holds `undefined`.
 */
export const ReplyDoneContext: Context<OhboxReplyDone | null | undefined> = createContext<
  OhboxReplyDone | null | undefined
>(undefined);

/** The reply that last settled in this frame, or null. Throws where no composer stands above: no row moves on a guess. */
export function useReplyDone(): OhboxReplyDone | null {
  const done = useContext(ReplyDoneContext);
  if (done === undefined) throw new Error("useReplyDone: no composer stands above (ReplyDoneContext)");
  return done;
}
