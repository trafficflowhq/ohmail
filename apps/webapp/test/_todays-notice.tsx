/**
 * THE SYNC STRIP'S STATES, SAID WHERE A PERSON READS THEM NOW. The strip (`SyncBar`) left with the old chrome; today's
 * mail state reaches the frame's one notice slot through the adapter's connection feed (`useTodaysConnection`). This
 * mounts the frame with one wide pane that feeds it exactly as today's views do, from `useMailState()` (which the
 * strip's tests stub), so those tests read the same state's sentence in the slot. A test file, not a shell.
 */
import { createElement as h, useState, type ReactNode } from "react";
import { useLocale, useMessages, useTimeZone } from "next-intl";
import { createFeed, NONE } from "@ohmail/app/host";
import { browserWindowFacts, fragmentAddress } from "@ohmail/app/host/browser";
import { Frame, PLACE_IDS, type FramePlaces, type PaneProps } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { useMailState } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { useTodaysConnection } from "../app/shell/todays-reasons";
import { demoHost } from "../app/(product)/demo/host";

function Feeding(_: PaneProps): ReactNode {
  const read = useMailState();
  /* Whose choice to read along is asked: the storage owner the test named, as the strip's own read was. */
  useTodaysConnection(read.state, null, read.freshness.asOf, storageOwner());
  return null;
}

/** The frame, with today's connection fed to its one notice slot. */
export function TodaysNotice(): ReactNode {
  /* The browser's address and window, as every shell hands them; no view is mounted (today's views are not needed). */
  const [host] = useState(() => {
    const feeding = { body: "today", rail: null, panes: { kind: "wide", Wide: Feeding } } as const;
    const places = Object.fromEntries(PLACE_IDS.map((id) => [id, { ...feeding, id }])) as unknown as FramePlaces;
    const frame = {
      places, stages: { firstRun: NONE }, recover: NONE, address: fragmentAddress(window), window: browserWindowFacts(window),
      appearance: createFeed({ face: "paper", scheme: "light" } as const),
    };
    /* A contract that reaches nothing (the demo's): the notice is all this mounts. */
    return demoHost(null as never, frame as never, { service: "self", sendCeiling: "strict" });
  });
  const locale = useLocale() === "de" ? "de" : "en";
  return h(TextProvider, { locale, messages: useMessages() as never, timeZone: useTimeZone() ?? "UTC" } as never, h(Frame, { host }));
}
