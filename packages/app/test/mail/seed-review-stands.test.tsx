/** @vitest-environment jsdom */
/**
 * THE REVIEW OF WHO THE PERSON WRITES TO TAKES THE STAGE ONLY WITH SOMETHING TO SHOW (R-20261118-4, the first words
 * typed after a cold load). The stage makes the whole app behind it inert, and a browser drops the focus of a box
 * made inert: the person's next words go nowhere. On an account whose sent-mail review is owed, the review read its
 * sent mail on the stage, so every cold load stood the stage for the read, and a read that found nobody to decide
 * about let it go again a moment later: the letter's subject the person had just clicked into had lost the keys.
 * Today's shell drew the review above the view and never took the person's box from them. Offered, the review now
 * reads first and takes the stage with people to decide about, or with its refusal; opened again from Settings it
 * stands while it reads, as the person asked for it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { resetDecisionAskedForTests } from "@ohmail/app-logic/mailboxes/first-run/decision-asked";
import { useSeedOfferHere } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import type { FrameHost, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type ConsentWire, type FirstRunWire, type SeedReviewWire } from "../../src/host/index.js";
import { MailGround, mailStages } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import screener from "../../messages/screener.en.json" with { type: "json" };
import { WORDS as SETUP_WORDS } from "../mailboxes/connect/support.js";
import { fakeMail, WORDS as MAIL_WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

const MESSAGES = { ...MAIL_WORDS.en, ...SETUP_WORDS, ...screener } as never;
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

/** A place where the person writes, and the door Settings offers back to the review. */
function Writing() {
  const offer = useSeedOfferHere();
  return (
    <div>
      <input aria-label="Subject" />
      <p>{offer?.owed ? "the review is owed" : "nothing is owed"}</p>
      <button type="button" onClick={() => offer?.reopen()}>
        Review them
      </button>
    </div>
  );
}
const WRITE: PlaceEntry = { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: Writing } };

const MAILBOX: MailboxFacts = {
  id: "mbx-1",
  address: "mbx-1@lichtgrat.example",
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
  organizeConsentedAt: "2026-11-02T00:00:00.000Z",
  initialImportCompletedAt: null,
};
/** The consent row with the review owed: never confirmed. */
const OWED = {
  seedConfirmedAt: null,
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: null,
  screeningBaselineAt: null,
};
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
const STAGES = mailStages({ firstRun: { factor: NONE, pair: NONE, aiProvider: NONE, calendar: NONE } });

/** The review's wire, each read held until the case answers it. */
function heldReads() {
  const pending: Array<{ answer: (v: unknown) => void; refuse: (e: unknown) => void }> = [];
  const read = vi.fn(() => new Promise<unknown>((answer, refuse) => pending.push({ answer, refuse })));
  const wire = { read, confirm: vi.fn(async () => ({})) } as unknown as SeedReviewWire;
  const last = () => pending[pending.length - 1]!;
  return {
    wire,
    read,
    answer: async (v: unknown) => {
      await act(async () => last().answer(v));
      await answered();
    },
    refuse: async () => {
      await act(async () => last().refuse(Object.assign(new Error("down"), { status: 0 })));
      await answered();
    },
  };
}
const NOBODY = { candidates: [], excluded: [], scannedMessages: 4, truncated: false };
const SOMEONE = {
  candidates: [{ address: "ben@lichtgrat.example", name: "Ben Arnold", messages: 3 }],
  excluded: [],
  scannedMessages: 4,
  truncated: false,
};

function mount(seed: SeedReviewWire) {
  const mail = fakeMail([]);
  const engine = { ...mail.engine, storeCoverage: () => ({ state: "unknown" }) } as unknown as OhmailEngine;
  const made = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: WRITE },
    stages: STAGES,
    above: MailGround,
    mailboxes: async () => [MAILBOX],
    wires: {
      consent: { state: async () => OWED } as unknown as ConsentWire,
      firstRun: VERBS,
      seedReview: seed,
    },
    address: fakeAddress("#/ohbox"),
  });
  const host: FrameHost = {
    ...made.host,
    capabilities: { ...made.host.capabilities, firstRunDoor: "cloud" },
  };
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
}
const stage = () => screen.queryByRole("dialog");
const subject = () => screen.getByRole("textbox", { name: "Subject" });
/** The box the person types into: never made inert under them (a browser drops the focus of an inert box). */
const boxIsLive = () => subject().closest("[inert]") === null;

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

describe("the review takes the stage only with something to show", () => {
  it("while the sent mail is still being read no stage stands, and the box being typed into stays live", async () => {
    const seed = heldReads();
    mount(seed.wire);
    await answered();
    expect(seed.read).toHaveBeenCalledTimes(1);
    subject().focus();
    fireEvent.change(subject(), { target: { value: "Plans for Friday" } });
    expect(stage()).toBeNull();
    expect(boxIsLive()).toBe(true);
    expect(document.activeElement).toBe(subject());
    expect((subject() as HTMLInputElement).value).toBe("Plans for Friday");
  });

  it("a read that finds nobody to decide about never takes the stage, and hands the offer back", async () => {
    const seed = heldReads();
    mount(seed.wire);
    await answered();
    expect(stage()).toBeNull();
    await seed.answer(NOBODY);
    expect(stage()).toBeNull();
    expect(boxIsLive()).toBe(true);
    expect(screen.getByText("nothing is owed")).toBeTruthy();
  });

  it("a read that finds people takes the stage with them", async () => {
    const seed = heldReads();
    mount(seed.wire);
    await answered();
    await seed.answer(SOMEONE);
    expect(stage()).not.toBeNull();
    expect(screen.getByText("Ben Arnold")).toBeTruthy();
  });

  it("a read the server refuses takes the stage with its sentence and its Not now", async () => {
    const seed = heldReads();
    mount(seed.wire);
    await answered();
    await seed.refuse();
    expect(stage()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("opened again from Settings, the stage stands while it reads, and reads again", async () => {
    const seed = heldReads();
    mount(seed.wire);
    await answered();
    await seed.answer(NOBODY);
    expect(stage()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review them" }));
    await answered();
    expect(stage()).not.toBeNull();
    expect(seed.read).toHaveBeenCalledTimes(2);
    await seed.answer(NOBODY);
    expect(stage()).not.toBeNull();
  });
});
