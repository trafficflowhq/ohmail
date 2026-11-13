import { expect } from "vitest";
import { journey, signedIn, type Bench, type Guard, type Person, type Setting } from "./web.js";
import { say } from "../vocabulary/catalogue.js";
import type { ControlId } from "../vocabulary/controls.js";
import { listsPane, PANES_SEEN, type WebSetting } from "../vocabulary/panes.js";
import { PLACES, paneIdOf, type PlaceId } from "../vocabulary/places.js";

/** The settings whose Settings menu lists `place`, and those whose menu does not. */
export function where(place: PlaceId): { listed: Setting[]; absent: Setting[] } {
  const all = Object.keys(PANES_SEEN) as Setting[];
  const listed = all.filter((s) => listsPane(s, paneIdOf(place)));
  return { listed, absent: all.filter((s) => !listed.includes(s)) };
}

/** Which sections, never where each stands: the order of a menu is the design's to change. */
export const sections = (names: readonly string[]): string[] => [...names].sort();

/** The names a setting's Settings menu lists, in the person's language, as a set. */
export const menuOf = (setting: string, lang: "en" | "de"): string[] =>
  sections(PANES_SEEN[setting as WebSetting].map((id) => say(PLACES[`settings-${id}` as PlaceId].landmark.key, {}, lang)));

/**
 * The Settings menu once it is whole, as a set. A section joins the menu when its own facts arrive,
 * so the menu is read until it holds the setting's own sections; what it holds then is returned.
 */
export async function wholeMenu(setting: string, person: Person, door?: string): Promise<string[]> {
  const want = JSON.stringify(menuOf(door ?? setting, person.lang));
  const read = async (): Promise<string[]> => sections(await person.listed("settings-menu", "button"));
  await person.until(async () => JSON.stringify(await read()) === want, "the Settings menu to be whole", 15_000).catch(() => {});
  return read();
}

/** The two journeys every Settings section has: it opens where it exists, and is not offered where it does not. */
export function paneGuards(place: PlaceId): Guard[] {
  const name = say(PLACES[place].landmark.key, {}, "en");
  const { listed, absent } = where(place);
  return [
    ...(listed.length > 0 ? [{ title: `${name} is in the Settings menu and opens`, rows: [], surfaces: listed, needs: [] }] : []),
    ...(absent.length > 0 ? [{ title: `${name} is not in the Settings menu of a setting that has none`, rows: [], surfaces: absent, needs: [] }] : []),
  ];
}

/**
 * Open `place` as a signed-in person and wait for the control that shows it is drawn. The menu is
 * read whole first: Settings is drawn once before the account's mailboxes arrive and again after,
 * and a person acts on the section that stays.
 */
export async function openPane(b: Bench, place: PlaceId, shows?: ControlId): Promise<{ person: Person; account: Awaited<ReturnType<typeof signedIn>>["account"] }> {
  const { person, account } = await signedIn(b);
  await person.arrive(place);
  await wholeMenu(b.setting, person);
  if (shows) await person.see(shows);
  return { person, account };
}

export function paneJourneys(place: PlaceId, guards: Guard[], shows?: ControlId): void {
  const { listed } = where(place);
  for (const guard of guards) {
    if (guard.surfaces === listed || guard.surfaces.every((s) => listed.includes(s))) {
      journey(guard, async (b) => { await openPane(b, place, shows); });
    } else {
      journey(guard, async (b) => {
        const { person } = await signedIn(b);
        await person.arrive("settings");
        expect(await wholeMenu(b.setting, person)).not.toContain(say(PLACES[place].landmark.key, {}, person.lang));
      });
    }
  }
}
