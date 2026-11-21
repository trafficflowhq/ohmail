/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function enter(): void {
  const active = document.activeElement!;
  const activate = fireEvent.keyDown(active, { key: "Enter" });
  if (activate && active instanceof HTMLButtonElement) fireEvent.click(active);
}

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

it("holds focus on the step while organizer checking blocks Continue, then offers Continue", async () => {
  const awaiting = { ...MAILBOX, organizerRole: "reader" as const, organizerChecked: false };
  const v = verbs();
  const s = stage({ verbs: v, ground: ground({ rows: [awaiting] }), door: "selfhost" });
  await settle();
  expect(heading()).toBe(O.resumeCheckingTitle);
  const waiting = screen.getByRole<HTMLButtonElement>("button", { name: words(O.continue) });
  expect(waiting.disabled).toBe(true);
  expect(document.activeElement).toBe(waiting.form);
  enter();
  await settle();
  expect(heading()).toBe(O.resumeCheckingTitle);
  expect(screen.queryByRole("button", { name: words(O.cancelConfirm) })).toBeNull();

  act(() => s.facts.set(ground({ rows: [{ ...awaiting, organizerChecked: true }] })));
  await settle();
  expect(heading()).toBe(O.consentTitle);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: words(O.continue) }));
});

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

  it("a second ↵ while the answer is on its way writes nothing more: the step's form waits for its write", async () => {
    let answer: () => void = () => {};
    const setAiEnabled = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    stage({ verbs: verbs({ setAiEnabled }), ground: ground({ rows: [consented] }) });
    await settle();
    expect(heading()).toBe(O.aiTitle);
    fireEvent.click(screen.getByRole("radio", { name: words(O.aiYesCloud) }));
    press(words(O.continue));
    await settle();
    expect(setAiEnabled).toHaveBeenCalledTimes(1);
    /* The answer is no press of the gate's one slot: the form's own wait alone holds a second one. */
    fireEvent.submit(screen.getByRole("heading", { level: 1 }).closest("form")!);
    await settle();
    expect(setAiEnabled).toHaveBeenCalledTimes(1);
    await act(async () => answer());
    await settle();
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

  it("opens the window on its chosen radio, moves with Arrow Up, and agrees from the new choice with Enter", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground() });
    await toWindow();
    const chosen = screen.getByRole("radio", { name: words(O.win365), checked: true });
    expect(document.activeElement).toBe(chosen);

    fireEvent.keyDown(chosen, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: words(O.win180), checked: true }));
    expect(v.organize).not.toHaveBeenCalled();
    enter();
    await settle();
    expect(v.organize.mock.calls).toEqual([
      [MAILBOX.id, { ...BODY, screening: { ...BODY.screening, dormancyDays: 180 } }],
    ]);
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

  it("the run moved to another mailbox while Agree is on its way: no factor is asked for the press it was moved under, nothing ran, and the other mailbox's run starts new", async () => {
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
    /* A run about another mailbox is a new run: it opens on its own statement, and no word of the press it was moved
       under stands on it. */
    expect(heading()).toContain(O.consentTitle);
    expect(screen.queryByText(M.cancelledNothingChanged)).toBeNull();
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

/**
 * ↵ belongs to one thing at a time, and the keys stand in it. The two questions (Close setup, Start over) are the
 * kit's dialog: asked, it takes the keys on its first answer, so ↵ answers the question and never runs the step's verb
 * behind it; Escape and Back take it back, and the keys are where the person was. Whatever was asked last has them: a
 * question asked over an open second-factor prompt, and a prompt asked from within a question.
 */
describe("the keys stand in what was asked last", () => {
  const WINDOW_CLOSED = { status: 403, code: "step_up_required", message: "Confirm it is you.", details: {} };
  const focused = (): Element | null => document.activeElement;
  const escape = (): void => void fireEvent.keyDown(focused() ?? document.body, { key: "Escape" });
  const question = (name: string): HTMLElement => screen.getByRole("dialog", { name });
  const stepForm = (): HTMLFormElement => screen.getByRole("heading", { level: 1 }).closest("form")!;

  it("Escape asks to close with the keys on its first verb, ↵'s own press there closes setup once, and taken back they are where the person was", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground() });
    await settle();
    const forward = screen.getByRole("button", { name: words(O.continue) });
    expect(focused()).toBe(forward);
    /* The person is on the foot's Cancel setup, not where the step opened. */
    const footCancel = screen.getByRole("button", { name: words(O.cancel) });
    footCancel.focus();

    escape();
    await settle();
    expect(focused()).toBe(within(question(O.cancel)).getByRole("button", { name: words(O.cancelConfirm) }));
    expect(stepForm().contains(focused())).toBe(false);

    escape();
    await settle();
    expect(screen.queryByRole("dialog", { name: O.cancel })).toBeNull();
    expect(focused()).toBe(footCancel);

    escape();
    await settle();
    fireEvent.click(focused()!);
    await settle();
    expect(v.complete).toHaveBeenCalledTimes(1);
    expect(v.organize).not.toHaveBeenCalled();
  });

  it("after Start over, Escape takes the question back with the keys where the person was, and two ↵ where the keys stand never organize the mailbox", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground() });
    await settle();
    /* Start over, pressed by the keys. */
    const over = screen.getByRole("button", { name: words(O.restart) });
    over.focus();
    fireEvent.click(over);
    await settle();
    expect(focused()).toBe(within(question(O.restart)).getByRole("button", { name: words(O.restartKeep) }));

    escape();
    await settle();
    const after = {
      asked: [O.cancel, O.restart].filter((name) => screen.queryByRole("dialog", { name }) !== null).length,
      keysOnStartOver: focused() === over,
    };
    /* Two ↵ where the keys stand. */
    for (let press = 0; press < 2; press += 1) {
      fireEvent.click(focused()!);
      await settle();
    }
    expect({
      ...after,
      organize: v.organize.mock.calls.length,
      complete: vi.mocked(v.complete).mock.calls.length,
    }).toEqual({
      asked: 0,
      keysOnStartOver: true,
      organize: 0,
      complete: 0,
    });
  });

  it("while a question stands the step behind it runs nothing: its form's submit sends nothing, and ↵ on the question's first answer closes setup once", async () => {
    const v = verbs();
    stage({ verbs: v, ground: ground() });
    await settle();
    press(words(O.continue));
    await settle();
    expect(heading()).toBe(O.windowTitle);

    escape();
    await settle();
    expect(focused()).toBe(within(question(O.cancel)).getByRole("button", { name: words(O.cancelConfirm) }));
    /* The step's own ↵, behind the question: Agree's form. */
    fireEvent.submit(stepForm());
    await settle();
    expect(v.organize).not.toHaveBeenCalled();
    expect(heading()).toBe(O.windowTitle);

    fireEvent.click(focused()!);
    await settle();
    expect(v.complete).toHaveBeenCalledTimes(1);
    expect(v.organize).not.toHaveBeenCalled();
  });

  it("a question asked while the other stands is asked anew: the foot's Start over, pressed while Close setup's question stands, puts the keys on Keep the mailbox", async () => {
    stage({ verbs: verbs(), ground: ground() });
    await settle();
    escape();
    await settle();
    expect(focused()).toBe(within(question(O.cancel)).getByRole("button", { name: words(O.cancelConfirm) }));

    const over = screen.getByRole("button", { name: words(O.restart) });
    over.focus();
    fireEvent.click(over);
    await settle();
    expect(screen.queryByRole("dialog", { name: O.cancel })).toBeNull();
    expect(focused()).toBe(within(question(O.restart)).getByRole("button", { name: words(O.restartKeep) }));
  });

  it("a question asked while a write is on its way: its first verb cannot be pressed yet, so the keys stand on its way out, in the question and never in the step's form, and stay in it once the verb can be pressed", async () => {
    let answer: (value: string) => void = () => {};
    const organize = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    const v = verbs({ organize: organize as never });
    stage({ verbs: v, ground: ground() });
    await settle();
    press(words(O.continue));
    await settle();
    press(words(O.agree));
    await settle();
    expect(organize).toHaveBeenCalledTimes(1);

    escape();
    await settle();
    const asked = question(O.cancel);
    const close = within(asked).getByRole("button", { name: words(O.cancelConfirm) }) as HTMLButtonElement;
    const out = within(asked).getByRole("button", { name: words(O.back) });
    expect(close.disabled).toBe(true);
    expect(focused()).toBe(out);
    expect(stepForm().contains(focused())).toBe(false);
    /* ↵ in the question runs nothing of the step: the press on its way stays the only one. */
    fireEvent.keyDown(focused()!, { key: "Enter" });
    await settle();
    expect(organize).toHaveBeenCalledTimes(1);

    /* The write ends with nothing stored: the step stays, the question stands, and the keys are still in it. */
    await act(async () => answer("gone"));
    await settle();
    expect(close.disabled).toBe(false);
    expect(asked.contains(focused())).toBe(true);
    expect(stepForm().contains(focused())).toBe(false);
  });

  it("a question asked over an open second-factor prompt has the keys: the prompt does not keep them ahead of it", async () => {
    const organize = vi.fn(async () => {
      throw WINDOW_CLOSED;
    });
    stage({ verbs: verbs({ organize }), ground: ground() });
    await settle();
    press(words(O.continue));
    await settle();
    press(words(O.agree));
    await settle();
    const prompt = screen.getByRole("dialog", { name: "the second factor" });
    /* The person is in the prompt. */
    within(prompt).getByRole("button", { name: "verify" }).focus();
    expect(prompt.contains(focused())).toBe(true);

    escape();
    await settle();
    expect(focused()).toBe(within(question(O.cancel)).getByRole("button", { name: words(O.cancelConfirm) }));
  });

  it("a prompt asked from within a question keeps the keys while it stands; when it leaves, the question has them again, never the step's form", async () => {
    const forgetMailbox = vi.fn(async () => {
      throw WINDOW_CLOSED;
    });
    stage({ verbs: verbs({ forgetMailbox }), ground: ground() });
    await settle();
    press(words(O.restart));
    await settle();
    const asked = question(O.restart);
    expect(focused()).toBe(within(asked).getByRole("button", { name: words(O.restartKeep) }));

    fireEvent.click(within(asked).getByRole("button", { name: words(O.restartForget) }));
    await settle();
    expect(forgetMailbox).toHaveBeenCalledTimes(1);
    const prompt = screen.getByRole("dialog", { name: "the second factor" });
    const cancel = within(prompt).getByRole("button", { name: "cancel" });
    cancel.focus();
    /* The prompt stands, asked last: nothing takes the keys out of it. */
    await settle();
    expect(focused()).toBe(cancel);

    fireEvent.click(cancel);
    await settle();
    expect(screen.queryByRole("dialog", { name: "the second factor" })).toBeNull();
    expect(question(O.restart).contains(focused())).toBe(true);
    expect(stepForm().contains(focused())).toBe(false);
    expect(forgetMailbox).toHaveBeenCalledTimes(1);
  });
});

describe("how far the run is: the kit's dots, said as one sentence", () => {
  /** The catalogue's sentence for a phase, with the step's number and the walk's length read back. */
  const said = (phase: string): RegExp =>
    new RegExp(
      `^${O.railSaid.replace("{n}", "(\\d+)").replace("{total}", "(\\d+)").replace("{phase}", phase)}$`,
    );
  const place = (phase: string): { n: number; total: number } => {
    const [, n, total] = said(phase).exec(
      screen.getByRole("img", { name: said(phase) }).getAttribute("aria-label")!,
    )!;
    return { n: Number(n), total: Number(total) };
  };

  it("names the step's place in the walk and its phase in one sentence, and moves with the walk", async () => {
    stage({ verbs: verbs(), ground: ground() });
    await settle();
    const organize = place(O.rail_organize);
    press(words(O.continue));
    await settle();
    expect(place(O.rail_history)).toEqual({ n: organize.n + 1, total: organize.total });
    expect(screen.queryByRole("list", { name: O.rail_mailbox })).toBeNull();
  });

  it("shows and says the screen count within the mailbox phase of first setup", async () => {
    stage({ verbs: verbs(), ground: ground({ rows: [] }) });
    await settle();
    press(words(O.welcomeStart));
    await settle();
    expect(screen.getByText("2/2").getAttribute("aria-hidden")).toBe("true");
    expect(
      screen.getByRole("img", { name: new RegExp(`^Step 1 of \\d+, ${O.rail_mailbox}, 2 of 2$`) }),
    ).toBeTruthy();
  });

  it("leaves out the screen count when adding a mailbox on its own", async () => {
    stage({ verbs: verbs(), ground: ground({ rows: [] }), at: "#/first-run/add" });
    await settle();
    expect(place(O.rail_mailbox).n).toBe(1);
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });
});
