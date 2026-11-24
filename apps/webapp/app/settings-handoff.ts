export const SETTINGS_HANDOFF_PANES = ["account", "security", "devices", "storage", "mailboxes", "calendar-google", "calendar-microsoft"] as const;
export type SettingsHandoffPane = (typeof SETTINGS_HANDOFF_PANES)[number];
export const SETTINGS_HANDOFF = "settingsHandoff";

export function settingsReference(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,720}$/.test(value) ? value : null;
}

export function settingsLogin(reference: string): string {
  return `/login?${SETTINGS_HANDOFF}=${encodeURIComponent(reference)}`;
}

export function settingsDestination(reference: string, pane: SettingsHandoffPane): string {
  const route = pane === "calendar-google" || pane === "calendar-microsoft"
    ? `/cal/cal-setup?via=${pane.slice("calendar-".length)}`
    : `/settings/${pane}`;
  return `/?${SETTINGS_HANDOFF}=${encodeURIComponent(reference)}#${route}`;
}
