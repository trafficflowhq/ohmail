/**
 * SOMEONE IS USING THE PHONE — a touch anywhere in the app (seen at the root), a push wake or a
 * pull. The drain cadence reads it to end an idle spacing at once (`drain-cadence.ts`). Pure: no
 * React Native, so the suite rings it by hand.
 */
import type { CadenceActivity } from "./drain-cadence";

const listeners = new Set<() => void>();

export function noteActivity(): void {
  for (const listener of listeners) listener();
}

export const appActivity: CadenceActivity = {
  subscribe: (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
