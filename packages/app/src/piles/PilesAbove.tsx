/**
 * WHAT STANDS ABOVE THE PILES' COLUMNS: the model, made once, for the three piles; the meeting line the reader's
 * column reads (the open letter's visit, its two steps, the blank); and the Reply Run the column draws from.
 * `PilesMeeting` stands a model made elsewhere (the seat's, live over the mail ground); `PilesAbove` makes it from an
 * input handed in.
 */
import { useMemo, type ReactNode } from "react";
import {
  PilesModelContext,
  ReplyRunContext,
  usePiles,
  type PilesInput,
  type PilesModel,
} from "@ohmail/app-logic/piles";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { useText } from "../text/index.js";

export function PilesMeeting({ model, children }: { model: PilesModel; children: ReactNode }) {
  const t = useText(model.pile);
  const tl = useText("later");
  /* The list's own two steps, named by the drawing. */
  const { up, down } = model.walk;
  const blankLabel = model.mayState && model.rows.length === 0 ? t("empty") : null;
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
