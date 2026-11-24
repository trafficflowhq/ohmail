/** The mounted calendar's setup capabilities, with an override for a host that supplies its own. */
import { createContext, useContext } from "react";
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
import { useFrame } from "../frame/commands.js";
import { NONE, type None } from "../host/index.js";

const SetupPortContext = createContext<CalendarSetupPort | None>(NONE);

/** What a shell (or a test) wraps the frame in to hand the port over. */
export const SetupPortProvider = SetupPortContext.Provider;

export function useSetupPort(): CalendarSetupPort | None {
  const given = useContext(SetupPortContext);
  const calendar = useFrame().host.wires.calendar;
  return given !== NONE ? given : calendar === NONE ? NONE : (calendar.setup ?? NONE);
}
