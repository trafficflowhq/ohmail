/**
 * THE SETUP'S WORLD for the frame's tests: a mirror as far as setup and settings read one, a setup port whose every
 * member is a counted double, and a mount of the whole frame at an address. The real queue over a real mirror is
 * held in app-logic's tests; the app's tests import no value of the client engine.
 */
import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
  CalendarSettingsWire,
} from "@ohmail/app-logic/calendar";
import type { CalendarSetupPort, CalendarWay } from "@ohmail/app-logic/calendar/setup";
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calsetupDe from "../../messages/calsetup.de.json" with { type: "json" };
import calsetupEn from "../../messages/calsetup.en.json" with { type: "json" };
import calsettingsDe from "../../messages/calsettings.de.json" with { type: "json" };
import calsettingsEn from "../../messages/calsettings.en.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };
import { calendar } from "../../src/calendar/entry.js";
import { calSetupStage, SetupPortProvider } from "../../src/calsetup/index.js";
import { Frame } from "../../src/frame/Frame.js";
import type { CalendarEntry, FramePlaces } from "../../src/frame/contract.js";
import { NONE, type None } from "../../src/host/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

export const ZURICH = "Europe/Zurich";
export const UPDATED = "2026-11-01T08:00:00.000Z";

export const WORDS = {
  en: {
    ...FRAME_WORDS.en,
    ...calendarEn,
    ...eventEn,
    ...weekEn,
    ...calsetupEn,
    ...calsettingsEn,
  } as unknown as Messages,
  de: {
    ...FRAME_WORDS.en,
    ...calendarEn,
    ...eventEn,
    ...weekEn,
    ...calsetupDe,
    ...calsettingsDe,
  } as unknown as Messages,
};

export function connectionRecord(over: Partial<CalendarConnectionRecord> = {}): CalendarConnectionRecord {
  return {
    id: "conn-1",
    provider: "caldav",
    label: "Studio account",
    status: "active",
    errorCode: null,
    grantMailboxId: null,
    serverHost: "dav.studio.test",
    consentedAt: UPDATED,
    lastSyncedAt: UPDATED,
    createdAt: UPDATED,
    updatedAt: UPDATED,
    ...over,
  };
}

export function calendarRecord(over: Partial<CalendarRecord> = {}): CalendarRecord {
  return {
    id: "cal-1",
    connectionId: "conn-1",
    name: "Studio",
    color: "#3366cc",
    access: "owner",
    shown: true,
    timeZone: ZURICH,
    window: null,
    defaultAlarms: [],
    lastSyncedAt: null,
    errorCode: null,
    updatedAt: UPDATED,
    ...over,
  };
}

/** A mirror as far as setup and settings read one: the records by kind, a version that moves, who hears it move. */
export function mirror(said: CalendarSettingsWire | null = null) {
  const kinds = new Map<string, Map<string, unknown>>();
  const heard = new Set<() => void>();
  let version = 0;
  const entries = (type: string) => [...(kinds.get(type)?.values() ?? [])].map((entity) => ({ entity }));
  const subscribe = (listener: () => void) => {
    heard.add(listener);
    return () => {
      heard.delete(listener);
    };
  };
  const engine = {
    store: { entries, get: (type: string, id: string) => kinds.get(type)?.get(id) },
    subscribe,
    read: () => ({ version: () => version, list: (kind: string) => [...(kinds.get(kind)?.values() ?? [])] }),
  } as unknown as OhmailEngine;
  const port: CalendarPort = {
    newId: () => "new",
    press: () => new Promise(() => undefined),
    flush: async () => undefined,
    verdict: () => null,
    events: () =>
      entries("calendar_event").map(({ entity }) => ({
        record: entity as CalendarEventRecord,
        waiting: null,
        refusal: null,
        refusedWriteId: null,
      })),
    settings: () => (said === null ? new Promise(() => undefined) : Promise.resolve(said)),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
    version: () => version,
    subscribe,
  };
  const put = (type: string, id: string, entity: unknown) => {
    const kind = kinds.get(type) ?? new Map<string, unknown>();
    kinds.set(type, kind);
    if (entity === null) kind.delete(id);
    else kind.set(id, entity);
    version += 1;
    for (const listener of [...heard]) listener();
  };
  /** Everything the mirror holds, as text: what a probe for a typed value reads. */
  const dump = () => JSON.stringify([...kinds.entries()].map(([k, m]) => [k, [...m.entries()]]));
  return { engine, port, put, dump };
}

/** A setup port: every member a counted double, the ways as handed in. */
export function setupPort(
  ways: () => Promise<readonly CalendarWay[]>,
  over: Partial<CalendarSetupPort> = {},
): CalendarSetupPort {
  return {
    ways: vi.fn(ways),
    connect: vi.fn(async () => ({ kind: "taken" as const })),
    signInAgain: vi.fn(async () => ({ kind: "taken" as const })),
    remove: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    setCalendar: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => ({
      enabledAt: UPDATED,
      secondZone: null,
      weekNumbers: false,
      dayFromMinute: null,
      dayToMinute: null,
      newEventsCalendarId: null,
    })),
    ...over,
  };
}

export interface Mounted {
  readonly address: ReturnType<typeof fakeAddress>;
  readonly unmount: () => void;
}

/** The whole frame at an address, the calendar's entry carrying the setup's stage and the places handed in. */
export function mountFrame(
  at: string,
  world: ReturnType<typeof mirror>,
  setup: CalendarSetupPort | None,
  extra: {
    places?: Partial<FramePlaces>;
    entry?: Partial<CalendarEntry>;
    locale?: "en" | "de";
    timeZone?: string;
    words?: Messages;
    /** The host has no calendar: no entry, no port, no switch. */
    noCalendar?: boolean;
  } = {},
): Mounted {
  const address = fakeAddress(at);
  const made = fakeHost({
    engine: world.engine,
    service: "managed",
    scope: "acct-1",
    calendar: extra.noCalendar ? NONE : { ...calendar, stage: calSetupStage, ...extra.entry },
    products: extra.noCalendar ? undefined : "both",
    wires: { calendar: extra.noCalendar ? NONE : world.port },
    address,
    places: extra.places,
  });
  const locale = extra.locale ?? "en";
  const { unmount } = render(
    <TextProvider
      locale={locale}
      messages={{ ...WORDS[locale], ...extra.words }}
      timeZone={extra.timeZone ?? ZURICH}
    >
      <SetupPortProvider value={setup}>
        <Frame host={made.host} />
      </SetupPortProvider>
    </TextProvider>,
  );
  return { address, unmount };
}

export { NONE };
