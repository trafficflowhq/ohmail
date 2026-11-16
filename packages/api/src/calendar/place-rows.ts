/**
 * A GEOCODER'S FEATURES AS THE PLACE FIELD'S ROWS. The answer is Photon's GeoJSON (a
 * FeatureCollection whose features carry `properties` and a point `[lon, lat]`); every row is
 * written here, its kind and its two lines, so that no client ever reads a geocoder's field. No
 * line names a country: a row carries its country's code, and the field writes the name where it
 * is not the person's own. A feature that cannot be read is left out; one with fields missing is
 * written as far as it can be.
 */
import type { PlaceKind, PlaceSuggestion } from "@ohmail/wire";

/** How long one value of a feature may be before it is cut, so that a row stays a row. */
const VALUE_MAX = 120;

/** Photon's kinds of settlement, and the settlements OSM names under `place`. */
const TOWN_TYPES: ReadonlySet<string> = new Set(["city", "district", "locality"]);
const TOWN_PLACES: ReadonlySet<string> = new Set([
  "city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "borough",
]);

/** Where the mail writes a number before its street (`1600 Pennsylvania Avenue`). */
const NUMBER_FIRST: ReadonlySet<string> = new Set(["us", "ca", "gb", "ie", "au", "nz", "fr", "lu"]);
/** Where it writes the town before its postcode (`Washington 20500`). */
const TOWN_FIRST: ReadonlySet<string> = new Set(["us", "ca", "gb", "ie", "au", "nz"]);

/** Every control character, by Unicode's own class of them. */
const CONTROL = /\p{Cc}/gu;
/** The marks that turn a line's direction (embeddings, overrides, isolates): a row reads as its letters. */
const DIRECTION = /[\u202A-\u202E\u2066-\u2069]/g;

/** A feature's value as text: a string, its controls and direction marks out, its spaces folded, cut at the bound. */
function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, " ").replace(DIRECTION, "").replace(/\s+/g, " ").trim().slice(0, VALUE_MAX);
}

/** The non-empty parts, each once, in order, without the one the first line already says. */
function distinct(parts: readonly string[], besides = ""): string[] {
  const seen = new Set<string>([besides.toLowerCase()]);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

function kindOf(p: Record<string, unknown>): PlaceKind {
  const type = text(p.type);
  const osmKey = text(p.osm_key);
  if (type === "street" || (type === "" && osmKey === "highway")) return "street";
  if (TOWN_TYPES.has(type) || (osmKey === "place" && TOWN_PLACES.has(text(p.osm_value)))) return "town";
  if (type === "house" || text(p.housenumber) !== "") return text(p.name) !== "" ? "venue" : "address";
  return "other";
}

/** The two lines of a feature of `kind`: what it is, then where. */
function linesOf(kind: PlaceKind, p: Record<string, unknown>): [string, string] {
  const cc = text(p.countrycode).toLowerCase();
  const name = text(p.name);
  const street = text(p.street);
  const number = text(p.housenumber);
  const city = text(p.city);
  const state = text(p.state);
  const streetLine = street === "" ? "" : number === "" ? street : NUMBER_FIRST.has(cc) ? `${number} ${street}` : `${street} ${number}`;
  const postcode = text(p.postcode);
  const townLine = distinct(TOWN_FIRST.has(cc) ? [city, postcode] : [postcode, city]).join(" ");
  const region = (first: string): string => distinct([city, state], first).join(", ");
  switch (kind) {
    case "venue":
      return [name, streetLine !== "" ? distinct([streetLine, townLine], name).join(", ") : region(name)];
    case "address": {
      const first = streetLine !== "" ? streetLine : name;
      return [first, townLine !== "" ? townLine : region(first)];
    }
    case "street": {
      const first = name !== "" ? name : street;
      return [first, townLine !== "" ? townLine : region(first)];
    }
    case "town":
      return [name, distinct([state], name).join(", ")];
    case "other": {
      const first = name !== "" ? name : streetLine !== "" ? streetLine : city;
      return [first, region(first)];
    }
  }
}

/** A coordinate to six places (a tenth of a metre), or null when it is no place on the globe. */
function coordinate(value: unknown, bound: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > bound) return null;
  return Math.round(value * 1e6) / 1e6;
}

function rowOf(feature: unknown): PlaceSuggestion | null {
  if (typeof feature !== "object" || feature === null) return null;
  const { properties, geometry } = feature as { properties?: unknown; geometry?: unknown };
  if (typeof properties !== "object" || properties === null) return null;
  const point = (geometry as { coordinates?: unknown } | null | undefined)?.coordinates;
  if (!Array.isArray(point) || point.length < 2) return null;
  const lon = coordinate(point[0], 180);
  const lat = coordinate(point[1], 90);
  if (lon === null || lat === null) return null;
  const p = properties as Record<string, unknown>;
  const kind = kindOf(p);
  const [first, second] = linesOf(kind, p);
  if (first === "") return null;
  const code = text(p.countrycode);
  return { kind, first, second, country: /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null, lat, lon };
}

/** A name as it is compared with what was typed: no case, no accents, ä ö ü as a o u however written (Zürich, Zurich and Zuerich are one). */
function folded(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/([aou])e/g, "$1");
}

/** A text's words: split at anything that is not a letter, a mark or a digit. */
function wordsOf(value: string): string[] {
  return value.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w !== "");
}

/** What the person typed, folded: every word of it, and those of three characters or more. */
interface Typed { readonly words: ReadonlySet<string>; readonly long: ReadonlySet<string> }

function typedWords(typed: string): Typed {
  const words = wordsOf(typed);
  return { words: new Set(words.map(folded)), long: new Set(words.filter((w) => w.length >= 3).map(folded)) };
}

/**
 * Is a feature in a town, district, locality or postcode the person typed? A town counts when every
 * one of its folded words of two letters or more was typed ("st. gallen" whole): one word of it never
 * does, so a street named after part of a town's name pulls none of its rows up. A district, a
 * locality or a postcode counts when it was typed as one word of three characters or more. Words are
 * compared with words, one by one: nothing typed is made a pattern.
 */
function inTypedTown(feature: unknown, typed: Typed): boolean {
  if (typed.words.size === 0) return false;
  const p = (feature as { properties: Record<string, unknown> }).properties;
  const town = wordsOf(text(p.city)).map(folded).filter((w) => w.length >= 2);
  if (town.length > 0 && town.every((w) => typed.words.has(w))) return true;
  return [p.district, p.locality, p.postcode].some((v) => {
    const name = folded(text(v));
    return name !== "" && typed.long.has(name);
  });
}

/**
 * The rows of a geocoder's answer, at most `limit`, each written once: two features that read the
 * same in one country (one street in several pieces) are one row. A row in a town, district or
 * postcode the person typed (`typed`, the question's plain text) comes first; then a row in the
 * person's own country (`home`, two capital letters, or null); then the rest. Inside each group the
 * geocoder's order stays, and no row is left out for its country. Anything that is not a
 * collection is no rows.
 */
export function placeRowsOf(answer: unknown, limit: number, typed = "", home: string | null = null): PlaceSuggestion[] {
  const features = (answer as { features?: unknown } | null | undefined)?.features;
  if (!Array.isArray(features)) return [];
  const words = typedWords(typed);
  const inTown: PlaceSuggestion[] = [];
  const atHome: PlaceSuggestion[] = [];
  const rest: PlaceSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    // No later row could come before these.
    if (inTown.length >= limit) break;
    const row = rowOf(f);
    if (row === null) continue;
    // The code is part of the key: the lines name no country, and two countries' towns of one name stay two rows.
    const key = `${row.first}\n${row.second}\n${row.country ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (inTypedTown(f, words) ? inTown : home !== null && row.country === home ? atHome : rest).push(row);
  }
  return [...inTown, ...atHome, ...rest].slice(0, limit);
}
