/**
 * WHICH SURFACE THIS BUILD SHOWS MAIL IN: the phone's own screens, or the shell's web view with the
 * shared views. In the ohmail app the screens until the shell carries everything they do; a build that sets
 * `EXPO_PUBLIC_OHMAIL_MAIL_SURFACE=shell` (Expo inlines it where the bundle is made) shows the
 * shell. An app that carries no screens (the calendar's) is always the shell, and asking it for the screens is a
 * build error, as is any other value: never a guess. Read once, where the connection's environment is built.
 */
import type { VariantRow } from "../variant";

export type MailSurface = "screens" | "shell";

export function mailSurfaceOf(said: string | undefined, app: Pick<VariantRow, "name" | "carries">): MailSurface {
  if (said !== undefined && said !== "" && said !== "screens" && said !== "shell") {
    throw new Error(`EXPO_PUBLIC_OHMAIL_MAIL_SURFACE is "${said}": it is "shell", "screens" or unset`);
  }
  if (!app.carries.screens) {
    if (said === "screens") throw new Error(`EXPO_PUBLIC_OHMAIL_MAIL_SURFACE is "screens", and ${app.name} carries no screens`);
    return "shell";
  }
  return said === "shell" ? "shell" : "screens";
}
