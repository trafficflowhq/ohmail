import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ownAddressesOf } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../frame/commands.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { NONE } from "../host/index.js";

const CalendarAddresses = createContext<readonly string[] | null>(null);

export function CalendarAddressScope({ children }: { children: ReactNode }) {
  const { host } = useFrame();
  const read = host.capabilities.products === "calendar" ? host.reads.mailboxes : NONE;
  const [known, setKnown] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (read === NONE) return;
    let live = true;
    void read().then(
      (facts) => {
        if (live)
          setKnown(
            ownAddressesOf(
              facts.filter(
                (fact): fact is { address: string; addressIsOwn?: boolean } =>
                  typeof fact === "object" &&
                  fact !== null &&
                  typeof (fact as { address?: unknown }).address === "string",
              ),
            ),
          );
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [read]);
  return <CalendarAddresses.Provider value={known}>{children}</CalendarAddresses.Provider>;
}

export function useCalendarOwnAddresses() {
  const room = useKnownOwnAddresses();
  const calendar = useContext(CalendarAddresses);
  return room ?? calendar;
}
