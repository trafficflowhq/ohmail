import { Dock, Rail, RailEntry, type DockPlace } from "@ohmail/ui/mail";
import type { CalendarRailProps } from "../frame/contract.js";
import { useText } from "../text/index.js";

import { useNewEvent } from "./use-new-event.js";

/** The calendar rail and the dock use the same command as the keyboard. */
export function CalendarRail({ form, route, commands, switcher, notice }: CalendarRailProps) {
  const t = useText("calendar");
  const open = useNewEvent();
  const create = open && {
    label: t("create.title"),
    icon: "plus" as const,
    onPress: open,
    keyHint: "C",
    shortcut: "c",
  };
  const places: DockPlace[] = [
    {
      id: "week",
      label: t("view.week"),
      icon: "week",
      current: route.place === "week",
      onPress: () => commands.go({ place: "week" }),
    },
    {
      id: "agenda",
      label: t("agenda"),
      icon: "agenda",
      current: route.place === "agenda",
      onPress: () => commands.go({ place: "agenda" }),
    },
    {
      id: "invitations",
      label: t("invitations"),
      icon: "invite",
      current: route.words.panel === "invitations",
      onPress: () => commands.go({ place: "week", sub: route.sub, words: { panel: "invitations" } }),
    },
    {
      id: "frommail",
      label: t("fromMail"),
      icon: "frommail",
      current: route.place === "frommail",
      onPress: () => commands.go({ place: "frommail" }),
    },
  ];
  if (form !== "words") {
    return (
      <Dock
        label={t("landmark")}
        places={places}
        {...(create && { write: create })}
        floor={1}
        upright={form === "icons"}
        switcher={switcher}
        more={{ label: t("more"), onPress: () => commands.rail(true) }}
      />
    );
  }
  return (
    <Rail
      label={t("places")}
      switcher={switcher}
      {...(create && { write: create })}
      foot={notice}
      groups={[
        places.map((place) => (
          <RailEntry
            key={place.id}
            kind="place"
            icon={place.icon}
            current={place.current}
            onPress={place.onPress}
          >
            {place.label}
          </RailEntry>
        )),
      ]}
    />
  );
}
