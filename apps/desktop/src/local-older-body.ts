/**
 * THE REACH-PAST BODY WIRE IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The door itself — the session cache, the states, the one-ask-per-row rule, the honest terminal
 * for a row the account no longer holds — is the shared shell's (`shell/older-body.ts`), exactly
 * as `local-consent.ts` says about the consent controls. Only the wire differs: this window's
 * content policy is `connect-src 'none'` and the Cloud client is aliased to a refusing stub, so
 * the ask goes down the pipe to the mail engine on this machine.
 *
 * On the HOSTED door the engine serves `GET /messages/:id/body` from its mirror when the message
 * is mirrored, and FORWARDS it to the hosted account when it is a reach-past row the mirror never
 * held (`cloud-engine.ts`'s fall-through) — so this one wire answers both shapes, and the answer
 * is the account's own stored row either way. A 404/410 down the pipe means the account no longer
 * holds the row, which the door renders as its terminal sentence rather than as a Retry that
 * cannot work; every other refusal rejects, which the door renders as `failed` with a real Retry.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import { narrowOlderBody, type OlderBodyWire } from "../../webapp/app/shell/older-body";

/**
 * The wire over ANY fetch-shaped transport — the narrowing and the status contract live once,
 * here, and each door supplies only its transport (`readMailboxFactsVia`'s rule): the desktop
 * window hands in `bridgeFetch`, and the LAN host client hands in its bearer fetch
 * (`host-client/transports.ts`), because that page's engine also lists reach-past rows over a
 * bounded in-memory mirror and a door nobody wires there is the stalled Retry all over again.
 */
export function olderBodyVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): OlderBodyWire {
  return {
    body: async (messageId) => {
      const res = await fetchImpl(`/messages/${encodeURIComponent(messageId)}/body`);
      if (res.status === 404 || res.status === 410) return { kind: "gone" };
      if (!res.ok) {
        let said: string | undefined;
        try {
          said = ((await res.json()) as { error?: { message?: string } }).error?.message;
        } catch {
          /* Not JSON, or an empty body. The status is all there is. */
        }
        throw new Error(said ?? `the mail engine answered ${res.status}`);
      }
      return narrowOlderBody((await res.json()) as Record<string, unknown>);
    },
  };
}

export const olderBodyOverBridge: OlderBodyWire = olderBodyVia(bridgeFetch);
