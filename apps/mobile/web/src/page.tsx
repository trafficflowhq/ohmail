/**
 * THE PAGE AS DRAWN: the frame over `phoneHost`, under the page's sentences, with the account's one engine and its
 * sync loop above it, as every shell mounts it. Never today's shell and nothing of the web app: the places the phone
 * shows are the ones registered with the frame, and where none is registered yet the frame stands with nothing in it.
 * Native holds its one waiting sentence over the page until the page says it has drawn.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EngineContext, useDerivedVersion, useEngine, useSyncStatus, type EngineBinding } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { useSessionDead } from "@ohmail/app-logic/session/session-truth";
import { Frame } from "@ohmail/app/frame";
import type { HostContract } from "@ohmail/app/host";
import { fillOver, TextProvider, type Locale, type Messages } from "@ohmail/app/text";
import type { NoticeChoices } from "./engine-package";
import { calendarPublisher, snapshotFromMirror, type calendarRecordClearer, type calendarRecordSender } from "./calendar-record";
import { PhoneNotices, storedWidgetChoices } from "./notices";

export interface PhonePageProps {
  readonly host: HostContract;
  readonly locale: Locale;
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
}

export function PhonePage({ host, locale, catalogue, timeZone, sync, drawn, noticeChoices, widgets }: PhonePageProps) {
  const [status, setStatus] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  const [pageReady, setPageReady] = useState(false);
  useEffect(() => sync(setStatus), [sync]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { void Promise.resolve(drawn()).then(() => setPageReady(true)); });
    return () => cancelAnimationFrame(frame);
    // Once per page: a page is one web view instance.
  }, []);
  const messages = useMemo(() => (locale === "de" ? fillOver(catalogue.en, catalogue.de) : catalogue.en), [locale, catalogue]);
  const binding: EngineBinding = useMemo(
    () => ({ engine: host.engine, demo: false, serverDemo: false, sync: status }),
    [host.engine, status],
  );
  return (
    <TextProvider locale={locale} messages={messages} timeZone={timeZone}>
      <EngineContext.Provider value={binding}>
        <PhoneNotices host={host} choices={noticeChoices} />
        {widgets && pageReady && host.session.scope !== null &&
          <PhoneCalendarWidgets scope={host.session.scope} zone={timeZone} widgets={widgets} />}
        <Frame host={host} />
      </EngineContext.Provider>
    </TextProvider>
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
  const version = useDerivedVersion();
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
      void publish(snapshotFromMirror(engine.store, scope, zone, storedWidgetChoices(localStorage)));
    };
    const off = widgets.subscribe(update);
    update();
    const timer = setInterval(update, 60_000);
    return () => { clearInterval(timer); off(); };
  }, [engine, publish, refused, scope, settledOpen, sync.bootstrapping, version, widgets, zone]);
  return null;
}
