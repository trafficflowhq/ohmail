/**
 * AN ENTERED HIT, TAKEN IN ONE PLACE. Another place opened a letter INTO this one as entered (a hit a person chose:
 * the frame's one-shot, `PlaceLiveArgs.entered`). Once this place lists that letter its row is entered, as a press
 * enters it, and the frame is told the word was taken: each once for a word. A letter the place does not list yet
 * waits; a word the frame withdrew (the address moved on, the place opened another letter) is dropped with it.
 *
 * Every other way in names no letter here: a link, a reload, Back and the place's own walk are previews, and this
 * enters nothing for them.
 *
 * `listed`: whether the place shows that letter now, where its row can be entered. `enter`: what entering a row is
 * at this place (a list's visit, a pile's open, a stream's drive).
 */
import { useEffect, useRef } from "react";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useStableCallback } from "../press/stable-callback.js";

export function useTakeEntered(
  entered: PlaceLiveArgs["entered"],
  listed: (id: string) => boolean,
  enter: (id: string) => void,
): void {
  const { letter, taken } = entered;
  const here = letter !== null && listed(letter);
  const take = useStableCallback((id: string) => {
    enter(id);
    taken();
  });
  /* The word last taken: a frame that is slow to withdraw it, or a row listed again under it, takes nothing twice. */
  const took = useRef<string | null>(null);
  useEffect(() => {
    if (letter === null) {
      took.current = null;
      return;
    }
    if (!here || took.current === letter) return;
    took.current = letter;
    take(letter);
  }, [letter, here, take]);
}
