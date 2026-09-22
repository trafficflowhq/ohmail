"use client";

/**
 * WHY THIS BROWSER IS AT THE SIGN-IN FORM, carried one page. The splash learns it from the refresh
 * door's code and `/login` is the page that has to say it, so the reason travels in this tab's
 * session storage and is read ONCE. Never a URL parameter: `/login` takes no redirect or reason
 * in its address. A note that cannot be stored costs the sentence, never the navigation.
 */

import { durableSessionRemove, durableSessionSet } from "../../shell/durable";

const NOTE_KEY = "ohmail.signed-out-reason";

/** The three refusals the refresh door names (`refresh_revoked` / `_expired` / `_missing`). */
export type SignedOutReason = "revoked" | "expired" | "absent";

const REASONS: readonly SignedOutReason[] = ["revoked", "expired", "absent"];

/** The `resume.*` sentence each refusal is told with, on the splash card and on `/login`. */
export const REASON_BODY: Record<SignedOutReason, "revokedBody" | "expiredBody" | "absentBody"> = {
  revoked: "revokedBody", expired: "expiredBody", absent: "absentBody",
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
