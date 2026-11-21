/**
 * A QUIT IS WAITING FOR THE UPDATE'S INSTALL, and the window says so until it closes.
 *
 * The shell holds every exit while an install writes the app (the install fence in
 * `src-tauri/src/updater.rs`): an exit in the middle of the write left an AppImage that would not
 * start. The wait is a second or so, and the window stays open for it, so it says why. The update
 * report's `closing` carries it; one sentence per wait, in the window report's polite live region.
 */
import { useEffect } from "react";
import { useWindowReport } from "@ohmail/app/frame";

import { DOOR_COPY } from "./door-copy.js";
import { onUpdateState } from "./update.js";

/** Longer than the shell's bound (60 s): the sentence stands until the window goes. */
export const CLOSING_SAID_FOR_MS = 75_000;

/** Says {@link DOOR_COPY.updateClosing} each time a quit starts waiting on an install. */
export function UpdateClosing(): null {
  const report = useWindowReport();
  useEffect(() => {
    if (!report) return;
    let saying = false;
    let left = false;
    let stop: (() => void) | null = null;
    void onUpdateState((state) => {
      if (state.closing && !saying) report(DOOR_COPY.updateClosing, { duration: CLOSING_SAID_FOR_MS });
      saying = state.closing;
    }).then((release) => {
      if (left) release();
      else stop = release;
    });
    return () => {
      left = true;
      stop?.();
    };
  }, [report]);
  return null;
}
