/** @vitest-environment jsdom */
/**
 * THE RAIL'S FOOT, FED BY THE MAIL GROUND (`MailRail`), and the rail's way to write.
 *
 * The account's line names the person (a mailbox's own name, its address only where it has none) with the count of
 * the account's mailboxes under it, and leads to Settings' Mailboxes; it is withheld where the host hands no Settings.
 * Pull new mail is one press with one flight: a second press while one is out rings nothing. The way to write prints
 * its key while the mail's own `c` is bound, which is where the host hands the place that writes.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { FrameHost, FramePlaces, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type ConsentWire, type HostReads } from "../../src/host/index.js";
import { MailGround, mailSettings, NO_PANE_PARTS } from "../../src/mail/index.js";
import { ListMenu } from "../../src/place-list/ListMenu.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const MESSAGES = { ...WORDS.en, ...frameEn, settings: settingsEn.settings } as never;

const stub = (id: PlaceEntry["id"], says: string): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes: { kind: "wide", Wide: () => <p>{says}</p> },
});

/** One mailbox as the account's mail state reads it, with the name its owner gave it where a case names one. */
const mailbox = (raw: string, displayName: string | null): MailboxFacts => ({
  id: raw,
  address: `${raw}@lichtgrat.example`,
  displayName,
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
});
const consentOf = (row: object): ConsentWire => ({ state: async () => row }) as unknown as ConsentWire;
const CONSENT = {
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  onboardingCompletedAt: "2026-11-01T00:00:00.000Z",
};

/** The ground's reads answer over a few turns. */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => {});
};

/** The engine's ring: counted, and held open until the case lets it answer. */
function ringOf() {
  let answer: () => void = () => undefined;
  const requestPull = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        answer = () => resolve(null);
      }),
  );
  return { requestPull, answer: () => answer() };
}

function mount(o: {
  mailboxes: HostReads["mailboxes"];
  places?: Partial<FramePlaces>;
  ring?: ReturnType<typeof ringOf>;
  /** What the case's host answers beside the fake's own answers. */
  answers?: (host: FrameHost) => FrameHost;
}): { address: FakeAddress } {
  const mail = fakeMail([]);
  const engine = {
    ...mail.engine,
    storeCoverage: () => ({ state: "unknown" }),
    pullAvailable: () => o.ring !== undefined,
    requestPull: o.ring?.requestPull ?? (async () => null),
    syncOnce: async () => undefined,
  } as unknown as OhmailEngine;
  const address = fakeAddress("#/ohbox");
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: o.places ?? { ohbox: stub("ohbox", "the Ohbox"), settings: stub("settings", "Settings") },
    above: MailGround,
    mailboxes: o.mailboxes,
    wires: { consent: consentOf(CONSENT) },
    address,
  });
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={o.answers ? o.answers(host as FrameHost) : (host as FrameHost)} />
    </TextProvider>,
  );
  return { address };
}
const rail = () => within(screen.getByRole("navigation", { name: "Places" }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the rail's foot, fed by the ground", () => {
  it("names the person and the count of their mailboxes, and the line leads to Settings' Mailboxes", async () => {
    const { address } = mount({
      mailboxes: async () => [mailbox("mila", "Mila Brunner"), mailbox("work", null)],
    });
    await answered();
    const line = rail().getByRole("button", { name: /Mila Brunner/ });
    expect(line.textContent).toContain("2 mailboxes");
    expect(line.textContent, "the address was drawn as the person's name").not.toContain(
      "mila@lichtgrat.example",
    );
    fireEvent.click(line);
    expect(address.read()).toBe("#/settings/mailboxes");
  });

  it("names the account's address where no mailbox's facts are known", async () => {
    const { address } = mount({
      mailboxes: async () => [],
      answers: (host) => ({
        ...host,
        session: { ...host.session, account: host.session.scope, accountAddress: "person@example.invalid" },
      }),
    });
    await answered();
    const line = rail().getByRole("button", { name: /person@example\.invalid/ });
    expect(line.textContent).toContain("0 mailboxes");
    fireEvent.click(line);
    expect(address.read()).toBe("#/settings/mailboxes");
  });

  it("withholds the previous account's address when the frame changes owner", async () => {
    mount({
      mailboxes: async () => [],
      answers: (host) => ({
        ...host,
        session: { ...host.session, account: "previous-account", accountAddress: "previous@example.invalid" },
      }),
    });
    await answered();
    expect(rail().queryByText("previous@example.invalid")).toBeNull();
  });

  it("names the address only where the mailbox carries no name", async () => {
    mount({ mailboxes: async () => [mailbox("work", null)] });
    await answered();
    const line = rail().getByRole("button", { name: /work@lichtgrat\.example/ });
    expect(line.textContent).toContain("1 mailbox");
  });

  it("leads to the first section the host's Settings lists where it lists no Mailboxes, never to a section that is not there", async () => {
    /* A browser signed in to somebody's computer: the mail's own Settings, whose only listed section is the
       account's, the sign-out alone. */
    const settings = mailSettings({
      ...NO_PANE_PARTS,
      account: {
        useDoor: () => ({
          who: async () => ({ ok: false, word: "signed_out" }) as const,
          signOut: async () => "left" as const,
          toErase: () => undefined,
          toSignIn: () => undefined,
        }),
        password: NONE,
      },
    });
    if (settings === NONE) throw new Error("the mail's Settings was not made over the account's door");
    const { address } = mount({
      mailboxes: async () => [mailbox("mila", "Mila Brunner")],
      places: { ohbox: stub("ohbox", "the Ohbox"), settings },
      answers: (host) => ({
        ...host,
        capabilities: { ...host.capabilities, account: "signOutOnly" },
        features: { ...host.features, account: { name: "account", render: () => null } },
      }),
    });
    await answered();
    fireEvent.click(rail().getByRole("button", { name: /Mila Brunner/ }));
    expect(address.read(), "the line opened a section this Settings does not list").toBe(
      "#/settings/account",
    );
  });

  it("is withheld where the host hands no Settings: no line that leads nowhere", async () => {
    mount({
      mailboxes: async () => [mailbox("mila", "Mila Brunner")],
      places: { ohbox: stub("ohbox", "the Ohbox") },
    });
    await answered();
    expect(rail().queryByRole("button", { name: /Mila Brunner/ })).toBeNull();
  });

  it("Pull new mail is one press: a second press while the first is out rings nothing", async () => {
    const ring = ringOf();
    const menu = "Ohbox actions";
    mount({
      mailboxes: async () => [mailbox("mila", "Mila Brunner")],
      ring,
      places: {
        ohbox: {
          ...stub("ohbox", "the Ohbox"),
          panes: { kind: "wide", Wide: () => <ListMenu label={menu} mail /> },
        },
      },
    });
    await answered();
    const open = () => {
      fireEvent.click(screen.getByRole("button", { name: menu }));
      return within(screen.getByRole("menu", { name: menu })).getByRole("menuitem");
    };
    const pull = open();
    expect(pull.textContent).toContain(frameEn.sync.pull);
    fireEvent.click(pull);
    const pending = open();
    fireEvent.click(pending);
    await act(async () => {});
    expect(ring.requestPull).toHaveBeenCalledOnce();
    await act(async () => ring.answer());
    await answered();
    const ready = screen.queryByRole("menu", { name: menu });
    fireEvent.click(ready ? within(ready).getByRole("menuitem") : open());
    expect(ring.requestPull, "the flight never ended").toHaveBeenCalledTimes(2);
  });
});

describe("Pull new mail by key", () => {
  it("p pulls new mail, with the button's one flight: a second press while the first is out rings nothing", async () => {
    const ring = ringOf();
    mount({ mailboxes: async () => [mailbox("mila", "Mila Brunner")], ring });
    await answered();
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "p" });
    await act(async () => {});
    expect(ring.requestPull, "p rang once while its first pull was out").toHaveBeenCalledOnce();
    await act(async () => ring.answer());
    await answered();
    fireEvent.keyDown(document.body, { key: "p" });
    await act(async () => {});
    expect(ring.requestPull, "the flight never ended").toHaveBeenCalledTimes(2);
  });
});

describe("the rail's way to write", () => {
  it("prints its key where the host hands the place that writes, and none where it does not", async () => {
    mount({
      mailboxes: async () => [],
      places: { ohbox: stub("ohbox", "the Ohbox"), write: stub("write", "Write") },
    });
    await answered();
    const write = rail().getByRole("button", { name: /Write/ });
    expect(write.getAttribute("aria-keyshortcuts")).toBe("c");
    cleanup();
    mount({ mailboxes: async () => [] });
    await answered();
    expect(rail().getByRole("button", { name: /Write/ }).getAttribute("aria-keyshortcuts")).toBeNull();
  });
});
