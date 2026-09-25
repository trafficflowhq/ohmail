/**
 * THE ACCOUNT'S CONSENT ROW IN THE DESKTOP WINDOW — the transport and nothing else. The controls
 * are the shared client's, and the ten calls are `consent-wire.ts`'s, shared with the served host
 * client so the window and the phone paired to it cannot answer one question two ways. This
 * window's Cloud client is a refusing stub, so the request goes down the pipe to the engine on
 * this machine. The standalone store is the mail schema in full, and `consentRoutes` are mounted
 * on `localRoutes` with the sidecar's cycle threading the resolved cutoff (mail 0083). Hosted-only
 * is the AI pair, which gates the auto-suggest opt-in.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import { consentVia } from "./consent-wire.js";
import type { ConsentReadFailure, ConsentTransport } from "../../webapp/app/shell/consent-state";

export { CONSENT_PATH, CONSENT_SETTINGS_PATH, consentVia } from "./consent-wire.js";

/** The engine's door for a window's failed consent read — `consent_read_failed` in its log. */
export const CONSENT_READ_FAILED_PATH = "/local/window/consent-read-failed";

/**
 * Carry a failed consent read to the engine's log, on both doors (the local and the cloud engine
 * both serve the path). The record is the hook's closed report; a refused report is dropped.
 */
export async function reportConsentReadFailure(report: ConsentReadFailure): Promise<void> {
  await bridgeFetch(CONSENT_READ_FAILED_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
}

/**
 * The hosted door's transport. A constant rather than a factory: it holds no state, and one
 * object per module is what lets the hook keep a stable wire identity across renders.
 */
export const consentOverBridge: ConsentTransport = {
  ...consentVia(bridgeFetch),
  readFailed: reportConsentReadFailure,
  /* THE MANAGED TABLE MOUNTS `foldersRoutes`: `/folders*` is not in `cloud-read.ts`, so all
     four verbs fall through to the write-through proxy and the account answers — true of an
     install connected to the managed service. `mode` has two values but the app has THREE
     doors: `configureSelfHostDoor` opens as `{ mode: "cloud", cloudUrl: <their origin> }` and
     `selfHostRoutes` spreads `localRoutes` whole, inheriting `withoutFoldersFlag` — there the
     flag reads off and the write is dropped, so the pane draws a switch that snaps back.
     Deliberately NOT fixed by a `flavor` probe here: the honest signal is a `/hello` feature
     word beside `pairing`, which the browser needs anyway and which would delete a probe the
     day it lands. Pre-existing, recorded as such in the settings census. */
  foldersStorable: true,
};

/**
 * THE SAME WIRE, ON THE STANDALONE DOOR — identical routes, one capability short. The methods are
 * the hosted transport's by construction, never a second copy of the ten calls, which would be a
 * second definition of what a consent means. The declared fact: `foldersStorable: false`. That
 * door wraps its consent group in `withoutFoldersFlag`, and since the wrapper REMOVES the field
 * rather than nulling it, the wire agrees with this declaration rather than merely not
 * contradicting it. Declared here by `doors.ts`'s rule: a value a test can drive, required so it
 * cannot be forgotten. A STABLE constant, like its twin — a wire identity across renders.
 */
export const consentOverBridgeStandalone: ConsentTransport = {
  ...consentOverBridge,
  foldersStorable: false,
};
