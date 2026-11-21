import type { RowProps } from "./Row.js";
import { RowPlaceFace } from "./row-place.js";
import { breakable } from "./row-tick.js";

/** A row's subject and preview, or the room held for its place. */
export function RowSecond({ subject, preview, entry, tick, place, id }: RowProps & { id?: string }) {
  return (
    <span className="oh-row-second" id={id} data-place={place ? "" : undefined}>
      {subject === "" ? null : <span className="oh-row-subject">{subject}</span>}
      {preview && subject !== "" ? <> </> : null}
      {preview ? (
        <span className="oh-row-preview">
          {entry && subject ? <i className="oh-row-sep">· </i> : null}
          {tick ? breakable(preview) : preview}
        </span>
      ) : null}
      {place ? <RowPlaceFace place={place} room /> : null}
    </span>
  );
}
