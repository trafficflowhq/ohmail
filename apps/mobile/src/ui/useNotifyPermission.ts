/**
 * THE ASK, AS ONE THING BOTH PRESSES DO. Organizing begins at two moments on this phone, and
 * neither may grow its own version of the sequence: decide, spend the ask, show the sentence,
 * then the system prompt, then record what the phone can do.
 *
 * `gate()` resolves when the sheet is answered, so a press can await it and go on — and at once
 * where there is nothing to ask. Every rule lives in `engine/notification-permission.ts`; this
 * holds the sheet's open state and the promise the press waits on.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  answerLeavesNotificationsOff,
  markOrganizerNotificationAsked,
  recordLiveNotificationState,
  requestOrganizerNotification,
  shouldAskForOrganizerNotification,
} from "../engine/notification-permission";
import { nativeNotificationPermission } from "../engine/notification-permission-native";
import { sayNotificationsOff, sayNotificationsOn } from "../engine/organizer-session";

export interface NotifyPermissionGate {
  /** Whether the sheet is showing. Handed straight to `NotifyPermission`. */
  readonly open: boolean;
  /** Run it at the press that started organizing. Resolves when there is nothing left to ask. */
  readonly gate: () => Promise<void>;
  /** The sheet's answer. `true` = show the system prompt. */
  readonly answer: (go: boolean) => void;
}

export function useNotifyPermission(): NotifyPermissionGate {
  const [open, setOpen] = useState(false);
  /**
   * THE SYSTEM'S OWN ANSWER, AND IT IS WHAT CLEARS THE STATE.
   *
   * The permission can be given back in system settings at any moment and nothing inside the app
   * is told; a record that could only be set would keep "Notifications are off" on screen over a
   * phone that had just been given the notification. The lifecycle is HERE and not in the screen
   * that renders it — the rule Settings lives under. `null` is "could not ask" and moves nothing.
   */
  useEffect(() => {
    let alive = true;
    void recordLiveNotificationState(nativeNotificationPermission(), {
      off: () => { if (alive) sayNotificationsOff(); },
      on: () => { if (alive) sayNotificationsOn(); },
    });
    return () => { alive = false; };
  }, []);
  /* The press waiting on the sheet. A ref and not state: it is resolved from a callback, and a
     re-render must not lose the press that is parked on it. */
  const waiting = useRef<(() => void) | null>(null);

  const gate = useCallback(async (): Promise<void> => {
    const host = nativeNotificationPermission();
    if (!(await shouldAskForOrganizerNotification(host))) return;
    /* SPENT WHEN THE SENTENCE GOES UP, not when it is answered — a dismissal is an answer, and a
       record kept only for a pressed Continue would put this sheet back at every later press. */
    await markOrganizerNotificationAsked(host);
    await new Promise<void>((resolve) => {
      waiting.current = resolve;
      setOpen(true);
    });
  }, []);

  const answer = useCallback((go: boolean): void => {
    setOpen(false);
    const resume = waiting.current;
    waiting.current = null;
    if (!go) {
      /* Dismissed. The permission is not held, so the panel says so — with the way to system
         settings beside it, which is the only remaining act. */
      sayNotificationsOff();
      resume?.();
      return;
    }
    void (async () => {
      const settled = await requestOrganizerNotification(nativeNotificationPermission());
      if (answerLeavesNotificationsOff(settled)) sayNotificationsOff();
      else sayNotificationsOn();
      resume?.();
    })();
  }, []);

  return { open, gate, answer };
}
