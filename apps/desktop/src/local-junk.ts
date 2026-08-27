/**
 * THE JUNK WINDOW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The window itself — the page, the honest states, the session body cache, the two rescue verbs,
 * the search-append and the one-time sweep offer — is the shared shell's (`shell/junk-window.ts`),
 * exactly as `local-older-body.ts` says about the reach-past body door. Only the wire differs:
 * this window's content policy is `connect-src 'none'` and the Cloud client is aliased to a
 * refusing stub, so every ask goes down the pipe to the mail engine on this machine.
 *
 * ── BOTH DOORS, ONE WIRE — and what each door does with it ──────────────────────────────────
 *
 * On the HOSTED door the engine has no `/screener/junk*` of its own: the routes are absent from
 * `cloud-read.ts`'s mirror table on purpose (a live read of the provider's own \Junk is the one
 * question a mirror can never answer — the window's defining property is that Junk is NEVER
 * mirrored), so they fall through to the write-through proxy and are answered by the hosted
 * account, which dials the mailbox under its own admission cap. The reach-past rule, verbatim:
 * a read whose answer is not in the mirror travels through to the server.
 *
 * On the STANDALONE door the engine mounts `localRoutes` — the screener table included — and its
 * organizer resolves the mailbox's native \Junk at connect (`findSpecialFolders`), so the routes
 * ARE served here, from this machine. What withholds the segment there today is not this wire but
 * the flag in front of it: the window exists only behind "Use folders", and the standalone door
 * has no consent row to hold that flag (the pane's standing condition, FOLDERS-SPEC.md §17). The
 * wire is handed in on both doors regardless — `olderBodyOverBridge`'s transport-not-a-control
 * rule — so the day the standalone door grows a folders pane, the segment follows the switch with
 * no desktop change at all.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { JunkWire } from "../../webapp/app/shell/junk-window";

/** Thrown for every non-2xx answer down the pipe; carries the status so the door can read a 410. */
export class JunkBridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "JunkBridgeError";
  }
}

async function refusal(res: Response): Promise<JunkBridgeError> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as { error?: { message?: string } }).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new JunkBridgeError(res.status, said ?? `the mail engine answered ${res.status}`);
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
  };
}

export const junkOverBridge: JunkWire = junkVia(bridgeFetch);
