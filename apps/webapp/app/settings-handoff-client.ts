"use client";

import { apiOwnerVerdict } from "./api-client";
import { SETTINGS_HANDOFF, SETTINGS_HANDOFF_PANES, settingsReference, type SettingsHandoffPane } from "./settings-handoff";

type HandoffAnswer = { kind: "ready"; account: string; pane: SettingsHandoffPane } | { kind: "login" } | { kind: "invalid" };

export async function checkSettingsHandoff(reference: string, signal?: AbortSignal): Promise<HandoffAnswer> {
  if (!settingsReference(reference)) return { kind: "invalid" };
  if (apiOwnerVerdict("/auth/session") === "signed-out") return { kind: "login" };
  try {
    const response = await fetch(`/api/auth/session?${SETTINGS_HANDOFF}=${encodeURIComponent(reference)}`, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    });
    if (response.status === 401 || response.status === 403 || response.status === 409) return { kind: "login" };
    if (!response.ok) return { kind: "invalid" };
    const body = await response.json() as { account?: unknown; pane?: unknown } | null;
    const pane = SETTINGS_HANDOFF_PANES.find((candidate) => candidate === body?.pane);
    if (typeof body?.account === "string" && body.account && pane) {
      return { kind: "ready", account: body.account, pane };
    }
  } catch {
    // A failed check cannot open Settings.
  }
  return { kind: "invalid" };
}
