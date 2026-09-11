/**
 * The headless task, registered — the JS half of what keeps this app's timers running.
 * `OrganizerHeadlessService` starts a task under this name, and React Native keeps its timer
 * manager alive for as long as the task's promise is pending: the foreground service keeps the
 * process unfrozen, the active headless task keeps the timers going. The engine's poll and the
 * claim watch are timers, so without this they stop when the Activity pauses and the
 * notification would stand over a runtime that had stopped. The task never resolves: it is ended
 * by the service going away — the person's stop — and the service's own watchdog ends it if the
 * beats stop. It does no work; it exists so the runtime keeps ticking.
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
