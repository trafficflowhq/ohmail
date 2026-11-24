/**
 * WHAT ONLY A LIST PLACE'S SEAT CAN READ, alike for the four beside the reader (History, a tag, a folder, an
 * address): the sentences a letter's verbs say, the zone the reader's clock runs in, a folder in the person's words,
 * the one composer's doors for a letter, the place's tag picker, and what the list's walk says and where the
 * keyboard's zones stand. Each seat hands it to its place's live hook with what is its own; the piles' seat hands
 * the same record.
 */
import { useCallback, useMemo } from "react";
import { cursorPlacementText } from "@ohmail/app-logic/keys";
import type { ListAnswer, PlaceListLiveOwn } from "@ohmail/app-logic/place-list";
import { placeLabelOver, wordsOver } from "@ohmail/app-logic/reader";
import type { EngineMessage } from "@ohmail/wire";
import { useFrame } from "../frame/commands.js";
import { draftFor } from "../reader/actions/use-verbs.js";
import { useText, useTimeZone } from "../text/index.js";

export interface PlaceListOwn extends PlaceListLiveOwn {
  readonly zone: string;
  readonly placeLabel: (folder: string) => string;
}

/**
 * Where the keyboard's zones stand at a list place, as the page finds them: the frame's reading section's scroller,
 * and the row the list marks as its cursor's in the frame's list section.
 */
export const AT = {
  reading: "section.fr-reading .oh-sheet-scroll",
  openRow: "section.fr-list [role=option][data-open]",
} as const;

/** No picker of tags is drawn over a list place yet: the press rests until the part stands. */
const noTagPicker = (): void => undefined;

/**
 * A FOLDER IN THE PERSON's WORDS: its place's word where it is a place's (Ohbox, News), else its last part. One
 * word for one place, wherever a place says where a letter is or where it goes back to.
 */
export function usePlaceLabel(): (folder: string) => string {
  const place = useText("place");
  return useMemo(() => placeLabelOver((view) => (place.has(view) ? place(view) : "")), [place]);
}

export function usePlaceListOwn(): PlaceListOwn {
  const { commands, host } = useFrame();
  const ohbox = useText("ohbox");
  const screening = useText("screening");
  const session = useText("session");
  const tag = useText("tag");
  const words = useMemo(
    () => wordsOver({ ohbox, screening, session, tag }),
    [ohbox, screening, session, tag],
  );
  const placeLabel = usePlaceLabel();
  /* Until the one composer stands on the ground, an answer hands its draft to the place that writes, as the reader
     does where no reply is handed. */
  const answer = useCallback(
    (how: ListAnswer, m: EngineMessage) => commands.write(draftFor(how === "draft" ? "reply" : how, m)),
    [commands],
  );
  /* The walk's keys by the names the Ohbox's own walk has in the key sheet, and the frame's sentence for a cursor
     a first verb key placed. */
  const cursor = useText("cursor");
  const keys = useMemo(
    () => ({
      next: ohbox("keyNext"),
      prev: ohbox("keyPrev"),
      open: ohbox("keyOpen"),
      placed: (label: string) => cursorPlacementText(cursor, label),
    }),
    [ohbox, cursor],
  );
  return {
    words,
    zone: useTimeZone(),
    placeLabel,
    answer,
    pickTags: noTagPicker,
    readerClosed: host.device.address.readerClosed?.() === true,
    keys,
    shortcuts: useText("shortcuts"),
    at: AT,
    rowsSelector: "section.fr-list [role=option][data-id]",
  };
}
