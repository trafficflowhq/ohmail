/**
 * THE SHELL'S PAGE: the phone's web view runs this, from the app's own files. `boot` comes first: it
 * finds the bridge and installs the words door before any other module can write to storage. Then
 * the page reads the kept words, asks native what it is to be, builds the client engine over the
 * bridge, answers the host contract for its setting and mounts the frame over it.
 */
import { bridge, kept } from "./boot";
import catalogue from "./catalogue";
import mounted from "./mounted";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { calendarPortOf } from "@ohmail/app-logic/calendar";
import { calendarSetupPortOf } from "@ohmail/app-logic/calendar/setup";
import { isCalendarPlace, routeOf } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import { mailboxTotalOf, readSearchBy } from "@ohmail/app-logic/search";
import { startSyncScheduler, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { setComposerScope } from "@ohmail/app-logic/writing/compose";
import { unsentDraftsOf, type NoticePermission } from "./engine-package";
import { benchDoor, type BenchDoor } from "./bench";
import { calendarRecordClearer, calendarRecordSender, followWidget } from "./calendar-record";
import { companionSwitch } from "./companion-switch";
import { isWidgetGeneration } from "../../src/calendar/opened";
import type { LinkInTarget } from "../../src/shell/bridge-kinds";
import { otherAppDoor } from "./other-app";
import { note, type Bridge } from "./bridge";
import { readCalendarDevice } from "./calendar-device";
import { accountFetch } from "./account-fetch";
import { bridgeFetch } from "./bridge-fetch";
import { createPhoneEngine, keptStoreOf } from "./engine";
import { phoneFrameSupplies } from "./frame-supplies";
import { phoneHost } from "./host";
import type { KeptStorage } from "./kept-storage";
import { phoneNoticeEmitter } from "./notice-emitter";
import { storedNoticeChoices } from "./notices";
import { takeOldCopy } from "./old-copy";
import { ownStorage } from "./owner";
import { PhonePage } from "./page";
import { onlineEvents, phoneSignals } from "./signals";
import { Standing } from "./standing";

const element = document.getElementById("root");

async function start(bridge: Bridge, kept: KeptStorage, root: Root): Promise<void> {
  // The native copy of a person's words first, for the scope native names: nothing reads storage before it is the
  // native set. The scope is native's word, never the storage's: every mailbox's page writes the same storage.
  const { words, refused } = await bridge.request("kept", {});
  const config = await bridge.request("config", {});
  await kept.adopt(words, refused, config.scope);
  ownStorage(config.scope);
  // One composer per phone WebView. Its kept words must survive a restart of the WebView process.
  if (config.app === "ohmail") setComposerScope("phone");
  // The phone's old copy of this mailbox, taken once, before the engine reads its own. One that could not be taken
  // stays, unmarked: the next start takes it again, filling only what this one lacks.
  if (config.oldCopy === "present") {
    const store = keptStoreOf(bridge, config.scope);
    try {
      await store.load();
      await takeOldCopy(bridge, config.scope, store, localStorage);
    } catch {
      note(bridge, "copyNotTaken");
    } finally {
      store.close();
    }
  }
  const { engine, store } = createPhoneEngine(config, bridge);
  // The emulator bench's door, in a page built for the bench alone (the build drops this branch otherwise).
  // The other app (the frame's switch takes this port), and the last place it opened this one at: held until a seat
  // that draws the place takes it.
  const other = otherAppDoor(bridge, config);
  let arrived: LinkInTarget | null = null;
  let widget: string | null = null;
  const widgetListeners = new Set<() => void>();
  bridge.on((e) => {
    if (e.type === "linkIn" && e.target.to !== "compose") arrived = e.target;
    if (config.app === "ohcal" && e.type === "calendarWidget" && isWidgetGeneration(e.generation)) {
      widget = e.generation;
      for (const changed of widgetListeners) changed();
    }
  });
  const sendCalendar = calendarRecordSender(bridge);
  const clearCalendar = calendarRecordClearer(bridge);
  if (__OHMAIL_BENCH__) {
    (window as unknown as { __ohmailBench?: BenchDoor }).__ohmailBench =
      benchDoor(engine, store, localStorage, {
        door: other, arrival: () => arrived,
        calendar: async (record) => {
          const publication = crypto.randomUUID();
          const cleared = await clearCalendar(publication);
          return cleared === "kept" ? sendCalendar(record, publication) : cleared;
        },
      });
  }
  let permission: NoticePermission = config.notifications;
  const mountedPlaces = mounted(bridge, config);
  const place = config.app === "ohcal" && (config.place === null || !isCalendarPlace(routeOf(config.place).place))
    ? `#/cal/${readCalendarDevice(config.scope).opensIn}`
    : config.place;
  const frame = phoneFrameSupplies(mountedPlaces, place, (fragment) => void bridge.request("place", { fragment }).catch(() => {}));
  const signals = phoneSignals(bridge, config.facts, () => unsentDraftsOf(engine.read()).length, frame.address);
  const transport = config.app === "ohcal" ? engine.calendarTransport() : null;
  const setup = transport && engine.calendarSetupTransport();
  const calendar = transport ? calendarPortOf({
    engine, transport, clock: { uuid: () => crypto.randomUUID(), now: Date.now },
    mayRun: () => engine.calendarQueueReady(), settings: transport.calendarSettings,
    setSuggestionDismissed: transport.setSuggestionDismissed,
    setup: setup ? calendarSetupPortOf(setup, () => engine.syncOnce(), () => crypto.randomUUID()) : undefined,
    held: () => engine.calendarHeld(), load: (span) => engine.loadCalendar(span),
  }) : undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const widgets = config.app === "ohcal" ? {
    send: sendCalendar,
    clear: clearCalendar,
    take() { const current = widget; widget = null; return current; },
    subscribe(changed: () => void) {
      widgetListeners.add(changed);
      return () => { widgetListeners.delete(changed); };
    },
    open: (generation: string) => !calendar ? Promise.resolve() : followWidget(
      generation,
      async (id) => (await bridge.request("act", { act: "calendar.resolve", generation: id })).widget,
      async () => {
        const started = Date.now();
        await engine.syncOnce();
        if (engine.lastDriveAt() < started) await engine.syncOnce();
      }, store, timeZone, (fragment) => frame.address.write(fragment, "push"),
    ),
  } : undefined;
  const facts = { setting: config.setting, serverName: config.serverName, scope: config.scope, accountId: config.accountId, build: config.build };
  const read = bridgeFetch(bridge, config.scope);
  const host = phoneHost(engine, facts, {
    mailboxWires: mountedPlaces.mailboxWires,
    mailFetch: read,
    accountFetch: config.app === "ohmail" ? accountFetch(bridge, config.scope) : undefined,
    search: {
      by: config.setting === "standalone" ? "people" : () => readSearchBy(read),
      mailboxTotal: async () => {
        const response = await read("/mailboxes?counts=1");
        if (!response.ok) return null;
        const answer = await response.json() as { items?: unknown };
        return Array.isArray(answer?.items) ? mailboxTotalOf(answer.items) : null;
      },
    },
    signOut: async () => { await bridge.request("act", { act: "signOut" }); },
    frame: frame.calendar !== NONE ? {
      ...frame,
      calendar: {
        ...frame.calendar, CompanionSwitch: companionSwitch(other, config.os),
        writeGuests: async (to, subject) => { await bridge.request("act", { act: "calendar.guests", to, subject }); },
      },
    } : frame,
    calendar,
    notifications: {
      permission: () => permission,
      request: async () => {
        const answer = await bridge.request("act", { act: "notifications.request" });
        permission = answer.permission ?? permission;
        return permission;
      },
      // The wake registration is native's. The page says whether its two switches want one (`notices.tsx`).
      syncSubscription: async (wanted) => {
        await bridge.request("act", { act: "wake.want", wanted });
        return null;
      },
      // Native draws; the page hands it the gate's answers, for the kinds native says it draws on this phone.
      emitter: phoneNoticeEmitter(bridge, config.notices),
    },
    signals,
  });
  /* The phone polls: no event stream (wake: null). A wake from native (the app back in front, or a push) drains now. */
  const sync = (status: (s: SyncStatus) => void) =>
    startSyncScheduler(engine, {
      onStatus: status,
      online: onlineEvents(signals.online),
      wake: null,
      pushWakes: (woke) => signals.wake.subscribe(() => woke()),
    });
  root.render(
    <portalRenderer.Provider value={createPortal}>
      <PhonePage
        host={host}
        language={{
          locale: config.language,
          choice: config.languageChoice ?? null,
          async set(choice) {
            const { language } = await bridge.request("act", { act: "language.set", choice });
            if (language === undefined) throw new Error("The phone did not confirm its language");
            return language;
          },
        }}
        catalogue={catalogue}
        timeZone={timeZone}
        sync={sync}
        drawn={() => bridge.request("ready", { place: frame.address.read() }).catch(() => {})}
        noticeChoices={() => storedNoticeChoices(localStorage, config.app === "ohcal", config.scope)}
        widgets={widgets}
      />
    </portalRenderer.Provider>,
  );
}

if (bridge && kept && element) {
  const root = createRoot(element);
  root.render(<Standing />);
  void start(bridge, kept, root);
}
