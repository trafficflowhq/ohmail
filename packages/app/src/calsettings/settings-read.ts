/**
 * THE ACCOUNT'S CALENDAR SETTINGS as the panes read them: asked of the port whenever its version moves, and replaced
 * by our server's own answer after a save. Until the first answer, null: no value is guessed.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CalendarPort, CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import type { CalendarSettingsBody, CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";

const still = () => () => undefined;
const zero = () => 0;

export interface SettingsRead {
  readonly said: CalendarSettingsWire | null;
  /** Saves through the setup's port; `none` where it has no door. Resolves false where it was not saved. */
  readonly save: ((body: CalendarSettingsBody) => Promise<boolean>) | "none";
}

export function useCalendarSettings(
  port: CalendarPort | null,
  setup: CalendarSetupPort | "none",
): SettingsRead {
  const version = useSyncExternalStore(
    port?.subscribe ?? still,
    port?.version ?? zero,
    port?.version ?? zero,
  );
  const [said, setSaid] = useState<CalendarSettingsWire | null>(null);
  useEffect(() => {
    if (port === null) return;
    let live = true;
    port.settings().then(
      (s) => live && setSaid(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port, version]);
  const door = setup === "none" ? "none" : setup.saveSettings;
  const save = useCallback(
    (body: CalendarSettingsBody) =>
      door === "none"
        ? Promise.resolve(false)
        : door(body).then(
            (answer) => (setSaid(answer), true),
            () => false,
          ),
    [door],
  );
  return { said, save: door === "none" ? "none" : save };
}
