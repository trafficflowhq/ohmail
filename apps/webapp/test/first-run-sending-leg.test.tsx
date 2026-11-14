/** @vitest-environment jsdom */
import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Answered, ConnectProbed } from "@ohmail/app-logic/mailboxes/connect/types";
import { O, P, fakeDoor } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/** The hosted door's probe, as `POST /mailboxes/probe` answers it; every body it was sent. */
const mockProbe = vi.fn();
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    aiSettings: { get: async () => ({ aiEnabled: true, aiAnswered: true }), set: async () => ({ aiEnabled: true }) },
    consent: { completeOnboarding: async () => undefined },
    mailboxes: { ...actual.mailboxes, probe: (...args: unknown[]) => mockProbe(...args), create: async () => ({ id: "m" }) },
  };
});
vi.mock("../app/hello", () => ({ SELF_HOST_BUILD: false, serverHello: async () => null }));

/**
 * ═══ "TEST CONNECTION" SAYS WHAT CONNECT WILL DO — BOTH SERVERS ════════════════════════════
 *
 * A mailbox has two servers and the standalone connect dials both: the seal writes an `smtp`
 * credential beside the `imap` one and refuses the WHOLE mailbox when the submission server says
 * no. The test asked only the incoming one, so it answered a green over a connect that was about
 * to fail, and the field to correct was the one the test never touched. Three shapes reach it —
 * SMTP blocked by the network, a submission server wanting a different login, and a preset whose
 * outgoing host is wrong for that account, which nobody typed.
 */

/**
 * The verdict is READ OFF THE SCREEN, in the words a person sees: the rule that chooses the
 * sentence is a pure function with its own cases, and a rule nothing renders is a rule nobody
 * reads. A blank outgoing field keeps its own answer here — "not set up" is a state somebody
 * chose, not a failure — and a door that never asked renders nothing at all.
 *
 * MUTATIONS WATCHED RED, restored `cmp`-equal: the sending block dropped from the stage's
 * render → the three naming cases; `not_configured` mapped to the ok sentence → the blank case;
 * the refusal's host dropped from the sentence → the naming case.
 *
 * RE-POINTED (the switch's older tests, sorted once): the first run is the new frame's stage
 * (`_first-run-stage.tsx`), its mailbox step the one connect form (`packages/app/src/mailboxes/connect`,
 * the verdict drawn by `Tested.tsx`) over a wire that answers as the door does (`fakeDoor`); on the hosted door the
 * wire is the web's own (`connect-wire.ts`, `webConnectWire`) over the same `mailboxes.probe` mock. The new form asks
 * for more before a Test than today's did: a provider's tile, the address, the password and both servers; the cases
 * give them, and the door's answer is what is scripted, as before. The verdict's MARK is read as a person's reader
 * hears it: a failure is a refusal line (said as a status, with the warning sign), a pass a plain line. Every
 * expectation is as it stood.
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** What is said as a refusal (a status or an alert), line by line. */
const refusalsOf = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[role="status"], [role="alert"]')].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

interface Harness {
  el: HTMLElement;
  text: () => string;
  test: () => Promise<void>;
}

async function pressIn(el: HTMLElement, label: string): Promise<void> {
  const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
  if (!button) {
    throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
      + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
  }
  await act(async () => {
    button.click();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function typeIn(el: HTMLElement, label: string, value: string): Promise<void> {
  const input = within(el).getByLabelText(label) as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { value } }); });
}

/** A standalone run with the mailbox still to connect — the step this screen belongs to. */
async function mount(answer: ConnectProbed): Promise<Harness> {
  const wire = fakeDoor({ probe: [{ ok: true, value: answer } as Answered<ConnectProbed>] });
  const st = await mountStage({ rows: [], door: "local", connect: wire.door, verbs: { ai: "unset" } });
  const el = st.el;
  /* A run with nothing behind it opens on the welcome screen, so the mailbox step — the one that
     holds the fields and the test — is one press in. */
  await pressIn(el, "Set up a mailbox");
  /* The form asks for a provider, the address, the password and both servers before a Test. */
  await pressIn(el, P.otherLabel);
  await typeIn(el, O.address, "someone@example.test");
  await typeIn(el, O.password, "app-password-fixture");
  await typeIn(el, O.imapHost, "imap.example.test");
  await typeIn(el, O.smtpHost, "outgoing.example.test");
  return { el, text: () => el.textContent ?? "", test: () => pressIn(el, "Test connection") };
}

const RECEIVING: Omit<ConnectProbed, "sending"> = {
  host: "imap.example.test", user: "someone@example.test", folders: 7,
};

describe("the connection test states both legs", () => {
  it("a refused submission server is named, and the receiving verdict still stands", async () => {
    const rig = await mount({
      ...RECEIVING,
      sending: { state: "refused", host: "outgoing.example.test", reason: "auth" },
    });
    await rig.test();

    expect(rig.text(), "the incoming verdict was taken away by the outgoing one")
      .toContain("imap.example.test answered");
    expect(rig.text(), "the outgoing refusal was not stated at all").toContain("Sending:");
    expect(rig.text(), "the refusal named no server, so no field can be corrected")
      .toContain("outgoing.example.test");
    // The MARK matters as much as the words: a tick over a refused submission is the shape this
    // row is about. One of each — the receiving pass and the sending failure.
    const refusals = refusalsOf(rig.el);
    expect(refusals.filter((r) => r.includes("Sending:") && r.includes("outgoing.example.test")), "the sending failure is not said as one")
      .toHaveLength(1);
    expect(refusals.filter((r) => r.includes("imap.example.test answered")), "the receiving pass is said as a failure").toEqual([]);
  });

  it("an accepted submission server says so, naming the host that answered", async () => {
    const rig = await mount({ ...RECEIVING, sending: { state: "ok", host: "smtp.example.test" } });
    await rig.test();

    expect(rig.text()).toContain("smtp.example.test accepted the same login");
    expect(refusalsOf(rig.el).filter((r) => r.includes("Sending:") || r.includes("answered")), "an accepted leg rendered a failure").toEqual([]);
  });

  it("nothing on the outgoing side is an ANSWER — no cross, and it says what it costs", async () => {
    const rig = await mount({ ...RECEIVING, sending: { state: "not_configured" } });
    await rig.test();

    expect(rig.text()).toContain("Sending: not set up");
    expect(rig.text(), "a mailbox that cannot send was not told so").toContain("nothing can be sent from it");
    expect(refusalsOf(rig.el).filter((r) => r.includes("Sending:") || r.includes("answered")), "a legitimate pair was marked as a failure").toEqual([]);
  });

  /* THE CONTROL. A door that tested only the incoming server answers no `sending` at all, and the
     stage must say NOTHING about sending rather than invent a verdict — absent is not "fine". */
  it("a door that did not ask about sending says nothing about it", async () => {
    const rig = await mount({ ...RECEIVING });
    await rig.test();

    expect(rig.text(), "the incoming verdict did not render at all").toContain("imap.example.test answered");
    expect(rig.text(), "a verdict was invented for a leg nobody tested").not.toContain("Sending:");
  });
});

/**
 * ON CLOUD THE TEST ASKS BOTH SERVERS TOO. The hosted door's host sent only the incoming block, so a
 * green test promised a connect the outgoing server was about to refuse. It sends the outgoing
 * block the connect sends, without its password, and the stage says the answer.
 */
describe("the hosted door's connection test", () => {
  it("sends the outgoing server and renders its verdict", async () => {
    const { webConnectWire } = await import("../app/(product)/mailbox/connect-wire");
    mockProbe.mockResolvedValue({
      ok: true, host: "imap.gmail.com", user: "pat@gmail.test", folders: 4,
      sending: { state: "refused", host: "smtp.gmail.com", reason: "auth" },
    });
    const st = await mountStage({
      rows: [], at: "#/first-run/add", door: "cloud", verbs: { ai: "on" },
      connect: webConnectWire({ owner: () => null, returned: "page" }),
    });
    const el = st.el;
    /* The form asks for a provider before its fields: Gmail's tile, whose outgoing server is Google's. */
    await pressIn(el, "Gmail");
    for (const [label, value] of [[O.address, "pat@gmail.test"], [O.password, "app-password-fixture"]] as const) {
      await typeIn(el, label, value);
    }
    await pressIn(el, O.test);

    const sent = mockProbe.mock.calls[0]![0] as { smtp?: Record<string, unknown> };
    expect(sent.smtp, "the outgoing server was not asked about").toMatchObject({ host: "smtp.gmail.com" });
    expect(sent.smtp, "the password travelled in the outgoing block").not.toHaveProperty("pass");
    expect(el.textContent).toContain(O.sendingRefusedAuth.replace("{host}", "smtp.gmail.com"));
  });
});
