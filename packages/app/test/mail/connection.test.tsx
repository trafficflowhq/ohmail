/** @vitest-environment jsdom */
/**
 * THE CONNECTION, FED BY THE MAIL GROUND (`MailConnection`): the ladder's reading of the account's own mailboxes, said in
 * the frame's one slot in the sentences the sync strip always said (`connectionReason`, moved word for word from the web
 * shell; the two are held equal in both languages by `apps/webapp/test/app-logic-twins.test.ts`).
 *
 * Its words lead where they always led: a mailbox's place in Settings by the frame's own address, never a load of the
 * page; and a person with no mailbox connects one on the host's own setup page, left for by the host's own way there.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { FrameHost, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { type ConsentWire, type FirstRunWire, type HostReads } from "../../src/host/index.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };

const MESSAGES = { ...WORDS.en, ...frameEn, ...mailboxesEn } as never;

const stub = (id: "ohbox" | "settings", says: string): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes: { kind: "wide", Wide: () => <p>{says}</p> },
});

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
  organizeConsentedAt: "2026-11-02T00:00:00.000Z",
  initialImportCompletedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});
/** The consent row as the account's server answers it: setup finished, nothing owed. */
const CONSENT = {
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: "2026-11-01T00:00:00.000Z",
  screeningBaselineAt: null,
};
const consentOf = (row: object): ConsentWire => ({ state: async () => row }) as unknown as ConsentWire;

/** The ground's reads answer over a few turns (the mailboxes, then the consent row, then what follows from them). */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

function mount(o: { mailboxes: HostReads["mailboxes"]; firstRun?: FirstRunWire }) {
  const mail = fakeMail([]);
  const engine = { ...mail.engine, storeCoverage: () => ({ state: "unknown" }) } as unknown as OhmailEngine;
  const address = fakeAddress("#/ohbox");
  const made = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: stub("ohbox", "the Ohbox"), settings: stub("settings", "Settings") },
    above: MailGround,
    mailboxes: o.mailboxes,
    wires: { consent: consentOf(CONSENT), ...(o.firstRun ? { firstRun: o.firstRun } : {}) },
    address,
  });
  const host: FrameHost = o.firstRun
    ? { ...made.host, capabilities: { ...made.host.capabilities, firstRunDoor: "cloud" } }
    : made.host;
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  return { address };
}
/** The connection's notice in the slot, found by what it offers. */
const notice = (act: string): HTMLElement | null =>
  screen.queryByRole("button", { name: act })?.closest<HTMLElement>('[role="status"]') ?? null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the connection said by the mail ground", () => {
  it("a mailbox whose sync is blocked is said in the strip's own sentence, and its act leads to Mailboxes by the address", async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const { address } = mount({
      mailboxes: async () => [
        mailbox("mbx-1", { syncBlockedReason: "mailbox_full", syncBlockedSince: since }),
      ],
    });
    await answered();
    const said = notice(frameEn.frame.connection.act.mailboxes);
    expect(said?.textContent, "the frame's own words stood where the strip's sentence belongs").toContain(
      frameEn.sync.blocked_mailbox_full,
    );
    fireEvent.click(within(said!).getByRole("button", { name: frameEn.frame.connection.act.mailboxes }));
    expect(address.read(), "the words were followed by anything but the frame's address").toBe(
      "#/settings/mailboxes",
    );
  });

  it("a person with no mailbox connects one on the host's setup page, left for by the host's own way there", async () => {
    const resume = vi.fn();
    const firstRun = {
      ai: "unset",
      probe: () => new Promise(() => {}),
      connect: () => new Promise(() => {}),
      organize: async () => "stored",
      complete: async () => {},
      probeReason: () => null,
      probeMessage: () => null,
      setupHref: "/join",
      resume,
      oauthPending: () => false,
    } as unknown as FirstRunWire;
    mount({ mailboxes: async () => [], firstRun });
    await answered();
    const connect = frameEn.frame.connection.act.connect;
    expect(notice(connect)?.textContent).toContain(frameEn.frame.connection.noMailbox.title);
    expect(resume, "the setup page was asked for before a press").not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: connect }));
    expect(resume).toHaveBeenCalledOnce();
  });
});
