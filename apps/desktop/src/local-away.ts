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
 * ── ONE DOOR ONLY, AND THAT IS THE PRODUCT RATHER THAN THE PLUMBING ─────────────────────────
 *
 * `DesktopScreening` and `local-ai.ts` are offered on BOTH doors, because on the standalone door
 * the engine answers those routes out of the database on this machine. This module is wired on the
 * HOSTED door alone (`awayDoorFor` in `doors.js`), and the reason is not that a standalone engine
 * would refuse — it would answer perfectly well, and that is exactly the trap. What sends an away
 * reply is a scheduled pass in the hosted worker. Nothing else can reach it: the worker's package
 * publishes four subpaths and the responder is not among them, which is a rule the build enforces
 * rather than one somebody remembers. An always-on replier cannot exist in an application that only
 * runs while its window is open, and both installs organize the SAME mailbox under one lease — two
 * responders would keep two separate at-most-once records and answer the same correspondent twice,
 * neither record seeing the other.
 *
 * So a standalone install gets no control at all rather than one that stores a configuration and
 * answers nobody. On the hosted door the engine serves no `/away-responder` of its own and forwards
 * it to the account with the bearer, so the row that is written IS the hosted account's row and the
 * hosted worker is what sends from it.
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
 * Exported because the engine has to do the right thing with it and "the right thing" is one
 * specific thing: this endpoint must be FORWARDED on the hosted door, never answered out of the
 * local mirror. `cloud-read.ts`'s table is the list of routes that are served locally, and this one
 * is deliberately absent from it — a locally-answered `PUT` here would store an away responder on
 * this machine that no worker anywhere reads.
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
