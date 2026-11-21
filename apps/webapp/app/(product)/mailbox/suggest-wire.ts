/**
 * THE WEB'S SUGGESTION WIRE: the calls the suggestion run makes over the server client, the account's own word on
 * whether AI is on, and the sentence a refusal of that client lends. It is the web host's own answer to the host
 * contract's `suggest` (`web-supplies.tsx` hands it); the run's hook reaches no server by itself. Moved out of
 * `shell/screener-suggest.ts` as it stood.
 */
import { account, ApiError, apiConfigured, screener as screenerApi } from "../../api-client";
import type { SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";

/**
 * The hosted transport — the browser talking to the API this app was written against.
 *
 * Handed in by the host that has it (the web's own supplies); never taken by the hook itself.
 */
export const CLOUD_WIRE: SuggestWire = {
  configured: () => apiConfigured(),
  list: (opts) => screenerApi.list(opts),
  suggest: (senders, opts) => screenerApi.suggest(senders, opts ?? {}),
  messageFor: apiMessageFor,
  // `GET /account/access` — the entitlements verdict this API already answers, served from the
  // port's own cache, so this costs the program nothing per ask. An unmetered host meters
  // nothing and gates nothing, which is `true`; an older server omits `aiEnabled` and that is
  // `null`, not `false` — "it did not say" must not read as "it said no".
  aiAvailable: async () => {
    try {
      // FRESH: this read takes a refusal DOWN, so an answer from before the refusal was made
      // would clear one that still stands. It is asked per press, never per mount, so it is not
      // the cadence the shared read exists to collapse.
      const a = await account.access({ fresh: true });
      // BOTH ANSWERS READ STRICTLY, because the third state is the one that matters: `metered`
      // absent is a server that did not say, and `!a.metered` would have read that as "no
      // program here, AI is on" — a body of `{}` clearing a true refusal.
      if (a.metered === false) return true;
      if (a.metered === true && typeof a.aiEnabled === "boolean") return a.aiEnabled;
      return null;
    } catch {
      return null;
    }
  },
};

/** The mounted frame keeps the scope that supplied the queue and the price request. */
export function suggestWireFor(expectedOwner: string): SuggestWire {
  return {
    ...CLOUD_WIRE,
    list: (opts) => screenerApi.list(opts, expectedOwner),
    suggest: (senders, opts) => screenerApi.suggest(senders, opts, expectedOwner),
  };
}

/**
 * The sentence for a refusal the HOSTED transport produced —
 * {@link CLOUD_WIRE}'s half of {@link SuggestWire.messageFor}, never called
 * directly by the flow. An {@link ApiError} already carries the service's
 * own message ("no AI classifier connected", "managed AI is switched off",
 * "no AI credits remain") — each a different, actionable fact written by
 * the code that decided. Re-deriving them from status codes is how a user
 * with an empty balance is told the model is down. Anything that is not an
 * `ApiError` is a bug in this client, with nothing true to say.
 */
function apiMessageFor(err: unknown, fallback: string): string {
  // ONLY A CODED ERROR LENDS ITS WORDS. `wire.coded` is "our envelope said this"; an `ApiError`
  // built on this side of the wire carries `coded: false`, and relaying its message put a
  // client-side sentence about a cookie on screen as the AI service's account of itself. The
  // caller's own copy is the honest answer there — see {@link clientRefusalKey}.
  return err instanceof ApiError && err.wire.coded ? err.message : fallback;
}
