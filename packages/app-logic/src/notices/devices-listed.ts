/**
 * WHAT THE DEVICES LIST ON SCREEN SHOWS, as the settings record's two rising numbers. Written by the
 * list itself after each read of it that answered: the numbers the record said as that read began,
 * so the list holds at least the devices they count. Read by the notices (`noticeReadsOf`): at the
 * list, a rise is told without a notice only once the list shows it. A list whose last read failed,
 * or a list that has left the screen, shows nothing here, and a rise is then told by a notice.
 *
 * Kept per engine, in memory: one engine is one account's copy, and the list is read from it.
 */
import type { ToldDevices } from "./told-devices.js";

const LISTED = new WeakMap<object, ToldDevices>();

/**
 * The list of `engine`'s account shows the devices `at` counts; `null` where its last read failed.
 * The answer takes this mark down again (the list left the screen) unless a later one replaced it.
 */
export function showDevicesListed(engine: object, at: ToldDevices | null): () => void {
  if (at === null) {
    LISTED.delete(engine);
    return () => undefined;
  }
  const mark: ToldDevices = { made: at.made, revoked: at.revoked };
  LISTED.set(engine, mark);
  return () => {
    if (LISTED.get(engine) === mark) LISTED.delete(engine);
  };
}

/** What the list of `engine`'s account shows now, or `null`. */
export function devicesListedOf(engine: object): ToldDevices | null {
  return LISTED.get(engine) ?? null;
}
