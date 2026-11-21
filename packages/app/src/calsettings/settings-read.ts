import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CalendarPort, CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import type { CalendarSettingsBody, CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";

const still = () => () => undefined;
const zero = () => 0;

type SettingsChange = CalendarSettingsBody | ((current: CalendarSettingsWire) => CalendarSettingsBody | null);
type SettingsSnapshot = { port: CalendarPort; said: CalendarSettingsWire };

export interface SettingsRead {
  readonly said: CalendarSettingsWire | null;
  readonly save: ((change: SettingsChange) => Promise<boolean>) | "none";
}

const SettingsContext = createContext<SettingsRead | null>(null);

function useObservedCalendarSettings(
  port: CalendarPort | null,
  setup: CalendarSetupPort | "none",
): SettingsRead {
  const version = useSyncExternalStore(
    port?.subscribe ?? still,
    port?.version ?? zero,
    port?.version ?? zero,
  );
  const [reading, setReading] = useState<SettingsSnapshot | null>(null);
  const snapshot = useRef<SettingsSnapshot | null>(null);
  const publish = useCallback((next: SettingsSnapshot) => {
    snapshot.current = next;
    setReading(next);
  }, []);
  const revision = useRef(0);
  const door = setup === "none" ? "none" : setup.saveSettings;
  const latest = useRef<{ port: CalendarPort; door: typeof door } | null>(null);
  const queues = useRef(new WeakMap<CalendarPort, Promise<boolean>>());
  useLayoutEffect(() => {
    latest.current = port === null ? null : { port, door };
    return () => {
      latest.current = null;
    };
  }, [port, door]);

  useEffect(() => {
    if (port === null) return;
    const started = ++revision.current;
    let live = true;
    port.settings().then(
      (said) => {
        if (live && started === revision.current && latest.current?.port === port) publish({ port, said });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port, publish, version]);

  const save = useCallback(
    async (change: SettingsChange) => {
      const owner = latest.current;
      if (port === null || door === "none" || owner?.port !== port || owner.door !== door) return false;
      const prior = queues.current.get(port) ?? Promise.resolve();
      const pending = prior.then(async () => {
        if (latest.current !== owner) return false;
        try {
          // Paired values are resolved when their turn comes, against the last accepted snapshot.
          let body: CalendarSettingsBody | null;
          if (typeof change === "function") {
            const current = snapshot.current;
            if (current?.port !== port) return false;
            body = change(current.said);
          } else {
            body = change;
          }
          if (body === null) return false;
          const said = await door(body);
          if (latest.current !== owner) return false;
          revision.current += 1;
          publish({ port, said });
          return true;
        } catch {
          return false;
        }
      });
      queues.current.set(port, pending);
      return pending;
    },
    [door, port, publish],
  );

  return { said: reading?.port === port ? reading.said : null, save: door === "none" ? "none" : save };
}

export function CalendarSettingsScope({
  port,
  setup,
  children,
}: {
  port: CalendarPort;
  setup: CalendarSetupPort | "none";
  children: ReactNode;
}) {
  const reading = useObservedCalendarSettings(port, setup);
  return createElement(SettingsContext.Provider, { value: reading }, children);
}

/** All mounted surfaces share the account's reading and use the server's answer to a change. */
export function useCalendarSettings(
  port: CalendarPort | null,
  setup: CalendarSetupPort | "none",
): SettingsRead {
  const shared = useContext(SettingsContext);
  const local = useObservedCalendarSettings(shared ? null : port, shared ? "none" : setup);
  return shared ?? local;
}

export function useCalendarSwitchOffered(): boolean {
  const said = useContext(SettingsContext)?.said;
  return said?.enabledAt !== null || said.unconfigured === true;
}

export function useSharedCalendarSettings(): SettingsRead | null {
  return useContext(SettingsContext);
}
