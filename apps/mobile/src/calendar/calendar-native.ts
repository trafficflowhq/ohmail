/**
 * The calendar's one door to its native module, the `*-native.ts` twin the node suite never imports. Null where the
 * build carries no such module: nothing is kept and nothing rings outside the app.
 */
import { requireOptionalNativeModule } from "expo";

import { CalendarAdmission } from "./live-port";
import type { CalendarNative } from "./calendar-port";

export function calendarNative(): CalendarNative | null {
  return requireOptionalNativeModule<CalendarNative>("OhmailCalendar");
}

const admission = new CalendarAdmission();
export const calendarAdmits = (instance: string): boolean => admission.allows(instance);

export function calendarLifecycle() {
  const native = calendarNative();
  if (!native) return undefined;
  return {
    open: (instance: string) => admission.open(native, instance),
    revoke: (instance: string) => admission.revoke(native, instance),
    close: () => admission.close(native),
  };
}
