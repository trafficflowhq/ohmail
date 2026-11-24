import type { SettingsBeside, SettingsPanes } from "./contract.js";
import { SettingsList } from "./SettingsList.js";
import { SettingsReading } from "./SettingsReading.js";
import { settingsPlaceWith, type SettingsAbove } from "./place-with.js";

export { SettingsList, SettingsReading };
export type { SettingsAbove } from "./place-with.js";

export function settingsPlace(
  sections: SettingsPanes | null | (() => SettingsPanes),
  useBeside: () => SettingsBeside,
  Above?: SettingsAbove,
) {
  return settingsPlaceWith(sections, useBeside, Above, SettingsList, SettingsReading);
}
