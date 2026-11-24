/** The grid column of day `index` (from 0): column 1 is the gutter, and the days after a hinge start one later. */
export function dayColumn(index: number, crease = 0): number {
  return index + 2 + (crease > 0 && index >= crease ? 1 : 0);
}

/** Where a minute of the day stands on the hours, in px from the first hour drawn. */
export function minuteTop(minutes: number, firstHour: number, hourHeight: number): number {
  return ((minutes - firstHour * 60) * hourHeight) / 60;
}

/* An hour's label gives way to the time of now from this many minutes. */
const NEAR = 14;

/** Whether the hour's label at `hour` gives way to the time of now. */
export function hourGivesWay(hour: number, nowMinutes: number | null): boolean {
  return nowMinutes !== null && Math.abs(nowMinutes - hour * 60) < NEAR;
}
