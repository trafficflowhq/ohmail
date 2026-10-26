/** @vitest-environment jsdom */
/**
 * THE PLAN STEP'S WAY OUT SAYS WHAT IT DOES. "Do this later" led to the app's front door, which for an
 * account with no plan was the lapsed-account wall. It is "Not now" now, with the sentence that is true
 * of it: the account is kept and the trial waits (the wall's never-started state offers it again).
 *
 * AND THE WAIT AFTER A RETURN FROM THE ACCOUNT PAGE IS ABOUT TWO MINUTES. Ten reads 1.5 s apart gave up
 * after 15 s, while the payment program can take longer than that to report a trial started; the person
 * was told "not yet" about a trial that was on its way. The reads now back off to a 15 s gap, the screen
 * says it is starting meanwhile, and "not yet" comes at about two minutes, never "failed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};
/** What the plane's lifecycle says of an account that never started a trial. */
const NEVER_STARTED = {
  state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
};

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
/** Every `/account/access` request. */
let reads = 0;
/** Milliseconds after the mount from which the service answers open; `null` = never. */
let openAfter: number | null = null;
let mountedAt = 0;

beforeEach(() => {
  reads = 0;
  openAfter = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    // A metered host on which this account may not add a mailbox yet: the plan step.
    if (url.includes("/account/access")) {
      reads += 1;
      if (openAfter !== null && Date.now() - mountedAt >= openAfter) {
        return json(200, { access: "open", metered: true, canAddMailbox: true, mailboxes: 0 });
      }
      return json(200, { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0, lifecycle: NEVER_STARTED });
    }
    if (url.includes("/account/manage-link")) return json(200, { url: "https://plane.example/manage?token=t" });
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The wizard on its plan step; `fake` when the test drives the clock (`vi.useFakeTimers` first). */
async function atThePlanStep(messages: typeof en, props: Record<string, unknown> = {}, fake = false) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const pause = () => (fake ? vi.advanceTimersByTimeAsync(1) : new Promise((r) => setTimeout(r, 0)));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedAt = Date.now();
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true, ...props }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await pause(); });
  const close = async () => { await act(async () => root.unmount()); host.remove(); };
  unmount = close;
  /** The clock moves `ms` on, half a second at a time. */
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= 500) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(500, left)); });
  };
  const title = () => host.querySelector("h1")?.textContent ?? null;
  return { host, advance, title, close: async () => { await close(); unmount = null; } };
}

describe("the plan step's way out", () => {
  for (const messages of [en, de]) {
    it(`${messages === de ? "de" : "en"}: "Not now", to the front door, with the sentence that is true of it`, async () => {
      const { host } = await atThePlanStep(messages);
      expect(host.querySelector("h1")?.textContent).toBe(messages.join.step_plan_title);
      const out = [...host.querySelectorAll("a")].find((a) => a.textContent === messages.join.planLater);
      expect(out, "no Not now link").toBeTruthy();
      expect(out!.getAttribute("href")).toBe("/");
      expect(host.textContent).toContain(messages.join.planLaterHint);
      expect(host.textContent).not.toContain(messages.join.later);
    });
  }
});

describe("the wait after a return from the account page", () => {
  const RETURN = { billingReturn: "success" };

  it("is still waiting at a minute, says 'not yet' only at about two, in 8 to 16 reads, and keeps the button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ui = await atThePlanStep(en, RETURN, true);
    expect(ui.title()).toBe(en.join.step_plan_title);
    expect(ui.host.textContent).toContain(en.join.planStarting);
    await ui.advance(60_000);
    expect(ui.host.textContent, "gave up before two minutes").not.toContain(en.join.planPending);
    expect(ui.host.textContent).toContain(en.join.planStarting);
    await ui.advance(50_000);
    expect(ui.host.textContent, "gave up before two minutes").not.toContain(en.join.planPending);
    await ui.advance(15_000);
    expect(ui.host.textContent, "never said 'not yet'").toContain(en.join.planPending);
    expect(ui.host.textContent).not.toContain(en.join.planStarting);
    expect(ui.host.querySelector("a.btn.primary")?.textContent).toBe(en.join.planStartTrial);
    expect(reads).toBeGreaterThanOrEqual(8);
    expect(reads).toBeLessThanOrEqual(16);
    const done = reads;
    await ui.advance(120_000);
    expect(reads, "the wait is not bounded").toBe(done);
  });

  it("an answer that opens the account at about 90 s lands on the mailbox step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    openAfter = 90_000;
    const ui = await atThePlanStep(en, RETURN, true);
    await ui.advance(85_000);
    expect(ui.title()).toBe(en.join.step_plan_title);
    await ui.advance(15_000);
    expect(ui.title()).toBe(en.join.step_mailbox_title);
  });

  it("reads nothing once the step is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ui = await atThePlanStep(en, RETURN, true);
    await ui.advance(20_000);
    const before = reads;
    expect(before).toBeGreaterThan(1);
    await ui.close();
    await vi.advanceTimersByTimeAsync(150_000);
    expect(reads).toBe(before);
  });
});
