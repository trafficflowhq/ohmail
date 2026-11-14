import { useId, type ReactNode } from "react";
import { Button } from "../../base/Primitives/Button.js";
import { Rail, RailEntry, type RailProps } from "../../mail/index.js";
import { CalendarRow, type CalendarRowProps } from "./CalendarRow.js";
import "./calendar-rail.css";

export interface CalendarRailProps {
  /** The landmark's name: "Places". */
  label: string;
  /** The way between the two products. It stands first. */
  switcher?: ReactNode;
  newEvent: { label: string; keyHint?: string; onPress?: () => void };
  /** The mini month. */
  mini: ReactNode;
  /** Invitations and From mail: the rail's entries. */
  places: ReactNode;
  /** One line that opens, as mail's Tags are made. Shut, it says how many of its rows show. */
  calendars: {
    label: string;
    /** How many show: "10 of 11". */
    note?: string;
    open: boolean;
    onToggle?: () => void;
    /** The accounts, each with its calendars; the kinds of mail that draw on the calendar follow as rows of the same kind. */
    accounts: readonly { name: string; calendars: readonly (CalendarRowProps & { id: string })[] }[];
  };
  /** What follows the calendars: Settings. */
  below?: ReactNode;
  /** The foot: Check now, the account, the two quiet tools. */
  foot?: ReactNode;
  focused?: RailProps["focused"];
  clip?: RailProps["clip"];
}

/**
 * The rail in the calendar: the same width, entries and foot as mail's, and calm until the
 * calendars are asked for. It is the pointer's rail; with a finger the dock stands in its place.
 */
export function CalendarRail({
  label,
  switcher,
  newEvent,
  mini,
  places,
  calendars,
  below,
  foot,
  focused,
  clip,
}: CalendarRailProps) {
  const id = useId();
  /* New event stands at the rail's head with the switch: only the month and the places scroll under it. */
  const head = (
    <>
      {switcher}
      <div className="oh-calrail-new">
        <Button kind="two" icon="plus" keyHint={newEvent.keyHint} onPress={newEvent.onPress}>
          {newEvent.label}
        </Button>
      </div>
    </>
  );
  const groups: ReactNode[] = [
    mini,
    places,
    <div className="oh-calrail-cals">
      <RailEntry
        kind="fold"
        expanded={calendars.open}
        count={calendars.note}
        title={calendars.label}
        onPress={calendars.onToggle}
      >
        {calendars.label}
      </RailEntry>
      {calendars.open
        ? calendars.accounts.map((account, n) => (
            <div
              key={account.name}
              className="oh-calrail-account"
              role="group"
              aria-labelledby={`${id}-${n}`}
            >
              <p id={`${id}-${n}`} className="oh-text oh-calrail-caption">
                {account.name}
              </p>
              {account.calendars.map(({ id: key, ...row }) => (
                <CalendarRow key={key} quiet {...row} />
              ))}
            </div>
          ))
        : null}
    </div>,
  ];
  if (below) groups.push(below);
  return <Rail label={label} switcher={head} groups={groups} foot={foot} focused={focused} clip={clip} />;
}
