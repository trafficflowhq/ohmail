/**
 * The platform half of the notification permission — `PermissionsAndroid`, the keystore record and
 * the way to system settings. The `background-native.ts` idiom: every rule lives in
 * `notification-permission.ts`, this file supplies four facts and has no branch of its own.
 *
 * NOT `unified-push.ts`'s `requestNotificationPermission`, which asks for the same permission:
 * `expo-unified-push` short-circuits it to "denied" on any emulator without showing a dialog, so
 * borrowing it would record a permanent refusal on every rig for a permission the device may hold.
 * `PermissionsAndroid` is the OS's own answer on every device.
 */
import { Linking, PermissionsAndroid, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import type { NotificationAnswer, NotificationPermissionHost } from "./notification-permission";

/**
 * The per-install record. `expo-secure-store` on Android is backed by this app's own preferences,
 * which go with an uninstall — so "asked" means "asked by THIS install", which is the bound the
 * one-ask rule is written against.
 */
export const ASKED_KEY = "ohmail.organizer.notification.asked";

/** The permission the foreground service's notification needs. Absent below API 33. */
const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

export function nativeNotificationPermission(): NotificationPermissionHost {
  const opts: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  return {
    platform: Platform.OS,
    /* THE SAME QUESTION THE SERVICE ASKS, from JavaScript. `OrganizerService.canPostNotification`
       reads `areNotificationsEnabled()`, which is also false when a person has switched the app's
       notifications off in settings without ever touching the runtime permission — so `check` on
       the permission alone would answer `true` over a phone that shows nothing. `checkNotifications`
       is the pair's JS twin and reads the same fact. */
    enabled: async (): Promise<boolean> => {
      const status = await PermissionsAndroid.check(
        POST_NOTIFICATIONS as Parameters<typeof PermissionsAndroid.check>[0],
      );
      return status;
    },
    request: async (): Promise<NotificationAnswer> => {
      /* NO `rationale` ARGUMENT. React Native shows that dialog only where the platform says a
         rationale is warranted — which is AFTER a refusal — so the sentence a first-time person
         needs would be the one they never saw. The deck's sentence is shown by the sheet in front
         of this call instead, where it is read before the system prompt appears. */
      const answer = await PermissionsAndroid.request(
        POST_NOTIFICATIONS as Parameters<typeof PermissionsAndroid.request>[0],
      );
      if (answer === PermissionsAndroid.RESULTS.GRANTED) return "granted";
      if (answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
      return "denied";
    },
    readAsked: async (): Promise<boolean> => (await SecureStore.getItemAsync(ASKED_KEY, opts)) !== null,
    writeAsked: async (): Promise<void> => { await SecureStore.setItemAsync(ASKED_KEY, "1", opts); },
  };
}

/**
 * THE WAY TO THE SETTING, because the app cannot grant it back. Android refuses the runtime prompt
 * for ever after a refusal, so the only remaining act is the system screen — and a state that names
 * a refusal without a way to undo it is a dead end.
 */
export async function openNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    /* The platform refused to open its own settings. There is nothing this app can add: the state
       above already says what is off and what that means. */
  }
}
