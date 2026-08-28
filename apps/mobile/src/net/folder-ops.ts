import type { ConnectedSession } from "./pairing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DELETE CONFIRM'S SERVER-TRUTH COUNTS — `GET /folders/:id/summary`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The folder-delete ceremony asks BEFORE the act, stating what moves (FOLDERS-SPEC.md §18):
 * "N messages across M folders move to Trash". Only the server can count that honestly — the
 * phone's mirror is a WINDOW over the mailbox, and a local count would understate what the
 * delete sweeps. This is the one read the folder verbs need beside the engine's own mutations
 * (the webapp's `useFolderVerbs.summary`, which rides its api-client; this app has none, so
 * the read lives here on the network seam's terms).
 *
 * ── THE TRANSPORT RULE, VERBATIM FROM `consent.ts` ─────────────────────────────────────────
 *
 * `session.bearer.fetch` is the only transport, bound to ONE origin — the profile the user is
 * currently connected to. This file holds no origin of its own, so "the count comes from the
 * server you paired with, never anywhere else" is structural. It joins the privacy census'
 * network seam (`test/privacy.test.ts` ENGINE_SEAM) on those terms.
 *
 * ── `null` MEANS "COULD NOT COUNT", AND THE CONFIRM STILL ASKS ─────────────────────────────
 *
 * A failed count must never block the ceremony OR pretend a number it does not have (the
 * webapp's own degrade): the caller renders the UNCOUNTED sentence and the ask stands. A
 * server that ACCEPTS the connection and never answers is the same failure wearing a longer
 * face — without a deadline the confirm would sit on "Counting what moves…" forever with the
 * Delete row withheld, so the read runs under {@link SUMMARY_TIMEOUT_MS} and a timeout IS the
 * uncounted answer (codex round 1).
 */

/** How long the count may take before the uncounted sentence stands in for it. */
export const SUMMARY_TIMEOUT_MS = 10_000;

export async function readFolderSummary(
  session: ConnectedSession,
  folderId: string,
  /** Test seam only — the shipped callers never pass it, so the one number above is the number. */
  timeoutMs: number = SUMMARY_TIMEOUT_MS,
): Promise<{ folders: number; messages: number } | null> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await session.bearer.fetch(
      `${session.profile.origin}/folders/${encodeURIComponent(folderId)}/summary`,
      { method: "GET", signal: abort.signal },
    );
    if (res.status !== 200) return null;
    const body = (await res.json()) as { folders?: unknown; messages?: unknown };
    if (typeof body.folders !== "number" || typeof body.messages !== "number") return null;
    return { folders: body.folders, messages: body.messages };
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
