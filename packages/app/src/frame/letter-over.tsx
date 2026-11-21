/**
 * THE LETTER OVER THE LIST, AND BESIDE IT. Where one column stands, a letter that is open stands over its list
 * (`Columns`): the innermost open thing of the place on screen. Escape closes it by taking the letter out of the
 * address, as the reading column's own way back does, from wherever the keyboard is and before any key of the place
 * under it: a picked set is cleared by the next press. Mounted only while such a letter stands.
 *
 * Where two stand, the letter is BESIDE the list, and Escape closes it after the place's own Escape and the walk back
 * from the letter to its row, as today's shell had them (the switch's point 64, by RULING-JOIN J-1): a press the list
 * holds closes it IN PLACE (`go(…, { replace: true })`), so Back leaves the place, before it would walk on to the
 * rail (the zone walk's seam, `setBesideClose`). No close of its own is drawn.
 *
 * A menu or a dialog over the letter answers its own Escape first: the key registry runs no binding for a press
 * something has taken. Where the keyboard goes when the letter has gone is the list's own rule.
 */
import { useEffect, useRef } from "react";
import { setBesideClose, setReaderSheet, useKeyBindings } from "@ohmail/app-logic/keys";
import { useTextLookup } from "../text/index.js";

export function LetterOverKeys({ close }: { readonly close: () => void }): null {
  const label = useTextLookup()("shortcuts")("escape");
  useKeyBindings([{ chord: "Escape", group: "app", label, inInput: true, run: close }], "overlay");
  /* The letter over the list is the zone walk's sheet while it stands, as today's reader sheet was: ↑ and ↓ scroll it
     from wherever the keyboard was left (a field under it too), never the list hidden under it; a dialog over it keeps
     its own arrows. */
  useEffect(() => {
    setReaderSheet(LETTER_OVER_SHEET);
    return () => setReaderSheet(null);
  }, []);
  return null;
}

/** Where the letter over the list scrolls: the reading column the frame stands over the list, its sheet's scroller. */
const LETTER_OVER_SHEET = ".fr-reading[data-over] [data-reading-scroll]";

/** Mounted while a letter stands open beside its list: Escape from the list closes it (the latest close). */
export function LetterBesideClose({ close }: { readonly close: () => void }): null {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    setBesideClose(() => latest.current());
    return () => setBesideClose(null);
  }, []);
  return null;
}
