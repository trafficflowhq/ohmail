"use client";

/**
 * THE ONE ADAPTER'S DOOR: what the three entries mount. Inside the entry's `EngineProvider` it reads the old shell's
 * inputs off the host once per host object, provides them to today's views, and mounts the frame, which owns every
 * part of the chrome. Today's views stand in the frame's wide pane (`TodaysViews`, in `AppShell.tsx`).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Frame } from "@ohmail/app/frame";
import { TextProvider, useTextProvided } from "@ohmail/app/text";
import { useLocale, useMessages, useTimeZone } from "next-intl";
import type { HostContract } from "@ohmail/app/host";
import { ManagedServiceContext } from "@ohmail/app-logic/doors/managed-service";
import { FocusFollows } from "@ohmail/app-logic/keys/focus-follows";
import { KeymapProvider } from "@ohmail/app/keys";
import { todaysInputs, type TodaysInputs, type TodaysNodes } from "./todays-inputs";
import { ZoneCursor } from "@ohmail/app-logic/keys/zone-nav";
import "./today.css";
import "./today-tokens.generated.css";

const Fixed = createContext<TodaysInputs | null>(null);

/** The old shell's inputs the adapter read off the host; only `TodaysViews` reads them. */
export function useTodaysFixed(): TodaysInputs {
  const fixed = useContext(Fixed);
  if (fixed === null) throw new Error("today's views were drawn outside TodaysFrame");
  return fixed;
}

/**
 * The frame's text reader, where the shell brought none: over the catalogue, language and zone of the intl provider
 * today's views stand under. The product's locale shells bring their own (it knows when the catalogue is still on its
 * way); a mount with only the intl provider above, as today's views' own tests have, gets this one.
 */
function TextFromIntl({ children }: { children: ReactNode }): ReactNode {
  const provided = useTextProvided();
  const locale = useLocale();
  const messages = useMessages();
  const timeZone = useTimeZone() ?? "UTC";
  if (provided) return children;
  return (
    <TextProvider locale={locale === "de" ? "de" : "en"} messages={messages as Parameters<typeof TextProvider>[0]["messages"]} timeZone={timeZone}>
      {children}
    </TextProvider>
  );
}

export function TodaysFrame({ host, todays }: { host: HostContract; todays: TodaysNodes }): ReactNode {
  const fixed = useMemo(() => todaysInputs(host, todays), [host, todays]);
  return (
    <ManagedServiceContext.Provider value={fixed.managedService}>
      <Fixed.Provider value={fixed}>
        {/* ONE keydown listener for the whole client: every view under it declares its bindings into one table. */}
        <KeymapProvider>
          <ZoneCursor />
          <FocusFollows />
          <TextFromIntl>
            <Frame host={host} />
          </TextFromIntl>
        </KeymapProvider>
      </Fixed.Provider>
    </ManagedServiceContext.Provider>
  );
}
