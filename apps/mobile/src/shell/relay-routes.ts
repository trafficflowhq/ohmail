/**
 * THE ROUTES THE SHELL'S PAGE MAY REACH: the relay's own allow-list (`packages/api/src/relay-allowlist.ts`),
 * as method and pattern, one entry each and in its order. They stand as data in `relay-routes.json` beside
 * this file, written from the relay's list by `node apps/mobile/scripts/relay-routes.mjs`, never by hand:
 * the phone's bundle may not reach the API package, so the list is carried here, and
 * `test/shell-http-door.test.ts` holds the data equal to the relay's, entry for entry, and names any change.
 * Data and not code, because a route the page may reach is no request: the censuses that read the client
 * trees for the requests they make read code. This gives the list its type; the HTTP door reads it here.
 */
import routes from "./relay-routes.json";

export const RELAY_ROUTES: readonly string[] = Object.freeze(routes);
