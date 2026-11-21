import type { ComponentType } from "react";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { ReportHost } from "../../src/frame/ReportHost.js";
import { useReportSlot } from "../../src/frame/report-slot.js";

/** Mount a standalone pane with the same reports it receives in the frame. */
export function WithReport({ view: View }: { view: ComponentType<{ report: ToastFn }> }) {
  const slot = useReportSlot();
  return (
    <>
      <View report={slot.report} />
      <ReportHost slot={slot} />
    </>
  );
}
