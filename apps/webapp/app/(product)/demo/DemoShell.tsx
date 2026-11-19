"use client";

/**
 * THE DEMO'S SHELL: invented mail in the frame. The frame lays out by the window, which a server does not know, so
 * the server and the first client render draw the product's empty gate, as the signed-in page's do; the provider and
 * the frame mount after hydration.
 */
import { useMemo, useSyncExternalStore } from "react";
import { NONE, type HostDevice } from "@ohmail/app/host";
import { browserMailParts, MailFrame, useBrowserMail } from "../../shell/browser-mail";
import { EngineProvider, useEngine } from "../../shell/engine";
import { useAppLocale } from "../../shell/LocaleContext";
import { demoHost, type DemoSays } from "./host";

/**
 * What the demo hands of its own: a browser host's reader, and nothing else. The invented world has no door to a second
 * factor and no account to sign out of, so no part of a stage and no section's door.
 */
const DEMO_MAIL_PARTS = browserMailParts({ mailboxes: NONE, account: NONE });

const noSubscription = () => () => {};

/** The demo's frame over the engine it stands on, with the mail ground: every wire, read and feature `none`. */
export function DemoFrame({ says }: { says: DemoSays }) {
  const engine = useEngine();
  const frame = useBrowserMail(NONE, DEMO_MAIL_PARTS);
  /* The language's controls the page wraps around the demo, as the host contract takes them. */
  const controls = useAppLocale();
  const drawnLocale = controls?.locale;
  const adoptLocale = controls?.adoptLocale;
  const language = useMemo(
    (): HostDevice["language"] =>
      drawnLocale === undefined || adoptLocale === undefined ? NONE : { locale: drawnLocale, adoptLocale },
    [drawnLocale, adoptLocale],
  );
  const host = useMemo(() => demoHost(engine, frame, says, language), [engine, frame, says, language]);
  return <MailFrame host={host} />;
}

export function DemoShell({ serverDemo, says }: { serverDemo: boolean; says: DemoSays }) {
  /* The server's snapshot is `false`, and hydration reads it again: both draw the gate, so the markup agrees. The gate
     names the demo (`data-demo`) only where the SERVER decided it, from the prop, never from the address: the one sign
     in the served document that the request was the demo (`?demo=1` reaches this gate through `CloudShell`). */
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  if (!hydrated) return <div className="gate" aria-busy="true" data-demo={serverDemo ? "" : undefined} />;
  return (
    <EngineProvider demo={serverDemo}>
      <DemoFrame says={says} />
    </EngineProvider>
  );
}
