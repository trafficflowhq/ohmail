/**
 * THE PAGE AS DRAWN: the frame over `phoneHost`, under the page's sentences, with the account's one engine and its
 * sync loop above it, as every shell mounts it. Never today's shell and nothing of the web app: the places the phone
 * shows are the ones registered with the frame, and where none is registered yet the frame stands with nothing in it.
 * Native holds its one waiting sentence over the page until the page says it has drawn.
 */
import { useEffect, useMemo, useState } from "react";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { Frame } from "@ohmail/app/frame";
import type { HostContract } from "@ohmail/app/host";
import { fillOver, TextProvider, type Locale, type Messages } from "@ohmail/app/text";
import type { NoticeChoices } from "./engine-package";
import { PhoneNotices } from "./notices";

export interface PhonePageProps {
  readonly host: HostContract;
  readonly locale: Locale;
  /** The page's catalogue in both languages; German is drawn filled over English. */
  readonly catalogue: { readonly en: Messages; readonly de: Messages };
  readonly timeZone: string;
  /** Starts the engine's sync loop, telling each status; answers its stop. */
  readonly sync: (status: (s: SyncStatus) => void) => () => void;
  /** Told once, when the first frame has been drawn. */
  readonly drawn: () => void;
  /** This device's notice choices, read at each settle of the copy. */
  readonly noticeChoices: () => NoticeChoices;
}

export function PhonePage({ host, locale, catalogue, timeZone, sync, drawn, noticeChoices }: PhonePageProps) {
  const [status, setStatus] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  useEffect(() => sync(setStatus), [sync]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => drawn());
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
        <Frame host={host} />
      </EngineContext.Provider>
    </TextProvider>
  );
}
