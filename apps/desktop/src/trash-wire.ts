/**
 * THE LIVE TRASH WINDOW'S REQUESTS — over an injected transport, and with no door in this module.
 *
 * The window itself is the shared shell's (`shell/trash-window.ts`); the two paths, the epoch
 * that travels with a UID and the status contract are here, once, for every door that carries
 * them: the desktop window over its bridge (`local-trash.ts`) and the served host client over its
 * bearer socket (`host-client/transports.ts`).
 *
 * The factory lives in a module that imports no transport because the served host client has no
 * bridge — sharing a file with the window's bridge binding put the shell command's name into the
 * bundle a phone is handed, which `scan:host` refuses.
 *
 * GET-ONLY, AND THE ABSENCE IS THE POINT: two reads, no verb. ohmail's restore aims at a mirror
 * row's recorded origin folder, and a message the provider filed in Trash has none — so "put it
 * back" would be ohmail choosing a folder for somebody else's mail.
 */

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
