import type { PaneProps, PlaceEntry, PlacePanes } from "../frame/contract.js";
import type { SettingsBeside, SettingsPanes } from "./contract.js";
import type { ComponentType } from "react";
import type { SettingsPartProps } from "./SettingsList.js";

export type SettingsAbove = NonNullable<Extract<PlacePanes, { kind: "columns" }>["Above"]>;

/**
 * Settings as a place of the frame: the menu in the list's column, the section in the reading column. The shell
 * hands every pane (the new ones, and today's nodes standing in until their task replaces them) and its own way
 * between sections, which runs through its leave hold. Nothing here defaults either.
 */
export function settingsPlaceWith(
  sections: SettingsPanes | null | (() => SettingsPanes),
  useBeside: () => SettingsBeside,
  Above: SettingsAbove | undefined,
  SettingsList: ComponentType<SettingsPartProps>,
  SettingsReading: ComponentType<SettingsPartProps>,
): PlaceEntry {
  const usePanes = typeof sections === "function" ? sections : () => sections;
  function List(props: PaneProps) {
    return <SettingsList {...props} panes={usePanes()} beside={useBeside()} />;
  }
  function Reading(props: PaneProps) {
    return <SettingsReading {...props} panes={usePanes()} beside={useBeside()} />;
  }
  return {
    id: "settings",
    body: "settings",
    rail: null,
    panes: { kind: "columns", List, Reading, ...(Above ? { Above } : {}) },
  };
}
