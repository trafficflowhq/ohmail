/**
 * ONE CALENDAR ON A LINE: with its switch and its menu where the port can change it, with its switch alone where only
 * that can be changed, else its square and its name and no control at all (a control that reaches no door is never
 * drawn).
 */
import type { MouseEventHandler } from "react";
import { CalendarRow, CalendarSquare, type CalendarTone } from "@ohmail/ui/calendar";
import { SettingLine } from "@ohmail/ui/mail";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";

export interface CalendarLineProps {
  readonly calendar: CalendarRecord;
  readonly tone: CalendarTone;
  readonly switchLabel: string;
  /** Shows or hides it; left out where nothing can. */
  readonly onToggle?: (shown: boolean) => void;
  readonly onMenu?: MouseEventHandler<HTMLButtonElement>;
  readonly menuOpen?: boolean;
  readonly defaultLabel?: string;
  readonly viewOnlyLabel?: string;
}

export function CalendarLine(p: CalendarLineProps) {
  if (p.onToggle === undefined || p.onMenu === undefined) {
    const onChange = p.onToggle;
    return (
      <SettingLine
        label={p.calendar.name}
        lead={<CalendarSquare tone={p.tone} hollow={!p.calendar.shown} />}
        tag={p.viewOnlyLabel}
        toggle={onChange ? { on: p.calendar.shown, onChange } : undefined}
      />
    );
  }
  return (
    <CalendarRow
      name={p.calendar.name}
      tone={p.tone}
      shown={p.calendar.shown}
      switchLabel={p.switchLabel}
      onToggle={p.onToggle}
      onMenu={p.onMenu}
      menuOpen={p.menuOpen}
      defaultLabel={p.defaultLabel}
      viewOnlyLabel={p.viewOnlyLabel}
      quiet
    />
  );
}
