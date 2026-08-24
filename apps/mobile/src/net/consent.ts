import type { ConnectedSession } from "./pairing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ACCOUNT SETTINGS OVER THE PAIRED SERVER — the "Use folders" consent read and write
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The folders feature is OFF by default and per-ACCOUNT (FOLDERS-SPEC.md §6; owner decision 1:
 * fully optional). The authority is the server's consent row — `GET /consent` answers
 * `foldersEnabledAt` (an instant, or `null` for off), `PATCH /consent/settings` with
 * `{ foldersEnabled }` moves it — the exact route pair the webapp's Settings switch rides
 * (`apps/webapp/app/api-client.ts#setFoldersEnabled`), so one toggle anywhere is every
 * client's answer.
 *
 * ── THE TRANSPORT RULE, VERBATIM FROM `push.ts` ───────────────────────────────────────────
 *
 * `session.bearer.fetch` is the only transport used here, bound to ONE origin — the profile
 * the user is currently connected to. This file holds no origin of its own, so "the consent
 * question goes to the server you paired with, never anywhere else" is structural. It joins
 * the privacy census' network seam (`test/privacy.test.ts` ENGINE_SEAM) on those terms.
 *
 * ── `null` MEANS "COULD NOT ASK", NEVER "OFF" ─────────────────────────────────────────────
 *
 * The read distinguishes the server's answer from the absence of one: `{ on: false }` is the
 * server saying off; `null` is a transport failure or an older server without the field's
 * route, and the caller keeps whatever it last knew (which starts at off — the pre-feature
 * interface, the safe branch in both directions).
 */

/** The one field this app reads off `GET /consent` today. */
export interface FoldersConsent {
  on: boolean;
}

export async function readFoldersEnabled(session: ConnectedSession): Promise<FoldersConsent | null> {
  try {
    const res = await session.bearer.fetch(`${session.profile.origin}/consent`, { method: "GET" });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { foldersEnabledAt?: unknown };
    // The wire's contract: an instant means on, `null` means off — and an ABSENT field means a
    // server too old to know about folders, which reads as off exactly like the webapp's
    // `wire.foldersEnabledAt != null` (consent-state.ts).
    return { on: typeof body.foldersEnabledAt === "string" && body.foldersEnabledAt !== "" };
  } catch {
    return null;
  }
}

/**
 * Write the flag. Resolves to the server-confirmed value — the Settings switch renders THIS,
 * never the optimistic pick (the webapp `FoldersRow`'s own rule: a refused write must not
 * draw a folders group the account does not have). Rejects on refusal or transport failure,
 * which the pane shows as its one failure sentence.
 */
export async function writeFoldersEnabled(session: ConnectedSession, enabled: boolean): Promise<FoldersConsent> {
  const res = await session.bearer.fetch(`${session.profile.origin}/consent/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ foldersEnabled: enabled }),
  });
  if (res.status !== 200) throw new Error(`consent write refused (${res.status})`);
  const body = (await res.json()) as { foldersEnabledAt?: unknown };
  return { on: typeof body.foldersEnabledAt === "string" && body.foldersEnabledAt !== "" };
}
