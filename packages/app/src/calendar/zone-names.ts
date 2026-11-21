import { readerZones } from "@ohmail/app-logic/calendar";

/** The zones the platform names and this device can place a time in, read once. */
let known: readonly string[] | null = null;
export function knownZones(): readonly string[] {
  if (known) return known;
  const zones = readerZones();
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  known = listed.filter((z) => zones.offsetAt(z, Date.now()) !== null);
  return known;
}
export const zoneName = (zone: string) => zone.replaceAll("_", " ");

export function zoneForCity(city: string): string | undefined {
  const word = city.toLowerCase();
  if (word === "lissabon") return "Europe/Lisbon";
  if (word === "zürich") return "Europe/Zurich";
  if (word === "gmt" || word === "utc") return "UTC";
  return knownZones().find((zone) => zoneName(zone).split("/").at(-1)?.toLowerCase() === word);
}
