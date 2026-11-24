import { SUGGESTION_GRANT_HEADER } from "@trafficflow/core/suggestion-consent";
import type { ConsentTransport } from "./consent-state.js";
/**
 * WHAT A CONSENT READ ANSWERS, AS THE CONSENT ROW READS IT: the fields the hook takes off `GET /consent`, each
 * with the type the server client's own declaration gives it (that declaration says what each field means). One
 * is wider here: `screeningByMailbox` is handed unread to the engine's own reader of it.
 */
import type { TravelledChangeWire } from "./travelled-change.js";

export interface ConsentStateWire {
  seedConfirmedAt: string | null;
  dormancyDays: number;
  screeningBaselineAt?: string | null;
  autoSuggestAt?: string | null;
  autoActAt?: string | null;
  blockRemoteImagesAt?: string | null;
  loadTrackingPixelsAt?: string | null;
  blockAutoUnsubscribeAt?: string | null;
  foldersEnabledAt?: string | null;
  folderMailboxesOff?: Record<string, string>;
  signatures?: Record<string, string>;
  signaturesHtml?: Record<string, string>;
  signatureSources?: Record<string, "organizer" | "local">;
  signatureChanges?: Record<string, TravelledChangeWire>;
  dormancyChange?: TravelledChangeWire;
  locale?: string | null;
  themeFace?: string | null;
  draftReplies?: boolean;
  screenerAcknowledgements?: number;
  resurfaceTime?: string | null;
  onboardingCompletedAt?: string | null;
  screeningScope?: "window" | "all_time";
  screeningByMailbox?: unknown;
}

/**
 * The engine's routes, addressed root-relative like every path on both doors.
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

/**
 * The engine's own sentence for a refusal, or the status line when it composed none — carrying
 * the STATUS, which the shared hook reports when a consent read fails (never the body).
 */
async function refusal(res: Response): Promise<Error & { status: number; code?: string; details?: unknown }> {
  let env: { message?: string; code?: string; details?: unknown } | undefined;
  try {
    env = ((await res.json()) as { error?: typeof env }).error;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  // `code` and `details` as the web's `ApiError` carries them: the pane reads why from them.
  return Object.assign(new Error(env?.message ?? `the mail engine answered ${res.status}`), {
    status: res.status,
    ...(typeof env?.code === "string" ? { code: env.code } : {}),
    ...(env?.details !== undefined ? { details: env.details } : {}),
  });
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * The ten calls the shared hook makes, over ANY fetch-shaped transport — every door's methods
 * are these, so the two doors of one engine cannot answer "how far back does the Screener ask?"
 * differently. `foldersStorable` is NOT here: it is the one thing this module cannot know, a
 * fact about the route table the caller's door mounts, and each door declares it.
 */
export function consentVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  hosted = false,
): Omit<ConsentTransport, "foldersStorable"> {
  /**
   * One `PATCH /consent/settings` naming ONE axis.
   *
   * The route tests presence with `in`, so an omitted key is "leave this alone" — which is what
   * lets four independent controls write to one row without any of them clobbering another, and
   * on these doors it is also what stops the app overwriting a setting changed in a browser tab a
   * moment ago. Every caller below therefore sends exactly the field it owns, never a whole object.
   */
  const answer = async <T extends object>(
    res: Response,
    carriesGrant: boolean,
  ): Promise<T & { relaySuggestionGrant?: string | null }> => {
    const value = await jsonOf<T>(res);
    return hosted && carriesGrant
      ? { ...value, relaySuggestionGrant: res.headers.get(SUGGESTION_GRANT_HEADER) }
      : value;
  };
  const patch = async <T extends object>(body: Record<string, unknown>, carriesGrant = false) =>
    answer<T>(
      await fetchImpl(CONSENT_SETTINGS_PATH, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      carriesGrant,
    );
  return {
    retryColdRead: true,
    state: async () => answer<ConsentStateWire>(await fetchImpl(CONSENT_PATH), true),
    setAutoSuggest: (enabled) =>
      patch<{ autoSuggestAt: string | null; autoActAt?: string | null }>({ autoSuggest: enabled }, true),
    // The act on suggestions: the same route on both doors, one axis per PATCH.
    setAutoAct: (enabled) => patch<{ autoActAt: string | null }>({ autoAct: enabled }),
    /* THE WINDOW AND ITS MODE, one call and one PATCH — the hosted door's shape exactly.
       `consentRoutes` are mounted on `localRoutes`, so this is the same route and the same single
       writer on the window's door and on the paired one; the standalone door is UNGATED (there is
       no account to step up), and the hosted door's own step-up applies where the route requires
       it. Absent halves are omitted from the body, not sent as null — see the api-client note. */
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
    setFoldersEnabled: (enabled) => patch<{ foldersEnabledAt: string | null }>({ foldersEnabled: enabled }),
    // Per-mailbox "Use folders" (FOLDERS-SPEC.md §17) — one mailbox per call, the hook's shape;
    // the echo is the WHOLE exceptions map, like the hosted route answers everywhere.
    setMailboxFoldersEnabled: (mailboxId, enabled) =>
      patch<{ folderMailboxesOff: Record<string, string> }>({
        folderMailboxes: { [mailboxId]: enabled },
      }),
    // Per-mailbox signature (mail 0075) — same shape, same forwarding rule: the write lands on
    // the account's row through the route, and the echo is the WHOLE map. Since mail 0098 both
    // maps, because a write to either changes both columns.
    //
    // `signatureHtml` carries the MARKUP shape on its own body field and the server derives the
    // text half from it; exactly one of the two is ever sent, which is why the branch is on the
    // argument being SUPPLIED rather than on its value (an explicit `null` markup is still the
    // markup door, and it clears the signature).
    setMailboxSignature: (mailboxId, signature, signatureHtml) =>
      patch<{
        signatures: Record<string, string>;
        signaturesHtml?: Record<string, string>;
        // Whose signature each mailbox shows. A standalone install organizes what it holds, so
        // its own rows answer `local` here by construction — the map is the route's, not a
        // second opinion composed at this door.
        signatureSources?: Record<string, "organizer" | "local">;
      }>(
        signatureHtml !== undefined
          ? { signaturesHtml: { [mailboxId]: signatureHtml } }
          : { signatures: { [mailboxId]: signature } },
      ),
    /**
     * "APPLY FOR ALL DEVICES" FOR THE APPEARANCE FACE (OHMARCHY-PLAN.md §3a). The DEVICE scope
     * needs no wire — it is the ThemeProvider's own pin. The ACCOUNT scope is one field on the
     * consent row; `AppShell` folds it to a nullable callback, null wherever no transport can
     * store one — the affordance is withheld STRUCTURALLY, and this is that null closing. No new
     * channel: the same `PATCH /consent/settings`, naming ONE axis so a face choice cannot
     * overwrite a dormancy window set moments ago. `paper` is STORED as `paper`, never collapsed
     * to NULL (`setThemeFace`): "no preference" and "asked for paper" differ.
     */
    setThemeFace: (themeFace) => patch<{ themeFace: string | null }>({ themeFace }),
    /**
     * THE RESURFACE TIME (mail 0110) — the same one-axis PATCH, so remembering a chosen hour
     * cannot overwrite a window set moments ago in a browser tab. `null` clears back to the
     * product's 09:00; the echo is what the shell applies.
     */
    acknowledgeScreener: (acknowledgeScreener) =>
      patch<{ screenerAcknowledgements: number }>({ acknowledgeScreener }),
    setDraftReplies: (draftReplies) => patch<{ draftReplies: boolean }>({ draftReplies }),
    setResurfaceTime: (resurfaceTime) => patch<{ resurfaceTime: string | null }>({ resurfaceTime }),
  };
}
