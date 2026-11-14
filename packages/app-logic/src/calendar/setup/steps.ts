/**
 * THE SETUP'S WAYS AND STEPS. Our server's list is the only list of ways: a failure, a throw or an answer of another
 * shape reads as none, a word this build does not know is dropped, and the client keeps no list to fall back on. A
 * way is offered only where this build has a step for it and connecting has a door. The step is read from the stage's
 * words and folds to the first one wherever it would name a way that is not offered.
 */
import { CALENDAR_WAYS, type CalendarSetupPort, type CalendarWay } from "./port.js";

/** The ways this build has a sign-in step for. Google and Microsoft have none: their ceremony has no route yet. */
const STEPPED: ReadonlySet<CalendarWay> = new Set<CalendarWay>(["icloud", "caldav", "ics"]);
const KNOWN: ReadonlySet<string> = new Set<string>(CALENDAR_WAYS);

export const SETUP_STEPS = ["way", "signin", "calendars", "default", "wait"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
/** The ways a sign-in step is drawn for. */
export type SteppedWay = "icloud" | "caldav" | "ics";

/** What our server lists, read once: `[]` on any failure. */
export async function waysSaid(port: CalendarSetupPort): Promise<readonly CalendarWay[]> {
  let said: unknown;
  try {
    said = await port.ways();
  } catch {
    return [];
  }
  if (!Array.isArray(said)) return [];
  const known = said.filter((w): w is CalendarWay => typeof w === "string" && KNOWN.has(w));
  return [...new Set(known)];
}

/** The ways drawn as a choice, in the server's order: none where connecting has no door. */
export function offeredWays(said: readonly CalendarWay[], port: CalendarSetupPort): readonly SteppedWay[] {
  if (port.connect === "none") return [];
  return said.filter((w): w is SteppedWay => STEPPED.has(w));
}

export type StandingStep =
  | { readonly step: "way" }
  | { readonly step: "signin"; readonly way: SteppedWay; readonly again: string | null }
  | {
      readonly step: "calendars" | "default" | "wait";
      readonly way: SteppedWay | null;
      readonly connection: string;
    };

/** The step the stage's words stand on, folded to `way` wherever they name a way that is not offered. */
export function stepOf(
  words: Readonly<Record<string, string>>,
  offered: readonly SteppedWay[],
): StandingStep {
  const way = offered.find((w) => w === words.way) ?? null;
  switch (words.step) {
    case "signin":
      return way === null ? { step: "way" } : { step: "signin", way, again: words.again || null };
    case "calendars":
    case "default":
    case "wait":
      return words.connection ? { step: words.step, way, connection: words.connection } : { step: "way" };
    default:
      return { step: "way" };
  }
}
