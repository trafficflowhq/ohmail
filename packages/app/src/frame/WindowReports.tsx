import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { ReportHost } from "./ReportHost.js";
import { useReportSlot, type ReportSlotApi } from "./report-slot.js";

interface WindowReportContext {
  slot: ReportSlotApi;
  showFrame: (shown: boolean) => void;
}

const WindowReports = createContext<WindowReportContext | null>(null);

/** Desktop recovery and update feedback can start before the mail frame is available. */
export function FrameReports({ children }: { children: ReactNode }) {
  const slot = useReportSlot(Date.now, true);
  const [frame, showFrame] = useState(false);
  const reports = useMemo(() => ({ slot, showFrame }), [slot]);
  return (
    <WindowReports.Provider value={reports}>
      {children}
      {!frame && (slot.state.standing || slot.state.notices.length > 0) ? (
        <div className="oh-root fr-window-report">
          <ReportHost slot={slot} />
        </div>
      ) : null}
    </WindowReports.Provider>
  );
}

export function useWindowReport(): ToastFn | null {
  return useContext(WindowReports)?.slot.report ?? null;
}

/** Mail reports live only as long as the keyed account frame that issued them. */
export function useFrameReportSlot(): ReportSlotApi {
  const local = useReportSlot();
  const { report: localReport } = local;
  const reports = useContext(WindowReports);
  const windowReport = reports?.slot.report;
  const showFrame = reports?.showFrame;
  const retireScope = reports?.slot.retireScope;
  const scope = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    if (!showFrame || !retireScope) return;
    const mounted = Symbol();
    scope.current = mounted;
    showFrame(true);
    return () => {
      scope.current = null;
      retireScope(mounted);
      showFrame(false);
    };
  }, [showFrame, retireScope]);
  const report = useCallback<ToastFn>(
    (message, options) => {
      if (!windowReport) {
        localReport(message, options);
        return;
      }
      const scoped = scope.current;
      if (!scoped) return;
      windowReport(message, options, scoped);
    },
    [localReport, windowReport],
  );

  return reports ? { ...reports.slot, report } : local;
}
