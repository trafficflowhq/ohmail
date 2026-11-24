/**
 * PLACE SUGGESTIONS for an event's place field: what a client asks of its server
 * (`POST /calendar/places/suggest`) and what comes back. The server asks a geocoder of its own and
 * shapes every row itself, so no client reads a geocoder's fields. What the person typed travels in
 * the request's body alone, never in an address, and nothing of a question is written down: the
 * server keeps an answer in its memory for a few minutes, for the account that asked it alone.
 */

/** The languages a row may be written in. Absent is the geocoder's own default. */
export type PlaceLanguage = "de" | "en" | "fr";

/** What a client asks. */
export interface PlaceSuggestBody {
  /** What the person typed. Under three characters is answered empty; over 200 is refused (400). */
  text: string;
  lang?: PlaceLanguage;
  /** How many rows, 1 to 8. Absent: 6. */
  limit?: number;
  /**
   * A region to prefer: a latitude and a longitude, which the server rounds to one decimal before
   * any use, so a region and never a position is what it holds. Absent: none.
   */
  near?: { lat: number; lon: number };
  /**
   * The person's own country, two capital letters (`CH`): its rows come after those in a town the
   * person typed and before the others, and no row is left out for its country. The server orders
   * with it and keeps an answer under it, and sends it to no geocoder. Any other shape is refused
   * (400). Absent: no country is preferred.
   */
  home?: string;
}

/**
 * What a row is: a venue or a named place, a street address, a street, a town or district, or
 * anything else.
 */
export type PlaceKind = "venue" | "address" | "street" | "town" | "other";

/**
 * One row, as the field shows it: two lines the server wrote. A venue's name over its street,
 * number, postcode and town; a street and number over postcode and town; a town over its region.
 * No line names a country: `country` is its code, and the client writes the country's name in its
 * own words where it is not the person's own. `second` is empty when nothing is known beyond the
 * first line.
 */
export interface PlaceSuggestion {
  kind: PlaceKind;
  first: string;
  second: string;
  /** The country's two-letter code, upper case, or null when the geocoder named none. */
  country: string | null;
  lat: number;
  lon: number;
}

/**
 * How the question went. `ok`: the rows are the answer (an empty list included). `off`: this
 * server offers no suggestions. `busy`: over a share, the geocoder's or this server's. `down`: the
 * geocoder could not answer now. Every state but `ok` is "no suggestions" to the field.
 */
export type PlaceSuggestState = "ok" | "off" | "busy" | "down";

/** The answer to every well-formed question, at 200. */
export interface PlaceSuggestAnswer {
  state: PlaceSuggestState;
  places: PlaceSuggestion[];
  /**
   * The credit the map data's licence asks to be shown with the rows: `osm`, which the app prints
   * in its own words. Null when no row came from the geocoder.
   */
  credit: "osm" | null;
}
