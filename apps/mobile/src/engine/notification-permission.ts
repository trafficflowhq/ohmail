/**
 * MAY THIS PHONE SHOW THE NOTIFICATION ITS ORGANIZING STANDS BEHIND — asked once, at the press.
 *
 * On Android 13+ `POST_NOTIFICATIONS` starts DENIED and the organizer's foreground service
 * refuses to start without it, so `background.ts` hands the mailbox back and the phone organizes
 * only while the app is open. Asked at the press that starts organizing here and nowhere else;
 * never at launch, where it would be a dialog in front of somebody who only opened their mail.
 * Below 33 there is nothing to ask: the app's notification switch is the fact, on by default.
 * The rules live here and the platform calls in `notification-permission-native.ts`, so the
 * node suite drives every decision through {@link NotificationPermissionHost}.
 */

/** What the OS answered. `blocked` is Android's "never ask again". */
export type NotificationAnswer = "granted" | "denied" | "blocked";

/**
 * The platform calls, behind a seam. `apiLevel`, the two reads and `request` are the OS's;
 * `readAsked`/`writeAsked` are the per-install record that stops the sentence below from being
 * shown twice. Both reads are live answers, never a copy: a remembered "off" goes stale the moment
 * somebody switches notifications on in system settings.
 */
export interface NotificationPermissionHost {
  /** `Platform.OS`. iOS has no organizer notification and therefore nothing to ask for. */
  readonly platform: string;
  /** Android's `SDK_INT`; `0` where the platform is not Android. */
  readonly apiLevel: number;
  /** `POST_NOTIFICATIONS` as `PermissionsAndroid.check` reads it. Undefined, so `false`, below 33. */
  permissionGranted(): Promise<boolean>;
  /** `OrganizerService.canPostNotification` — the service's own gate. `null`: no module to ask. */
  switchOn(): Promise<boolean | null>;
  /** Show the OS prompt. Only a press that {@link shouldAskForOrganizerNotification} admitted. */
  request(): Promise<NotificationAnswer>;
  /** The per-install record: `true` once this install has asked. Never un-written. */
  readAsked(): Promise<boolean>;
  writeAsked(): Promise<void>;
}

/**
 * IS THERE AN ORGANIZER NOTIFICATION ON THIS PLATFORM AT ALL?
 *
 * Android only, and the iOS arm is the DEFAULT — `platformRuleLine`'s rule, for its reason. iOS
 * suspends the app instead of letting it organize in the background, `nativeBackgroundService()`
 * answers `null` there, and `expo-notifications` is banned from this build, so an iPhone shows no
 * organizer notification, asks for no permission and has no state to render. A platform this app
 * has not met is treated as iOS: it must not be asked for a permission it may not have.
 */
export function notificationBacksOrganizing(platform: string): boolean {
  return platform === "android";
}

/** The first Android level that has `POST_NOTIFICATIONS`, and so the only one with a prompt. */
export const NOTIFICATION_PERMISSION_API = 33;

/**
 * CAN THIS PHONE SHOW THE ORGANIZER'S NOTIFICATION — the question `OrganizerService` asks before it
 * starts, and the one answer the panel's sentence and the start press read.
 *
 * Below API 33 the permission does not exist and checking it answers `false` on every phone, so
 * the fact is the app's notification switch: the service's own gate, read through the module. From
 * 33 Android keeps the permission and that switch as one fact, so the permission is read once.
 * `null` is "could not ask", never off.
 */
export async function organizerNotificationEnabled(
  host: NotificationPermissionHost,
): Promise<boolean | null> {
  if (host.apiLevel >= NOTIFICATION_PERMISSION_API) return host.permissionGranted();
  return host.switchOn();
}

/**
 * SHOULD THIS PRESS ASK? Four noes and one yes, and the noes are not the same no.
 *
 *  · not this platform — there is no notification to permit (iOS);
 *  · below API 33 — there is no system prompt, so the sheet would lead to nothing;
 *  · already enabled — a prompt would be a dialog about nothing;
 *  · asked before — Android never shows the dialog twice, so re-requesting would put OUR
 *    sentence in front of an OS prompt that never appears: the re-prompt loop, made invisible.
 * A platform call that throws answers `false`: the press goes on, and the background half's
 * own decline is what says the notification is not showing.
 */
export async function shouldAskForOrganizerNotification(
  host: NotificationPermissionHost,
): Promise<boolean> {
  if (!notificationBacksOrganizing(host.platform)) return false;
  if (host.apiLevel < NOTIFICATION_PERMISSION_API) return false;
  try {
    if ((await organizerNotificationEnabled(host)) !== false) return false;
    return !(await host.readAsked());
  } catch {
    return false;
  }
}

/**
 * SPEND THE ONE ASK — written when the sentence goes ON SCREEN, not when the person answers it.
 *
 * A dismissal is an answer. Recording only a pressed Continue would put the sheet back at the next
 * start press and at every one after it, which is the re-prompt loop wearing our own sheet instead
 * of the system's. Written before the dialog for the same reason: somebody who is shown the system
 * prompt and kills the app on it has been asked.
 *
 * Never throws — a press that starts organizing must not fail over a record.
 */
export async function markOrganizerNotificationAsked(
  host: NotificationPermissionHost,
): Promise<void> {
  try {
    await host.writeAsked();
  } catch {
    /* The record could not be kept. The ask still happens: being asked twice across two launches is
       a smaller harm than never being asked, and Android's own refusal to re-prompt is the belt. */
  }
}

/**
 * THE SYSTEM PROMPT, once the sentence has been read. Never throws: a refused ask and a refused
 * permission are the same outcome for every caller, and neither is a fault.
 */
export async function requestOrganizerNotification(
  host: NotificationPermissionHost,
): Promise<NotificationAnswer> {
  try {
    return await host.request();
  } catch {
    return "denied";
  }
}

/**
 * WHAT A SETTLED ANSWER MEANS FOR THE PANEL. Only `granted` leaves this phone able to show the
 * notification; `denied` and `blocked` are the same state to a reader and differ only in whether
 * Android would ever ask again, which is not a fact the panel states.
 */
export function answerLeavesNotificationsOff(answer: NotificationAnswer): boolean {
  return answer !== "granted";
}

/**
 * IS THE OFF-STATE TRUE FOR THIS PHONE — {@link organizerNotificationEnabled} as last answered.
 *
 * `null` is "nobody has asked the OS yet" and is its own state: it is the value before the first
 * read settles, and reading it as "off" would put "Notifications are off" under a chip a second
 * after the panel opened. Three answers, `organizingNow`'s rule.
 */
export function notificationsOffHere(platform: string, enabled: boolean | null): boolean {
  if (!notificationBacksOrganizing(platform)) return false;
  return enabled === false;
}

/**
 * READ THE LIVE STATE FOR THE PANEL. `null` where the platform has no notification to speak of, or
 * where the OS could not be asked — never a guess in either direction.
 */
export async function readNotificationsEnabled(
  host: NotificationPermissionHost,
): Promise<boolean | null> {
  if (!notificationBacksOrganizing(host.platform)) return null;
  try {
    return await organizerNotificationEnabled(host);
  } catch {
    return null;
  }
}

/**
 * THE PANEL'S RECORD, FROM THE LIVE ANSWER — what the hook runs when Settings or the door mounts.
 * `null` ("could not ask") moves nothing; otherwise the record follows the phone both ways.
 */
export async function recordLiveNotificationState(
  host: NotificationPermissionHost,
  say: { off(): void; on(): void },
): Promise<void> {
  const enabled = await readNotificationsEnabled(host);
  if (enabled === null) return;
  if (notificationsOffHere(host.platform, enabled)) say.off();
  else say.on();
}
