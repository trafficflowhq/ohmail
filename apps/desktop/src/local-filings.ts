/** The filings that wait, over this window's bridge — `filings-wire.ts` holds the requests. */
import { bridgeFetch } from "./bridge-fetch.js";
import { filingsVia } from "./filings-wire.js";

export const filingsOverBridge = filingsVia(bridgeFetch);
