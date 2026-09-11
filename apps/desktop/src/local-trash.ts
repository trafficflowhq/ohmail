/**
 * THE LIVE TRASH WINDOW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The window itself — the page, the honest states, the session body cache — is the shared shell's
 * (`shell/trash-window.ts`), exactly as `local-junk.ts` says about the Junk one. Only the wire
 * differs: this window's content policy is `connect-src 'none'` and the Cloud client is aliased to
 * a refusing stub, so every ask goes down the pipe to the mail engine on this machine.
 *
 * BOTH DOORS, ONE WIRE. The standalone door mounts `localRoutes`, which spreads `trashRoutes`, so
 * `/trash/window*` is served from this machine. The hosted door has no mirror entry for those paths
 * — a live read of the provider's own \Trash is the one question a mirror cannot answer — so they
 * fall through to the write-through proxy and are answered by the hosted account (`relay-allowlist`
 * carries all three). The wire is handed in on both doors regardless.
 *
 * GET-ONLY, AND THE ABSENCE IS THE POINT: two reads, no verb. ohmail's restore aims at a mirror
 * row's recorded origin folder, and a message the provider filed in Trash has none — so "put it
 * back" would be ohmail choosing a folder for somebody else's mail.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { TrashWire } from "../../webapp/app/shell/trash-window";

/** Thrown for every non-2xx answer down the pipe; carries the status so a caller can read a 410. */
export class TrashBridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TrashBridgeError";
  }
}

async function refusal(res: Response): Promise<TrashBridgeError> {
  let said: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    said = body.error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new TrashBridgeError(res.status, said ?? `the mail engine answered ${res.status}`);
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * The wire over ANY fetch-shaped transport — the status contract lives once, here, and each door
 * supplies only its transport (`junkVia`'s rule): the desktop window hands in `bridgeFetch`.
 *
 * Every call is a bare GET: no method, no headers, no body, anywhere in this function. The epoch
 * travels as `uidValidity` because a UID names a message only within one UIDVALIDITY, and an
 * emptied-and-recreated folder must answer 410 rather than whatever now wears the number.
 */
export function trashVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
): TrashWire {
  return {
    list: async (opts) =>
      jsonOf(await fetchImpl(
        `/trash/window${opts?.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`,
      )),
    body: async (mailboxId, uid, uidValidity) =>
      jsonOf(await fetchImpl(
        `/trash/window/body?mailboxId=${encodeURIComponent(mailboxId)}&uid=${uid}`
          + `&uidValidity=${encodeURIComponent(uidValidity)}`,
      )),
  };
}

export const trashOverBridge: TrashWire = trashVia(bridgeFetch);
