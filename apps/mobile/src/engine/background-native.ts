/**
 * THE REAL BACKGROUND SERVICE — the one module in this app that asks for the organizer service.
 *
 * The `host-pinning-native.ts` idiom, for the reason that file states as a fact: importing `expo`
 * pulls the whole Expo runtime, which needs `__DEV__` and is not present under vitest, so the
 * node-side suite drives every rule in `background.ts` through its seam and never loads this file.
 *
 * `requireOptionalNativeModule` answers `null` rather than throwing where the native half is
 * absent — **iOS, which has no half here and needs none**: iOS does not let a suspended app hold
 * an organizer claim honestly, so the iPhone answer is to give the mailbox back rather than to
 * find a way to keep it. `null` is therefore the CORRECT iOS value, not a gap, and the arms in
 * `background.ts` read it as "organizes only while open".
 */
import { requireOptionalNativeModule } from "expo";

import type { BackgroundService, ServiceNotice } from "./background";

/** What the Kotlin module exposes. `onStopRequested` is an event, so it is adapted below. */
interface OrganizerServiceNative {
  start(channelName: string, body: string, stopLabel: string): Promise<boolean>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isRestricted(): boolean;
  /** Says this runtime is still running; answers whether the service is still up. */
  beat(): boolean;
  beatIntervalMs(): number;
  addListener(event: string, listener: () => void): { remove(): void };
}

/** The event the Kotlin half emits for the action AND for a swipe-dismiss — one name, one act. */
export const STOP_REQUESTED_EVENT = "onStopRequested";

export function nativeBackgroundService(): BackgroundService | null {
  const mod = requireOptionalNativeModule<OrganizerServiceNative>("OhmailOrganizerService");
  if (mod === null) return null;
  return {
    /* THE STRINGS COME FROM THE DECK, per call. A notification composed in Kotlin would need its
       own localized resources — a second copy of three sentences, and the `ExtraTranslation` lint
       hazard this app has already met — and the body carries a mail ADDRESS, which is runtime data
       no resource can hold. */
    start: (notice: ServiceNotice) => mod.start(notice.channelName, notice.body, notice.stopLabel),
    stop: () => mod.stop(),
    running: () => mod.isRunning(),
    restricted: () => mod.isRestricted(),
    beat: () => mod.beat(),
    beatIntervalMs: () => mod.beatIntervalMs(),
    onStopRequested: (listener: () => void) => {
      const sub = mod.addListener(STOP_REQUESTED_EVENT, listener);
      return () => { sub.remove(); };
    },
  };
}
