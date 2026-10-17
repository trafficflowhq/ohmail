/** @vitest-environment jsdom */
/**
 * THE PLAN STEP'S WAY OUT SAYS WHAT IT DOES. "Do this later" led to the app's front door, which for an
 * account with no plan was the lapsed-account wall. It is "Not now" now, with the sentence that is true
 * of it: the account is kept and the trial waits (the wall's never-started state offers it again).
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

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    // A metered host on which this account may not add a mailbox yet: the plan step.
    if (url.includes("/account/access")) {
      return json(200, { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0 });
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
  vi.restoreAllMocks();
});

async function atThePlanStep(messages: typeof en) {
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
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: messages === de ? "de" : "en", messages, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  return host;
}

describe("the plan step's way out", () => {
  for (const messages of [en, de]) {
    it(`${messages === de ? "de" : "en"}: "Not now", to the front door, with the sentence that is true of it`, async () => {
      const host = await atThePlanStep(messages);
      expect(host.querySelector("h1")?.textContent).toBe(messages.join.step_plan_title);
      const out = [...host.querySelectorAll("a")].find((a) => a.textContent === messages.join.planLater);
      expect(out, "no Not now link").toBeTruthy();
      expect(out!.getAttribute("href")).toBe("/");
      expect(host.textContent).toContain(messages.join.planLaterHint);
      expect(host.textContent).not.toContain(messages.join.later);
    });
  }
});
