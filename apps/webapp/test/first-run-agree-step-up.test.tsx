/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import type { FirstRunOrganized } from "../../../packages/app/src/host/payloads.js";
import { D, O, P, factorButtons, fakeDoor, id, no, refusal } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage, stageRow } from "./_first-run-stage.js";

/**
 * AGREE MEETS THE DOOR'S SECOND-FACTOR CHECK. On the self-hosted server the consent
 * route is step-up gated; past the window it answered 403 and setup stepped back to the consent
 * statement with no sentence and no code prompt, and Close setup then said "what you agreed to
 * stays agreed". Now the step stays, says so, asks with the host's prompt and presses once more.
 * HOW TO WATCH IT FAIL: drop `{ stayOnFailure: true }` from the Agree press in `FirstRun.tsx`.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`) over a ground the case moves (`_first-run-stage.tsx`),
 * its words the stage's catalogue; the host's code prompt is the stage's factor slot (its presses
 * "verify" and "cancel"); Start over's question is the stage's dialog. Every expectation is as it stood.
 * Two cases left for the new parts' own: a second refusal after the code (the stage's "never twice",
 * `packages/app/test/mailboxes/first-run/stage.test.tsx`) and Test connection and Connect over the code (the
 * mailbox step is the connect form: `packages/app/test/mailboxes/connect/form.test.tsx`, "the second factor, asked
 * in place and once").
 */

const t = O;
const VERIFY = "verify";
const CANCEL = "cancel";

const stepUp = (): Error => Object.assign(new Error("step-up required"), {
  status: 403, code: "step_up_required", message: "Confirm it is you.", details: {},
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** A consented mailbox another install holds: a re-run reaches "Organize here instead" one Back from consent. */
const TAKEN = {
  organizedBy: { kind: "local", name: "Office laptop", since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held", organizeConsentedAt: "2026-09-01T08:00:00.000Z",
} as const;

async function mount(
  answers: Array<"step_up" | FirstRunOrganized>,
  opts: {
    mailbox?: Partial<FirstRunRow> | null; rerun?: boolean;
    /** What Forget answers, in order; `ok` once these run out. */
    forget?: Array<"step_up" | "ok">;
    /** Holds every Forget's answer until it settles: a press in flight while the person moves on. */
    forgetHeld?: Promise<void>;
  } = {},
) {
  let rows: readonly FirstRunRow[] = opts.mailbox === null ? [] : [stageRow({
    initialImportCompletedAt: "2026-09-26T09:29:00.000Z", importOver: true,
    ...(opts.mailbox as Partial<FirstRunRow> | undefined),
  })];
  const presses: Array<Record<string, unknown>> = [];
  const tried = { forget: 0 };
  const factors: Parameters<typeof factorButtons>[0] = { asks: [] };
  const st = await mountStage({
    rows,
    at: opts.rerun ? "#/first-run/again?mailbox=mb-1" : "#/first-run",
    door: "selfhost",
    factor: factorButtons(factors),
    live: () => rows,
    verbs: {
      // AI already answered, so Agree walks straight on to Done.
      ai: "off",
      forgetMailbox: async () => {
        if (opts.forgetHeld) await opts.forgetHeld;
        tried.forget += 1;
        if (opts.forget?.shift() === "step_up") throw stepUp();
        rows = [];
      },
      organize: async (_id, body) => {
        presses.push(body as Record<string, unknown>);
        const a = answers.shift() ?? "stored";
        if (a === "step_up") throw stepUp();
        if (a === "stored") rows = rows.map((r) => ({ ...r, organizeConsentedAt: "2026-09-26T09:31:00.000Z" }));
        return a;
      },
      complete: async () => { /* stamped */ },
      setAiEnabled: async () => { /* answered */ },
      probeMessage: () => null,
    },
  });
  const el = st.el;
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  await act(settle);
  return {
    heading: st.heading,
    text: () => el.textContent ?? "",
    has: (label: string) => button(label) !== undefined,
    readMailbox: async (mailbox: Partial<FirstRunRow>) => {
      rows = rows.map((row) => ({ ...row, ...mailbox }));
      await st.move(rows);
    },
    /** A press inside Start over's question: its Back, not the step foot's. */
    pressInConfirm: async (label: string) => {
      const ask = [...el.querySelectorAll("[role='dialog'], [role='alertdialog']")]
        .filter((d) => (d.textContent ?? "").includes(t.restartWhat)).pop();
      const b = [...(ask?.querySelectorAll("button") ?? [])]
        .find((x) => (x.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
      if (!b) throw new Error(`no confirm button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); await settle(); });
    },
    press: async (label: string) => {
      const b = button(label);
      if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); await settle(); });
    },
    presses, tried, factors,
  };
}

async function toWindow(s: Awaited<ReturnType<typeof mount>>) {
  await s.press(t.continue);
  expect(s.heading()).toBe(t.windowTitle);
}

describe("Agree over the door's second-factor check", () => {
  it("403 step_up_required: the step stays, says so, and asks for the code", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.heading(), "setup stepped back in silence").toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowStepUp);
    expect(s.has(VERIFY), "no code prompt").toBe(true);
  });

  it("a verified code presses once more, and setup goes on", async () => {
    const s = await mount(["step_up", "stored"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press(VERIFY);
    expect(s.presses, "the same press ran twice").toHaveLength(2);
    expect(s.presses[1]).toEqual(s.presses[0]);
    expect(s.heading()).not.toBe(t.windowTitle);
    expect(s.heading()).not.toBe(t.consentTitle);
  });

  it("a second refusal after the code is said, and is not asked again", async () => {
    const s = await mount(["step_up", "step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press(VERIFY);
    expect(s.presses).toHaveLength(2);
    expect(s.presses[1]).toEqual(s.presses[0]);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.text()).toContain(D.stepUpExpired);
    expect(s.has(VERIFY)).toBe(false);
  });

  it("each asks for the code, is pressed once more on a verified code, and a cancel stores nothing", async () => {
    const refused = no({ ...refusal("step_up_required"), status: 403 });
    const wire = fakeDoor({
      probe: [refused, { ok: true, value: { host: "imap.example.test", user: "test@example.test", folders: 2 } }],
      connect: [refused, refused, { ok: true, value: { mailboxId: id("mb-2"), address: null } }],
    });
    const s = await mountStage({ rows: [], at: "#/first-run/add", door: "selfhost", connect: wire.door });
    await s.press(P.otherLabel);
    for (const [label, text] of [[O.address, "test@example.test"], [O.password, "app-password-fixture"], [O.imapHost, "imap.example.test"], [O.smtpHost, "smtp.example.test"]]) {
      const input = within(s.el).getByLabelText(label);
      await act(async () => fireEvent.change(input, { target: { value: text } }));
    }
    await s.press(O.test);
    await s.press(VERIFY);
    expect(wire.of("probe").map((call) => call.sent)).toEqual([wire.of("probe")[0]!.sent, wire.of("probe")[0]!.sent]);
    await s.press(O.connect);
    await s.press(CANCEL);
    expect(wire.of("connect")).toHaveLength(1);
    expect(within(s.el).queryByRole("dialog", { name: "the second factor" })).toBeNull();
    await s.press(O.connect);
    await s.press(VERIFY);
    expect(wire.of("connect")).toHaveLength(3);
    expect(wire.of("connect")[2]!.sent).toEqual(wire.of("connect")[1]!.sent);
  });

  it("CONTROL: an answer that stores goes on with no prompt", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.presses).toHaveLength(1);
    expect(s.has(VERIFY)).toBe(false);
    expect(s.heading()).not.toBe(t.windowTitle);
  });

  it("Done after Agree on a mailbox nothing holds says organizing is starting, not 'it reads'", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    // AI, then the pull or Done: walk forward until Done.
    for (let i = 0; i < 4 && s.heading() !== t.doneReaderTitle && s.heading() !== t.doneTitle; i++) {
      if (s.has(t.continue)) await s.press(t.continue);
      else if (s.has(t.pullLeave)) await s.press(t.pullLeave);
    }
    expect(s.text()).toContain(t.doneStartLands);
    expect(s.text(), "Done said this computer only reads").not.toContain(t.doneReaderReads);
  });

  it("Close setup after a refused Agree does not say anything was agreed", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press(CANCEL);
    await s.press(t.cancel);
    expect(s.text()).toContain(t.cancelWhatNothingAgreed);
    expect(s.text()).not.toContain(t.cancelWhat);
  });
});

describe("Organize here instead over the door's second-factor check", () => {
  it("allows the second factor when setup itself opens on Organize here instead", async () => {
    const s = await mount(["step_up", "stored"], { mailbox: { ...TAKEN, organizeConsentedAt: null } });
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.readMailbox(TAKEN);
    expect(s.heading()).toBe(t.elsewhereTitle);

    await s.press(t.continue);

    expect(s.presses).toEqual([{ intent: "takeover" }]);
    expect(s.heading()).toBe(t.elsewhereTitle);
    expect(s.has(VERIFY)).toBe(true);
    await s.press(VERIFY);
    expect(s.presses).toEqual([{ intent: "takeover" }, { intent: "takeover" }]);
    expect(s.text()).toContain(t.elsewhereQueued);
  });

  async function toTheTakeover(answers: Array<"step_up" | FirstRunOrganized>) {
    const s = await mount(answers, { mailbox: TAKEN, rerun: true });
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.back);
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.press(t.continue);
    return s;
  }

  it("403 step_up_required: the screen stays, says so, and asks for the code", async () => {
    const s = await toTheTakeover(["step_up"]);
    expect(s.presses).toEqual([{ intent: "takeover" }]);
    expect(s.heading(), "the take-over left its screen").toBe(t.elsewhereTitle);
    expect(s.text()).toContain(t.elsewhereStepUp ?? "elsewhereStepUp");
    expect(s.has(VERIFY), "no code prompt").toBe(true);
  });

  it("a verified code takes it over once more; a second refusal is said, not asked again", async () => {
    const s = await toTheTakeover(["step_up", "stored"]);
    await s.press(VERIFY);
    expect(s.presses).toEqual([{ intent: "takeover" }, { intent: "takeover" }]);
    expect(s.text()).toContain(t.elsewhereQueued);

    const again = await toTheTakeover(["step_up", "step_up"]);
    await again.press(VERIFY);
    expect(again.presses).toHaveLength(2);
    expect(again.has(VERIFY), "a second prompt: the retry is once").toBe(false);
  });

  it("Cancel presses nothing, and the sentence says nothing changed", async () => {
    const s = await toTheTakeover(["step_up"]);
    await s.press(CANCEL);
    expect(s.presses).toHaveLength(1);
    expect(s.has(VERIFY)).toBe(false);
    expect(s.text()).toContain(t.elsewhereStepUp ?? "elsewhereStepUp");
  });
});

describe("Start over's Forget over the door's second-factor check", () => {
  async function forgetOnWindow(forget: Array<"step_up" | "ok">) {
    const s = await mount([], { forget });
    await toWindow(s);
    await s.press(t.restart);
    await s.press(t.restartForget);
    return s;
  }

  it("403 step_up_required: the step stays, says so, and asks for the code", async () => {
    const s = await forgetOnWindow(["step_up"]);
    expect(s.tried.forget).toBe(1);
    expect(s.heading(), "setup said it started empty").toBe(t.windowTitle);
    expect(s.text()).toContain(t.forgetStepUp ?? "forgetStepUp");
    expect(s.has(VERIFY), "no code prompt").toBe(true);
  });

  it("a verified code forgets once more and lands on the first step", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    await s.press(VERIFY);
    expect(s.tried.forget).toBe(2);
    /* The kit draws a title's closing full stop as its end dot (a mark, not a letter). */
    expect(s.text()).toContain(t.welcomeTitle.replace(/\.$/, ""));
    expect(s.text()).not.toContain(t.forgetStepUp ?? "forgetStepUp");
  });

  it("Keep the mailbox after a refused Forget disarms the prompt: walking back to the step forgets nothing", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    expect(s.has(VERIFY)).toBe(true);
    await s.press(t.restartKeep);
    expect(s.has(VERIFY), "the forget prompt stayed armed after Keep").toBe(false);
    for (let i = 0; i < 4 && s.heading() !== t.windowTitle; i++) await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.has(VERIFY), "the forget prompt came back on How far back").toBe(false);
    expect(s.tried.forget, "the kept mailbox was forgotten").toBe(1);
    expect(s.text()).not.toContain(t.welcomeTitle.replace(/\.$/, ""));
  });

  it("the confirm's Back after a refused Forget closes the forget prompt with it", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    await s.pressInConfirm(t.back);
    expect(s.has(VERIFY), "the forget prompt outlived its confirm").toBe(false);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.tried.forget).toBe(1);
  });

  it("the confirm's Back while the Forget is in flight: its later step-up refusal opens no prompt", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Agree then fails for a reason of its own ("gone"), so the step stays with a sentence up.
    const s = await mount(["gone"], { forget: ["step_up", "ok"], forgetHeld: held });
    await toWindow(s);
    await s.press(t.restart);
    await s.press(t.restartForget);
    await s.pressInConfirm(t.back);
    expect(s.tried.forget, "the Forget answered before Back").toBe(0);
    await act(async () => { release(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    expect(s.tried.forget).toBe(1);
    expect(s.has(VERIFY), "the withdrawn Forget's refusal opened a code prompt").toBe(false);
    expect(s.factors.asks, "a withdrawn Forget must never reach the factor dialog").toHaveLength(0);
    await s.press(t.agree);
    expect(s.has(VERIFY), "a code prompt for the withdrawn Forget").toBe(false);
    if (s.has(VERIFY)) await s.press(VERIFY);
    expect(s.tried.forget, "a later code forgot the kept mailbox").toBe(1);
    expect(s.text()).not.toContain(t.welcomeTitle.replace(/\.$/, ""));
  });

  it("Escape over Start over's confirm withdraws the Forget, and its prompt with it", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    expect(s.has(VERIFY)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      for (let i = 0; i < 16; i++) await Promise.resolve();
    });
    expect(s.text()).not.toContain(t.restartWhat);
    expect(s.has(VERIFY), "the forget prompt outlived Escape").toBe(false);
    expect(s.tried.forget).toBe(1);
  });

  it("Cancel forgets nothing more and the sentence stays", async () => {
    const s = await forgetOnWindow(["step_up"]);
    await s.press(CANCEL);
    expect(s.tried.forget).toBe(1);
    expect(s.has(VERIFY)).toBe(false);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.text()).toContain(t.forgetStepUp ?? "forgetStepUp");
  });
});
