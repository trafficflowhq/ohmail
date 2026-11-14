import { useLayoutEffect, useRef } from "react";
import { useZoneNav } from "@ohmail/app-logic/keys";
import { queryAllVisible, queryVisible } from "@ohmail/app-logic/lists/visible-dom";
import { useText } from "../text/index.js";
import type { SettingsPaneId, SettingsBeside, SettingsPane } from "./contract.js";

const ROW = "[data-settings-menu] [data-entry]";
const SECTION = '.fr-main [data-reading-scroll][role="region"]';

export function useSettingsZone(
  menu: readonly SettingsPane[],
  shown: SettingsPaneId | null,
  oneColumn: boolean,
  go: SettingsBeside["go"],
): void {
  const t = useText("shortcuts");
  const previousSection = useRef<SettingsPaneId | null>(null);
  const landing = shown ?? menu.find((pane) => pane.id === previousSection.current)?.id ?? menu[0]?.id;
  const entry = landing === undefined ? ROW : `${ROW}[data-id="${landing}"]`;
  const sectionOverMenu = oneColumn && shown !== null;
  const disableRoving = menu.length === 0 || sectionOverMenu;

  const rove = (direction: 1 | -1): void => {
    const rows = queryAllVisible<HTMLElement>(ROW);
    const active = rows[0]?.ownerDocument.activeElement;
    const at = rows.findIndex((row) => row === active);
    const row = at < 0 ? queryVisible<HTMLElement>(entry) : rows[at + direction];
    row?.focus();
  };

  const openFocused = (): void => {
    const active = queryVisible(ROW)?.ownerDocument.activeElement;
    const id = active?.matches(ROW) ? active.getAttribute("data-id") : null;
    const pane = menu.find((item) => item.id === id)?.id ?? landing;
    if (pane !== undefined) go(pane);
  };

  useZoneNav(t, {
    listFocusSelector: entry,
    list: {
      up: { disabled: disableRoving, label: t("zoneMenuUp"), run: () => rove(-1) },
      down: { disabled: disableRoving, label: t("zoneMenuDown"), run: () => rove(1) },
    },
    reader: {
      selector: SECTION,
      disabled: landing === undefined,
      onEnter: () => queryVisible<HTMLElement>(SECTION)?.scrollIntoView?.({ block: "nearest" }),
      ...(oneColumn && !sectionOverMenu ? { onHiddenEnter: openFocused } : {}),
      ...(sectionOverMenu ? { onExit: () => go(null) } : {}),
    },
  });

  /* One column replaces the previous keyboard stop. Return to the entry for the section that closed. */
  useLayoutEffect(() => {
    if (sectionOverMenu) {
      previousSection.current = shown;
      queryVisible<HTMLElement>(SECTION)?.focus({ preventScroll: true });
    } else if (previousSection.current !== null) {
      previousSection.current = null;
      if (oneColumn) queryVisible<HTMLElement>(entry)?.focus();
    }
  }, [entry, oneColumn, sectionOverMenu, shown]);
}
