/** @vitest-environment jsdom */
/**
 * THE FIRST RUN, SEATED ON THE MAIL GROUND. The frame stands over a host that hands `MailGround` above the panes and
 * the mail's stages (`mailStages`), as every browser entry hands them; the stage's facts are what the ground's readers
 * answer (the mail state, the consent row, the presented mirror, the Screener's one model), and nothing is handed in
 * by a test. What the stage asks of the first-run verbs and of the connect form's wire is read off the doubles; what
 * it says is the catalogue's sentence.
 *
 * Held here: nothing is drawn before the account's mailboxes and its consent row have both answered; organizing a
 * mailbox starts once, after the person's yes, for the mailbox the address names and no other; a password goes to the
 * server the person confirmed and nowhere else, and the two consents to go without encryption are asked, never
 * assumed; a refused sign-in says its sentence and keeps nothing; the guided decision is the Screener's own; another
 * account under the same frame meets nothing of the first.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { CONSENT_BOOT_SCOPE } from "@ohmail/app-logic/consent/consent-state";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state";
import {
  decisionAsked,
  resetDecisionAskedForTests,
} from "@ohmail/app-logic/mailboxes/first-run/decision-asked";
import { writeBootCache } from "@ohmail/app-logic/session/boot-cache";
import type { FrameHost, PlaceEntry } from "../../../src/frame/contract.js";
import { Frame } from "../../../src/frame/Frame.js";
import {
  NONE,
  type ConsentWire,
  type FirstRunWire,
  type HostCapabilities,
  type HostReads,
} from "../../../src/host/index.js";
import { MailGround, mailStages, type MailStageParts } from "../../../src/mail/index.js";
import { useFirstRunSeat } from "../../../src/mailboxes/first-run/index.js";
import { TextProvider } from "../../../src/text/index.js";
import screenerEn from "../../../messages/screener.en.json" with { type: "json" };
import searchEn from "../../../messages/search.en.json" with { type: "json" };
import { fakeMail, letter, WORDS as MAIL_WORDS } from "../../reader/support/mail.js";
import { fakeHost } from "../../support/fake-host.js";
import { fakeAddress } from "../../support/fake-window.js";
import {
  M,
  MARKER,
  O,
  P,
  REFUSED_PASSWORD,
  WORDS,
  factorButtons,
  fakeDoor,
  id,
  later,
  noEncryption,
  type Call,
} from "../connect/support.js";

const MESSAGES = { ...MAIL_WORDS.en, ...WORDS } as never;
const settle = (): Promise<void> => act(async () => {});
/** The ground's reads answer over a few turns (the mailboxes, then the consent row, then what follows from them). */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await settle();
};
const words = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const press = (name: string | RegExp): void => {
  const button = screen.queryByRole("button", { name });
  if (button) fireEvent.click(button);
  else {
    fireEvent.click(screen.getByRole("button", { name: O.setupMenu }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
  }
};
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** The stage's page title, or nothing where no stage is drawn. */
const title = (): string | null => screen.queryByRole("heading", { level: 1 })?.textContent ?? null;

const SCOPE = "acct-1";
/** What the app behind the stage ran by a key of its own. */
const ran: string[] = [];
/** The list behind the stage, with its keys bound as a place and their owners bind them: a verb, a place, Write, Search. */
function OhboxList() {
  useKeyBindings(
    [
      { chord: "e", group: "message", label: "Archive", run: () => ran.push("archive") },
      { chord: "g o", group: "navigate", label: "Go to the Ohbox", run: () => ran.push("go") },
      { chord: "c", group: "app", label: "Write", run: () => ran.push("write") },
      { chord: "/", group: "app", label: "Search", run: () => ran.push("search") },
    ],
    "global",
  );
  return <p>the Ohbox</p>;
}
const OHBOX_PANES = { kind: "columns", List: OhboxList, Reading: "reader" } as const;
const OHBOX: PlaceEntry = { id: "ohbox", body: "ohbox", rail: null, panes: OHBOX_PANES };

/** One mailbox as the account's mail state reads it: connected, read here, nobody asked about organizing it yet. */
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
/** The consent row as the account's server answers it: setup never left, nothing stored of the window. */
const CONSENT = {
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: null,
  screeningBaselineAt: null,
};
const consentOf = (answer: (() => Promise<unknown>) | "never"): ConsentWire =>
  ({ state: () => (answer === "never" ? new Promise(() => undefined) : answer()) }) as unknown as ConsentWire;
/**
 * The consent row this device kept at its last live read, for the next boot, as the row writes it: the window's days
 * and the stamp of a stored answer, never the window's scope nor the stamp of setup.
 */
const keptRow = (): void =>
  writeBootCache(CONSENT_BOOT_SCOPE, SCOPE, {
    v: 1,
    seedConfirmedAt: "2026-11-01T00:00:00.000Z",
    dormancyDays: 365,
    screeningBaselineAt: "2026-11-02T00:00:00.000Z",
    foldersEnabledAt: null,
  });

function verbs(over: Partial<FirstRunWire> = {}) {
  return {
    ai: "unset",
    probeMessage: () => null,
    ...over,
    organize: vi.fn<FirstRunWire["organize"]>(over.organize ?? (async () => "stored")),
    complete: vi.fn<FirstRunWire["complete"]>(over.complete ?? (async () => {})),
    setAiEnabled: vi.fn<NonNullable<FirstRunWire["setAiEnabled"]>>(over.setAiEnabled ?? (async () => {})),
  } satisfies FirstRunWire;
}

interface Seated {
  readonly at?: string;
  readonly scope?: string;
  readonly mailboxes: HostReads["mailboxes"];
  readonly consent?: ConsentWire;
  readonly verbs?: FirstRunWire;
  readonly connect?: ReturnType<typeof fakeDoor>["door"];
  readonly letters?: readonly EngineMessage[];
  readonly door?: HostCapabilities["firstRunDoor"];
  /** The list of the place behind the stage, where a case draws its own. */
  readonly list?: () => ReactNode;
}
/** What a host alone hands the first run here: the second factor's dialog as two presses, and nothing else. */
const seen = { asks: [] as Parameters<ReturnType<typeof factorButtons>>[0][] };
const PARTS: MailStageParts = {
  firstRun: { factor: factorButtons(seen), pair: NONE, aiProvider: NONE, calendar: NONE },
};
/** Made once, as a host makes them: the entry is the same for every mount. */
const STAGES = mailStages(PARTS);

function seated(o: Seated) {
  const mail = fakeMail(o.letters ?? []);
  /* What the first run asks of an engine beside what the ground does: whether the store holds the whole mailbox. */
  const engine = { ...mail.engine, storeCoverage: () => ({ state: "unknown" }) } as unknown as OhmailEngine;
  const address = fakeAddress(o.at ?? "#/first-run");
  const hostOf = (scope: string): FrameHost => {
    const made = fakeHost({
      engine,
      service: "self",
      scope,
      places: { ohbox: o.list ? { ...OHBOX, panes: { ...OHBOX_PANES, List: o.list } } : OHBOX },
      stages: STAGES,
      above: MailGround,
      mailboxes: o.mailboxes,
      wires: {
        consent: o.consent ?? consentOf(async () => CONSENT),
        firstRun: o.verbs ?? verbs(),
        connect: o.connect ?? NONE,
      },
      address,
    });
    return {
      ...made.host,
      capabilities: { ...made.host.capabilities, firstRunDoor: o.door ?? "cloud" },
    };
  };
  const frame = (scope: string) => (
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={hostOf(scope)} />
    </TextProvider>
  );
  const view = render(frame(o.scope ?? SCOPE));
  return { mail, address, as: (scope: string) => view.rerender(frame(scope)), unmount: view.unmount };
}

beforeEach(() => {
  seen.asks.length = 0;
  ran.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  resetDecisionAskedForTests();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the first run reads the ground, and draws nothing over a guess", () => {
  it("stands on the mail's own stages: the entry a host is handed is the first run's", () => {
    expect(STAGES.firstRun).not.toBe(NONE);
    expect(mailStages(PARTS).firstRun).not.toBe(NONE);
  });

  it("draws no step while the account's mailboxes are unread", async () => {
    seated({ mailboxes: () => new Promise(() => undefined) });
    await answered();
    expect(title()).toBeNull();
  });

  it("draws no step while the account's consent row has not answered: a resting row is no answer", async () => {
    seated({ mailboxes: async () => [mailbox("mbx-1")], consent: consentOf("never") });
    await answered();
    expect(title()).toBeNull();
  });

  it("draws no step over the device's cached consent row while the live row has not answered: a boot cache is no answer", async () => {
    keptRow();
    seated({ mailboxes: async () => [mailbox("mbx-1")], consent: consentOf("never") });
    await answered();
    expect(title()).toBeNull();
  });

  it("with both answers it opens on the step the account's own rows name: what ohmail will do to this mailbox", async () => {
    const v = verbs();
    seated({ mailboxes: async () => [mailbox("mbx-1")], verbs: v });
    await answered();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    expect(v.organize).not.toHaveBeenCalled();
    /* A step was drawn: this launch has asked the organize decision of the mailbox. */
    expect(decisionAsked(SCOPE)).toBe(true);
  });

  it("a step drawn for one account marks that account's launch alone: another signed in in the same tab is still to be asked", async () => {
    const made = seated({ mailboxes: async () => [mailbox("mbx-1")] });
    await answered();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    const marks = { first: decisionAsked(SCOPE), second: decisionAsked("acct-2") };
    /* The second account signs in under the same frame and is drawn its own step. */
    made.as("acct-2");
    await answered();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    expect({ ...marks, secondOnceDrawn: decisionAsked("acct-2") }).toEqual({
      first: true,
      second: false,
      secondOnceDrawn: true,
    });
  });

  it("an account that left setup and holds an organized mailbox has nothing to walk: the address goes back to the app", async () => {
    const organized = mailbox("mbx-1", {
      organizeConsentedAt: "2026-11-02T00:00:00.000Z",
      initialImportCompletedAt: "2026-11-02T01:00:00.000Z",
    });
    const { address } = seated({
      mailboxes: async () => [organized],
      consent: consentOf(async () => ({ ...CONSENT, onboardingCompletedAt: "2026-11-03T00:00:00.000Z" })),
      verbs: verbs({ ai: "on" }),
    });
    await answered();
    expect(title()).toBeNull();
    expect(address.read()).toBe("#/ohbox");
    /* A run with nothing to draw has asked nothing. */
    expect(decisionAsked(SCOPE)).toBe(false);
  });
});

describe("while setup stands, the app behind it takes no key", () => {
  /** A verb, a place's chord, Write, Search and the frame's own Undo, each pressed where no field has the keys. */
  const behind = (): void => {
    for (const key of ["e", "g", "o", "c", "/", "z"]) fireEvent.keyDown(document.body, { key });
  };
  /* The frame's Undo with nothing to take back says so: its sentence, in the frame's report. */
  const undone = (): boolean =>
    (document.body.textContent ?? "").includes(searchEn.shortcuts.nothingToUndo.replace(/\.$/, ""));

  it("a key the place behind binds runs nothing while a step is on screen, and runs again once setup is closed", async () => {
    const v = verbs();
    seated({ mailboxes: async () => [mailbox("mbx-1")], verbs: v });
    await answered();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    fireEvent.keyDown(document.body, { key: "e" });
    expect(ran).toEqual([]);

    /* Escape asks, and its first verb closes setup: the app behind has its keys again. */
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    press(words(O.cancelConfirm));
    await answered();
    expect(title()).toBeNull();
    expect(v.complete).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(ran).toEqual(["archive"]);
  });

  it("the app's chords run nothing either while a step is on screen (g o, c, /, z), and run again once setup is closed", async () => {
    seated({ mailboxes: async () => [mailbox("mbx-1")] });
    await answered();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    behind();
    await settle();
    const whileSetup = { ran: [...ran], undo: undone(), title: title() };

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    press(words(O.cancelConfirm));
    await answered();
    expect(title()).toBeNull();
    behind();
    await settle();
    expect({ whileSetup, after: { ran: [...ran], undo: undone() } }).toEqual({
      whileSetup: {
        ran: [],
        undo: false,
        title: O.organizeLast.replace("<window></window>", O.windowYear).replace(/\.$/, ""),
      },
      after: { ran: ["archive", "go", "write", "search"], undo: true },
    });
  });
});

describe("organizing a mailbox starts once, after the person's yes", () => {
  it("asks nothing of the first-run verbs on the way to the question, sends one organize for the run's mailbox at Agree, and no second one while it is on its way", async () => {
    const answer = later<string>();
    const v = verbs({ organize: vi.fn(() => answer.promise) as never });
    seated({ mailboxes: async () => [mailbox("mbx-1")], verbs: v });
    await answered();
    await settle();
    expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
    expect(v.organize).not.toHaveBeenCalled();
    expect(v.complete).not.toHaveBeenCalled();

    press(words(O.agree));
    await settle();
    expect(v.organize).toHaveBeenCalledTimes(1);
    expect(v.organize.mock.calls[0]![0]).toBe("mbx-1");
    /* While the press is on its way, ↵ and a second press send nothing. */
    fireEvent.submit(screen.getByRole("button", { name: words(O.agreeing) }).closest("form")!);
    await settle();
    expect(v.organize).toHaveBeenCalledTimes(1);

    await act(async () => answer.resolve("stored"));
    await answered();
    expect(v.organize).toHaveBeenCalledTimes(1);
    expect(title()).toContain(O.aiSay.split("<on>")[0]!.trim());
  });

  it("a refusal that asks for the second factor asks it through the part the host named, and the verified factor sends the same organize once more", async () => {
    const windowClosed = { status: 403, code: "step_up_required", message: "", details: {} };
    const organize = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw windowClosed;
      })
      .mockImplementation(async () => "stored");
    seated({ mailboxes: async () => [mailbox("mbx-1")], verbs: verbs({ organize }) });
    await answered();
    await settle();
    press(words(O.agree));
    await answered();
    expect(organize).toHaveBeenCalledTimes(1);
    expect(seen.asks).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "verify" }));
    await answered();
    expect(organize).toHaveBeenCalledTimes(2);
    expect(organize.mock.calls[1]).toEqual(organize.mock.calls[0]);
  });

  it("is about the mailbox the address names, and writes onto no other", async () => {
    const v = verbs();
    seated({
      at: "#/first-run?mailbox=mbx-2",
      mailboxes: async () => [mailbox("mbx-1"), mailbox("mbx-2")],
      verbs: v,
    });
    await answered();
    await settle();
    press(words(O.agree));
    await answered();
    expect(v.organize.mock.calls.map((call) => call[0])).toEqual(["mbx-2"]);
  });

  it("an address that names no mailbox on an account with several asks which, and organizes none", async () => {
    const v = verbs();
    seated({ mailboxes: async () => [mailbox("mbx-1"), mailbox("mbx-2")], verbs: v });
    await answered();
    expect(title()).toBe(O.chooseTitle);
    expect(v.organize).not.toHaveBeenCalled();
  });

  it("a mailbox the address names that the account does not hold says it is gone: no form, no verb of a mailbox", async () => {
    const v = verbs();
    const door = fakeDoor();
    seated({
      at: "#/first-run/again?mailbox=mbx-9",
      mailboxes: async () => [mailbox("mbx-1")],
      verbs: v,
      connect: door.door,
    });
    await answered();
    expect(title()).toBe(O.vanishedTitle);
    expect(screen.queryByLabelText(O.password)).toBeNull();
    expect(door.calls).toEqual([]);
    expect(v.organize).not.toHaveBeenCalled();
  });
});

describe("a run about another mailbox is a new run: nothing chosen for one stands for another", () => {
  it("a second mailbox's claim question opens with nothing chosen and Continue off, and its own Just read it here organizes nothing", async () => {
    const held = (raw: string): MailboxFacts =>
      mailbox(raw, {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-11-01T09:30:00.000Z" },
        organizerState: "held",
      });
    const v = verbs({ ai: "on" });
    const { address } = seated({ mailboxes: async () => [held("mb-a"), held("mb-b")], verbs: v });
    await answered();
    expect(title()).toBe(O.chooseTitle);
    press(words("mb-a@"));
    await answered();
    expect(title()).toContain(O.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
    /* For A the person chooses to organize it here, and goes no further. */
    fireEvent.click(screen.getByRole("radio", { name: words(O.elsewhereChoiceHere) }));
    await settle();
    /* Back to the choice of mailbox, and B. */
    await act(async () => address.visit("#/first-run"));
    await answered();
    expect(title()).toBe(O.chooseTitle);
    press(words("mb-b@"));
    await answered();
    expect(title()).toContain(O.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
    const asked = {
      chosen: screen.queryAllByRole("radio", { checked: true }).length,
      continueOn: !(screen.getByRole("button", { name: words(O.continue) }) as HTMLButtonElement).disabled,
    };
    /* B's own answer: read it here. */
    fireEvent.click(screen.getByRole("radio", { name: words(O.elsewhereChoiceRead) }));
    await settle();
    press(words(O.continue));
    await answered();
    expect({ ...asked, organized: v.organize.mock.calls.length }).toEqual({
      chosen: 0,
      continueOn: false,
      organized: 0,
    });
  });
});

/** A recorded call of the connect wire with every `pass` taken out. */
const besidesPass = (call: Call): string =>
  JSON.stringify(call.sent, (key, value: unknown) => (key === "pass" ? undefined : value)) ?? "";

describe("a further mailbox's password goes to the server the person confirmed, and nowhere else", () => {
  const ADDRESS = "new@pfeilgrat.example";
  const HOST = "mail-in.home.arpa";
  const HOST_OUT = "mail-out.home.arpa";

  /** The add run's form with an address, a server typed by hand and the password. */
  async function typed(door: ReturnType<typeof fakeDoor>, v: FirstRunWire) {
    const made = seated({
      at: "#/first-run/add",
      mailboxes: async () => [mailbox("mbx-1", { organizeConsentedAt: "2026-11-02T00:00:00.000Z" })],
      verbs: v,
      connect: door.door,
    });
    await answered();
    expect(title().trim()).toBe(O.providerAnother);
    type(O.address, ADDRESS);
    press(words(P.otherShort));
    type(O.imapHost, HOST);
    type(O.smtpHost, HOST_OUT);
    type(O.password, MARKER);
    return made;
  }

  it("nothing leaves before the press; the connect carries the typed server and the password in its `pass` alone; the first-run verbs and the address never hold it", async () => {
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const door = fakeDoor({ connect: [{ ok: true, value: { mailboxId: id("mbx-2"), address: null } }] });
    const v = verbs();
    const { address } = await typed(door, v);
    expect(door.of("connect")).toEqual([]);
    expect(door.of("probe")).toEqual([]);

    press(words(O.connect));
    await answered();
    const connects = door.of("connect");
    expect(connects).toHaveLength(1);
    const sent = connects[0]!.sent as {
      input: { imap: { host: string; pass: string; allowInsecure?: boolean } };
      mode: string;
    };
    expect(sent.mode).toBe("add");
    expect(sent.input.imap.host).toBe(HOST);
    expect(sent.input.imap.pass).toBe(MARKER);
    /* Going without encryption was not asked of the person, so it is not claimed for them. */
    expect(sent.input.imap.allowInsecure).not.toBe(true);
    for (const call of door.calls) expect(besidesPass(call)).not.toContain("MARKER");
    expect(JSON.stringify([v.organize.mock.calls, v.complete.mock.calls])).not.toContain("MARKER");
    expect(address.read()).not.toContain("MARKER");
    expect(sets.mock.calls.filter((call) => JSON.stringify(call).includes("MARKER"))).toEqual([]);
    /* The connect organizes nothing: that is the next step's question. */
    expect(v.organize).not.toHaveBeenCalled();
  });

  it("a server that offers no encryption is not written to until the person ticks its own line: the offer is asked, unticked", async () => {
    const door = fakeDoor({
      connect: [
        noEncryption("imap"),
        noEncryption("imap"),
        { ok: true, value: { mailboxId: id("mbx-2"), address: null } },
      ],
    });
    await typed(door, verbs());
    /* Before the server offered it, no such line is on the page. */
    expect(screen.queryByRole("switch")).toBeNull();
    press(words(O.connect));
    await answered();
    expect(door.of("connect")).toHaveLength(1);
    const line = screen.getByRole("switch", { name: M.insecureConsentLabel });
    expect(line.getAttribute("aria-checked")).toBe("false");
    /* Pressed again with the line unticked: the claim is still not made, for either server. */
    press(words(O.connect));
    await answered();
    for (const call of door.of("connect")) expect(call.sealed).not.toContain("allowInsecure");
    /* Ticked by the person, for that one server: only then is it said for them. */
    fireEvent.click(screen.getByRole("switch", { name: M.insecureConsentLabel }));
    press(words(O.connect));
    await answered();
    const last = door.of("connect").at(-1)!.sent as {
      input: { imap: { allowInsecure?: boolean }; smtp?: { allowInsecure?: boolean } };
    };
    expect(last.input.imap.allowInsecure).toBe(true);
    expect(last.input.smtp?.allowInsecure).not.toBe(true);
  });

  it("a refused sign-in says its sentence at the form, creates no mailbox and stores nothing", async () => {
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const door = fakeDoor({ connect: [REFUSED_PASSWORD] });
    const v = verbs();
    const { address } = await typed(door, v);
    press(words(O.connect));
    await answered();
    expect(door.of("connect")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).not.toBe("");
    expect(title()).toBe(O.mailboxTitle);
    /* Nothing was named as connected, nothing organized, and nothing of the attempt rests in a store. */
    expect(address.read()).toBe("#/first-run/add");
    expect(v.organize).not.toHaveBeenCalled();
    expect(
      sets.mock.calls.filter((call) => /MARKER|pfeilgrat|home\.arpa/.test(JSON.stringify(call))),
    ).toEqual([]);
  });

  it("another account under the same frame meets an empty form: nothing typed for the first stands, and nothing of it was stored", async () => {
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const door = fakeDoor();
    const made = await typed(door, verbs());
    made.as("acct-2");
    await answered();
    const fields = [...document.querySelectorAll<HTMLInputElement>("input")].map((field) => field.value);
    expect(fields.filter((value) => /MARKER|pfeilgrat|home\.arpa/.test(value))).toEqual([]);
    expect(document.documentElement.outerHTML).not.toContain("MARKER");
    /* Nothing typed for the first was sent for it, and nothing is sent for the second by standing there. */
    expect(door.of("connect")).toEqual([]);
    expect(door.of("probe")).toEqual([]);
    expect(door.calls.filter((call) => /MARKER|pfeilgrat|home\.arpa/.test(call.sealed))).toEqual([]);
    expect(
      sets.mock.calls.filter((call) => /MARKER|pfeilgrat|home\.arpa/.test(JSON.stringify(call))),
    ).toEqual([]);
  });
});

describe("the guided decision is the Screener's own", () => {
  it("names the sender at the head of the Screener's queue once the mailbox is read, and one press is one decision through the frame's seam", async () => {
    const organized = mailbox("mb-1", {
      organizeConsentedAt: "2026-11-02T00:00:00.000Z",
      initialImportCompletedAt: "2026-11-02T01:00:00.000Z",
    });
    const { mail, unmount } = seated({
      mailboxes: async () => [organized],
      verbs: verbs({ ai: "on" }),
      letters: [letter("m1"), letter("m2")],
    });
    await answered();
    expect(title()).toContain(O.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
    const stage = within(screen.getByRole("dialog"));
    expect(stage.getByText(/Ben Kiln/)).toBeTruthy();
    expect(mail.mutations).toEqual([]);

    fireEvent.click(
      within(document.querySelector<HTMLElement>(".mbx-run .oh-page-acts")!).getByRole("button", {
        name: words(screenerEn.screener.pileOhbox),
      }),
    );
    await answered();
    expect(title()).toBe(O.noOneWaits.replace(/\.$/, ""));
    /* The decision is committed with the frame, as one taken in the Screener is: once. */
    unmount();
    await settle();
    expect(mail.mutations.filter((m) => JSON.stringify(m).includes("ben@kiln.example"))).toHaveLength(1);
    /* One write: the sender's own rule. No letter of theirs is marked read by it. */
    expect(mail.mutations.map((m) => m.kind)).toEqual(["rule_create"]);
    expect(mail.mutations[0]).toMatchObject({ ruleKind: "sender", match: "ben@kiln.example" });
  });
});

describe("what the run says of the account is what the ground holds of it", () => {
  const organized = (raw: string): MailboxFacts =>
    mailbox(raw, {
      organizeConsentedAt: "2026-11-02T00:00:00.000Z",
      initialImportCompletedAt: "2026-11-02T01:00:00.000Z",
    });

  it("with several mailboxes the guided decision is about a sender who wrote to the run's own mailbox, never the head of another's queue", async () => {
    /* Each mailbox's run names its own sender and not the other's: whichever stands first in the whole queue. */
    for (const [word, own, other] of [
      ["mb-2", /Ada Loom/, /Ben Kiln/],
      ["mb-1", /Ben Kiln/, /Ada Loom/],
    ] as const) {
      const made = seated({
        at: `#/first-run?mailbox=${word}`,
        mailboxes: async () => [organized("mb-1"), organized("mb-2")],
        verbs: verbs({ ai: "on" }),
        letters: [
          letter("m1"),
          letter("m2", { mailboxId: "mb-2", from: { name: "Ada Loom", address: "ada@loom.example" } }),
        ],
      });
      await answered();
      expect(title(), word).toContain(O.decideGoes.split("{name}")[1]!.split("<place>")[0]!.trim());
      const stage = within(screen.getByRole("dialog"));
      expect(stage.getByText(own), word).toBeTruthy();
      expect(stage.queryByText(other), word).toBeNull();
      made.unmount();
      localStorage.clear();
    }
  });

  it("a question about a mailbox the run is not about is refused, never answered with the run's own record", async () => {
    const said: string[] = [];
    /* The seat's facts as a part under the ground reads them, asked about a mailbox the address does not name. */
    function Asks() {
      const ground = useFirstRunSeat();
      if (ground.rows !== null && said.length === 0) {
        try {
          ground.about(id("mb-9"));
          said.push("answered");
        } catch (thrown) {
          said.push(thrown instanceof Error ? thrown.message : String(thrown));
        }
        /* Its own mailbox is answered. */
        said.push(`own: ${ground.about(id("mb-1")).queuedSenders}`);
      }
      return <p>the Ohbox</p>;
    }
    seated({
      at: "#/ohbox",
      mailboxes: async () => [organized("mb-1")],
      list: Asks,
    });
    await answered();
    expect(said).toEqual(["useFirstRunLive: asked about a mailbox the run is not about", "own: 0"]);
  });

  it("a re-run shows the window the account stored, and only where one is stored: a resting window is the year the flow offers", async () => {
    const window = async (consent: object): Promise<{ year: boolean; ninety: boolean }> => {
      const made = seated({
        at: "#/first-run/again",
        mailboxes: async () => [organized("mbx-1")],
        consent: consentOf(async () => ({ ...CONSENT, ...consent })),
      });
      await answered();
      await settle();
      expect(title()).toContain(O.organizeLast.split("<window>")[0]!.trim());
      /* The one rung that stands chosen, by its own name. */
      const chosen = screen.getByRole("heading", { level: 1 }).querySelector(".oh-slot")?.textContent ?? "";
      const read = { year: chosen.startsWith(O.windowYear), ninety: chosen.startsWith(O.win90) };
      made.unmount();
      localStorage.clear();
      return read;
    };
    /* The row rests at sixty days with no answer stored: the nearest rung is not the person's choice. */
    expect(await window({ dormancyDays: 60, screeningBaselineAt: null })).toEqual({
      year: true,
      ninety: false,
    });
    expect(await window({ dormancyDays: 90, screeningBaselineAt: "2026-11-02T00:00:00.000Z" })).toEqual({
      year: false,
      ninety: true,
    });
  });

  it("a re-run over the device's cached consent row waits for the live row: it shows and stores the window the account stored, never one chosen from the cache", async () => {
    keptRow();
    const live = later<unknown>();
    const v = verbs();
    seated({
      at: "#/first-run/again",
      mailboxes: async () => [organized("mbx-1")],
      consent: consentOf(() => live.promise),
      verbs: v,
    });
    /* The account's mailboxes answer first; its live consent row is still on its way. */
    await answered();
    const drawnBeforeTheRow = title();
    await act(async () =>
      live.resolve({
        ...CONSENT,
        dormancyDays: 365,
        screeningBaselineAt: "2026-11-02T00:00:00.000Z",
        screeningScope: "all_time",
        onboardingCompletedAt: "2026-11-03T00:00:00.000Z",
      }),
    );
    await answered();
    await settle();
    const onWindow = title();
    const chosen = screen.getByRole("heading", { level: 1 }).querySelector(".oh-slot")?.textContent ?? "";
    press(words(O.agree));
    await answered();
    const body = v.organize.mock.calls[0]?.[1] as { screening?: unknown } | undefined;
    expect({
      drawnBeforeTheRow,
      onWindow,
      chosenAll: chosen.startsWith(O.windowEverything),
      screening: body?.screening,
    }).toEqual({
      drawnBeforeTheRow: null,
      onWindow: O.organizeAll.replace("<window></window>.", O.windowEverything),
      chosenAll: true,
      screening: { scope: "all_time" },
    });
  });

  it("a mailbox another install organizes is asked about with that holder's day, as a date in the reader's language", async () => {
    const elsewhere = mailbox("mbx-1", {
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-11-01T09:30:00.000Z" },
      organizerState: "held",
    });
    const v = verbs();
    seated({ mailboxes: async () => [elsewhere], verbs: v });
    await answered();
    expect(title()).toContain(O.elsewhereSay.replace("{name}", "").replace(/\.$/, "").trim());
    expect(title()).toBe(O.elsewhereSay.replace("{name}", "ohmail Cloud").replace(/\.$/, ""));
    expect(within(screen.getByRole("dialog")).getByText(/Since Nov 1, 2026/)).toBeTruthy();
    /* The claim question is asked: nothing is taken over by standing there. */
    expect(v.organize).not.toHaveBeenCalled();
  });
});
