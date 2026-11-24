/** The places' states list (`places-states.mjs`). */
export const STREAM_SCREENS: string[];
export const LIST_SCREENS: string[];
export const PLACE_SCREENS: string[];
export interface PlacesState {
  key: string;
  screen: string;
  kind: string;
  owner: string;
  how: string;
}
export function listPlacesStates(screens?: readonly string[]): PlacesState[];
export function comparedKeys(screen: string): string[];
