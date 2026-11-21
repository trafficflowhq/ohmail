import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import { Empty } from "@ohmail/ui/base";
import { useSetupPort } from "../calsetup/index.js";
import { useSharedCalendarSettings } from "../calsettings/settings-read.js";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";

const EmptyCalendar = createContext(false);

export function CalendarFirstStepScope({ port, children }: { port: CalendarPort; children: ReactNode }) {
  const { host } = useFrame();
  const setup = useSetupPort();
  const said = useSharedCalendarSettings()?.said;
  const heldConnection = useSyncExternalStore(
    port.subscribe,
    () =>
      host.engine.store.entries("calendar_connection").length > 0 ||
      host.engine.store.entries("calendar").length > 0,
    () => false,
  );
  const enabledAt = said?.enabledAt;
  const check =
    typeof enabledAt === "string" && !heldConnection && setup !== NONE ? setup.hasConnections : undefined;
  const [empty, setEmpty] = useState<{ check: NonNullable<typeof check> } | null>(null);
  useEffect(() => {
    if (!check) return;
    let live = true;
    // A mirror still catching up does not prove the account has no connections.
    void check().then(
      (connected) => {
        if (live) setEmpty(connected ? null : { check });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [check]);
  const unconnected =
    !heldConnection && (said?.unconfigured === true || (check !== undefined && check === empty?.check));
  return <EmptyCalendar.Provider value={unconnected}>{children}</EmptyCalendar.Provider>;
}

export function useCalendarFirstStep(): boolean {
  return useContext(EmptyCalendar);
}

export function CalendarFirstStep() {
  const { commands } = useFrame();
  const t = useText("calendar");
  const accounts = useText("calsettings");
  return (
    <section className="cal-body cal-first-step" aria-label={t("landmark")}>
      <Empty
        label={accounts("accounts.none")}
        act={{
          kind: "ink",
          label: t("connect"),
          onPress: () => commands.go({ place: "calsettings", sub: "calaccounts" }),
        }}
      />
    </section>
  );
}
