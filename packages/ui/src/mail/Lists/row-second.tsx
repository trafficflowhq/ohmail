import type { RowProps } from "./Row.js";
import { RowPlaceFace } from "./row-place.js";
import { breakable } from "./row-tick.js";

/** A row's subject and preview, or the room held for its place. */
export function RowSecond({
  subject,
  preview,
  squares,
  squaresBelow,
  entry,
  tick,
  place,
  id,
}: RowProps & { id?: string }) {
  const besidePreview = squaresBelow && squares;
  const snippet = preview ? (
    <span className="oh-row-preview">
      {entry && subject ? <i className="oh-row-sep">· </i> : null}
      {tick ? breakable(preview) : preview}
    </span>
  ) : null;
  return (
    <span className="oh-row-second" id={id} data-place={place ? "" : undefined}>
      {subject === "" ? null : <span className="oh-row-subject">{subject}</span>}
      {besidePreview ? (
        <span className="oh-row-thread-preview">
          {squares}
          {snippet}
        </span>
      ) : (
        <>
          {preview && subject !== "" ? <> </> : null}
          {snippet}
        </>
      )}
      {place ? <RowPlaceFace place={place} room /> : null}
    </span>
  );
}
