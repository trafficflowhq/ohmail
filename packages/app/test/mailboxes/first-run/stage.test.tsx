/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FirstRunAbout,
  FirstRunGround,
  FirstRunRow,
} from "@ohmail/app-logic/mailboxes/first-run/ground";
import type { FrameHost } from "../../../src/frame/contract.js";
import { Frame } from "../../../src/frame/Frame.js";
import { NONE, type FirstRunWire, type HostCapabilities } from "../../../src/host/index.js";
import { firstRunStage, type FirstRunSlots } from "../../../src/mailboxes/first-run/index.js";
import { TextProvider } from "../../../src/text/index.js";
import frame from "../../../messages/frame.en.json" with { type: "json" };
import screener from "../../../messages/screener.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../../support/fake-host.js";
import { fakeAddress, movable } from "../../support/fake-window.js";
import { D, M, MARKER, O, P, WORDS, factorButtons, fakeDoor, id } from "../connect/support.js";

/**
 * THE FIRST RUN AS THE FRAME'S STAGE, over a fake host and a fake ground, driven by role and name. What it asks of the
 * first-run verbs is read off the double; what it says is the catalogue's sentence.
 */
const MESSAGES = { ...WORDS, ...frame, ...screener } as never;
const settle = (): Promise<void> => act(async () => {});
const press = (name: RegExp): void => void fireEvent.click(screen.getByRole("button", { name }));
const heading = (): string => screen.getByRole("heading", { level: 1 }).textContent ?? "";
const words = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const MAILBOX: FirstRunRow = {
  id: id("mbx-1"),
  address: "me@lichtgrat.example",
  organizerRole: "organizer",
  organizedBy: null,
  organizerChecked: true,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
  importOver: false,
};
const ABOUT: FirstRunAbout = {
  queuedSenders: 0,
  pull: { screened: 0, history: 0, pulled: 0, whole: false },
  sender: null,
  queueSettling: false,
  rereadQueue: async () => {},
};
const ground = (over: Partial<FirstRunGround> = {}): FirstRunGround => ({
  rows: [MAILBOX],
  account: { onboardingCompletedAt: null },
  accountOrganizer: null,
  about: () => ABOUT,
  refresh: async () => {},
  drawn: () => {},
  ...over,
});

type Verbs = FirstRunWire & { organize: ReturnType<typeof vi.fn>; setAiEnabled: ReturnType<typeof vi.fn> };
function verbs(over: Partial<FirstRunWire> = {}): Verbs {
  return {
    ai: "unset",
    probe: () => new Promise(() => {}),
    connect: () => new Promise(() => {}),
    organize: vi.fn(async () => "stored"),
    complete: vi.fn(async () => {}),
    setAiEnabled: vi.fn(async () => {}),
    probeReason: () => null,
    probeMessage: () => null,
    ...over,
  } as Verbs;
}

function stage(o: {
  verbs: FirstRunWire;
  ground: FirstRunGround;
  at?: string;
  door?: "local" | "cloud" | "selfhost";
  factor?: FirstRunSlots["factor"];
  connect?: ReturnType<typeof fakeDoor>["door"];
}) {
  const facts = movable(o.ground);
  const seen = { asks: [] as Parameters<NonNullable<Exclude<FirstRunSlots["factor"], typeof NONE>>>[0][] };
  /* The ground as a shell's fill reads it: a hook, the facts moved by the case. */
  function useGround(): FirstRunGround {
    return useSyncExternalStore(facts.subscribe, facts.read);
  }
  const slots: FirstRunSlots = {
    factor: o.factor ?? factorButtons(seen),
    pair: NONE,
    aiProvider: NONE,
    calendar: NONE,
    ground: useGround,
  };
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    stages: { firstRun: firstRunStage(slots) },
    address: fakeAddress(o.at ?? "#/first-run"),
  });
  const capabilities: HostCapabilities = { ...made.host.capabilities, firstRunDoor: o.door ?? "cloud" };
  const host: FrameHost = {
    ...made.host,
    capabilities,
    wires: { ...made.host.wires, firstRun: o.verbs, connect: o.connect ?? NONE },
  };
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  return { facts, seen, address: made.address };
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the AI question stops the run and asks; nothing is spent before the press", () => {
  const consented = { ...MAILBOX, organizeConsentedAt: "2026-11-01T00:00:00Z" };

  it("asks with AI unset, and the answer is one write, after the press", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground({ rows: [consented] }) });
    await settle();
    expect(heading()).toBe(O.aiTitle);
    expect(v.setAiEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: words(O.aiYesCloud) }));
    press(words(O.continue));
    await settle();
    expect(v.setAiEnabled.mock.calls).toEqual([[true]]);
  });

  it("offers no yes where a self-hosted server has no model: no is the only answer", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground({ rows: [consented] }), door: "selfhost" });
    await settle();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([`${O.aiNo}${O.aiNoWhy}`]);
    press(words(O.continue));
    await settle();
    expect(v.setAiEnabled.mock.calls).toEqual([[false]]);
  });
});

describe("Agree is one call, carrying the consent, the window and the scope", () => {
  const BODY = { screening: { dormancyDays: 365, scope: "window" }, intent: "join" };
  const toWindow = async (): Promise<void> => {
    await settle();
    expect(heading()).toContain(O.consentTitle);
    press(words(O.continue));
    await settle();
    expect(heading()).toBe(O.windowTitle);
  };

  it("sends one organize for the mailbox the run is about, the year's window as offered", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground() });
    await toWindow();
    press(words(O.agree));
    await settle();
    expect(v.organize.mock.calls).toEqual([[MAILBOX.id, BODY]]);
  });

  it("a press that stored nothing says so and stays", async () => {
    const v = verbs({ organize: vi.fn(async () => "gone") });
    stage({ verbs: v, ground: ground() });
    await toWindow();
    press(words(O.agree));
    await settle();
    expect(screen.getByText(O.windowGone)).toBeTruthy();
    expect(heading()).toBe(O.windowTitle);
  });

  it("the second factor is asked only on the server's refusal, the same press is sent once more, and never twice", async () => {
    const windowClosed = {
      status: 403,
      code: "step_up_required",
      message: "Confirm it is you.",
      details: {},
    };
    const organize = vi.fn(async () => {
      throw windowClosed;
    });
    const v = verbs({ organize });
    const s = stage({ verbs: v, ground: ground() });
    await toWindow();
    press(words(O.agree));
    await settle();
    expect(organize).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "the second factor" })).toBeTruthy();
    expect(s.seen.asks.length).toBeGreaterThan(0);
    expect(screen.getByText(O.windowStepUp)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "verify" }));
    await settle();
    expect(organize).toHaveBeenCalledTimes(2);
    expect(organize.mock.calls[1]).toEqual(organize.mock.calls[0]);
    expect((organize.mock.calls[1] as unknown[])[1]).toBe((organize.mock.calls[0] as unknown[])[1]);
    expect(screen.queryByRole("dialog", { name: "the second factor" })).toBeNull();
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
  });

  it("Cancel sends nothing; with no dialog to ask, nothing is parked and it says to sign in again", async () => {
    const windowClosed = {
      status: 403,
      code: "step_up_required",
      message: "Confirm it is you.",
      details: {},
    };
    const organize = vi.fn(async () => {
      throw windowClosed;
    });
    stage({ verbs: verbs({ organize }), ground: ground() });
    await toWindow();
    press(words(O.agree));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await settle();
    expect(organize).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "the second factor" })).toBeNull();
    cleanup();
    const bare = vi.fn(async () => {
      throw windowClosed;
    });
    stage({ verbs: verbs({ organize: bare }), ground: ground(), factor: NONE });
    await toWindow();
    press(words(O.agree));
    await settle();
    expect(bare).toHaveBeenCalledTimes(1);
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
  });

  it("the run moved to another mailbox while Agree is on its way: no factor is asked for the press it was moved under, and nothing ran", async () => {
    const windowClosed = {
      status: 403,
      code: "step_up_required",
      message: "Confirm it is you.",
      details: {},
    };
    const refuse: ((thrown: unknown) => void)[] = [];
    const organize = vi.fn(() => new Promise<string>((_taken, refused) => void refuse.push(refused)));
    const other = { ...MAILBOX, id: id("mbx-2"), address: "post@berghof.example" };
    const s = stage({
      verbs: verbs({ organize }),
      ground: ground({ rows: [MAILBOX, other] }),
      at: "#/first-run/again?mailbox=mbx-1",
    });
    await toWindow();
    press(words(O.agree));
    await settle();
    expect(organize).toHaveBeenCalledTimes(1);
    // The route names the other mailbox while the press is still on its way.
    act(() => s.address.visit("#/first-run/again?mailbox=mbx-2"));
    await settle();
    await act(async () => refuse[0]!(windowClosed));
    await settle();
    const asked = screen.queryByRole("dialog", { name: "the second factor" }) !== null;
    if (asked) {
      fireEvent.click(screen.getByRole("button", { name: "verify" }));
      await settle();
    }
    expect({ asked, organizes: organize.mock.calls.length }).toEqual({ asked: false, organizes: 1 });
    expect(screen.getByText(M.cancelledNothingChanged)).toBeTruthy();
  });
});

describe("the mailbox step is the one connect form, and the mode is the route's, never a default", () => {
  const typed = (): void => {
    fireEvent.change(screen.getByLabelText(O.address), { target: { value: "me@lichtgrat.example" } });
    fireEvent.click(screen.getByRole("button", { name: words(P.otherLabel) }));
    fireEvent.change(screen.getByLabelText(O.imapHost), { target: { value: "mail-a.home.arpa" } });
    fireEvent.change(screen.getByLabelText(O.smtpHost), { target: { value: "mail-b.home.arpa" } });
    fireEvent.change(screen.getByLabelText(O.password), { target: { value: MARKER } });
    press(words(O.connect));
  };

  for (const [at, mode] of [
    ["#/first-run", "seed"],
    ["#/first-run/add", "add"],
  ] as const) {
    it(`${at} connects as ${mode}`, async () => {
      const wire = fakeDoor({ connect: [{ ok: true, value: { mailboxId: id("mbx-2"), address: null } }] });
      stage({ verbs: verbs(), ground: ground({ rows: [] }), at, connect: wire.door });
      await settle();
      if (at === "#/first-run") press(words(O.welcomeStart));
      await settle();
      typed();
      await settle();
      expect(wire.of("connect").map((c) => (c.sent as { mode: string }).mode)).toEqual([mode]);
    });
  }

  it("an add's new row is written into the run's address by a replace; the typed password is held nowhere after", async () => {
    const wire = fakeDoor({ connect: [{ ok: true, value: { mailboxId: id("mbx-2"), address: null } }] });
    const s = stage({
      verbs: verbs(),
      ground: ground({ rows: [] }),
      at: "#/first-run/add",
      connect: wire.door,
    });
    await settle();
    typed();
    await settle();
    expect(s.address.writes).toEqual([{ next: "#/first-run/add?mailbox=mbx-2", how: "replace" }]);
    act(() => s.facts.set(ground({ rows: [{ ...MAILBOX, id: id("mbx-2") }] })));
    await settle();
    expect(heading()).toContain(O.consentTitle);
    expect(document.body.innerHTML).not.toContain(MARKER);
    expect([...document.querySelectorAll("input")].some((i) => i.value.includes(MARKER))).toBe(false);
  });

  it("with no connect wire the step draws no form", async () => {
    stage({ verbs: verbs(), ground: ground({ rows: [] }), at: "#/first-run/add" });
    await settle();
    expect(heading()).toContain(O.mailboxTitle);
    expect(screen.queryByLabelText(O.password)).toBeNull();
  });
});

describe("a step says its lead: the sentence that explains it is on screen with its title", () => {
  const consented = { ...MAILBOX, organizeConsentedAt: "2026-11-01T00:00:00Z" };
  const cases: readonly (readonly [string, string, FirstRunGround, string])[] = [
    ["the welcome", "#/first-run", ground({ rows: [] }), O.welcomeLead],
    ["the connect step of an add", "#/first-run/add", ground({ rows: [] }), O.mailboxLead],
    ["the AI question", "#/first-run", ground({ rows: [consented] }), O.aiLead],
    ["a run whose mailbox is gone", "#/first-run/again?mailbox=mbx-gone", ground(), O.vanishedLead],
  ];
  for (const [name, at, facts, lead] of cases) {
    it(`${name} says its lead`, async () => {
      stage({ verbs: verbs(), ground: facts, at });
      await settle();
      expect(screen.getByText(lead)).toBeTruthy();
    });
  }

  it("the window says its lead beside the choice", async () => {
    stage({ verbs: verbs(), ground: ground() });
    await settle();
    press(words(O.continue));
    await settle();
    expect(heading()).toBe(O.windowTitle);
    expect(screen.getByText(O.windowLead)).toBeTruthy();
  });
});

describe("the route's word is a claim, answered by the account's own rows", () => {
  for (const word of ["mbx-gone", "..%2F..%2Fsessions", "mbx-1%2F..%2F"]) {
    it(`a run naming ${word} is refused by name and sends nothing`, async () => {
      const v = verbs();
      stage({ verbs: v, ground: ground(), at: `#/first-run/again?mailbox=${word}` });
      await settle();
      expect(heading()).toContain(O.vanishedTitle);
      expect(v.organize).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(O.password)).toBeNull();
    });
  }

  it("an add naming a mailbox the rows do not hold yet waits in words: no form, and nothing is asked of a wire", async () => {
    const wire = fakeDoor();
    const v = verbs();
    const s = stage({
      verbs: v,
      ground: ground({ rows: [MAILBOX] }),
      at: "#/first-run/add?mailbox=mbx-2",
      connect: wire.door,
    });
    await settle();
    expect(heading()).toContain(O.resumeCheckingTitle);
    expect(screen.getByText(O.resumeChecking)).toBeTruthy();
    expect(screen.queryByLabelText(O.password)).toBeNull();
    expect(screen.queryByLabelText(O.address)).toBeNull();
    expect(wire.of("probe")).toEqual([]);
    expect(wire.of("connect")).toEqual([]);
    expect(v.organize).not.toHaveBeenCalled();
    /* The row arrives: the run goes on with the mailbox the account's own list holds. */
    act(() => s.facts.set(ground({ rows: [MAILBOX, { ...MAILBOX, id: id("mbx-2") }] })));
    await settle();
    expect(heading()).toContain(O.consentTitle);
  });
});
