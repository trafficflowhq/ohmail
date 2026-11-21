/**
 * THE SCREENER'S READING COLUMN: its own, never the reader's (a held letter is not read, and the reader's room would
 * run a second press seam beside the model's). It draws the sender the list has open; with nothing open it says how
 * many wait.
 */
import { BlankColumn } from "@ohmail/ui/mail";
import { motionEase, motionMs, motionReduced, motionShape } from "@ohmail/ui/base";
import { junkKey } from "@ohmail/app-logic/screener";
import { useLayoutEffect, useRef } from "react";
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
  const { facts, junk } = useScreenerBeside();
  const above = useScreenerAbove();
  const allDecided = useAllDecided(view);
  const nextSender = useRef<HTMLDivElement>(null);
  const lastDecision = useRef(view?.decisionMotion ?? 0);
  useLayoutEffect(() => {
    const sequence = view?.decisionMotion ?? 0;
    const changed = sequence !== lastDecision.current;
    lastDecision.current = sequence;
    const node = nextSender.current;
    if (!changed || !node || motionReduced(node)) return;
    const duration = motionMs(node, "--d-out");
    if (!duration) return;
    const flight = node.animate(
      [
        { opacity: 0, transform: motionShape(node, "--x-col") },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing: motionEase(node, "--e-out"), fill: "none" },
    );
    return () => flight.cancel();
  }, [view?.decisionMotion]);
  if (junk !== NONE && segmentOf(route.sub) === "spam" && !view?.quarantine) {
    /* The Junk row the list has open; with none (being read, not read, empty) the list says why. */
    const key = above.selected("junk");
    const item = key === null ? undefined : junk.visible.find((i) => junkKey(i) === key);
    return item === undefined ? null : <JunkLetter junk={junk} item={item} />;
  }
  if (view !== null && view.failedOpen !== null && !view.full)
    return <Failed view={view} letter={view.failedOpen} />;
  if (view !== null && view.open !== null && !view.full)
    return (
      <div ref={nextSender} className="sc-next-sender">
        <Sender view={view} />
      </div>
    );
  if (allDecided)
    return (
      <div className="sc-all-decided">
        <AllDecided />
      </div>
    );
  if (!model.queueSettled) return <BlankColumn>{t("place.loading")}</BlankColumn>;
  const count = model.waitingCount;
  if (count === 0 && facts.notOrganizingYet !== null) return null;
  return <BlankColumn hot={count > 0}>{t("metaWaiting", { count })}</BlankColumn>;
}
