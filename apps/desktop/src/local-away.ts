/**
 * THE AWAY RESPONDER IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The control itself is the shared client's (`app/shell/AwayResponderRow.tsx`), rendered here
 * unchanged. Only the wire is different, and it has to be: this window's content policy is
 * `connect-src 'none'` and `offline-guard.ts` has replaced every browser API that could open a
 * socket, so the Cloud client is not merely unused here — `vite.config.ts` aliases it to a stub
 * whose value exports refuse. The request goes down the pipe to the mail engine on this machine
 * instead, exactly as `cloud-suggest.ts` sends the Screener's purchase.
 *
 * ── BOTH DOORS NOW, AND THIS HEADER USED TO ARGUE THE OPPOSITE ──────────────────────────────
 *
 * It said "ONE DOOR ONLY": that the responder was "a scheduled pass in the hosted worker", that
 * "nothing else can reach it", and that "an always-on replier cannot exist in an application that
 * only runs while its window is open" — so a standalone install got "no control at all rather than
 * one that stores a configuration and answers nobody".
 *
 * The premise was true and is not any more. The pass is `runAwayResponderPass` in
 * `@trafficflow/services`, which the desktop engine bundles, and the sidecar's drain runs it with
 * this machine's own SMTP dial. A standalone install therefore stores a configuration that IS
 * acted on — by the engine on this computer, while the window is open, which is a smaller promise
 * than Cloud's and is the sentence the pane now carries ("Replies are sent while ohmail is open on
 * this computer").
 *
 * The two-responders objection in that paragraph was the real one, and it is answered structurally
 * rather than by withholding the door. Exactly one install organizes a mailbox at a time — the
 * lease — the pass's candidate query JOINs `organizer_role='organizer'`, and the reservation is a
 * UNIQUE on (account, message). A reader answers nobody, and two runners racing one message produce
 * one reply between them.
 *
 * ── SO WHAT DOES THIS MODULE STILL DO, AND ON WHICH DOOR ────────────────────────────────────
 *
 * It is the WIRE, and the same wire serves both. On the HOSTED door the engine serves no
 * `/away-responder` of its own and forwards it to the account with the bearer, so the row written
 * is the hosted account's. On the STANDALONE door the engine answers the same path out of the
 * database on this machine. Same request from the window's point of view, two different rows behind
 * it — which is why `awayDoorFor` returns WHICH door rather than a boolean: the pane's copy differs
 * even though this transport does not.
 *
 * ── WHAT A REFUSAL MEANS HERE ───────────────────────────────────────────────────────────────
 *
 * Thrown, not swallowed. The shared control already distinguishes the two states a person can see —
 * it draws no switches on a failed READ (a resting OFF switch shown to somebody whose responder is
 * ON is a lie about mail going out) and says so on the pane, and it reports a failed SAVE beside the
 * button. An engine that is offline answers `503` before it forwards anything, which reaches those
 * same two places; inventing a third taxonomy down here would only let this file disagree with the
 * one the browser tab shows.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { AwayTransport } from "../../webapp/app/shell/AwayResponderRow";
import type { AwayResponderWire } from "../../webapp/app/api-client";

/**
 * The hosted route, addressed root-relative like every path in this window.
 *
 * Exported because the engine has to do the right thing with it, and the right thing is
 * door-dependent: on the HOSTED door this endpoint must be FORWARDED to the account, never answered
 * out of the local mirror — `cloud-read.ts`'s table lists the routes served locally and this one is
 * deliberately absent from it, because a locally-answered `PUT` there would store a responder on
 * this machine while the account's own row, which the hosted clock reads, stayed as it was.
 *
 * On the STANDALONE door there is no account to forward to and the engine answers it itself, which
 * is the ordinary shape for every route on that door. That asymmetry is `cloud-read.ts`'s whole
 * subject and needs no exception for this path.
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
 * The two calls the shared control makes, over the bridge.
 *
 * A constant rather than a factory: it holds no state, and one object per module means the shell's
 * `useAwayNotice` sees a stable identity across renders.
 */
export const awayOverBridge: AwayTransport = {
  state: async () => wireOf(await bridgeFetch(AWAY_PATH)),
  save: async (next) =>
    wireOf(
      await bridgeFetch(AWAY_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
    ),
};
