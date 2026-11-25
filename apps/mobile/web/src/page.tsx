import { useNoticesVersion } from "@ohmail/app-logic/notices/browser-channels";
import { CalendarDeviceContext } from "@ohmail/app/calsettings";
/**
 * THE PAGE AS DRAWN: the frame over `phoneHost`, under the page's sentences, with the account's one engine and its
 * sync loop above it, as every shell mounts it. Never today's shell and nothing of the web app: the places the phone
 * shows are the ones registered with the frame, and where none is registered yet the frame stands with nothing in it.
 * Native holds its one waiting sentence over the page until the page says it has drawn.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ConsentContext, useConsentRow } from "@ohmail/app-logic/consent";
import { EngineContext, useDerivedVersion, useEngine, useSyncStatus, type EngineBinding } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { useSessionDead } from "@ohmail/app-logic/session/session-truth";
import { localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { applyTextSize, readTextSize } from "@ohmail/app-logic/text/text-size";
import { Frame } from "@ohmail/app/frame";
import { useThemeLook } from "@ohmail/app/mail";
import { NONE, type HostContract } from "@ohmail/app/host";
import type { Messages } from "@ohmail/app/text";
import { Button } from "@ohmail/ui/base";
import { useText } from "@ohmail/app/text";
import { ThemeProvider } from "@ohmail/ui/theme";
import type { NoticeChoices } from "./engine-package";
import { calendarPublisher, snapshotFromMirror, type calendarRecordClearer, type calendarRecordSender } from "./calendar-record";
import { PhoneNotices, storedWidgetChoices } from "./notices";
import { usePhoneCalendarDevice } from "./calendar-device";
import { PhoneLanguage, type PhoneLanguageDoor } from "./phone-language";

const themeStorage = localStorageDoor("theme");
const noAppearanceEvents = () => () => {};

function PhoneFrame({ host, openServers }: { readonly host: HostContract; readonly openServers?: () => Promise<unknown> }) {
  const { face, scheme } = useThemeLook();
  const themedHost = useMemo(() => {
    const look = { face, scheme };
    return {
      ...host,
      device: {
        ...host.device,
        appearance: { read: () => look, subscribe: noAppearanceEvents },
      },
    };
  }, [face, host, scheme]);
  return host.capabilities.products === "calendar" ? (
    <PhoneCalendarFrame host={themedHost} openServers={openServers} />
  ) : <Frame host={themedHost} />;
}

function PhoneCalendarFrame({ host, openServers }: { readonly host: HostContract; readonly openServers?: () => Promise<unknown> }) {
  const t = useText("phoneSettings");
  const servers = useText("servers");
  const derived = useDerivedVersion();
  const consent = useConsentRow({
    engine: host.engine, derived, facts: null, scope: host.session.scope, active: false, transport: NONE,
  });
  const unavailable = useSyncExternalStore(
    (changed) => host.engine.subscribe(changed),
    () => host.engine.calendarServerUnavailable(),
  );
  if (unavailable) {
    return (
      <main>
        <p role="status">{t("calendarServerUnavailable")}</p>
        {openServers && <Button kind="two" size="s" onPress={() => void openServers().catch(() => undefined)}>{servers("title")}</Button>}
      </main>
    );
  }
  return <ConsentContext.Provider value={consent}><Frame host={host} /></ConsentContext.Provider>;
}

export interface PhonePageProps {
  readonly host: HostContract;
  readonly language: PhoneLanguageDoor;
  /** The page's catalogue in both languages; German is drawn filled over English. */
  readonly catalogue: { readonly en: Messages; readonly de: Messages };
  readonly timeZone: string;
  /** Starts the engine's sync loop, telling each status; answers its stop. */
  readonly sync: (status: (s: SyncStatus) => void) => () => void;
  /** Told once, when the first frame has been drawn. */
  readonly drawn: () => void | Promise<unknown>;
  /** This device's notice choices, read at each settle of the copy. */
  readonly noticeChoices: () => NoticeChoices;
  readonly widgets?: WidgetPublisher;
  readonly openServers?: () => Promise<unknown>;
}

export function PhonePage({ host, language, catalogue, timeZone, sync, drawn, noticeChoices, widgets, openServers }: PhonePageProps) {
  const calendarOnly = host.capabilities.products === "calendar";
  const calendarDevice = usePhoneCalendarDevice(calendarOnly ? host.session.scope : null);
  const zone = calendarDevice.settings.zone ?? timeZone;
  const [status, setStatus] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  const [pageReady, setPageReady] = useState(false);
  useEffect(() => sync(setStatus), [sync]);
  useEffect(() => applyTextSize(readTextSize(), document.documentElement), []);
  useEffect(() => {
    const port = host.wires.calendar;
    if (port === NONE) return;
    const stop = port.activate?.();
    let ready = host.engine.calendarQueueReady();
    const off = host.engine.subscribe(() => {
      if (ready || !host.engine.calendarQueueReady()) return;
      ready = true;
      void port.flush();
    });
    return () => { off(); stop?.(); };
  }, [host]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void Promise.resolve(drawn()).then(() => setPageReady(true)); });
    return () => cancelAnimationFrame(frame);
    // Once per page: a page is one web view instance.
  }, []);
  const binding: EngineBinding = useMemo(
    () => ({ engine: host.engine, demo: false, serverDemo: false, sync: status }),
    [host.engine, status],
  );
  return (
    <PhoneLanguage door={language} catalogue={catalogue} timeZone={zone}>
      <CalendarDeviceContext.Provider value={calendarOnly ? calendarDevice : null}>
      <EngineContext.Provider value={binding}>
        <PhoneNotices host={host} choices={noticeChoices} />
        {widgets && pageReady && host.session.scope !== null &&
          <PhoneCalendarWidgets scope={host.session.scope} zone={zone} widgets={widgets} />}
        <ThemeProvider storage={themeStorage} faces stampPaper={host.capabilities.products === "calendar"} deferLinuxFace accountFaceScope={host.session.scope}>
          <PhoneFrame host={host} openServers={openServers} />
        </ThemeProvider>
      </EngineContext.Provider>
      </CalendarDeviceContext.Provider>
    </PhoneLanguage>
  );
}

interface WidgetPublisher {
  send: ReturnType<typeof calendarRecordSender>;
  clear: ReturnType<typeof calendarRecordClearer>;
  take(): string | null;
  subscribe(changed: () => void): () => void;
  open(generation: string): Promise<void>;
}

function PhoneCalendarWidgets({ scope, zone, widgets }: { scope: string; zone: string; widgets: WidgetPublisher }) {
  const engine = useEngine();
  const version = useNoticesVersion(useDerivedVersion());
  const sync = useSyncStatus();
  const dead = useSessionDead();
  const refused = dead || sync.terminal || sync.refused || sync.ownerLost || !!sync.standingDown;
  const publish = useMemo(() => calendarPublisher(widgets.send, widgets.clear), [widgets]);
  const opening = useRef(false);
  const [settledOpen, setSettledOpen] = useState(0);
  useEffect(() => {
    const update = () => {
      if (refused) {
        widgets.take();
        void publish(null);
        return;
      }
      if (sync.bootstrapping || opening.current) return;
      const arrival = widgets.take();
      if (arrival !== null) {
        opening.current = true;
        void widgets.open(arrival).finally(() => {
          opening.current = false;
          setSettledOpen((previous) => previous + 1);
        });
        return;
      }
      void publish(snapshotFromMirror(engine.store, scope, zone, storedWidgetChoices(localStorage, scope)));
    };
    const off = widgets.subscribe(update);
    update();
    const timer = setInterval(update, 60_000);
    return () => { clearInterval(timer); off(); };
  }, [engine, publish, refused, scope, settledOpen, sync.bootstrapping, version, widgets, zone]);
  return null;
}
