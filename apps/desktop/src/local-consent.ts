/**
 * THE ACCOUNT'S CONSENT ROW IN THE DESKTOP WINDOW — the transport and nothing else. The
 * controls are the shared client's, all reading and writing one `useConsentState`; this
 * window's Cloud client is a refusing stub, so the request goes down the pipe to the engine on
 * this machine. The standalone store is the mail schema in full — `account_settings` with
 * `dormancy_days`, `screening_scope`, `screening_baseline_at` — and `consentRoutes` are mounted
 * on `localRoutes`, the sidecar's cycle threading the resolved cutoff as the hosted worker does
 * (mail 0083). Hosted-only is the AI pair (no ledger, no watermark standalone), which gates the
 * auto-suggest opt-in. Reads fail silently to resting values; writes rethrow, never silent.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { ConsentTransport } from "../../webapp/app/shell/consent-state";
import type { ConsentStateWire } from "../../webapp/app/api-client";

/**
 * The hosted routes, addressed root-relative like every path in this window.
 *
 * Exported because the engine has to do the right thing with them and "the right thing" is one
 * specific thing: both must be FORWARDED on the hosted door, never answered out of the local
 * mirror. `cloud-read.ts`'s table is the list of routes served locally and neither of these is in
 * it — a locally-answered `PATCH` here would store a consent decision on this machine that no
 * worker anywhere reads, and a locally-answered `GET` would report an account's settings from a
 * copy that holds none.
 */
export const CONSENT_PATH = "/consent";
export const CONSENT_SETTINGS_PATH = "/consent/settings";

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

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * One `PATCH /consent/settings` naming ONE axis.
 *
 * The route tests presence with `in`, so an omitted key is "leave this alone" — which is what lets
 * four independent controls write to one row without any of them clobbering another, and on this
 * door it is also what stops the app overwriting a setting changed in a browser tab a moment ago.
 * Every caller below therefore sends exactly the field it owns and never a whole object.
 */
async function patch<T>(body: Record<string, unknown>): Promise<T> {
  return jsonOf<T>(
    await bridgeFetch(CONSENT_SETTINGS_PATH, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The ten calls the shared hook makes, over the bridge.
 *
 * A constant rather than a factory: it holds no state, and one object per module is what lets the
 * hook keep a stable wire identity across renders.
 */
export const consentOverBridge: ConsentTransport = {
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
  state: async () => jsonOf<ConsentStateWire>(await bridgeFetch(CONSENT_PATH)),
  setAutoSuggest: (enabled) => patch<{ autoSuggestAt: string | null }>({ autoSuggest: enabled }),
  /* THE WINDOW AND ITS MODE, one call and one PATCH — the hosted door's shape exactly, so the
     two doors cannot answer "how far back does the Screener ask?" differently. `consentRoutes`
     are mounted on `localRoutes`, so this is the same route and the same single writer; the
     standalone door is UNGATED (there is no account to step up), and the hosted door's own
     step-up applies where the route requires it. Absent halves are omitted from the body, not
     sent as null — see the api-client note. */
  setDormancyDays: (days, scope) =>
    patch<{ dormancyDays?: number; screeningScope?: "window" | "all_time" }>({
      ...(days !== undefined ? { dormancyDays: days } : {}),
      ...(scope !== undefined ? { screeningScope: scope } : {}),
    }),
  setBlockRemoteImages: (blocked) =>
    patch<{ blockRemoteImagesAt: string | null }>({ blockRemoteImages: blocked }),
  setBlockTrackingPixels: (blocked) =>
    patch<{ loadTrackingPixelsAt: string | null }>({ blockTrackingPixels: blocked }),
  setBlockAutoUnsubscribe: (blocked) =>
    patch<{ blockAutoUnsubscribeAt: string | null }>({ blockAutoUnsubscribe: blocked }),
  setFoldersEnabled: (enabled) =>
    patch<{ foldersEnabledAt: string | null }>({ foldersEnabled: enabled }),
  // Per-mailbox "Use folders" (FOLDERS-SPEC.md §17) — one mailbox per call, the hook's shape;
  // the echo is the WHOLE exceptions map, like the hosted route answers everywhere.
  setMailboxFoldersEnabled: (mailboxId, enabled) =>
    patch<{ folderMailboxesOff: Record<string, string> }>({
      folderMailboxes: { [mailboxId]: enabled },
    }),
  // Per-mailbox signature (mail 0075) — same shape, same forwarding rule: the write lands on
  // the account's row through the hosted route, and the echo is the WHOLE map. Since mail 0098
  // both maps, because a write to either changes both columns.
  //
  // `signatureHtml` carries the MARKUP shape on its own body field and the server derives the
  // text half from it; exactly one of the two is ever sent, which is why the branch is on the
  // argument being SUPPLIED rather than on its value (an explicit `null` markup is still the
  // markup door, and it clears the signature).
  setMailboxSignature: (mailboxId, signature, signatureHtml) =>
    patch<{
      signatures: Record<string, string>;
      signaturesHtml?: Record<string, string>;
    }>(signatureHtml !== undefined
      ? { signaturesHtml: { [mailboxId]: signatureHtml } }
      : { signatures: { [mailboxId]: signature } }),
  /**
   * "APPLY FOR ALL DEVICES" FOR THE APPEARANCE FACE (OHMARCHY-PLAN.md §3a). The DEVICE scope
   * needs no wire — it is the ThemeProvider's own pin. The ACCOUNT scope is one field on the
   * consent row; `AppShell` folds it to a nullable callback, null wherever no transport can
   * store one — the affordance is withheld STRUCTURALLY, and this is that null closing. No new
   * channel: the same forwarded `PATCH /consent/settings`, naming ONE axis so a face choice
   * cannot overwrite a dormancy window set moments ago. `paper` is STORED as `paper`, never
   * collapsed to NULL (`setThemeFace`): "no preference" and "asked for paper" differ. A
   * STANDALONE door never reaches this: wired on the hosted door alone (`DesktopGate`).
   */
  setThemeFace: (themeFace) => patch<{ themeFace: string | null }>({ themeFace }),
};

/**
 * THE SAME WIRE, ON THE STANDALONE DOOR — identical routes, one capability short. The methods
 * are the hosted transport's, spread rather than rewritten: a second copy of the ten calls
 * would be a second definition of what a consent means. The declared fact:
 * `foldersStorable: false`. A standalone engine wraps its consent group in `withoutFoldersFlag`
 * (no folder verb on this door), invisible from this side — the GET answers 200, and the shared
 * shell once drew a whole Folders pane whose master switch snapped back. Declaring it here
 * follows `doors.ts`'s rule: the decision is a value a test can drive, and the required field
 * cannot be forgotten. A STABLE constant, like its twin — a wire identity across renders.
 */
export const consentOverBridgeStandalone: ConsentTransport = {
  ...consentOverBridge,
  foldersStorable: false,
};
