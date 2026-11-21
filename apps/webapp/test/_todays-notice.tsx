/**
 * THE SYNC STRIP'S STATES, SAID WHERE A PERSON READS THEM NOW. The strip (`SyncBar`) left with the old chrome; the
 * mail state reaches the frame's one notice slot through the mail ground's connection feeder (`MailConnection`). This
 * mounts the frame with one wide pane that stands that very feeder, over `useMailState()` (which the strip's tests
 * stub), so those tests read the same state's sentence in the slot. A test file, not a shell.
 */
import { createElement as h, useState, type ReactNode } from "react";
import { useLocale, useMessages, useTimeZone } from "next-intl";
import { createFeed, NONE, type HostContract } from "@ohmail/app/host";
import { browserWindowFacts, fragmentAddress } from "@ohmail/app/host/browser";
import { Frame, PLACE_IDS, type FramePlaces, type PaneProps } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { SetupHrefContext } from "../../../packages/app/src/mail/ground/boot-setup.js";
import { MailConnection } from "../../../packages/app/src/mail/ground/MailConnection.js";
import { demoHost } from "../app/(product)/demo/host";

/** The ground's own feeder as it stands in the ground; no boot duty stands here, so it knows no setup page. */
function Feeding(_: PaneProps): ReactNode {
  return h(SetupHrefContext.Provider, { value: null }, h(MailConnection));
}

/** The frame, with the connection fed to its one notice slot. */
export function TodaysNotice({ bare = false }: { bare?: boolean }): ReactNode {
  /* The browser's address and window, as every shell hands them; no place of the mail is mounted (none is needed). */
  const [host] = useState<HostContract>(() => {
    const feeding = { body: "today", rail: null, panes: { kind: "wide", Wide: Feeding } } as const;
    const places = Object.fromEntries(PLACE_IDS.map((id) => [id, { ...feeding, id }])) as unknown as FramePlaces;
    const frame = {
      places, stages: { firstRun: NONE }, reader: NONE, above: NONE, overs: { palette: NONE, keys: NONE }, recover: NONE, address: fragmentAddress(window),
      window: browserWindowFacts(window),
      appearance: createFeed({ face: "paper", scheme: "light" } as const),
    };
    /* A contract that reaches nothing (the demo's): the notice is all this mounts. Whose choice to read along is
       asked: the storage owner the test named, as the strip's own read was; where it named none, the demo's own. */
    const quiet = demoHost(null as never, frame as never, { service: "self", sendCeiling: "strict" }, NONE);
    const made: typeof quiet = { ...quiet, features: { ...quiet.features, stageCard: NONE } };
    const owner = storageOwner();
    return {
      ...made,
      ...(bare ? { features: { ...made.features, stageCard: NONE as typeof NONE } } : {}),
      ...(owner === null ? {} : { session: { ...made.session, scope: owner } }),
    };
  });
  const locale = useLocale() === "de" ? "de" : "en";
  return h(TextProvider, { locale, messages: useMessages() as never, timeZone: useTimeZone() ?? "UTC" } as never, h(Frame, { host }));
}
