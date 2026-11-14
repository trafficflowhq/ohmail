/**
 * WHERE THE SETUP'S PORT COMES FROM: the one place that knows it, until the calendar's port carries it. Nothing hands
 * one in yet, so every screen reads `none` and draws no control that would need it.
 */
import { createContext, useContext } from "react";
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
import { NONE, type None } from "../host/index.js";

const SetupPortContext = createContext<CalendarSetupPort | None>(NONE);

/** What a shell (or a test) wraps the frame in to hand the port over. */
export const SetupPortProvider = SetupPortContext.Provider;

export function useSetupPort(): CalendarSetupPort | None {
  return useContext(SetupPortContext);
}
