/**
 * THE SCREENER'S READING COLUMN: its own, never the reader's (a held letter is not read, and the reader's room would
 * run a second press seam beside the model's). It draws the sender the list has open; with nothing open it says how
 * many wait.
 */
import { BlankColumn } from "@ohmail/ui/mail";
import { junkKey } from "@ohmail/app-logic/screener";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { segmentOf, useListView, useScreener, useScreenerAbove, useScreenerBeside } from "./contract.js";
import { JunkLetter } from "./held/JunkLetter.js";
import { AllDecided, useAllDecided } from "./list/Empty.js";
import { Failed } from "./sender/Failed.js";
import { Sender } from "./sender/Sender.js";

export function ScreenerReading({ route }: PaneProps) {
  const t = useText("screener");
  const model = useScreener();
  const view = useListView();
  const { junk } = useScreenerBeside();
  const above = useScreenerAbove();
  const allDecided = useAllDecided(view);
  if (junk !== NONE && segmentOf(route.sub) === "spam") {
    /* The Junk row the list has open; with none (being read, not read, empty) the list says why. */
    const key = above.selected("junk");
    const item = key === null ? undefined : junk.visible.find((i) => junkKey(i) === key);
    return item === undefined ? null : <JunkLetter junk={junk} item={item} />;
  }
  if (view !== null && view.failedOpen !== null && !view.full)
    return <Failed view={view} letter={view.failedOpen} />;
  if (view !== null && view.open !== null && !view.full) return <Sender view={view} />;
  if (allDecided)
    return (
      <div className="sc-all-decided">
        <AllDecided />
      </div>
    );
  if (!model.queueSettled) return <BlankColumn>{t("place.loading")}</BlankColumn>;
  const count = model.waitingCount;
  return <BlankColumn hot={count > 0}>{t("metaWaiting", { count })}</BlankColumn>;
}
