/**
 * A QUIT IS WAITING FOR THE UPDATE'S INSTALL, and the window says so until it closes.
 *
 * The shell holds every exit while an install writes the app (the install fence in
 * `src-tauri/src/updater.rs`): an exit in the middle of the write left an AppImage that would not
 * start. The wait is a second or so, and the window stays open for it, so it says why. The update
 * report's `closing` carries it; one sentence per wait, in the toast host's polite live region.
 */
import { useEffect } from "react";
import { useToast } from "@ohmail/ui";

import { DOOR_COPY } from "./door-copy.js";
import { onUpdateState } from "./update.js";

/** Longer than the shell's bound (60 s): the sentence stands until the window goes. */
export const CLOSING_SAID_FOR_MS = 75_000;

/** Says {@link DOOR_COPY.updateClosing} each time a quit starts waiting on an install. */
export function UpdateClosing(): null {
  const toast = useToast();
  useEffect(() => {
    let saying = false;
    let left = false;
    let stop: (() => void) | null = null;
    void onUpdateState((report) => {
      if (report.closing && !saying) toast(DOOR_COPY.updateClosing, { duration: CLOSING_SAID_FOR_MS });
      saying = report.closing;
    }).then((release) => {
      if (left) release();
      else stop = release;
    });
    return () => {
      left = true;
      stop?.();
    };
  }, [toast]);
  return null;
}
