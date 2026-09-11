/**
 * THE JUNK WINDOW'S REQUESTS — over an injected transport, and with no door in this module.
 *
 * The window itself is the shared shell's (`shell/junk-window.ts`); the paths, the status
 * contract and the rescue verbs are here, once, for every door that carries them: the desktop
 * window over its bridge (`local-junk.ts`) and the served host client over its bearer socket
 * (`host-client/transports.ts`).
 *
 * The factory lives in a module that imports no transport because the served host client has no
 * bridge — sharing a file with the window's bridge binding put the shell command's name into the
 * bundle a phone is handed, which `scan:host` refuses.
 */

import type { JunkWire } from "../../webapp/app/shell/junk-window";

/**
 * Thrown for every non-2xx answer down the pipe; carries the status so the door can read a 410,
 * and the server's error CODE so it can read a partial outcome (`junk_rescue_move_failed`).
 */
export class JunkBridgeError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "JunkBridgeError";
  }
}

async function refusal(res: Response): Promise<JunkBridgeError> {
  let said: string | undefined;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    said = body.error?.message;
    code = typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new JunkBridgeError(res.status, code, said ?? `the mail engine answered ${res.status}`);
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * The wire over ANY fetch-shaped transport — the status contract lives once, here, and each door
 * supplies only its transport (`olderBodyVia`'s rule): the desktop window hands in `bridgeFetch`.
 */
export function junkVia(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): JunkWire {
  const post = (path: string, body?: unknown): Promise<Response> =>
    fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  return {
    list: async (opts) =>
      jsonOf(await fetchImpl(`/screener/junk${opts?.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`)),
    body: async (mailboxId, uid, uidValidity) =>
      jsonOf(await fetchImpl(
        `/screener/junk/body?mailboxId=${encodeURIComponent(mailboxId)}&uid=${uid}&uidValidity=${encodeURIComponent(uidValidity)}`,
      )),
    rescue: async (mailboxId, uid, uidValidity, opts) =>
      jsonOf(await post("/screener/junk/rescue", {
        mailboxId, uid, uidValidity, ...(opts?.allow ? { allow: opts.allow } : {}),
      })),
    search: async (q) => jsonOf(await fetchImpl(`/screener/junk/search?q=${encodeURIComponent(q)}`)),
    sweepPreview: async () => jsonOf(await fetchImpl("/screener/junk/sweep")),
    sweepRequest: async () => jsonOf(await post("/screener/junk/sweep")),
    isGone: (err) => err instanceof JunkBridgeError && err.status === 410,
    codeOf: (err) => (err instanceof JunkBridgeError ? err.code : null),
  };
}
