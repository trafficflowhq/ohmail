/** @vitest-environment jsdom */
import { describe, expect, it, afterEach, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost, FirstRunProbeOk } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

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
 */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A standalone run with the mailbox still to connect — the step this screen belongs to. */
const facts: OnboardingFacts = {
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
};

interface Harness {
  el: HTMLElement;
  text: () => string;
  test: () => Promise<void>;
}

async function mount(answer: FirstRunProbeOk): Promise<Harness> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door: "local",
    ai: "unset",
    probe: async () => answer,
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => { /* nothing to finish here */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts,
          onRefresh: () => { /* the facts do not move in these cases */ },
          onLeave: () => { /* nobody leaves */ },
          pull: { screened: 0, history: 0, pulled: 0 },
          decide: null,
          mailboxId: null,
        }),
      }),
    }));
  });

  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) {
      throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
        + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };

  /* A run with nothing behind it opens on the welcome screen, so the mailbox step — the one that
     holds the fields and the test — is one press in. */
  await press("Set up a mailbox");

  return { el, text: () => el.textContent ?? "", test: () => press("Test connection") };
}

const RECEIVING: Omit<FirstRunProbeOk, "sending"> = {
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
    expect([...rig.el.querySelectorAll(".set-verdict")].map((v) => v.className))
      .toEqual(expect.arrayContaining([expect.stringContaining("ok"), expect.stringContaining("bad")]));
  });

  it("an accepted submission server says so, naming the host that answered", async () => {
    const rig = await mount({ ...RECEIVING, sending: { state: "ok", host: "smtp.example.test" } });
    await rig.test();

    expect(rig.text()).toContain("smtp.example.test accepted the same login");
    expect(rig.el.querySelector(".set-verdict.bad"), "an accepted leg rendered a failure").toBeNull();
  });

  it("nothing on the outgoing side is an ANSWER — no cross, and it says what it costs", async () => {
    const rig = await mount({ ...RECEIVING, sending: { state: "not_configured" } });
    await rig.test();

    expect(rig.text()).toContain("Sending: not set up");
    expect(rig.text(), "a mailbox that cannot send was not told so").toContain("nothing can be sent from it");
    expect(rig.el.querySelector(".set-verdict.bad"), "a legitimate pair was marked as a failure").toBeNull();
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
    const { useCloudFirstRun } = await import("../app/(product)/mailbox/useCloudFirstRun");
    mockProbe.mockResolvedValue({
      ok: true, host: "imap.gmail.com", user: "pat@gmail.test", folders: 4,
      sending: { state: "refused", host: "smtp.gmail.com", reason: "auth" },
    });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    const Stage = () => {
      const host = useCloudFirstRun(false);
      return host ? h(FirstRun, {
        host, facts: { ...facts, door: "cloud", ai: "on" }, add: true,
        onRefresh: () => {}, onLeave: () => {}, pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: null,
      }) : null;
    };
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", children: h(KeymapProvider, { children: h(Stage) }),
      }));
    });
    for (const [suffix, value] of [["address", "pat@gmail.test"], ["pass", "app-password-fixture"]]) {
      const input = el.querySelector<HTMLInputElement>(`input[id$='-${suffix}']`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const test = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === messages.onboarding.test)!;
    await act(async () => { test.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });

    const sent = mockProbe.mock.calls[0]![0] as { smtp?: Record<string, unknown> };
    expect(sent.smtp, "the outgoing server was not asked about").toMatchObject({ host: "smtp.gmail.com" });
    expect(sent.smtp, "the password travelled in the outgoing block").not.toHaveProperty("pass");
    expect(el.textContent).toContain(messages.onboarding.sendingRefusedAuth.replace("{host}", "smtp.gmail.com"));
  });
});
