/** THE ONE REPORT at the foot, drawn with the kit's `Report`. Each report is its own node, so a repeat is said again. */
import { useLayoutEffect } from "react";
import { Report } from "@ohmail/ui/base";
import type { ReportSlotApi } from "./report-slot.js";

export function ReportHost({ slot }: { slot: Pick<ReportSlotApi, "state" | "gone" | "presented"> }) {
  const standing = slot.state.standing;
  const calendarId = standing?.calendarScope === undefined ? undefined : standing.id;
  const { presented } = slot;
  useLayoutEffect(() => {
    if (calendarId !== undefined) presented(calendarId);
  }, [calendarId, presented]);
  if (!standing) return null;
  const common = { leaving: standing.leaving, onGone: () => slot.gone(standing.id) };
  if (standing.kind === "why" && standing.press) {
    const { label, onPress } = standing.press;
    return (
      <Report key={standing.id} {...common} kind="why" why="" act={{ label, onPress }}>
        {standing.message}
      </Report>
    );
  }
  return (
    <Report
      key={standing.id}
      {...common}
      undo={
        standing.kind === "undo" && !standing.leaving && !standing.dismissed && standing.press
          ? standing.press
          : undefined
      }
    >
      {standing.message}
    </Report>
  );
}
