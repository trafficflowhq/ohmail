/** Reports at the foot, each drawn as its own announcement. */
import { useLayoutEffect } from "react";
import { Report } from "@ohmail/ui/base";
import type { ReportSlotApi, SlotReport } from "./report-slot.js";

export function ReportHost({
  slot,
  hideKeyedUndo = false,
}: {
  slot: Pick<ReportSlotApi, "state" | "gone" | "presented">;
  hideKeyedUndo?: boolean;
}) {
  const { standing, notices } = slot.state;
  const hidden = hideKeyedUndo && standing?.kind === "undo" && Boolean(standing.press?.keyHint);
  const calendarId = standing?.calendarScope === undefined ? undefined : standing.id;
  const expiredId = hidden && standing.leaving ? standing.id : undefined;
  const { gone, presented } = slot;
  useLayoutEffect(() => {
    if (calendarId !== undefined) presented(calendarId);
  }, [calendarId, presented]);
  useLayoutEffect(() => {
    if (expiredId !== undefined) gone(expiredId);
  }, [expiredId, gone]);

  return (
    <>
      {notices.map((notice) => (
        <Dismissible key={notice.id} notice={notice} />
      ))}
      {standing && !hidden ? <Standing key={standing.id} standing={standing} gone={gone} /> : null}
    </>
  );
}

function Dismissible({ notice }: { notice: SlotReport }) {
  const press = notice.press;
  return press ? (
    <Report kind="why" why="" act={{ label: press.label, onPress: press.onPress }}>
      {notice.message}
    </Report>
  ) : null;
}

function Standing({
  standing,
  gone,
}: {
  standing: NonNullable<ReportSlotApi["state"]["standing"]>;
  gone: ReportSlotApi["gone"];
}) {
  if (standing.kind === "why") return <Dismissible notice={standing} />;
  const common = { leaving: standing.leaving, onGone: () => gone(standing.id) };
  const undo =
    standing.kind === "undo" &&
    !standing.dismissed &&
    standing.press &&
    (!standing.leaving || standing.undoDuringFade)
      ? standing.press
      : undefined;
  return (
    <Report
      {...common}
      line={standing.line}
      undo={undo && standing.leaving ? { ...undo, keyHint: undefined } : undo}
    >
      {standing.message}
    </Report>
  );
}
