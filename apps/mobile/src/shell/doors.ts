/**
 * THE NATIVE DOORS ON THE SHELL'S SESSION: what the page may ask of the phone and what the phone tells the page, each
 * answered by the phone's own reader. A wake (the app back in front, or a push for this pairing) reaches the page as
 * an event; the notice permission is the phone's own reading; and the claim about backups covers every place the
 * shell keeps mail (the keeper, the web view's data, and on a phone that organizes its own mailbox the engine's
 * store and its copy), recording the worst of them, because one place that rides a backup makes the sentence false.
 */
import { measureBackupExclusion, type BackupExclusion, type BackupExclusionNative } from "../engine/backup-exclusion";
import type { NotificationPermissionHost } from "../engine/notification-permission";
import type { NoticePermission } from "./bridge-kinds";

/** Why the page is woken: the app came back in front, or a push for this pairing arrived. */
export type WakeWhy = "foreground" | "push";

const wakes = new Set<(why: WakeWhy) => void>();

/** A wake for the shell's page, from the root's wake provider; the shell's screen hands it on. */
export function wakeShell(why: WakeWhy): void {
  for (const woke of [...wakes]) woke(why);
}

export function onShellWake(woke: (why: WakeWhy) => void): () => void {
  wakes.add(woke);
  return () => {
    wakes.delete(woke);
  };
}

/**
 * The notice permission as the page reads it. The phone's notices are the organizer's, Android's; iOS posts none, so
 * there is nothing to ask for there.
 */
export async function noticePermission(host: NotificationPermissionHost): Promise<NoticePermission> {
  if (host.platform !== "android") return "unsupported";
  if (await host.permissionGranted()) return "granted";
  return (await host.readAsked()) ? "denied" : "default";
}

/** The page asked for the permission: the system's prompt, and the install's record that it asked. */
export async function askNoticePermission(host: NotificationPermissionHost): Promise<NoticePermission> {
  if (host.platform !== "android") return "unsupported";
  const answer = await host.request();
  await host.writeAsked().catch(() => undefined);
  return answer === "granted" ? "granted" : "denied";
}

/** Every place measured, each marked and read back; the worst answer of them all. Nothing to measure is unknown. */
export async function measureShellBackup(
  native: BackupExclusionNative | null,
  paths: readonly string[],
): Promise<BackupExclusion> {
  if (paths.length === 0) return "unknown";
  const states = await Promise.all(paths.map((path) => measureBackupExclusion(native, path)));
  if (states.includes("included")) return "included";
  return states.includes("unknown") ? "unknown" : "excluded";
}
