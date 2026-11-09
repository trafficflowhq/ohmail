/**
 * THE WINDOW'S OWN KEYS FOR A MAILBOX IT SERVED, removed when that account ends here: Sign out, the
 * account's erasure, a revoke. The window keys its storage by the mailbox the engine serves
 * (`setStorageOwner` in `DesktopGate.tsx`), and the web's `forgetThisBrowser` never runs in it, so the
 * compose scratch, the reply buffers and the intent journals outlived the account. This is that sweep,
 * scoped to the mailboxes named: another mailbox's keys and the preferences stay, and the reply buffers
 * that name no mailbox go whole. A lapse (an expired sign-in) keeps them, as it keeps the mail. Only an
 * erasure takes the send lanes as well.
 */

import { ROUTING_INTENTS_PREFIX } from "@ohmail/client-engine";
import { clearBootCaches, dropLocalStorageKeysWhere, type LocalSweep } from "../../webapp/app/shell/boot-cache";
import {
  COMPOSE_DRAFT_PREFIX, COMPOSE_ROW_PREFIX, COMPOSE_SESSION_PREFIX, LEGACY_COMPOSE_DRAFT_KEY,
} from "../../webapp/app/shell/compose";
import { DELETE_INTENTS_PREFIX } from "../../webapp/app/shell/delete-intents";
import {
  OWNED_REPLY_DRAFT_PREFIX, OWNED_REPLY_META_PREFIX, REPLY_DRAFT_PREFIX, REPLY_META_PREFIX, sentCopyNotesKey,
} from "../../webapp/app/shell/mail-send";
import { isOwnerShaped } from "../../webapp/app/shell/owner-cookie";
import { READING_ALONG_PREFIX } from "../../webapp/app/shell/reading-along";
import { SCREENER_INTENTS_PREFIX } from "../../webapp/app/shell/screener-intents";
import { SEND_LOCKS_PREFIX } from "../../webapp/app/shell/send-lock";
import { ACCESS_VERDICT_PREFIX } from "../../webapp/app/shell/wall-lift";
import { windowSentFoldersKey } from "./window-outbox-store.js";

/**
 * The keys built as `<prefix><mailbox>`, the compose three also as `<prefix><mailbox>.<composer>`. Not the
 * send lanes: Sign out and a revoke keep them, as the engine keeps the queued sends for the account's next
 * sign-in, where the record still guards against a second send ({@link forgetErasedWindowScopes} takes them).
 */
export const WINDOW_SCOPED_PREFIXES: readonly string[] = [
  SCREENER_INTENTS_PREFIX, DELETE_INTENTS_PREFIX, ROUTING_INTENTS_PREFIX,
  COMPOSE_DRAFT_PREFIX, COMPOSE_SESSION_PREFIX, COMPOSE_ROW_PREFIX, READING_ALONG_PREFIX, ACCESS_VERDICT_PREFIX,
];

/**
 * THE MAILBOX A CLOUD DOOR LAST SHOWED, kept across launches: a revoke or an erasure heard at a launch
 * shows its card before any mail, so that launch never shows the mailbox whose keys are owed.
 */
export const CLOUD_SCOPE_KEY = "ohmail.desktop.cloudScope";

export function rememberCloudScope(scope: string): void {
  try {
    window.localStorage.setItem(CLOUD_SCOPE_KEY, scope);
  } catch { /* a refused jar holds no keys to sweep either */ }
}

export function rememberedCloudScope(): string | null {
  try {
    return window.localStorage.getItem(CLOUD_SCOPE_KEY);
  } catch {
    return null;
  }
}

/**
 * `<p><scope>`, its hand-off slot, or `<p><scope>.<composer>` — never another mailbox's (mbx-10, mbx-1.x) —
 * and a reply buffer the mailbox typed, `<p><scope>:<lane>`.
 */
function scopedTo(key: string, scope: string): boolean {
  return WINDOW_SCOPED_PREFIXES.some((p) => {
    const at = `${p}${scope}`;
    return key === at || (key.startsWith(`${at}.`) && !key.slice(at.length + 1).includes("."));
  }) || [OWNED_REPLY_DRAFT_PREFIX, OWNED_REPLY_META_PREFIX].some((p) => key.startsWith(`${p}${scope}:`));
}

/**
 * Remove the window's keys for `scopes`, read back: Sign out's and a revoke's sweep, the send lanes kept.
 * A reply buffer that names no mailbox (written before they did) goes whole; one that names a mailbox goes
 * with it, and so do the mailbox's Sent copy notes (exactly its own key: each names a recipient and a
 * subject). Nothing owed (no scope) touches nothing and answers null, so a card still up at the next launch
 * sweeps nothing again. The marker goes once a clean sweep covered it; a sweep that did not read back clean
 * keeps it, and the next end retries.
 */
export function forgetWindowScopes(scopes: readonly (string | null | undefined)[]): LocalSweep | null {
  return sweepScopes(scopes, (key, scope) => key === sentCopyNotesKey(scope));
}

/**
 * AN ERASED ACCOUNT'S SWEEP: {@link forgetWindowScopes}, and each mailbox's send lane (exactly
 * `<SEND_LOCKS_PREFIX><mailbox>`). The engine discarded the window's outbox with the account, so no send
 * is owed and nothing else would ever prune them. The send-record door census admits this function, and
 * no other, to name the jar's prefix.
 */
export function forgetErasedWindowScopes(scopes: readonly (string | null | undefined)[]): LocalSweep | null {
  return sweepScopes(scopes, (key, scope) => key === `${SEND_LOCKS_PREFIX}${scope}` || key === sentCopyNotesKey(scope));
}

function sweepScopes(
  scopes: readonly (string | null | undefined)[], alsoGone: (key: string, scope: string) => boolean,
): LocalSweep | null {
  const owed = [...new Set(scopes.filter((s): s is string => typeof s === "string" && isOwnerShaped(s)))];
  if (owed.length === 0) return null;
  const keys = dropLocalStorageKeysWhere((k) =>
    k === LEGACY_COMPOSE_DRAFT_KEY || k.startsWith(REPLY_DRAFT_PREFIX) || k.startsWith(REPLY_META_PREFIX)
    || owed.some((s) => scopedTo(k, s) || k === windowSentFoldersKey(s) || alsoGone(k, s)));
  const sweeps = [keys, ...owed.map((s) => clearBootCaches(s))];
  const swept: LocalSweep = {
    survivors: sweeps.flatMap((s) => s.survivors),
    enumerated: sweeps.every((s) => s.enumerated),
  };
  if (swept.enumerated && swept.survivors.length === 0) {
    const marker = rememberedCloudScope();
    if (marker !== null && owed.includes(marker)) {
      try {
        window.localStorage.removeItem(CLOUD_SCOPE_KEY);
      } catch { /* kept: the next end sweeps again */ }
    }
  } else {
    console.warn("ohmail desktop: the window's sweep did not complete", {
      enumerated: swept.enumerated,
      survivors: swept.survivors.length,
    });
  }
  return swept;
}
