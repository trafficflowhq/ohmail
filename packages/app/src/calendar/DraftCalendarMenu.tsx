import { hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { wayOfConnection } from "@ohmail/app-logic/calendar/setup";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { CalendarSquare } from "@ohmail/ui/calendar";
import { useCalendarMirror } from "../calsetup/index.js";
import { useText } from "../text/index.js";

export function DraftCalendarMenu({
  anchor,
  choices,
  current,
  choose,
  close,
}: {
  anchor: HTMLElement;
  choices: readonly CalendarRecord[];
  current: string | undefined;
  choose: (id: string) => void;
  close: () => void;
}) {
  const t = useText("calendar");
  const settings = useText("calsettings");
  const mirror = useCalendarMirror();
  return (
    <Menu open up anchor={anchor} label={t("create.calendar")} onClose={close}>
      {choices.map((choice) => {
        const connection = mirror?.connections.find(({ id }) => id === choice.connectionId);
        return (
          <MenuItem
            key={choice.id}
            leading={<CalendarSquare tone={mirror?.tones.get(choice.id) ?? hueOf(choice.color)} />}
            checked={choice.id === current}
            note={connection && settings(`way.${wayOfConnection(connection)}`)}
            onPress={() => choose(choice.id)}
          >
            {choice.name}
          </MenuItem>
        );
      })}
    </Menu>
  );
}
