import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useCalendarMirror, useSetupPort } from "../calsetup/index.js";
import { useText } from "../text/index.js";

type CalendarCheck = { busy: boolean; run: () => void };

const Check = createContext<CalendarCheck | null>(null);

export function useCalendarCheck() {
  return useContext(Check);
}

export function CalendarCheckScope({ children }: { children: ReactNode }) {
  const mirror = useCalendarMirror();
  const setup = useSetupPort();
  const report = useReport();
  const t = useText("calsettings");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const check = setup === NONE ? NONE : setup.check;
  const connections = mirror?.connections ?? [];
  const value =
    check !== NONE && connections.length
      ? {
          busy,
          run: () => {
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            void Promise.allSettled(connections.map(({ id }) => check(id))).then((results) => {
              pending.current = false;
              setBusy(false);
              if (results.some((result) => result.status === "rejected")) report(t("notChecked"));
            });
          },
        }
      : null;
  return <Check.Provider value={value}>{children}</Check.Provider>;
}
