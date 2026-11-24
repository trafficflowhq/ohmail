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
 * The iPhone's own permission for the calendar's local notifications, where the build carries the calendar's module
 * (`calendar/calendar-port.ts`): the one kind of notice the iPhone shows.
 */
export interface LocalNoticePermission {
  permission?(): Promise<"granted" | "denied" | "default">;
  request?(): Promise<"granted" | "denied">;
}

/**
 * The notice permission as the page reads it. Android's is the app's one notification permission. The iPhone posts
 * no mail notice: its one notice is the calendar's alert, a local notification, so the permission there is that one,
 * read through the calendar's module; without it there is nothing to ask for.
 */
export async function noticePermission(
  host: NotificationPermissionHost, local: LocalNoticePermission | null = null,
): Promise<NoticePermission> {
  if (host.platform !== "android") return local?.permission === undefined ? "unsupported" : local.permission();
  if (await host.permissionGranted()) return "granted";
  return (await host.readAsked()) ? "denied" : "default";
}

/**
 * The page asked for the permission: the system's prompt, and the install's record that it asked. The page asks at
 * the press that needs it (on the iPhone, turning the calendar's alerts on), never at launch.
 */
export async function askNoticePermission(
  host: NotificationPermissionHost, local: LocalNoticePermission | null = null,
): Promise<NoticePermission> {
  if (host.platform !== "android") return local?.request === undefined ? "unsupported" : local.request();
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
