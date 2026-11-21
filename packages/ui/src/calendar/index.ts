/**
 * The calendar parts of the kit: the grids, the event, what a letter shows of a calendar.
 * They draw from plain data and know no engine.
 */
import "../mail/index.js";
import "./Grids/today-pulse.css";

export { toneOf, toneStyle, type CalendarTone } from "./tone.js";
export { CalendarSquare, type CalendarSquareProps } from "./Grids/CalendarSquare.js";
export {
  DraftChipArrival,
  EventChip,
  type EventChipProps,
  type EventChipState,
  type EventBlockProps,
  type EventPillProps,
  type EventLineProps,
} from "./Grids/EventChip.js";
export { blockLayout, type BlockLayout, type BlockPlace } from "./Grids/chip-layout.js";
export { WeekNumber, type WeekNumberProps } from "./Grids/WeekNumber.js";
export { NowLine, type NowLineProps } from "./Grids/NowLine.js";
export { AllDayRow, type AllDayRowProps } from "./Grids/AllDayRow.js";
export {
  OutOfSightCapsule,
  type OutOfSightCapsuleProps,
  type OutOfSightItem,
} from "./Grids/OutOfSightCapsule.js";
export { TimeGrid, type TimeGridDay, type TimeGridMark, type TimeGridProps } from "./Grids/TimeGrid.js";
export { dayColumn, minuteTop } from "./Grids/time-grid-layout.js";
export { MonthGrid, type MonthGridDay, type MonthGridProps, type MonthGridWeek } from "./Grids/MonthGrid.js";
export { MiniMonth, type MiniMonthDay, type MiniMonthHead, type MiniMonthProps } from "./Shell/MiniMonth.js";
export { CalendarRow, type CalendarRowProps } from "./Shell/CalendarRow.js";
export { ViewSwitch, type ViewSwitchProps } from "./Shell/ViewSwitch.js";
export { AnswerSwitch, type AnswerSwitchProps } from "./Event/AnswerSwitch.js";
export { CalendarHead, type CalendarHeadProps } from "./Shell/CalendarHead.js";
export { SidePanel, type SidePanelProps } from "./Shell/SidePanel.js";
export { AgendaRow, type AgendaMark, type AgendaRowProps } from "./Grids/AgendaRow.js";
export { EventCard, type EventCardProps, type EventCardRow } from "./Event/EventCard.js";
export { EventBridge, type EventBridgeProps } from "./Event/EventBridge.js";
export {
  bridgeShape,
  bridgeSide,
  type BridgeBody,
  type BridgeBox,
  type BridgeForm,
  type BridgeInput,
  type BridgeShape,
  type BridgeSide,
} from "./Event/bridge-shape.js";
export { EventForm, type EventFormItem, type EventFormProps, type EventFormRow } from "./Event/EventForm.js";
export { QuickAdd, type QuickAddProps } from "./Event/QuickAdd.js";
export { QuestionBeforeAct, type QuestionBeforeActProps } from "./Event/QuestionBeforeAct.js";
export { CalendarRail, type CalendarRailProps } from "./Shell/CalendarRail.js";
export { InvitationCard, type InvitationCardProps } from "./Letter/InvitationCard.js";
export { FoundEventRow, type FoundEventRowProps } from "./Letter/FoundEventRow.js";
export { TodayList, type TodayListProps, type TodayListRow } from "./Letter/TodayList.js";
