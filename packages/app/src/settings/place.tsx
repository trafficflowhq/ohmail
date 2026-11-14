import type { PaneProps, PlaceEntry } from "../frame/contract.js";
import type { SettingsBeside, SettingsPanes } from "./contract.js";
import { SettingsList } from "./SettingsList.js";
import { SettingsReading } from "./SettingsReading.js";

/**
 * Settings as a place of the frame: the menu in the list's column, the section in the reading column. The shell
 * hands every pane (the new ones, and today's nodes standing in until their task replaces them) and its own way
 * between sections, which runs through its leave hold. Nothing here defaults either.
 */
export function settingsPlace(panes: SettingsPanes, useBeside: () => SettingsBeside): PlaceEntry {
  function List(props: PaneProps) {
    return <SettingsList {...props} panes={panes} beside={useBeside()} />;
  }
  function Reading(props: PaneProps) {
    return <SettingsReading {...props} panes={panes} beside={useBeside()} />;
  }
  return { id: "settings", body: "settings", rail: null, panes: { kind: "columns", List, Reading } };
}
