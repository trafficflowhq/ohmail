/**
 * The calendar's setup: the stage that connects a calendar (iCloud, another CalDAV server, a subscription), and the
 * one place that knows where the setup's port comes from. Its registration line is the calendar entry's `stage`.
 */
import type { StageEntry } from "../frame/contract.js";
import { CalSetupStage } from "./CalSetupStage.js";

export const calSetupStage: StageEntry = { id: "calSetup", Body: CalSetupStage };
export { CalSetupStage };
export { CalendarLine, type CalendarLineProps } from "./CalendarLine.js";
export { useCalendarMirror, type CalendarMirror } from "./mirror.js";
export { SetupPortProvider, useSetupPort } from "./use-setup-port.js";
