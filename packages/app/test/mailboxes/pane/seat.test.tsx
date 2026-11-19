/** @vitest-environment jsdom */
/**
 * SETTINGS' MAILBOXES SECTION, SEATED ON THE MAIL GROUND. The frame stands over a host that hands `MailGround` above
 * the panes, the mail's Settings made by its one line (`mailSettings`) and the mail's stages, as every browser entry
 * hands them; the section reads the ground's own mail state and the frame's engine. What it asks of the pane's wire, of
 * the connect form's wire and of the first run's verbs is read off the doubles; what it says is the catalogue's.
 *
 * Held here: the rows are the pane's wire's, the count the ground's; a host with no wire draws nothing and asks
 * nothing; an edit's password goes to the opened mailbox alone and nowhere else; a removal sends nothing before the
 * person's choice and sends it once, for the row it was opened on; a take-over is sent only after its own press, once,
 * and a second factor asked for it sends the same press once more; another account under the same frame meets
 * nothing of the first; the notices of the section are said in the frame's slot and answered once.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useMailState, type MailboxFacts } from "@ohmail/app-logic/mail-state";
import type { Answered } from "@ohmail/app-logic/mailboxes/connect/types";
import type { OrganizeAnswer } from "@ohmail/app-logic/mailboxes/pane/types";
import type { FrameHost, PlaceEntry } from "../../../src/frame/contract.js";
import { Frame } from "../../../src/frame/Frame.js";
import {
  NONE,
  type ConnectWire,
  type ConsentWire,
  type FirstRunWire,
  type GapLettersWire,
  type MailboxesWire,
  type None,
  type OrganizerNoticeWire,
} from "../../../src/host/index.js";
import { MailGround, mailSettings, mailStages, type MailStageParts } from "../../../src/mail/index.js";
import type { FactorAsk, FactorSlot } from "../../../src/mailboxes/connect/contract.js";
import { mailboxesNotices, type MailboxesParts } from "../../../src/mailboxes/index.js";
import { TextProvider } from "../../../src/text/index.js";
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import mailboxesEn from "../../../messages/mailboxes.en.json" with { type: "json" };
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
import menuEn from "../../../messages/settings-menu.en.json" with { type: "json" };
import { fakeMail, WORDS as MAIL_WORDS } from "../../reader/support/mail.js";
import { fakeHost } from "../../support/fake-host.js";
import { fakeAddress } from "../../support/fake-window.js";
import { MARKER, O, REFUSED_PASSWORD, fakeDoor, later, type Call } from "../connect/support.js";
import { A, B, M, WINDOW_CLOSED, factorButtons, fakePane, id, ok, refusal, row } from "./support.js";

const MESSAGES = {
  ...MAIL_WORDS.en,
  ...accountEn,
  ...menuEn,
  settings: settingsEn.settings,
  ...mailboxesEn,
} as never;
const settle = (): Promise<void> => act(async () => {});
/** The ground's reads and the pane's answer over a few turns. */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await settle();
};
const words = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const press = (name: string | RegExp): void => void fireEvent.click(screen.getByRole("button", { name }));
const named = (address: string): RegExp => new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
/** The section's own column, Settings' reading sheet: the rail's foot names an address too. */
const section = () => within(screen.getByRole("region", { name: settingsEn.settings.title }));
const rowOf = (address: string): HTMLElement => section().getByRole("button", { name: named(address) });
const ALLOWED = ok({ emailVerified: true, access: null });
const SCOPE = "acct-1";

/** The section's head: its name, and the count Settings says beside it. */
function head(): { name: string | null; count: string | null } {
  const title = screen.queryByRole("heading", { level: 1, name: settingsEn.settings.mailboxes });
  const line = title?.closest("header")?.textContent ?? null;
  return {
    name: title?.textContent ?? null,
    count: line === null ? null : line.slice(title!.textContent!.length),
  };
}

/** One mailbox as the account's mail state reads it: connected and organized here unless the case says otherwise. */
const fact = (raw: string, address: string, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: raw,
  address,
  status: "active",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-11-16T08:58:00.000Z",
  createdAt: "2026-11-01T08:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerChecked: true,
  organizeConsentedAt: "2026-11-01T08:05:00.000Z",
  initialImportCompletedAt: "2026-11-01T09:00:00.000Z",
  ...over,
});
const FACTS = [fact("mbx-a", A), fact("mbx-b", B)];
const ROWS = [row("mbx-a", A), row("mbx-b", B)];
const CONSENT = {
  seedConfirmedAt: "2026-11-01T00:00:00.000Z",
  dormancyDays: 60,
  blockRemoteImagesAt: null,
  loadTrackingPixelsAt: null,
  onboardingCompletedAt: "2026-11-02T00:00:00.000Z",
  screeningBaselineAt: null,
};
const consent = { state: async () => CONSENT } as unknown as ConsentWire;

function verbs(): FirstRunWire & { organize: ReturnType<typeof vi.fn> } {
  return {
    ai: "unset",
    probe: () => new Promise(() => {}),
    connect: () => new Promise(() => {}),
    organize: vi.fn(async () => "stored"),
    complete: vi.fn(async () => {}),
    setAiEnabled: vi.fn(async () => {}),
    probeReason: () => null,
    probeMessage: () => null,
  } as unknown as FirstRunWire & { organize: ReturnType<typeof vi.fn> };
}

/** What a host alone hands the section here: the second factor's dialog as presses, and no calendar's half. */
const seen = { asks: [] as FactorAsk[], shown: 0 };
/** The dialog's stand-in, counted each time it is put on screen: a second ask is a second mount. */
function counted(): FactorSlot {
  const buttons = factorButtons(seen);
  function Shown({ ask }: { readonly ask: FactorAsk }) {
    useEffect(() => {
      seen.shown += 1;
    }, []);
    return <>{buttons(ask)}</>;
  }
  return (ask) => <Shown ask={ask} />;
}
const PARTS: MailboxesParts = { factor: counted(), calendar: NONE };
/** Made once, as a host makes them: Settings with the Mailboxes section alone, and the mail's stages. */
const SETTINGS = mailSettings({ mailboxes: PARTS, account: NONE });
const STAGE_PARTS: MailStageParts = {
  firstRun: { factor: factorButtons(seen), pair: NONE, aiProvider: NONE, calendar: NONE },
};
const STAGES = mailStages(STAGE_PARTS);
/** The section's feature as a host hands it: its notices over the ground's mail state. */
const FEATURE = { name: "mailboxes", render: () => null, notice: mailboxesNotices(useMailState) } as const;

const OHBOX: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: { kind: "columns", List: () => <p>the Ohbox</p>, Reading: "reader" },
};

interface Seated {
  readonly at?: string;
  readonly settings?: PlaceEntry | None;
  readonly mailboxCapability?: FrameHost["capabilities"]["mailboxes"];
  readonly managed?: boolean;
  /** The account's mailboxes as the ground's mail state reads them, by account. */
  readonly facts?: (scope: string) => readonly MailboxFacts[];
  /** The section's own wire, by account. */
  readonly pane: (scope: string) => MailboxesWire | None;
  readonly connect?: ConnectWire | None;
  readonly firstRun?: FirstRunWire;
  /** The host hands the mail's stages: `false`, none. */
  readonly stages?: boolean;
  readonly organizerNotice?: OrganizerNoticeWire;
  readonly gapLetters?: GapLettersWire;
  readonly letters?: readonly EngineMessage[];
}

function seated(o: Seated) {
  const mail = fakeMail(o.letters ?? []);
  const syncOnce = vi.fn(async () => undefined);
  const engine = {
    ...mail.engine,
    syncOnce,
    storeCoverage: () => ({ state: "unknown" }),
  } as unknown as OhmailEngine;
  const address = fakeAddress(o.at ?? "#/settings/mailboxes");
  const reads: string[] = [];
  const hostOf = (scope: string): FrameHost => {
    const made = fakeHost({
      engine,
      service: o.managed ? "managed" : "self",
      scope,
      places: { ohbox: OHBOX, settings: o.settings ?? SETTINGS },
      ...(o.stages === false ? {} : { stages: STAGES }),
      above: MailGround,
      features: {
        mailboxes: FEATURE,
        ...(o.managed ? { account: { name: "account", render: () => null } } : {}),
      },
      mailboxes: async () => {
        reads.push(scope);
        return [...(o.facts ?? (() => FACTS))(scope)];
      },
      wires: {
        consent,
        mailboxes: o.pane(scope),
        connect: o.connect ?? NONE,
        firstRun: o.firstRun ?? verbs(),
        ...(o.organizerNotice ? { organizerNotice: o.organizerNotice } : {}),
        ...(o.gapLetters ? { gapLetters: o.gapLetters } : {}),
      },
      address,
    });
    return {
      ...made.host,
      capabilities: {
        ...made.host.capabilities,
        mailboxes: o.mailboxCapability ?? "here",
        account: o.managed ? "inBrowser" : NONE,
        firstRunDoor: "cloud",
      },
    };
  };
  const frame = (scope: string) => (
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={hostOf(scope)} />
    </TextProvider>
  );
  const view = render(frame(SCOPE));
  return { address, reads, syncOnce, as: (scope: string) => view.rerender(frame(scope)) };
}

beforeEach(() => {
  seen.asks.length = 0;
  seen.shown = 0;
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the section reads the account's mailboxes over the ground", () => {
  it("lists the account's own mailboxes from the section's wire, and its count is the mail state's live mailboxes (a disabled one not counted)", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ALLOWED] });
    seated({
      pane: () => pane.wire,
      facts: () => [...FACTS, fact("mbx-old", "old@lichtgrat.example", { status: "disabled" })],
    });
    await answered();
    expect(head()).toEqual({ name: settingsEn.settings.mailboxes, count: "2" });
    expect(rowOf(A)).toBeTruthy();
    expect(rowOf(B)).toBeTruthy();
    expect(pane.of("list").map((c) => c.args[0])).toEqual([{ counts: true }]);
  });

  it("draws nothing where the host answers the section's wire with none, and asks nothing of any wire", async () => {
    const door = fakeDoor();
    const firstRun = verbs();
    seated({ pane: () => NONE, connect: door.door, firstRun });
    await answered();
    expect(head().name).toBe(settingsEn.settings.mailboxes);
    expect(screen.queryByText(M.modeSelfhost)).toBeNull();
    expect(screen.queryByRole("button", { name: M.connect })).toBeNull();
    expect(door.calls).toEqual([]);
    expect(firstRun.organize).not.toHaveBeenCalled();
  });

  it("a write the server took asks the engine to sync once and reads the mail state again; Sync now asks the server and reads the mail state again", async () => {
    const door = fakeDoor({ edit: [ok(null)] });
    const pane = fakePane({
      list: [ok(ROWS), ok(ROWS), ok(ROWS)],
      allowance: [ALLOWED, ALLOWED, ALLOWED],
      resync: [ok(null)],
    });
    const made = seated({
      at: "#/settings/mailboxes?mailbox=mbx-a",
      pane: () => pane.wire,
      connect: door.door,
    });
    await answered();
    const at = () => ({ reads: made.reads.length, engine: made.syncOnce.mock.calls.length });
    const rest = at();
    press(M.syncNow);
    await answered();
    expect(pane.of("resync").map((c) => c.args)).toEqual([["mbx-a"]]);
    const synced = at();
    expect({ engine: synced.engine - rest.engine, readAgain: synced.reads > rest.reads }).toEqual({
      engine: 0,
      readAgain: true,
    });

    press(M.edit);
    fireEvent.change(screen.getByLabelText(M.passwordLabel), { target: { value: "a new one" } });
    press(M.continue);
    await answered();
    expect(door.of("edit")).toHaveLength(1);
    const saved = at();
    expect({ engine: saved.engine - synced.engine, readAgain: saved.reads > synced.reads }).toEqual({
      engine: 1,
      readAgain: true,
    });
  });
});

describe("connecting goes to the first run's add run over the ground", () => {
  it("Connect a mailbox writes the add run into the address and the first run's mailbox step stands; with no first run it is not offered", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ALLOWED] });
    const made = seated({ pane: () => pane.wire, connect: fakeDoor().door });
    await answered();
    press(M.connect);
    await answered();
    expect(made.address.read()).toBe("#/first-run/add");
    expect(screen.getByLabelText(O.address)).toBeTruthy();
    expect(pane.writes()).toEqual([]);

    cleanup();
    const none = fakePane({ list: [ok(ROWS)], allowance: [ALLOWED] });
    seated({ pane: () => none.wire, connect: fakeDoor().door, stages: false });
    await answered();
    expect(rowOf(A)).toBeTruthy();
    expect(screen.queryByRole("button", { name: M.connect })).toBeNull();
  });

  it("the address's word opens a row only where the account's own rows hold it; a word no row holds opens nothing and sends nothing", async () => {
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ALLOWED] });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    expect([rowOf(A).getAttribute("aria-expanded"), rowOf(B).getAttribute("aria-expanded")]).toEqual([
      "false",
      "true",
    ]);

    cleanup();
    const one = fakePane({ list: [ok([row("mbx-a", A)])], allowance: [ALLOWED] });
    seated({
      at: "#/settings/mailboxes?mailbox=mbx-elsewhere",
      pane: () => one.wire,
      facts: () => [FACTS[0]!],
    });
    await answered();
    expect(rowOf(A).getAttribute("aria-expanded")).toBe("false");
    expect(one.calls.map((c) => c.verb).sort()).toEqual(["allowance", "list"]);
  });
});

/* THE SINKS a password must never reach, as `secret-in-its-mounts.test.tsx` walks them: every store, the address, the
   console and any request beside the two wires. */
let written: string[] = [];
let reached: string[] = [];
const record =
  (sink: string) =>
  (...args: unknown[]): void => {
    written.push(
      `${sink}: ${args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" ")}`,
    );
  };
const never =
  (name: string) =>
  (..._args: unknown[]): never => {
    reached.push(name);
    throw new Error(`${name} was reached`);
  };
function onThePage(): { markup: boolean; fields: string[] } {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter((field) => field.value.includes("MARKER"))
    .map((field) => field.getAttribute("type") ?? "text");
  return { markup: document.documentElement.outerHTML.includes("MARKER"), fields };
}
const besidesPass = (call: Call): string =>
  JSON.stringify(call.sent, (key, value: unknown) => (key === "pass" ? undefined : value)) ?? "";
function clean(calls: readonly Call[], mounts: unknown): void {
  expect(written.filter((line) => line.includes("MARKER"))).toEqual([]);
  expect(reached).toEqual([]);
  for (const call of calls) {
    expect(besidesPass(call)).not.toContain("MARKER");
    expect(call.sealed).not.toContain("MARKER");
  }
  expect(JSON.stringify(mounts) ?? "").not.toContain("MARKER");
}

describe("an edit of a mailbox whose domain is internationalized", () => {
  it("is titled with the mailbox's address in Unicode, never in its ASCII form", async () => {
    const ascii = "post@xn--bcher-kva.example";
    const pane = fakePane({ list: [ok([row("mbx-a", ascii)])], allowance: [ALLOWED] });
    seated({
      at: "#/settings/mailboxes?mailbox=mbx-a",
      pane: () => pane.wire,
      connect: fakeDoor().door,
      facts: () => [fact("mbx-a", ascii)],
    });
    await answered();
    press(M.edit);
    expect(section().getByText(M.editTitle.replace("{address}", "post@bücher.example"))).toBeTruthy();
    expect(section().queryByText(/xn--/)).toBeNull();
  });
});

describe("an edit's password, over the ground", () => {
  beforeEach(() => {
    written = [];
    reached = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(record("storage"));
    vi.spyOn(window.history, "pushState").mockImplementation(record("history"));
    vi.spyOn(window.history, "replaceState").mockImplementation(record("history"));
    for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
      vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
    vi.stubGlobal("fetch", vi.fn(never("fetch")));
    vi.stubGlobal("XMLHttpRequest", vi.fn(never("XMLHttpRequest")));
    vi.stubGlobal("WebSocket", vi.fn(never("WebSocket")));
    vi.stubGlobal("Image", vi.fn(never("Image")));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is in its one field and in the patch's `pass` for the opened mailbox's id alone, through a refusal and the save; never in the section's wire, the address, a store or the markup", async () => {
    const door = fakeDoor({ edit: [REFUSED_PASSWORD, ok(null)] });
    const pane = fakePane({
      list: [ok(ROWS), ok(ROWS), ok(ROWS)],
      allowance: [ALLOWED, ALLOWED, ALLOWED, ALLOWED],
    });
    const made = seated({
      at: "#/settings/mailboxes?mailbox=mbx-b",
      pane: () => pane.wire,
      connect: door.door,
    });
    await answered();
    press(M.edit);
    fireEvent.change(screen.getByLabelText(M.passwordLabel), { target: { value: MARKER } });
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });

    press(M.continue);
    await answered();
    /* Refused: the stored login stands, and what was typed stays in its field alone. */
    expect(onThePage()).toEqual({ markup: false, fields: ["password"] });
    clean(door.calls, [pane.calls, made.address.writes, made.address.read()]);

    press(M.continue);
    await answered();
    const edits = door
      .of("edit")
      .map((c) => c.sent as { mailboxId: string; patch: { imap: { pass: string } } });
    expect(edits.map((e) => e.mailboxId)).toEqual(["mbx-b", "mbx-b"]);
    expect(edits[1]!.patch.imap.pass).toBe(MARKER);
    /* Saved: the form left its row, and the password went with its field. */
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    clean(door.calls, [pane.calls, made.address.writes, made.address.read()]);
  });
});

describe("a removal, over the ground", () => {
  const erased = ok({ erasing: false, mailboxId: id("mbx-b"), messages: 3, drafts: 1, draftsUnanchored: 0 });

  it("nothing is sent until the address is typed and the erasure chosen; then one erasure for the row it was opened on, as typed", async () => {
    const pane = fakePane({
      list: [ok(ROWS), ok([ROWS[0]!])],
      allowance: [ALLOWED, ALLOWED],
      erase: [erased],
    });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    press(M.remove);
    await settle();
    expect(pane.writes()).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: M.removeEraseChoice }));
    /* Chosen, with nothing typed: the press sends nothing. */
    press(M.removeEraseConfirm);
    await settle();
    expect(pane.writes()).toEqual([]);
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), { target: { value: B } });
    press(M.removeEraseConfirm);
    await answered();
    expect(pane.writes().map((c) => [c.verb, ...c.args])).toEqual([["erase", "mbx-b", B]]);
  });

  it("keeping the copy removes the row it was opened on, once; closed, nothing is sent", async () => {
    const pane = fakePane({
      list: [ok(ROWS), ok([ROWS[1]!])],
      allowance: [ALLOWED, ALLOWED],
      remove: [ok(null)],
    });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-a", pane: () => pane.wire });
    await answered();
    press(M.remove);
    await settle();
    press(M.removeCancel);
    await settle();
    expect(pane.writes()).toEqual([]);

    press(M.remove);
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: M.removeKeepChoice }));
    press(M.removeConfirm);
    await answered();
    expect(pane.writes().map((c) => [c.verb, ...c.args])).toEqual([["remove", "mbx-a"]]);
  });

  it("its confirmation is the kit's dialog over the window, named by its question: the keys stand on Keep it, a refusal is said in it, and Escape keeps the mailbox", async () => {
    const busy = {
      ok: false as const,
      refusal: refusal("mailbox_busy", {}, 409, "The mailbox is busy for a moment."),
    };
    const pane = fakePane({ list: [ok(ROWS)], allowance: [ALLOWED, ALLOWED], remove: [busy] });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    press(M.remove);
    await settle();
    const asked = M.removeTitle.replace("{address}", B);
    const question = screen.getByRole("dialog", { name: asked });
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: M.removeCancel }));
    fireEvent.click(within(question).getByRole("button", { name: M.removeConfirm }));
    await answered();
    expect(
      within(screen.getByRole("dialog", { name: asked })).getByText("The mailbox is busy for a moment."),
    ).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("dialog", { name: asked })).toBeNull();
    expect(pane.writes().map((c) => [c.verb, ...c.args])).toEqual([["remove", "mbx-b"]]);
  });
});

describe("organizing a mailbox another install holds, over the ground", () => {
  /** Held by an install of the person's own elsewhere: this one reads it. */
  const held = row("mbx-b", B, {
    organizerRole: "reader",
    organizedBy: { kind: "local", name: "Mila's MacBook", since: "2026-11-10T08:00:00.000Z" },
  });
  const peek = ok({
    state: "held" as const,
    holders: [
      {
        kind: "local",
        displayName: "Mila's MacBook",
        heartbeatAt: "2026-11-16T08:55:00.000Z",
        active: true,
      },
    ] as never[],
    unreadable: 0,
  });
  const taken = ok({ outcome: "authorized" as const });

  it("is asked first, and one take-over is sent after its own press, with the intent the press chose", async () => {
    const pane = fakePane({
      list: [ok([ROWS[0]!, held]), ok([ROWS[0]!, held])],
      allowance: [ALLOWED, ALLOWED],
      organizer: [peek],
      organizeHere: [taken],
    });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    press(M.organizerCheckServer);
    await answered();
    expect(pane.of("organizer").map((c) => c.args)).toEqual([["mbx-b"]]);
    expect(pane.of("organizeHere")).toEqual([]);
    press(M.organizerConfirm);
    await answered();
    expect(pane.of("organizeHere").map((c) => c.args)).toEqual([["mbx-b", {}]]);
  });

  it("under a second-factor refusal the same press is sent once more after the factor; Cancel sends nothing", async () => {
    const pane = fakePane({
      list: [ok([ROWS[0]!, held]), ok([ROWS[0]!, held])],
      allowance: [ALLOWED, ALLOWED],
      organizer: [peek, peek],
      organizeHere: [WINDOW_CLOSED, taken, WINDOW_CLOSED],
    });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    press(M.organizerCheckServer);
    await answered();
    press(M.organizerConfirm);
    await answered();
    expect(seen.shown).toBe(1);
    expect(
      within(screen.getByRole("dialog", { name: "the second factor" })).getByText(M.factorBodyTakeover),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "verify" }));
    await answered();
    expect(pane.of("organizeHere").map((c) => c.args)).toEqual([
      ["mbx-b", {}],
      ["mbx-b", {}],
    ]);

    /* Asked again later, Cancel: nothing more is sent. */
    press(M.organizerCheckServer);
    await answered();
    press(M.organizerConfirm);
    await answered();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await answered();
    expect(pane.of("organizeHere")).toHaveLength(3);
    expect(screen.queryByRole("dialog", { name: "the second factor" })).toBeNull();
  });

  it("what a press would send changed while the take-over was on its way: a second-factor refusal then parks nothing", async () => {
    const answer = later<Answered<OrganizeAnswer>>();
    const pane = fakePane({
      list: [ok([ROWS[0]!, held]), ok([ROWS[0]!, held])],
      allowance: [ALLOWED, ALLOWED],
      organizer: [peek],
      organizeHere: [answer.promise],
    });
    seated({ at: "#/settings/mailboxes?mailbox=mbx-b", pane: () => pane.wire });
    await answered();
    press(M.organizerCheckServer);
    await answered();
    press(M.organizerConfirm);
    await settle();
    /* The person opens the removal of the same mailbox: the take-over on its way is moved under. */
    press(M.remove);
    await act(async () => answer.resolve(WINDOW_CLOSED));
    await answered();
    expect({ asked: seen.shown, sent: pane.of("organizeHere").length }).toEqual({ asked: 0, sent: 1 });
    expect(screen.getByText(M.cancelledNothingChanged)).toBeTruthy();
  });
});

describe("another account under the same frame", () => {
  const C = "post@hohtenn.example";
  /** The first account with its two rows, the second with one of its own; each account's own wire. */
  function twoAccounts(script: Parameters<typeof fakePane>[0], connect: ConnectWire | None = NONE) {
    const first = fakePane({ list: [ok(ROWS), ok(ROWS)], allowance: [ALLOWED, ALLOWED], ...script });
    const second = fakePane({ list: [ok([row("mbx-c", C)])], allowance: [ALLOWED] });
    const made = seated({
      at: "#/settings/mailboxes?mailbox=mbx-a",
      pane: (scope) => (scope === SCOPE ? first.wire : second.wire),
      connect,
      facts: (scope) => (scope === SCOPE ? FACTS : [fact("mbx-c", C)]),
    });
    return { first, second, made };
  }

  it("the list is read again for it; the first account's opened row and an edit's typed words are gone, and none of it was stored", async () => {
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const door = fakeDoor();
    const { second, made } = twoAccounts({}, door.door);
    await answered();
    press(M.edit);
    fireEvent.change(screen.getByLabelText(M.passwordLabel), { target: { value: MARKER } });
    expect(onThePage().fields).toEqual(["password"]);

    made.as("acct-2");
    await answered();
    expect(second.of("list")).toHaveLength(1);
    expect(rowOf(C).getAttribute("aria-expanded")).toBe("false");
    expect(section().queryByRole("button", { name: named(A) })).toBeNull();
    expect(onThePage()).toEqual({ markup: false, fields: [] });
    expect(stored.mock.calls.filter((call) => JSON.stringify(call).includes("MARKER"))).toEqual([]);
    expect(door.of("edit")).toEqual([]);
  });

  it("a press of the first account parked for its factor is gone with it: a factor verified after the change sends nothing", async () => {
    const { first, made } = twoAccounts({ remove: [WINDOW_CLOSED, ok(null)] });
    await answered();
    press(M.remove);
    await settle();
    press(M.removeConfirm);
    await answered();
    expect(seen.shown).toBe(1);
    const parked = seen.asks.at(-1)!;

    made.as("acct-2");
    await answered();
    expect(screen.queryByRole("dialog", { name: "the second factor" })).toBeNull();
    act(() => parked.onVerified());
    await answered();
    expect(first.of("remove")).toHaveLength(1);
  });
});

describe("the section's notices, in the frame's slot", () => {
  const AT = "2026-11-16T08:00:00.000Z";
  /* As the notices' own case has it: its holder, an install of the person's own, stopped. */
  const stopped = fact("mbx-b", B, {
    organizerRole: "reader",
    organizedBy: { kind: "local", name: "Mila's MacBook", since: AT },
    organizeConsentedAt: null,
    organizerState: "stopped",
    organizerEventAt: AT,
    organizerEventSeenAt: null,
  } as Partial<MailboxFacts>);

  it("that a mailbox stopped being organized is said once with its act, and gone once answered through its wire", async () => {
    const acknowledged: string[] = [];
    const facts = { now: [FACTS[0]!, stopped] };
    const made = seated({
      at: "#/ohbox",
      pane: () => fakePane().wire,
      facts: () => facts.now,
      organizerNotice: async (mailboxId) => {
        acknowledged.push(mailboxId);
        facts.now = [FACTS[0]!, { ...stopped, organizerEventSeenAt: AT } as MailboxFacts];
      },
    });
    await answered();
    expect(screen.getAllByRole("button", { name: M.noticeDismiss })).toHaveLength(1);
    expect(screen.getAllByText(new RegExp(`stopped organizing ${B.replace(".", "\\.")}`))).toHaveLength(1);
    press(M.noticeDismiss);
    await answered();
    expect(acknowledged).toEqual(["mbx-b"]);
    expect(screen.queryByRole("button", { name: M.noticeDismiss })).toBeNull();
    expect(made.address.read()).toBe("#/ohbox");
  });

  it.each([
    { state: "stopped", holder: "Office · stopped", unknown: "stopped", rest: 1, count: "1 other mailbox" },
    {
      state: "held",
      holder: "Office",
      unknown: "another ohmail install",
      rest: 2,
      count: "2 other mailboxes",
    },
  ] as const)(
    "names up to three mailboxes when their organizer is $state and opens the full roster",
    async ({ state, holder, unknown, rest, count }) => {
      const addresses = [A, B, ...[3, 4, 5].map((n) => A.replace(/^[^@]+/, `mailbox${n}`))].slice(
        0,
        3 + rest,
      );
      const idOf = (index: number) => `mailbox-${index}`;
      const facts = addresses.map((address, index) =>
        fact(idOf(index), address, {
          organizerRole: "reader",
          organizedBy: { kind: "local", name: index === 1 ? null : "Office", since: AT },
          organizerState: state,
          organizerEventAt: AT,
          organizerEventSeenAt: null,
        } as Partial<MailboxFacts>),
      );
      const pane = fakePane({ list: [ok(addresses.map((address, index) => row(idOf(index), address)))] });
      const acknowledge = vi.fn(async () => {
        throw new TypeError();
      });
      const made = seated({
        at: "#/ohbox",
        pane: () => pane.wire,
        facts: () => facts,
        organizerNotice: acknowledge,
      });
      await answered();

      const notice = screen.getByRole("button", { name: M.noticeDismiss }).closest('[role="status"]')!;
      expect(notice.textContent).toContain(
        `${A} · ${holder}, ${B} · ${unknown}, ${addresses[2]} · ${holder} and ${count}.`,
      );
      for (const address of addresses.slice(3)) expect(notice.textContent).not.toContain(address);

      press(M.noticeDismiss);
      await answered();
      expect(notice.textContent).toContain(`${addresses[2]} · ${holder} and ${count}.`);
      expect(notice.textContent).toContain(M.noticeDismissOffline);

      fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: M.noticeOpenMailboxes }));
      await answered();
      expect(made.address.read()).toBe("#/settings/mailboxes");
      for (const address of addresses) expect(rowOf(address)).toBeTruthy();
      expect(acknowledge).toHaveBeenCalledTimes(addresses.length);
    },
  );

  it.each([
    { door: "standalone", capability: "here", settings: NONE, wire: NONE },
    {
      door: "managed",
      capability: "resyncAndOut",
      settings: mailSettings({
        mailboxes: NONE,
        account: { useBrowserDoor: () => ({ open: async () => true }) },
      }),
      wire: NONE,
    },
    { door: "paired", capability: "resyncOnly", settings: NONE, wire: NONE },
    { door: "without the list wire", capability: "here", settings: SETTINGS, wire: NONE },
    { door: "without mailbox capability", capability: NONE, settings: SETTINGS, wire: fakePane().wire },
  ] as const)(
    "keeps an uninspectable group pending on a host that is $door",
    async ({ door, capability, settings, wire }) => {
      const rows = [A, B, ...[3, 4].map((n) => A.replace(/^[^@]+/, `mailbox${n}`))].map((address, index) =>
        fact(`mailbox-${index}`, address, {
          organizerRole: "reader",
          organizedBy: { kind: "local", name: "Office", since: AT },
          organizerState: "held",
          organizerEventAt: AT,
        } as Partial<MailboxFacts>),
      );
      const acknowledge = vi.fn(async () => {});
      seated({
        at: "#/ohbox",
        pane: () => wire,
        settings,
        mailboxCapability: capability,
        managed: door === "managed",
        facts: () => rows,
        organizerNotice: acknowledge,
      });
      await answered();

      const notice = screen
        .getByText(/4 mailboxes are organized elsewhere/)
        .closest('[role="status"]') as HTMLElement;
      expect(notice.textContent).toContain("1 other mailbox.");
      expect(within(notice).queryByRole("button", { name: M.noticeOpenMailboxes })).toBeNull();
      expect(within(notice).queryByRole("button", { name: M.noticeDismiss })).toBeNull();
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it("still dismisses a stopped mailbox named in full on a host without the list", async () => {
    const acknowledge = vi.fn(async () => {});
    seated({
      at: "#/ohbox",
      pane: () => NONE,
      settings: NONE,
      facts: () => [stopped],
      organizerNotice: acknowledge,
    });
    await answered();
    const notice = screen
      .getByRole("button", { name: M.noticeDismiss })
      .closest('[role="status"]') as HTMLElement;
    expect(within(notice).queryByRole("button", { name: M.noticeOpenMailboxes })).toBeNull();
    press(M.noticeDismiss);
    await answered();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("mbx-b");
    expect(screen.queryByRole("button", { name: M.noticeDismiss })).toBeNull();
  });

  it("the offer about the letters a gap left answers through its wire once", async () => {
    const offered: unknown[] = [];
    const gap = fact("mbx-a", A, { gapLetters: 3, gapStrangers: 0 } as Partial<MailboxFacts>);
    seated({
      at: "#/ohbox",
      pane: () => fakePane().wire,
      facts: () => [gap],
      gapLetters: async (mailboxId, answer) => void offered.push([mailboxId, answer]),
    });
    await answered();
    press(words("File them"));
    await answered();
    expect(offered).toEqual([["mbx-a", { file: true, count: 3, strangers: 0 }]]);
  });
});

describe("a provider's sign-in that came back", () => {
  it("is said once at the section, as the server's sentence in an alert; one watch for a mount, and the first account's watch stops when another account stands", async () => {
    const door = fakeDoor({
      ways: { microsoft: { redirect: true, device: false } },
      returned: { kind: "failed", reason: null, message: "The provider did not answer in time." },
    });
    const made = seated({
      pane: () => fakePane({ list: [ok(ROWS), ok(ROWS)], allowance: [ALLOWED, ALLOWED] }).wire,
      connect: door.door,
    });
    await answered();
    const said = screen.getAllByText("The provider did not answer in time.");
    expect(said).toHaveLength(1);
    expect(said[0]!.closest('[role="alert"]')).not.toBeNull();
    expect(door.returned.listeners()).toBe(1);

    made.as("acct-2");
    await answered();
    expect(door.returned.listeners()).toBe(1);
  });
});
