/**
 * WHAT STANDS ABOVE THE PILES' COLUMNS: the model, made once, for the three piles; the meeting line the reader's
 * column reads (the open letter's visit, its two steps, the blank); and the Reply Run the column draws from.
 * `PilesMeeting` stands a model made elsewhere (the seat's, live over the mail ground); `PilesAbove` makes it from an
 * input handed in.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import {
  PilesModelContext,
  ReplyRunContext,
  usePileCount,
  usePiles,
  type PilesInput,
  type PilesModel,
} from "@ohmail/app-logic/piles";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";

const RunOnArrival = createContext<RefObject<boolean> | null>(null);

/** From another mail place, open Answer Later before asking its own run to start. */
export function ReplyRunShortcut({ children }: { children: ReactNode }) {
  const { route, commands, host, product } = useFrame();
  const pending = useRef(false);
  const count = usePileCount("later");
  const t = useText("triage");
  const later = host.features.places.later;
  const offered =
    product === "mail" && route.place !== "later" && route.stage === null && later != null && later !== NONE;
  useOptionalKeyBindings(
    offered
      ? [
          {
            chord: "f",
            group: "message",
            label: t("keyReplyRun"),
            disabled: !count,
            run: () => {
              pending.current = true;
              commands.go({ place: "later" });
            },
          },
        ]
      : [],
    "global",
  );
  useEffect(() => {
    if (route.place !== "later") pending.current = false;
  }, [route.place, route.sub]);
  return <RunOnArrival.Provider value={pending}>{children}</RunOnArrival.Provider>;
}

export function PilesMeeting({ model, children }: { model: PilesModel; children: ReactNode }) {
  const t = useText(model.pile);
  const tl = useText("later");
  const pending = useContext(RunOnArrival);
  const { start } = model.run;
  useEffect(() => {
    if (model.pile !== "later" || !pending?.current) return;
    // The writing owner first closes any editor from the place we just left.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      pending.current = false;
      start();
    });
    return () => {
      cancelled = true;
    };
  }, [model.pile, pending, start]);
  /* The list's own two steps, named by the drawing. */
  const { up, down } = model.walk;
  // Parked's empty sentence belongs to the list.
  const blankLabel = model.pile !== "parked" && model.mayState && model.rows.length === 0 ? t("empty") : null;
  const { visit } = model;
  const meeting: ListMeeting = useMemo(
    () => ({
      visit:
        visit === null
          ? null
          : {
              ...visit,
              step: {
                up: { ...up, label: tl("step.up") },
                down: { ...down, label: tl("step.down") },
              },
            },
      blank: blankLabel === null ? null : { label: blankLabel, hot: false },
    }),
    [visit, up, down, blankLabel, tl],
  );
  return (
    <PilesModelContext.Provider value={model}>
      <ReplyRunContext.Provider value={model.run.state}>
        <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>
      </ReplyRunContext.Provider>
    </PilesModelContext.Provider>
  );
}

export function PilesAbove({ input, children }: { input: PilesInput; children: ReactNode }) {
  return <PilesMeeting model={usePiles(input)}>{children}</PilesMeeting>;
}
