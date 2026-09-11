/**
 * BUYING SUGGESTIONS FOR A HOSTED ACCOUNT, FROM THE DESKTOP — the transport and nothing else.
 * On the hosted door the allowance and ledger are the account's, so the suggest control asks
 * the same server a browser tab would; only the bytes travel differently. This window cannot
 * open a socket (`offline-guard.ts`), so requests go down the pipe to the engine, which holds
 * the session and forwards onward. No ladder, quote or chunk loop here: spending — price the
 * exact set, consent to the sum, chunked with a FRESH key per chunk, halt on the first
 * refusal — is the shared control's, decided above this file. The hosted routes `GET /screener`
 * and `POST /screener/suggest` fall through to the engine's write-through proxy.
 */

import { bridgeAvailable, bridgeFetch } from "./bridge-fetch.js";
import type { SuggestWire } from "../../webapp/app/shell/screener-suggest.js";
import type { ScreenerSuggestWire, ScreenerWirePage } from "../../webapp/app/api-client.js";

/**
 * THE TWO HOSTED ROUTES THIS TRANSPORT ADDRESSES — named once, and used below.
 *
 * Exported because the engine has to do the right thing with both and "the right thing" is not the
 * same for every route: its mirror answers most reads locally, and answering EITHER of these out of
 * the mirror would be a purchase priced against a copy that holds no ledger. So the engine's own
 * suite asserts, from this list, that both are relayed to the account on the hosted door and served
 * by the route table on the standalone one. A list nothing built from would be decoration, so these
 * constants are what the calls are actually composed from.
 */
export const SUGGEST_ROUTES = [
  { method: "GET", pattern: "/screener" },
  { method: "POST", pattern: "/screener/suggest" },
] as const;

const [PAGE, BUY] = SUGGEST_ROUTES;

/**
 * A REFUSAL THAT CARRIES THE SERVICE'S OWN SENTENCE.
 *
 * Every refusal on this path already has a true, actionable one written by whichever code made the
 * decision — no classifier connected, managed AI switched off, no actions remaining on this account,
 * or this install is offline so writes are paused. None of them is inferable from a status code, and
 * a second taxonomy composed here is how somebody with an empty balance is told the model is down.
 * So the message is carried out of the body untouched and handed straight to the control.
 */
export class SuggestRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SuggestRefused";
    this.status = status;
    this.code = code;
  }
}

async function refusalOf(res: Response): Promise<SuggestRefused> {
  let code = "";
  let message = `the mail engine answered ${res.status}`;
  try {
    const wire = (await res.json()) as { error?: { code?: string; message?: string } };
    code = wire.error?.code ?? "";
    message = wire.error?.message ?? message;
  } catch {
    /* Not JSON. The status is all there is to say, and saying it beats inventing a reason. */
  }
  return new SuggestRefused(res.status, code, message);
}

/** One request down the pipe, as the JSON the caller expects — or the refusal, thrown. */
async function ask<T>(path: string, init?: Record<string, unknown>): Promise<T> {
  const res = await bridgeFetch(path, init);
  if (!res.ok) throw await refusalOf(res);
  return (await res.json()) as T;
}

/**
 * The hosted suggest flow, over the bridge.
 *
 * A module constant rather than a factory: it holds no state, and one shared object means a control
 * that remounts as the Screener comes and goes cannot arrive with a different transport than the one
 * that priced its last press.
 */
export const cloudSuggestWire: SuggestWire = {
  /**
   * There is a server to ask whenever this window is inside the app at all.
   *
   * The narrower question — is this install signed in, and is it on the hosted door — is answered by
   * the gate, which is what decides whether the control is mounted. Answering it twice, in two
   * places, is how the two answers start to disagree.
   */
  configured: () => bridgeAvailable(),

  list: ({ limit }) =>
    ask<ScreenerWirePage>(`${PAGE.pattern}${limit != null ? `?limit=${limit}` : ""}`),

  /**
   * Price a set, or buy it.
   *
   * The body is the endpoint's: an explicit sender list, plus `dryRun` when nothing is to be spent.
   * The KEY IS THE CALLER'S and is set only on the real run — a dry run moves nothing, so there is
   * nothing for a replay to protect, and a key on it would consume one for a request that never
   * charged. On the real run it is per chunk and it is what turns a lost answer into a replay
   * instead of a second purchase.
   */
  suggest: (senders, opts = {}) =>
    ask<ScreenerSuggestWire>(BUY.pattern, {
      method: BUY.method,
      headers: {
        "content-type": "application/json",
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(opts.dryRun ? { senders, dryRun: true } : { senders }),
    }),

  messageFor: (err, fallback) => (err instanceof SuggestRefused ? err.message : fallback),
};
