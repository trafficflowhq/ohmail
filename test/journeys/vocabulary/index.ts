import { CONTROLS, type Control } from "./controls.js";
import { DOOR_CONTROLS, type DoorControl } from "./controls-doors.js";

/**
 * EVERY CONTROL OF THE VOCABULARY, from every file that holds rows: the seats' (`controls.ts`) and the doors'
 * (`controls-doors.ts`). A bench finds a control through `control` here, so a row may move between the files
 * without a journey noticing. An id stands once.
 */
export type AnyControl = Control | DoorControl;

/** Ids that stand in more than one file. */
export function twice(...files: Array<Readonly<Record<string, unknown>>>): string[] {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const file of files) for (const id of Object.keys(file)) (seen.has(id) ? again : seen).add(id);
  return [...again].sort();
}

const doubled = twice(CONTROLS, DOOR_CONTROLS);
if (doubled.length > 0) throw new Error(`the vocabulary names a control twice: ${doubled.join(", ")}`);

export const ALL_CONTROLS: Readonly<Record<string, AnyControl>> = Object.freeze({ ...CONTROLS, ...DOOR_CONTROLS });

export function control(id: string): AnyControl {
  const found = ALL_CONTROLS[id];
  if (!found) throw new Error(`the vocabulary has no control ${JSON.stringify(id)}`);
  return found;
}
