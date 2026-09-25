/**
 * WHERE A DOOR'S ANSWER STANDS — under the door that was pressed, never in a slot below the list.
 * Two of the four doors answer on this screen (ohmail Cloud negotiates, Your own server asks for
 * an address); the other two route away. Every probe carries the door that asked, and a door's
 * slot renders only its own, so a check that lands after the person moved on cannot appear under
 * another option. Imports no `react-native`, so the tests drive it directly.
 */
import type { Refusal } from "../refusal";

/** The doors that answer in place. The computer and the standalone door open their own screens. */
export type AnsweringDoor = "cloud" | "self";

/** Which door is open. `null` = no answer is showing. */
export type OpenDoor = null | AnsweringDoor;

/** What a door's check has established, tagged with the door that asked. */
export type Probe =
  | { k: "idle" }
  | { k: "asking"; door: AnsweringDoor }
  | { k: "probed"; door: AnsweringDoor; origin: string; flavor: string; base: string; prefixed: boolean }
  | { k: "failed"; door: AnsweringDoor; sentence: Refusal };

export const IDLE: Probe = { k: "idle" };

/** A press. ohmail Cloud opens under itself and asks again; Your own server toggles its form. */
export function pressDoor(open: OpenDoor, door: AnsweringDoor): OpenDoor {
  if (door === "cloud") return "cloud";
  return open === "self" ? null : "self";
}

/** The probe this door's own slot renders: its own, while it is the open door; else idle. */
export function probeUnder(door: AnsweringDoor, open: OpenDoor, probe: Probe): Probe {
  return open === door && probe.k !== "idle" && probe.door === door ? probe : IDLE;
}
