"use client";

/**
 * WHAT THE WEB HANDS A DOOR'S PAGE: the browser's window, the look the old theme provider stands under, and the
 * catalogue through the doors' text reader. The device is made in the browser only, when the stage asks for it
 * (the window facts read `window`); the look follows the theme provider from then on.
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocale, useMessages, useTimeZone } from "next-intl";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { createFeed, type Appearance, type Feed } from "@ohmail/app/host";
import { browserWindowFacts } from "@ohmail/app/host/browser";
import { DoorStage, type DoorDevice, type DoorRoot } from "@ohmail/app/doors/stage";
import { TextProvider, useTextProvided } from "@ohmail/app/text";

const sameLook = (a: Appearance, b: Appearance): boolean => a.face === b.face && a.scheme === b.scheme;

/** The document's own element: where the boot scripts stamped the first frame's attributes, and the stage goes on. */
function documentRoot(): DoorRoot {
  const root = document.documentElement;
  return {
    read: (name) => root.getAttribute(name),
    write: (name, value) => { if (value === null) root.removeAttribute(name); else root.setAttribute(name, value); },
  };
}

function useWebDoorDevice(): () => DoorDevice {
  const theme = useOptionalTheme();
  const look: Appearance = { face: theme?.face ?? "paper", scheme: theme?.resolved ?? "light" };
  const made = useRef<{ device: DoorDevice; appearance: Feed<Appearance> } | null>(null);
  const first = useRef(look);
  useLayoutEffect(() => { made.current?.appearance.set({ face: look.face, scheme: look.scheme }); }, [look.face, look.scheme]);
  return useCallback((): DoorDevice => {
    if (made.current === null) {
      const appearance = createFeed<Appearance>(first.current, sameLook);
      made.current = { device: { window: browserWindowFacts(window), appearance, root: documentRoot() }, appearance };
    }
    return made.current.device;
  }, []);
}

/**
 * The doors' reader, where the product's locale shell brought none: over the catalogue, language and zone of the
 * intl provider the route stands under (as a test that mounts a route under the intl provider alone has it).
 */
export function DoorText({ children }: { children: ReactNode }): ReactNode {
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

/** A door's page on its stage, as the web serves it. */
export function WebDoor({ children }: { children: ReactNode }): ReactNode {
  const device = useWebDoorDevice();
  return (
    <DoorText>
      <DoorStage device={device}>{children}</DoorStage>
    </DoorText>
  );
}
