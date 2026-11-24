/**
 * THE FIRST RUN AS THE NEW FRAME's STAGE, over a place whose list a case draws (share ohbox-1's helper: the join
 * folds it). The frame mounts its own key registry and focus rule (`Frame.tsx`: `OwnKeys`, `FocusFollows`), so a
 * binding the case's list declares is heard exactly as a seated place's is; the stage is the first run's own
 * (`firstRunStage`, as `mail/stages.ts` hands it), over a ground the case names (`packages/app/test/mailboxes/
 * first-run/stage.test.tsx`'s shape: one mailbox row, nobody waiting) and first-run verbs that count `complete`.
 * `open: false` stands the place alone; `setupAt()` opens setup as its address does.
 */
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { FirstRunAbout, FirstRunGround, FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { FrameHost } from "../../../packages/app/src/frame/contract.js";
import { NONE, type FirstRunWire, type HostCapabilities } from "../../../packages/app/src/host/index.js";
import { firstRunStage } from "../../../packages/app/src/mailboxes/first-run/stage.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import frame from "../../../packages/app/messages/frame.en.json" with { type: "json" };
import screener from "../../../packages/app/messages/screener.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { O, WORDS, factorButtons, id } from "../../../packages/app/test/mailboxes/connect/support.js";

/** The first run's own words (`mailboxes.onboarding`): what a case reads the stage by. */
export const SETUP = O;

/** A mailbox another install organizes (ohmail Cloud): this computer may only read it, and setup asks which. */
export const PEEKED_ROW: FirstRunRow = {
  id: id("mb-1"),
  address: "me@example.invalid",
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
  organizerChecked: true,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
  importOver: false,
} as FirstRunRow;

const ABOUT: FirstRunAbout = {
  queuedSenders: 0,
  pull: { screened: 0, history: 0, pulled: 0, whole: false },
  sender: null,
  queueSettling: false,
  rereadQueue: async () => {},
};
const GROUND: FirstRunGround = {
  rows: [PEEKED_ROW],
  account: { onboardingCompletedAt: null },
  accountOrganizer: null,
  about: () => ABOUT,
  refresh: async () => {},
  drawn: () => {},
};

export interface SetupOverPlace {
  /** How often setup's own ↵ verb opened ohmail (the first-run verbs' `complete`). */
  readonly completed: () => number;
  /** Setup opened by its address, as a button behind it or a link opens it. */
  readonly setupAt: () => Promise<void>;
}

export function mountSetupOverPlace(list: () => ReactNode, opts: { open: boolean }): SetupOverPlace {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  let completed = 0;
  const verbs: FirstRunWire = {
    ai: "unset",
    probe: () => new Promise(() => {}),
    connect: () => new Promise(() => {}),
    organize: async () => "stored",
    complete: async () => {
      completed += 1;
    },
    setAiEnabled: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
  } as unknown as FirstRunWire;
  const seen = { asks: [] as never[] };
  const address = fakeAddress(opts.open ? "#/first-run" : "#/ohbox");
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    address,
    places: {
      ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <>{list()}</> } },
    },
    stages: {
      firstRun: firstRunStage({
        factor: factorButtons(seen),
        pair: NONE,
        aiProvider: NONE,
        calendar: NONE,
        ground: () => GROUND,
      }),
    },
  });
  const capabilities: HostCapabilities = { ...made.host.capabilities, firstRunDoor: "local" };
  const host: FrameHost = {
    ...made.host,
    capabilities,
    wires: { ...made.host.wires, firstRun: verbs, connect: NONE },
  };
  render(
    <TextProvider locale="en" messages={{ ...WORDS, ...frame, ...screener } as never} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  return {
    completed: () => completed,
    setupAt: async () => {
      await act(async () => {
        address.visit("#/first-run");
      });
    },
  };
}
