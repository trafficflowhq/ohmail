/**
 * THE ACCOUNT'S CONSENT ROW IN THE DESKTOP WINDOW — the transport, and deliberately nothing else.
 *
 * The controls are the shared client's: the dormancy dial, the auto-suggest opt-in and the
 * auto-unsubscribe switch, all built by `AppShell` and all reading and writing one
 * `useConsentState`. Only the wire is different, and it has to be — this window's content policy is
 * `connect-src 'none'`, `offline-guard.ts` has replaced every browser API that could open a socket,
 * and `vite.config.ts` aliases the Cloud client to a stub whose value exports refuse. The request
 * goes down the pipe to the mail engine on this machine instead, exactly as `local-away.ts` sends
 * the responder's and `cloud-suggest.ts` sends the Screener's purchase.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * `apiConfigured()` is false in every desktop build, so the shared shell's `GET /consent` never
 * ran, `consent.known` stayed false for the life of the process, and every control gated on it was
 * withheld — on a HOSTED install that is mirroring a real account, with all three settings sitting
 * in that account's row and a hosted worker acting on them. The person could turn auto-suggest on
 * in a browser tab and had no way to see or revoke it in the app that was spending against it.
 *
 * ── ONE DOOR ONLY, AND IT IS THE PRODUCT RATHER THAN THE PLUMBING ───────────────────────────
 *
 * Wired on the HOSTED door alone (`consentDoorFor` in `doors.ts`).
 *
 * ── AMENDED 2026-09-01, mail 0083: THE STANDALONE HALF OF THAT ARGUMENT WAS FALSE ───────────
 *
 * It read: *"A standalone engine would answer `/consent` no better than it answers
 * `/away-responder` — there is no account row behind it, no watermark for the automatic suggestion
 * pass to measure from, and no ledger for the opt-in to spend against. Its window keeps
 * `DEFAULT_DORMANCY_DAYS`, which is the window its own engine uses unasked, and offers no dial for
 * a number there is nowhere to store."*
 *
 * There IS an account row: the standalone store is the mail schema in full, `account_settings`
 * included, and `dormancy_days`, `screening_scope` and `screening_baseline_at` all live in it. And
 * the closing clause was not merely wrong about storage — it was wrong about behaviour, in the
 * direction that costs the most. The standalone engine did NOT use `DEFAULT_DORMANCY_DAYS`
 * "unasked": it had no cutoff at all (`engine.ts` contained zero occurrences of `screeningCutoff`),
 * so it screened every backfilled message regardless of age. On a mailbox with a decade of history
 * that is a decade of it moved into `ohmail/Screener`, one physical IMAP move at a time.
 *
 * `consentRoutes` are mounted on `localRoutes` now, and the sidecar's cycle threads the resolved
 * cutoff exactly as the hosted worker does. The two clauses that remain TRUE of a standalone
 * install are the AI ones — no ledger to spend against, no watermark for the automatic suggestion
 * pass — and those gate the auto-suggest opt-in, not the window.
 *
 * ── WHAT A REFUSAL MEANS HERE ───────────────────────────────────────────────────────────────
 *
 * The READ is allowed to fail silently and the WRITES are not, and that asymmetry is the shared
 * hook's rather than this file's. A failed read leaves every flag at its resting value — off for
 * the one that authorises spending, on for the one that discloses an outbound request — so a
 * refusal down this pipe lands exactly where a refused `GET /consent` lands in a browser tab. A
 * failed WRITE rethrows, because a settings control that silently did nothing is the failure the
 * person in front of it has to be told about. Composing a second taxonomy here is how somebody
 * whose install is merely offline would be told their setting does not exist.
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
  // the account's row through the hosted route, and the echo is the WHOLE map.
  setMailboxSignature: (mailboxId, signature) =>
    patch<{ signatures: Record<string, string> }>({
      signatures: { [mailboxId]: signature },
    }),
  /**
   * "APPLY FOR ALL DEVICES" FOR THE APPEARANCE FACE (OHMARCHY-PLAN.md §3a) — the last knob this
   * transport was missing, and the reason the affordance was withheld here.
   *
   * The face has two scopes. The DEVICE scope needs no wire at all — it is the ThemeProvider's
   * own pin, so the segmented control in Settings already worked in this window and on a
   * standalone install alike. The ACCOUNT scope is one field on the consent row, and
   * `AppShell` folds it to a nullable callback: null wherever no transport can store one, which
   * withheld the "apply for all devices" line here STRUCTURALLY rather than drawing a control
   * that could not control. This is that null closing.
   *
   * No new channel: the same forwarded `PATCH /consent/settings` every other knob above rides,
   * naming ONE axis so a face choice cannot overwrite a dormancy window set in a browser tab a
   * moment ago. The echo is the account's stored value — `paper` is STORED as `paper` and never
   * collapsed to NULL (`setThemeFace` in packages/services), because "no preference" and "asked
   * for paper" are different answers and only the first may be overridden by a later account
   * write.
   *
   * A STANDALONE door never reaches this: the transport is wired on the hosted door alone
   * (`DesktopGate`'s `accountDoor` branch), and there is no account row behind a standalone
   * engine to hold a face — its window keeps the device pin, which is the whole of the
   * appearance choice a machine with no account can make.
   */
  setThemeFace: (themeFace) => patch<{ themeFace: string | null }>({ themeFace }),
};
