/**
 * THE HEADLESS TASK, REGISTERED — the JS half of what keeps this app's timers running.
 *
 * `OrganizerHeadlessService` starts a task under this name, and React Native keeps its timer
 * manager alive for as long as the task's promise is pending. That is the whole mechanism: a
 * foreground service keeps the PROCESS unfrozen, and an active headless task keeps the TIMERS
 * going. The engine's poll and the claim watch are timers, so without this they stop the moment
 * the Activity pauses and the notification would stand over a runtime that had stopped.
 *
 * The task therefore never resolves. It is ended by the SERVICE going away, which is what the
 * person's stop does — and the service's own watchdog ends it too if the beats stop, so a task
 * that somehow outlived its purpose cannot hold this app awake silently.
 *
 * It does no work. Everything that organizes the mailbox is the engine, already running in this
 * runtime; this exists so that runtime keeps ticking.
 */
import { AppRegistry } from "react-native";

/** Byte-equal to `OrganizerHeadlessService.TASK_NAME`; the suite holds the two together. */
export const ORGANIZER_TASK = "ohmail-organizer";

/**
 * Register it. Called once, from the app's entry, and idempotent in practice — `AppRegistry`
 * replaces a task of the same name rather than stacking them.
 *
 * `never` and not a resolved promise: a task that resolves is a task React Native retires, and
 * retiring it takes the timers with it.
 */
export function registerOrganizerTask(): void {
  AppRegistry.registerHeadlessTask(ORGANIZER_TASK, () => async (): Promise<void> => {
    await new Promise<never>(() => undefined);
  });
}
