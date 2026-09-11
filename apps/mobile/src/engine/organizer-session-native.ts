/**
 * The platform half of the organizer session — `AppState`, the service, the headless task. The
 * `background-native.ts` idiom, for its reason: `AppState` and `requireOptionalNativeModule` come from
 * packages the node suite's transform refuses, so everything that decides lives in `organizer-session.ts` and
 * `background.ts`, and this file supplies the four platform facts with no branch of its own. The headless
 * task is registered here, not at the app's entry: it becomes needed only when the foreground service goes
 * up, and that only behind this session — a module-scope registration in `app/_layout.tsx` would install it
 * on every paired phone that can never start one. `AppRegistry` replaces a task of the same name rather than
 * stacking, so a second session's registration is not a second task.
 */
import { AppState, Platform } from "react-native";

import { Copy } from "../copy";
import { nativeBackgroundService } from "./background-native";
import { registerOrganizerTask } from "./organizer-task";
import { startOrganizerSession } from "./organizer-session";
import type { StandaloneEngine } from "./standalone-door";

/**
 * Wire the engine this app just opened to the app's own lifecycle. Answers whether THIS call is
 * the live session — see `startOrganizerSession`.
 *
 * `address` is the mailbox the notification names. It is the ONE runtime value in the notice and
 * it is passed rather than read from a row, because at this moment the door has just opened and no
 * mirror row exists yet — a notice composed from an unread row would name nothing.
 */
export function startOrganizerSessionNative(engine: StandaloneEngine, address: string): boolean {
  registerOrganizerTask();
  return startOrganizerSession({
    platform: Platform.OS === "android" ? "android" : "ios",
    engine: {
      handBack: () => engine.handBack(),
      resume: () => engine.resume(),
      /* THE ROW'S ANSWER PER MAILBOX, in the shape the watch reads. A throw propagates: the
         background half treats an unreadable state as "cannot say" and leaves the notification
         standing rather than ending somebody's organizing over a momentary failure. */
      organizing: () => Object.entries(engine.runtimes().organizer)
        .map(([mailboxId, state]) => ({ mailboxId, organizing: state.organizing })),
    },
    /* `null` on iOS, and that is the platform rather than a gap — see `background-native.ts`. */
    service: nativeBackgroundService(),
    /* RE-READ PER START, so a language switch between two backgrounds is picked up. */
    notice: () => ({
      channelName: Copy.stateOrganizing,
      body: Copy.notifBody(address),
      stopLabel: Copy.notifStop,
    }),
    appPhases: (listener) => {
      const sub = AppState.addEventListener("change", (status) => { listener(status); });
      return () => { sub.remove(); };
    },
  });
}
