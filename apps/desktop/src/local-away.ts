/**
 * THE AWAY RESPONDER IN THE DESKTOP WINDOW — the transport and nothing else; the control is the
 * shared client's (`app/shell/AwayResponderRow.tsx`), and the Cloud client is a refusing stub,
 * so requests go down the pipe to the engine on this machine. One wire serves BOTH doors:
 * hosted forwards `/away-responder` to the account; standalone answers it from the local
 * database and `runAwayResponderPass` (`@trafficflow/services`) acts on it — the sidecar's
 * drain, this machine's SMTP dial, while the window is open. No double reply: the lease keeps
 * one organizer, the pass JOINs `organizer_role='organizer'`, the reservation is a UNIQUE on
 * (account, message). `awayDoorFor` names WHICH door; refusals rethrow to the shared control.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { AwayTransport } from "../../webapp/app/shell/AwayResponderRow";
import type { AwayResponderSaveWire, AwayResponderWire } from "../../webapp/app/api-client";

/**
 * The hosted route, addressed root-relative like every path in this window. Exported because
 * the engine's right thing is door-dependent: on the HOSTED door this endpoint must be
 * FORWARDED to the account, never answered from the local mirror — `cloud-read.ts`'s table of
 * locally-served routes deliberately omits it, since a locally-answered `PUT` would store a
 * responder on this machine while the account's own row, which the hosted clock reads, stayed
 * as it was. On the STANDALONE door there is no account to forward to and the engine answers
 * it itself — `cloud-read.ts`'s ordinary asymmetry, no exception needed.
 */
export const AWAY_PATH = "/away-responder";

/** The engine's own sentence for a refusal, or the status line when it composed none. */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as { error?: { message?: string } }).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

async function wireOf(res: Response): Promise<AwayResponderWire> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AwayResponderWire;
}

/**
 * The SAVE's answer, which carries one field the READ never does: `pending`, the 202 the engine
 * forwards when the mailboxes belong to an install that organizes them elsewhere. Typed here
 * rather than cast away, because the shared control decides its sentence on it — dropped, the pane
 * says "Saved." over the values it just put back.
 */
async function saveWireOf(res: Response): Promise<AwayResponderSaveWire> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AwayResponderSaveWire;
}

/**
 * The two calls the shared control makes, over the bridge.
 *
 * A constant rather than a factory: it holds no state, and one object per module means the shell's
 * `useAwayNotice` sees a stable identity across renders.
 */
export const awayOverBridge: AwayTransport = {
  state: async () => wireOf(await bridgeFetch(AWAY_PATH)),
  save: async (next) =>
    saveWireOf(
      await bridgeFetch(AWAY_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
    ),
};
