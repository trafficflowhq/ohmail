/**
 * A SERVER SAID THIS APP IS TOO OLD FOR IT, OR THAT IT IS BEING UPDATED — the window's one listener.
 * The bridge hears the answer where every response comes in (`bridge-fetch.ts`, `onUpdateAnswer`);
 * this tells the one update line (`app/shell/update-answer.ts`) with the verb that asks the updater
 * now: `updatePress`, the shell's own check or restart. The window names no feed, version or file.
 * A 2xx lifts a "being updated" line and nothing else. Mounted by `DesktopGate` for the window's
 * life: a sign-in meets the answer before there is a session. A standalone engine says neither.
 */
import { noticeServerAnswered, noticeUpdateAnswer } from "../../webapp/app/shell/update-answer";
import { onUpdateAnswer } from "./bridge-fetch.js";
import { updatePress } from "./update.js";

export function listenForUpdateAnswers(
  press: () => Promise<void> = updatePress,
  listen: typeof onUpdateAnswer = onUpdateAnswer,
): () => void {
  return listen((heard) => {
    if (heard === "answered") noticeServerAnswered();
    else noticeUpdateAnswer(heard, { verb: "update", act: () => { void press().catch(() => undefined); } });
  });
}
