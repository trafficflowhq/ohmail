import { useRef, useState } from "react";
import { Menu, MenuGroup, MenuItem } from "@ohmail/ui/base";
import { CalendarSquare, type CalendarRailProps } from "@ohmail/ui/calendar";
import { useText } from "../text/index.js";
import "./calendar-swatches.css";

export function CalendarSwatches({
  short,
  rows,
}: {
  readonly short: boolean;
  readonly rows: CalendarRailProps["calendars"]["accounts"];
}) {
  const t = useText("calendar");
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!rows.some(({ calendars }) => calendars.length > 0)) return null;
  const label = t("calendars");
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="oh-control cal-rail-swatches"
        data-short={short ? "" : undefined}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {rows.flatMap(({ calendars }) =>
          calendars.map((row) => (
            <CalendarSquare key={row.id} size={10} tone={row.tone} hollow={!row.shown} />
          )),
        )}
      </button>
      <Menu anchor={anchor} label={label} open={open} onClose={() => setOpen(false)} anchored fit="beside">
        {rows.map(({ id, name, calendars }) => (
          <MenuGroup key={id ?? name} title={name}>
            {calendars.map((row) => (
              <MenuItem
                key={row.id}
                label={row.switchLabel}
                leading={<CalendarSquare tone={row.tone} hollow={!row.shown} />}
                note={row.viewOnlyLabel}
                checked={row.shown}
                many
                stay
                disabled={!row.onToggle}
                onPress={() => row.onToggle?.(!row.shown)}
              >
                {row.name}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
      </Menu>
    </>
  );
}
