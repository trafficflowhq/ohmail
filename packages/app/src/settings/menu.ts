/** Which sections the menu lists, and which one stands; and, for a Settings place the mail made, the sections it was made over (`rememberSettingsMenu`), so the ground can lead a press to a listed section. */
import type { PlaceEntry } from "../frame/contract.js";
import { NONE, type HostContract } from "../host/contract.js";
import {
  PANE_GROUPS,
  PANE_IDS,
  type PaneGroup,
  type PaneId,
  type SettingsPaneId,
  type SettingsPane,
  type SettingsPanes,
} from "./contract.js";

/** The listed sections in the menu's order: registered, and listed by the host's answers. */
export function menuOf(host: HostContract, panes: SettingsPanes | null): readonly SettingsPane[] {
  if (panes === null) return [];
  const listed: SettingsPane[] = [];
  for (const id of PANE_IDS) {
    const pane = panes[id];
    if (pane !== NONE && pane.listed(host)) listed.push(pane);
  }
  return listed;
}

/** The menu in its three groups, each in the menu's order; a group with no listed section is left out. */
export function groupsOf(
  menu: readonly SettingsPane[],
  calendarFirst = false,
): readonly { group: PaneGroup; panes: readonly SettingsPane[] }[] {
  const order = calendarFirst
    ? (["calendar", ...PANE_GROUPS] as const)
    : (["mail", "calendar", "account", "about"] as const);
  return order
    .map((group) => ({ group, panes: menu.filter((pane) => pane.group === group) }))
    .filter((part) => part.panes.length > 0);
}

/**
 * The section that stands. A listed `sub` wins. Otherwise two columns show the link's section where it is listed,
 * else General; one column shows the menu (`null`). An unknown or unlisted section is never drawn.
 */
export function shownOf(
  sub: string | null,
  menu: readonly SettingsPane[],
  columns: 1 | 2,
  startAt: SettingsPaneId | null,
): SettingsPane | null {
  const find = (id: string | null) => (id === null ? undefined : menu.find((pane) => pane.id === id));
  const asked = find(sub);
  if (asked) return asked;
  if (columns === 1) return null;
  return find(startAt) ?? find("general") ?? menu[0] ?? null;
}

/** The sections a mail Settings place can list, even before the place is drawn. */
const menus = new WeakMap<PlaceEntry, SettingsPanes>();

export function rememberSettingsMenu(place: PlaceEntry, panes: SettingsPanes): void {
  menus.set(place, panes);
}

/**
 * WHERE A WAY INTO SETTINGS LEADS ON THIS HOST, for a part of the ground that names a section (the rail's foot names
 * Mailboxes): that section where the host's menu lists it, else the first section the menu does list, so a press
 * never opens a section that is not there or a Settings with nothing drawn. Null where the host hands no Settings,
 * or one that was not made here: nothing is known of its sections then.
 */
export function settingsSection(host: HostContract, asked: PaneId): PaneId | null {
  const place = host.features.places.settings;
  const panes = place === NONE ? undefined : menus.get(place);
  if (panes === undefined) return null;
  const menu = menuOf(host, panes);
  const selected = (menu.find((pane) => pane.id === asked) ?? menu[0])?.id;
  return PANE_IDS.find((id) => id === selected) ?? null;
}
