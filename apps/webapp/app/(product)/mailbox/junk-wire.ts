/**
 * THE WEB'S JUNK WIRE: the calls the Junk window makes, over the server client, and how that client's refusals are
 * read. It is the web host's own answer to the host contract's `junk` (`web-supplies.tsx` hands it); the Junk
 * window's hook names no server client. Moved out of `shell/junk-window.ts` as it stood.
 */
import { ApiError, screener as screenerApi } from "../../api-client";
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";

/** The browser's wire: the Cloud client, verbatim. */
export const cloudWire: JunkWire = {
  list: (opts) => screenerApi.junkList(opts),
  body: (m, u, v) => screenerApi.junkBody(m, u, v),
  rescue: (m, u, v, opts) => screenerApi.junkRescue(m, u, v, opts),
  dismissRescue: (id) => screenerApi.junkRescueDismiss(id),
  search: (q) => screenerApi.junkSearch(q),
  sweepPreview: () => screenerApi.junkSweepPreview(),
  sweepRequest: (confirmation) => screenerApi.junkSweepRequest(confirmation),
  isGone: (err) => err instanceof ApiError && err.status === 410,
  codeOf: (err) => (err instanceof ApiError ? err.code : null),
};
