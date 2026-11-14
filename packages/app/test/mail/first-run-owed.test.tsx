/** @vitest-environment jsdom */
/**
 * WHAT SAYS THE FIRST RUN IS OWED (`MailBoot` on the mail ground), over the frame and the ground's own reads.
 *
 * THE REVIEW of who the person writes to: while its offer is owed the stage stands at whatever address, the address
 * untouched, and the stage reads the frame's one offer. "Not now" lets the stage go.
 *
 * THE ORGANIZE QUESTION about a mailbox nobody decided about: asked once per launch, by leading the address to the
 * run for that mailbox (a re-run where setup was left before the mailbox arrived), over the mail's real stage. A
 * person who leaves it is not asked again in this launch; a mailbox that was there when setup was left is never
 * asked about; neither is asked on the demo or over a host with no first run.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { EngineContext } from "@ohmail/app-logic/engine";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { resetDecisionAskedForTests } from "@ohmail/app-logic/mailboxes/first-run/decision-asked";
import { useSeedOfferHere } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import type { FrameHost, FrameStages, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import {
  NONE,
  type ConsentWire,
  type FirstRunWire,
  type HostReads,
  type HostWires,
} from "../../src/host/index.js";
import { MailGround, mailStages } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { WORDS as SETUP_WORDS } from "../mailboxes/connect/support.js";
import { fakeMail, WORDS as MAIL_WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

const MESSAGES = { ...MAIL_WORDS.en, ...SETUP_WORDS } as never;
/** The ground's reads answer over a few turns (the mailboxes, then the consent row, then what follows from them). */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

const OHBOX: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>the Ohbox</p> },
};

/** One mailbox as the account's mail state reads it: connected, organized here. */
const mailbox = (raw: string, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: raw,
  address: `${raw}@lichtgrat.example`,
  status: "active",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerChecked: true,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
  ...over,
});
/** A mailbox nobody decided about: read here, its lease read, nobody named, and no agreement stored. */
const undecided = (raw: string): MailboxFacts => mailbox(raw, { organizerRole: "reader" });
/** A mailbox whose owner agreed long ago: nothing is asked about it. */
const DECIDED = mailbox("mbx-9", { organizeConsentedAt: "2026-11-02T00:00:00.000Z" });
/** The consent row as the account's server answers it: the review confirmed, setup never left. */
const CONSENT = {
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: null,
  screeningBaselineAt: null,
};
const consentOf = (row: object): ConsentWire => ({ state: async () => row }) as unknown as ConsentWire;
const VERBS = {
  ai: "unset",
  probe: () => new Promise(() => {}),
  connect: () => new Promise(() => {}),
  organize: vi.fn(async () => "stored"),
  complete: vi.fn(async () => {}),
  setAiEnabled: vi.fn(async () => {}),
  probeReason: () => null,
  probeMessage: () => null,
} as unknown as FirstRunWire;

/** The mail's real stage, made once as a host makes it. */
const REAL = mailStages({ firstRun: { factor: NONE, pair: NONE, aiProvider: NONE, calendar: NONE } });
/** A fixture stage that says what it reads: the run the address names, or the frame's offer of the review. */
function Review({ route }: PaneProps) {
  const offer = useSeedOfferHere();
  if (route.stage !== null) return <p>a run is named</p>;
  if (offer === null || !offer.owed) return <p>the stage stands with nothing owed</p>;
  return (
    <div>
      <p>the review is owed</p>
      <button type="button" onClick={offer.later}>
        Not now
      </button>
    </div>
  );
}
const FIXTURE: FrameStages = { firstRun: { id: "firstRun", Body: Review } };

interface Over {
  readonly at?: string;
  readonly mailboxes: HostReads["mailboxes"];
  readonly consent?: object;
  readonly stages?: Partial<FrameStages>;
  readonly wires?: Partial<HostWires>;
  readonly demo?: boolean;
}
function mount(o: Over) {
  const mail = fakeMail([]);
  /* What the first run asks of an engine beside what the ground does: whether the store holds the whole mailbox. */
  const engine = { ...mail.engine, storeCoverage: () => ({ state: "unknown" }) } as unknown as OhmailEngine;
  const address = fakeAddress(o.at ?? "#/ohbox");
  const made = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: OHBOX },
    stages: o.stages ?? REAL,
    above: MailGround,
    mailboxes: o.mailboxes,
    wires: { consent: consentOf(o.consent ?? CONSENT), firstRun: VERBS, ...o.wires },
    address,
  });
  const host: FrameHost = {
    ...made.host,
    capabilities: { ...made.host.capabilities, firstRunDoor: "cloud" },
  };
  const frame = (
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>
  );
  render(
    o.demo ? (
      <EngineContext.Provider value={{ engine, demo: true, serverDemo: true, sync: SYNC_SETTLED }}>
        {frame}
      </EngineContext.Provider>
    ) : (
      frame
    ),
  );
  return { address };
}
const stage = () => screen.queryByRole("dialog");

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetDecisionAskedForTests();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the review of who the person writes to, owed for the frame's life", () => {
  const OWED = { ...CONSENT, seedConfirmedAt: null };
  /* The review's read finds someone to decide about: offered, the review takes the stage once its read has answered. */
  const SEED = {
    seedReview: {
      read: async () => ({ candidates: [{ address: "ben@lichtgrat.example", messages: 2 }], excluded: [] }),
      confirm: async () => ({}),
    } as never,
  };

  it("takes the stage at whatever address while it is owed, the address untouched, and Not now lets it go", async () => {
    const { address } = mount({
      mailboxes: async () => [DECIDED],
      consent: OWED,
      stages: FIXTURE,
      wires: SEED,
    });
    await answered();
    expect(screen.getByText("the review is owed")).toBeTruthy();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(stage()).toBeNull();
    expect(address.writes).toEqual([]);
  });

  it("is not owed where the account confirmed it, nor over a host with no wire for it, nor before a mailbox", async () => {
    mount({ mailboxes: async () => [DECIDED], consent: CONSENT, stages: FIXTURE, wires: SEED });
    await answered();
    expect(stage()).toBeNull();
    cleanup();
    mount({ mailboxes: async () => [DECIDED], consent: OWED, stages: FIXTURE });
    await answered();
    expect(stage()).toBeNull();
    cleanup();
    mount({ mailboxes: async () => [], consent: OWED, stages: FIXTURE, wires: SEED });
    await answered();
    expect(stage()).toBeNull();
  });

  it("is not owed on the demo", async () => {
    mount({ mailboxes: async () => [DECIDED], consent: OWED, stages: FIXTURE, wires: SEED, demo: true });
    await answered();
    expect(stage()).toBeNull();
  });
});

describe("the organize question, once per launch", () => {
  it("leads to the run for the mailbox nobody decided about, over the mail's real stage, and asks once", async () => {
    const { address } = mount({ mailboxes: async () => [undecided("mbx-1")] });
    await answered();
    expect(address.read()).toBe("#/first-run?mailbox=mbx-1");
    expect(address.writes).toEqual([{ next: "#/first-run?mailbox=mbx-1", how: "push" }]);
    /* The real stage drew its step for that mailbox. */
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    /* The person leaves: this launch has asked. */
    act(() => address.visit("#/ohbox"));
    await answered();
    expect(address.read()).toBe("#/ohbox");
    expect(stage()).toBeNull();
  });

  it("is a re-run where setup was left before the mailbox arrived", async () => {
    const { address } = mount({
      mailboxes: async () => [undecided("mbx-2")],
      consent: { ...CONSENT, onboardingCompletedAt: "2026-10-01T00:00:00.000Z" },
    });
    await answered();
    expect(address.read()).toBe("#/first-run/again?mailbox=mbx-2");
  });

  it("is not asked about a mailbox that was there when setup was left, nor about one that is decided", async () => {
    const left = { ...CONSENT, onboardingCompletedAt: "2026-12-01T00:00:00.000Z" };
    const { address } = mount({ mailboxes: async () => [undecided("mbx-1"), DECIDED], consent: left });
    await answered();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([]);
  });

  it("is not asked on the demo, nor over a host that hands no first run", async () => {
    const demo = mount({ mailboxes: async () => [undecided("mbx-1")], demo: true });
    await answered();
    expect(demo.address.writes).toEqual([]);
    cleanup();
    const bare = mount({ mailboxes: async () => [undecided("mbx-1")], stages: {} });
    await answered();
    expect(bare.address.writes).toEqual([]);
  });
});
