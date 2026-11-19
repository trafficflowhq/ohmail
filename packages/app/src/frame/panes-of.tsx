/**
 * WHICH PANES A PLACE DRAWS: the list and the reading column, or one wide pane, as the place's registration names
 * them, with the shell's reading column where a place names the reader. Pure: the frame's body calls it once a render
 * with the route's place and hands the answer to the columns.
 */
import { NONE, type None, type ReaderEntry } from "../host/index.js";
import type { ColumnsProps, PaneProps, PlaceEntry } from "./contract.js";
import { boundaryAt, PlaceBoundary } from "./place-boundary.js";

/** The reading column stands over the list while a letter is open, or always where the place holds it. */
export function holdsItsReading(entry: PlaceEntry | null): boolean {
  return entry !== null && entry.panes.kind === "columns" && entry.panes.holds === "always";
}

/** Each pane stands inside the frame's error boundary, keyed to the place. */
export function panesOf(
  entry: PlaceEntry | null,
  pane: PaneProps,
  reading: boolean,
  reader: ReaderEntry | None,
): Pick<ColumnsProps, "list" | "reading" | "wide" | "above"> {
  if (!entry) return { list: null, reading: null, wide: null, above: null };
  const panes = entry.panes;
  const at = boundaryAt(pane.route);
  if (panes.kind === "wide")
    return {
      list: null,
      reading: null,
      wide: (
        <PlaceBoundary key={entry.body} at={at}>
          <panes.Wide {...pane} keysHere />
        </PlaceBoundary>
      ),
      above: null,
    };
  const Reading = panes.Reading;
  /* A place that holds its reading column gives it the keys whatever is open. */
  const holds = panes.holds === "always";
  const readingKeys = holds || pane.route.open !== null;
  return {
    list: (
      <PlaceBoundary key={entry.body} at={at}>
        <panes.List {...pane} keysHere={!holds && pane.route.open === null} />
      </PlaceBoundary>
    ),
    /* A place that names the reader gets the shell's reading column; with none handed, the column stays empty. */
    reading: !reading ? null : Reading !== "reader" ? (
      <PlaceBoundary at={at}>
        <Reading {...pane} keysHere={readingKeys} />
      </PlaceBoundary>
    ) : reader === NONE ? null : (
      <PlaceBoundary at={at}>
        <reader.Reading {...pane} keysHere={readingKeys} />
      </PlaceBoundary>
    ),
    wide: null,
    above: panes.Above ? { Above: panes.Above, body: entry.body } : null,
  };
}
