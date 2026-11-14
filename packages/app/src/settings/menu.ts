/** Which sections the menu lists, and which one stands. Pure: the host's answers and the route decide. */
import { NONE, type HostContract } from "../host/index.js";
import {
  PANE_GROUPS,
  PANE_IDS,
  type PaneGroup,
  type PaneId,
  type SettingsPane,
  type SettingsPanes,
} from "./contract.js";

/** The listed sections in the menu's order: registered, and listed by the host's answers. */
export function menuOf(host: HostContract, panes: SettingsPanes): readonly SettingsPane[] {
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
): readonly { group: PaneGroup; panes: readonly SettingsPane[] }[] {
  return PANE_GROUPS.map((group) => ({ group, panes: menu.filter((pane) => pane.group === group) })).filter(
    (part) => part.panes.length > 0,
  );
}

/**
 * The section that stands. A listed `sub` wins. Otherwise two columns show the link's section where it is listed,
 * else General; one column shows the menu (`null`). An unknown or unlisted section is never drawn.
 */
export function shownOf(
  sub: string | null,
  menu: readonly SettingsPane[],
  columns: 1 | 2,
  startAt: PaneId | null,
): SettingsPane | null {
  const find = (id: string | null) => (id === null ? undefined : menu.find((pane) => pane.id === id));
  const asked = find(sub);
  if (asked) return asked;
  if (columns === 1) return null;
  return find(startAt) ?? find("general") ?? menu[0] ?? null;
}
