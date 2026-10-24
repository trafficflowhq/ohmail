/** @vitest-environment jsdom */
/**
 * THE PLAN CHOSEN ON THE SITE REACHES THE PLAN STEP. The site's tier buttons link `/join?plan=…`, and
 * the wizard read only `?code` and `?billing`: the choice was dropped at the door, and the verification
 * link (which comes back to `/join` without the query) would have dropped it again. It is read from
 * closed sets, kept in this browser through the mail round trip, named on the plan step beside the
 * trial (14 days free, no card, never a price), sent with the page's language when the account page
 * is minted, and forgotten once the trial has started.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const KEY = "ohmail.signup.plan";
const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
/** Each mint's body, as the API would read it. */
let mints: Array<Record<string, unknown>> = [];
/** What `/account/access` answers: refused until the test says the trial started. */
let entitled = false;

beforeEach(() => {
  mints = [];
  entitled = false;
  localStorage.clear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    if (url.includes("/account/access")) {
      return json(200, entitled
        ? { access: "ok", metered: true, canAddMailbox: true, mailboxes: 0 }
        : { access: "refused", metered: true, canAddMailbox: false, mailboxes: 0 });
    }
    if (url.includes("/account/manage-link")) {
      mints.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return json(200, { url: "https://plane.example/manage?token=t" });
    }
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

async function join(messages: typeof en, props: Record<string, unknown> = {}) {
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
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true, ...props }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const close = async () => { await act(async () => root.unmount()); host.remove(); };
  unmount = close;
  const trial = () => host.querySelector('[data-testid="join-plan-trial"]')?.textContent ?? null;
  return { host, trial, close: async () => { await close(); unmount = null; } };
}

describe("/join reads ?plan and ?interval from closed sets", () => {
  it("members pass, anything else is no hint, and a repeated value keeps its first", async () => {
    const { default: JoinPage } = await import("../app/(product)/join/page.js");
    const hintOf = async (q: Record<string, string | string[]>) =>
      ((await JoinPage({ searchParams: Promise.resolve(q) })) as { props: { planHint: unknown } }).props.planHint;
    expect(await hintOf({ plan: "pro", interval: "year" })).toEqual({ plan: "pro", interval: "year" });
    expect(await hintOf({ plan: "solo" })).toEqual({ plan: "solo" });
    expect(await hintOf({ plan: "gold", interval: "week" })).toEqual({});
    expect(await hintOf({ plan: "Pro", interval: "YEAR" })).toEqual({});
    expect(await hintOf({ plan: ["plus", "pro"], interval: ["month", "year"] })).toEqual({ plan: "plus", interval: "month" });
    expect(await hintOf({})).toEqual({});
  });

  it("the web's sets are the API's, member for member", async () => {
    const { PLAN_HINT_PLANS, PLAN_HINT_INTERVALS } = await import("../app/plan-hint.js");
    const src = read("packages/db/src/entitlements-port.ts");
    const members = (name: string): string[] => {
      const block = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(src);
      expect(block, `${name} is no longer an \`export const … as const\` — rewrite this guard`).not.toBeNull();
      return [...block![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    };
    expect([...PLAN_HINT_PLANS]).toEqual(["solo", "plus", "pro"]);
    expect(members("PLAN_HINT_PLANS")).toEqual([...PLAN_HINT_PLANS]);
    expect(members("PLAN_HINT_INTERVALS")).toEqual([...PLAN_HINT_INTERVALS]);
  });
});

describe("the plan step names the site's choice beside the trial, and the account page is asked for it", () => {
  it("en: Pro, yearly: named, 14 days free, no card, no price; the mint carries {lang, plan, interval}", async () => {
    const { trial } = await join(en, { planHint: { plan: "pro", interval: "year" } });
    expect(trial()).toBe("You chose Pro, billed yearly. 14 days free, no card.");
    expect(trial()).not.toMatch(/[$€£]|CHF|\d+[.,]\d\d/);
    expect(mints).toEqual([{ lang: "en", plan: "pro", interval: "year" }]);
  });

  it("de: the same choice in German, and the page is asked for in German", async () => {
    const { trial } = await join(de, { planHint: { plan: "solo", interval: "month" } });
    expect(trial()).toBe("Du hast Solo gewählt, mit monatlicher Abrechnung. 14 Tage gratis, ohne Karte.");
    expect(mints).toEqual([{ lang: "de", plan: "solo", interval: "month" }]);
  });

  it("a plan without an interval is named alone; no hint at all still says what the trial is", async () => {
    const one = await join(en, { planHint: { plan: "plus" } });
    expect(one.trial()).toBe("You chose Plus. 14 days free, no card.");
    expect(mints).toEqual([{ lang: "en", plan: "plus" }]);
    await one.close();
    localStorage.clear();
    mints = [];
    const none = await join(en);
    expect(none.trial()).toBe(en.join.planTrial);
    expect(mints).toEqual([{ lang: "en" }]);
  });
});

describe("the choice survives the verification mail's round trip", () => {
  it("kept from the first /join, recalled when /join comes back without the query", async () => {
    const first = await join(en, { planHint: { plan: "pro", interval: "year" } });
    await first.close();
    mints = [];
    const back = await join(en);
    expect(back.trial()).toBe("You chose Pro, billed yearly. 14 days free, no card.");
    expect(mints).toEqual([{ lang: "en", plan: "pro", interval: "year" }]);
  });

  it("a kept hint older than a week, or one that is not a member, is no hint", async () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    localStorage.setItem(KEY, JSON.stringify({ plan: "pro", interval: "year", at: Date.now() - week - 60_000 }));
    const stale = await join(en);
    expect(stale.trial()).toBe(en.join.planTrial);
    await stale.close();
    localStorage.setItem(KEY, JSON.stringify({ plan: "enterprise", interval: "decade", at: Date.now() }));
    mints = [];
    const odd = await join(en);
    expect(odd.trial()).toBe(en.join.planTrial);
    expect(mints).toEqual([{ lang: "en" }]);
  });

  it("forgotten once the trial has started: the return from the account page clears it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ plan: "pro", interval: "year", at: Date.now() }));
    entitled = true;
    const { host } = await join(en, { billingReturn: "success" });
    expect(host.querySelector("h1")?.textContent).not.toBe(en.join.step_plan_title);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
