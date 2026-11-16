/**
 * WHICH SURFACE THIS BUILD SHOWS MAIL IN: the phone's own screens, or the shell's web view with the
 * shared views. The screens until the shell carries everything they do; a build that sets
 * `EXPO_PUBLIC_OHMAIL_MAIL_SURFACE=shell` (Expo inlines it where the bundle is made) shows the
 * shell. Any other value it was given is a build error at load, never a guess. Read once, where the
 * connection's environment is built.
 */
export type MailSurface = "screens" | "shell";

export function mailSurfaceOf(said: string | undefined): MailSurface {
  if (said === undefined || said === "" || said === "screens") return "screens";
  if (said === "shell") return "shell";
  throw new Error(`EXPO_PUBLIC_OHMAIL_MAIL_SURFACE is "${said}": it is "shell", "screens" or unset`);
}

export const MAIL_SURFACE: MailSurface = mailSurfaceOf(process.env.EXPO_PUBLIC_OHMAIL_MAIL_SURFACE);
