/**
 * WHAT STANDS ABOVE THE PILES' COLUMNS: the model, made once, for the three piles; the meeting line the reader's
 * column reads (the open letter's visit, its two steps, the blank); and the Reply Run the column draws from.
 */
import { useMemo, type ReactNode } from "react";
import { PilesModelContext, ReplyRunContext, usePiles, type PilesInput } from "@ohmail/app-logic/piles";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { useText } from "../text/index.js";

export function PilesAbove({ input, children }: { input: PilesInput; children: ReactNode }) {
  const model = usePiles(input);
  const t = useText(input.pile);
  const tl = useText("later");
  const shown = model.rows.find((r) => r.message !== null && r.message.id === model.openId)?.message ?? null;
  const up = model.stepFrom(-1);
  const down = model.stepFrom(1);
  const blankLabel = model.mayState && model.rows.length === 0 ? t("empty") : null;
  const wiring = model.wiring;
  const { act, open } = model;
  const meeting: ListMeeting = useMemo(
    () => ({
      visit:
        shown === null || wiring === null
          ? null
          : {
              openId: shown.id,
              unread: shown.unread,
              wiring,
              readSet: [shown.id],
              act,
              step: {
                up: { disabled: up === null, run: () => up && open(up), label: tl("step.up") },
                down: { disabled: down === null, run: () => down && open(down), label: tl("step.down") },
              },
            },
      blank: blankLabel === null ? null : { label: blankLabel, hot: false },
    }),
    [shown, wiring, up, down, act, open, blankLabel, tl],
  );
  return (
    <PilesModelContext.Provider value={model}>
      <ReplyRunContext.Provider value={model.run.state}>
        <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>
      </ReplyRunContext.Provider>
    </PilesModelContext.Provider>
  );
}
