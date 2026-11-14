"use client";

/**
 * THE DEMO'S SHELL: invented mail in the frame. The frame lays out by the window, which a server does not know, so
 * the server and the first client render draw the product's empty gate, as the signed-in page's do; the provider and
 * the frame mount after hydration.
 */
import { useMemo, useSyncExternalStore } from "react";
import { NONE } from "@ohmail/app/host";
import { EngineProvider, useEngine } from "../../shell/engine";
import { TodaysFrame } from "../../shell/TodaysFrame";
import { NO_TODAYS } from "../../shell/todays-inputs";
import { useTodaysSupplies } from "../../shell/todays-supplies";
import { demoHost, type DemoSays } from "./host";

const noSubscription = () => () => {};

/** The demo's frame over the engine it stands on: every wire, read and feature `none`. */
export function DemoFrame({ says }: { says: DemoSays }) {
  const engine = useEngine();
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(() => demoHost(engine, frame, says), [engine, frame, says]);
  return <TodaysFrame host={host} todays={NO_TODAYS} />;
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
