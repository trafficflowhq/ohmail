"use client";

/**
 * WHY THIS BROWSER IS AT THE SIGN-IN FORM, carried one page. The splash learns it from the refresh
 * door's code and `/login` is the page that has to say it, so the reason travels in this tab's
 * session storage and is read ONCE. Never a URL parameter: `/login` takes no redirect or reason
 * in its address. A note that cannot be stored costs the sentence, never the navigation.
 */

import { durableSessionRemove, durableSessionSet, durableSet } from "../../shell/durable";
import { SIGNED_OUT_COOKIE } from "../../session-gate";

const NOTE_KEY = "ohmail.signed-out-reason";

/**
 * THE SAME REASON FOR THE OTHER TABS: a splash waiting on the cross-tab lock while another tab heard
 * the door finds its jar emptied and nothing told. A reason and a time, never an account; read while
 * younger than {@link SHARED_NOTE_MS} and left for every tab that needs it.
 */
export const SHARED_NOTE_KEY = "ohmail.signed-out-reason.shared";
export const SHARED_NOTE_MS = 15_000;

/**
 * The three refusals the refresh door names (`refresh_revoked` / `_expired` / `_missing`); `reused`,
 * a `refresh_revoked` that was a reuse sweep's own (its `details.cause`); and `pending`: a sign-out
 * this browser asked for that the server never confirmed, which `/login` reads off `tf_owner` itself
 * and never from a note.
 */
export type SignedOutReason = "revoked" | "reused" | "expired" | "absent" | "pending";

/** The reasons a note may carry: the refresh door's. */
const REASONS: readonly SignedOutReason[] = ["revoked", "reused", "expired", "absent"];

/** The `resume.*` sentence each reason is told with, on the splash card and on `/login`. */
export const REASON_BODY: Record<
  SignedOutReason, "revokedBody" | "reusedBody" | "expiredBody" | "absentBody" | "pendingBody"
> = {
  revoked: "revokedBody", reused: "reusedBody", expired: "expiredBody", absent: "absentBody", pending: "pendingBody",
};

export function isSignedOutReason(v: unknown): v is SignedOutReason {
  return typeof v === "string" && (REASONS as readonly string[]).includes(v);
}

export function leaveSignedOutNote(reason: SignedOutReason): void {
  durableSessionSet(NOTE_KEY, reason, "resume.note");
}

/** The note, removed as it is read; `null` when there is none or storage is unreadable. */
export function takeSignedOutNote(): SignedOutReason | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(NOTE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  durableSessionRemove(NOTE_KEY, "resume.note");
  return isSignedOutReason(raw) ? raw : null;
}

export function shareSignedOutNote(reason: SignedOutReason): void {
  durableSet(SHARED_NOTE_KEY, JSON.stringify({ reason, at: Date.now() }), "resume.note");
  // The edge's copy: a tab opened next is sent to /login, not the landing. Host-only, the reason's word only.
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SIGNED_OUT_COOKIE}=${reason}; Path=/; Max-Age=${SHARED_NOTE_MS / 1000}; SameSite=Lax${secure}`;
}

/** Another tab's reason while it is young, else `null`; unreadable storage costs only the sentence. */
export function takeSharedSignedOutNote(): SignedOutReason | null {
  let note: { reason?: unknown; at?: unknown } | null = null;
  try {
    const raw = localStorage.getItem(SHARED_NOTE_KEY);
    note = raw === null ? null : (JSON.parse(raw) as { reason?: unknown; at?: unknown } | null);
  } catch {
    return null;
  }
  const age = typeof note?.at === "number" ? Date.now() - note.at : -1;
  return age >= 0 && age < SHARED_NOTE_MS && isSignedOutReason(note?.reason) ? note.reason : null;
}
