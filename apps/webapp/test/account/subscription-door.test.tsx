/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountLifecycle } from "../../app/api-client";
import { NONE } from "@ohmail/app/host";
import type { SubscriptionModel } from "@ohmail/app/account";
import { fillOver, TextProvider, type Messages } from "@ohmail/app/text";
import { useSubscription } from "../../../../packages/app/src/account/subscription/index.js";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { ConsentContext, useConsentState } from "@ohmail/app-logic/consent";
import { fakeHost, NO_ENGINE } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../../packages/app/test/support/fake-window.js";
import ownDe from "../../../../packages/app/messages/account-subscription.de.json";
import ownEn from "../../../../packages/app/messages/account-subscription.en.json";
import { de, en, json, OFFLINE, published, refusal, serve, settle, type Server } from "./storage-harness";
import { NEAR, open } from "./storage-fixtures";

/**
 * SETTINGS › SUBSCRIPTION OVER THE WEB'S OWN FILLING (`subscription-door.ts`): the address is made by the press and
 * never by the mount; it leaves in this tab with no referrer; no address takes the pane away; a mint that threw is
 * said; the address itself is in no node, no model and no log; the standing is the access answer the shell holds,
 * for the account it hands in. Plans only carry prices supplied in that answer.
 */

const MINT = "POST /api/account/manage-link";
const PAGE = "https://pay.example.com/manage/t-subscription";

let server: Server;
let access: Record<string, unknown> = open(NEAR);
let drawnModel: SubscriptionModel | null = null;
beforeEach(() => {
  access = open(NEAR);
  drawnModel = null;
  server = serve(() => access);
});
afterEach(() => {
  cleanup();
  server.restore();
});

const TEXT: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...en, ...ownEn } as Messages,
  de: fillOver({ ...en, ...ownEn } as Messages, { ...de, ...ownDe } as Messages),
};
function Words({ lang = "en", children }: { readonly lang?: "en" | "de"; readonly children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={lang} messages={lang === "en" ? en : de} timeZone="UTC">
      <TextProvider locale={lang} messages={TEXT[lang]} timeZone="UTC">
        {children}
      </TextProvider>
    </NextIntlClientProvider>
  );
}

async function filled(withdraw: () => void = () => {}, scope: string | null = null) {
  const { useSubscriptionDoor } = await import("../../app/(product)/mailbox/subscription-door");
  return renderHook(() => useSubscriptionDoor(scope, withdraw), { wrapper: Words });
}
/** The mounted Settings place and the web section the host offers with its access answer. */
async function mounted(withdraw: () => void = () => {}) {
  const [{ useSubscriptionDoor }, { MailFrame }, { WEB_PANE_PARTS }, { SubscriptionSection }] = await Promise.all([
    import("../../app/(product)/mailbox/subscription-door"),
    import("../../app/shell/browser-mail"),
    import("../../app/(product)/mailbox/pane-parts"),
    import("../../app/(product)/mailbox/SubscriptionSection"),
  ]);
  await published();
  server.forget();
  const { host } = fakeHost({
    scope: "subscription-test",
    engine: NO_ENGINE,
    service: "managed",
    address: fakeAddress("#/settings/billing"),
    places: { settings: mailSettings({
      ...NO_PANE_PARTS,
      billing: WEB_PANE_PARTS.billing,
      billingHasFoot: WEB_PANE_PARTS.billingHasFoot,
    }) },
    features: {
      subscription: { name: "subscription", render: (sheet) => <SubscriptionSection onNowhere={withdraw} sheet={sheet} /> },
    },
  });
  function SubscriptionFrame() {
    const consent = useConsentState(false, host.session.scope, NONE);
    drawnModel = useSubscription(useSubscriptionDoor(null, withdraw));
    return <ConsentContext.Provider value={consent}><MailFrame host={host} /></ConsentContext.Provider>;
  }
  await (await import("@ohmail/app/mail")).prepareWriting();
  const view = render(
    <Words>
      <ThemeProvider>
        <ToastHost>
          <SubscriptionFrame />
        </ToastHost>
      </ThemeProvider>
    </Words>,
  );
  await screen.findByRole("button", { name: en.settings.subscriptionManage });
  return view;
}
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en.settings.subscriptionManage }));
  });
  await settle();
};

describe("the door's answers to the press (each read in the shipped section's order)", () => {
  const cases: [string, Response | typeof OFFLINE, string, boolean][] = [
    ["an address leaves", json({ url: PAGE }), "left", false],
    ["an empty address is no page here", json({ url: "" }), "nowhere", true],
    ["an answer without an address is no page here", json({}), "nowhere", true],
    ["a 404 is no page here", refusal(404, "not_found"), "nowhere", true],
    ["an address not confirmed could not open", refusal(403, "email_unverified"), "failed", false],
    ["the server broke", refusal(500, "internal"), "failed", false],
    ["no server answered", OFFLINE, "failed", false],
  ];
  for (const [what, answer, outcome, withdrawn] of cases) {
    it(what, async () => {
      const withdraw = vi.fn();
      server.answer(MINT, answer);
      const { result } = await filled(withdraw);
      let got: unknown = null;
      await act(async () => {
        got = await result.current.manage();
      });
      expect(got).toBe(outcome);
      expect(withdraw).toHaveBeenCalledTimes(withdrawn ? 1 : 0);
      expect(server.on(MINT).map((s) => s.body)).toEqual([{ lang: "en" }]);
      expect(server.left).toEqual(outcome === "left" ? [{ href: PAGE, rel: "noreferrer", target: "" }] : []);
    });
  }

  it("carries the plan and the interval it was handed, and drops what their closed sets do not hold", async () => {
    server.answer(MINT, json({ url: PAGE }), json({ url: PAGE }));
    const { result } = await filled();
    await act(async () => {
      await result.current.manage({ plan: "plus", interval: "year" });
      await result.current.manage({ plan: "gold", interval: "decade" } as never);
    });
    expect(server.on(MINT).map((s) => s.body)).toEqual([{ lang: "en", plan: "plus", interval: "year" }, { lang: "en" }]);
  });

  it("opens the page in this screen's language", async () => {
    const { useSubscriptionDoor } = await import("../../app/(product)/mailbox/subscription-door");
    server.answer(MINT, json({ url: PAGE }));
    const { result } = renderHook(() => useSubscriptionDoor(null, () => {}), {
      wrapper: ({ children }) => <Words lang="de">{children}</Words>,
    });
    await act(async () => {
      await result.current.manage();
    });
    expect(server.on(MINT).map((s) => s.body)).toEqual([{ lang: "de" }]);
  });

  it("has no read of the plans before the matching access answer", async () => {
    const { result } = await filled();
    expect(result.current.plans).toBe(NONE);
  });
});

describe("the press over the real filling", () => {
  it("shows the offered plan prices and carries the chosen plan to checkout", async () => {
    access = { ...open(NEAR), trialProgress: { day: 6, total: 14 } };
    server.answer(MINT, json({ url: PAGE }));
    await mounted();
    expect(await screen.findByText("6 of 14")).toBeTruthy();
    expect(await screen.findByText("$15")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Monthly" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Yearly" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Plus/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Subscribe to Plus" }));
    });
    expect(server.on(MINT).map((request) => request.body)).toEqual([
      { lang: "en", plan: "plus", interval: "month" },
    ]);
  });

  it("makes no address by being drawn, and asks nothing to draw the pane", async () => {
    await mounted();
    expect(screen.getByRole("button", { name: en.settings.subscriptionManage })).toBeTruthy();
    await settle();
    expect(server.sent).toEqual([]);
  });

  it("makes the address by the press, once, and leaves in this tab with no referrer", async () => {
    server.answer(MINT, json({ url: PAGE }));
    await mounted();
    await press();
    expect(server.sent.map((s) => [s.line, s.keys])).toEqual([[MINT, ["lang"]]]);
    expect(server.left).toEqual([{ href: PAGE, rel: "noreferrer", target: "" }]);
  });

  it("takes the pane away where no address came, and says nothing", async () => {
    const withdraw = vi.fn();
    server.answer(MINT, json({ url: "" }));
    await mounted(withdraw);
    await press();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(en.settings.subscriptionManageFailed);
    expect(server.left).toEqual([]);
  });

  it("says a mint that threw, and the next press makes the address again", async () => {
    server.answer(MINT, refusal(500, "internal"), json({ url: PAGE }));
    await mounted();
    await press();
    expect(document.body.textContent).toContain(en.settings.subscriptionManageFailed);
    await press();
    expect(server.on(MINT)).toHaveLength(2);
    expect(server.left).toEqual([{ href: PAGE, rel: "noreferrer", target: "" }]);
  });

  it("keeps the account page's address out of every node, the model and the log", async () => {
    const lines: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args)),
    );
    server.answer(MINT, json({ url: PAGE }));
    await mounted();
    await press();
    expect(server.left.map((l) => l.href)).toEqual([PAGE]);
    expect(document.documentElement.outerHTML).not.toContain("pay.example.com");
    expect(JSON.stringify(drawnModel)).not.toContain("pay.example.com");
    expect(JSON.stringify(lines)).not.toContain("pay.example.com");
    for (const spy of spies) spy.mockRestore();
  });

  it("asks no price and draws no price when the access answer has no offer", async () => {
    access = open({ ...NEAR, offer: null });
    server.answer(MINT, json({ url: PAGE }));
    await mounted();
    await press();
    expect(server.sent.filter((s) => s.line.includes("/account/plans"))).toEqual([]);
    expect(document.body.textContent).not.toMatch(/[$€£]/);
  });
});

describe("the standing, from the access answer the shell holds", () => {
  const lifecycle = (over: Partial<AccountLifecycle>): AccountLifecycle => ({ state: "active", closedReason: null, ...over });

  it("is each lifecycle's own, with the day said by the product's formatter", async () => {
    const { standingOf } = await import("../../app/(product)/mailbox/subscription-door");
    const { dayStamp } = await import("../../app/shell/format");
    const day = "2026-11-18T12:00:00.000Z";
    expect(standingOf(lifecycle({ state: "trialing", trialEndsAt: day }))).toEqual({ state: "trial", ends: dayStamp(day) });
    expect(standingOf(lifecycle({ state: "trialing", trialEndsAt: "soon" }))).toEqual({ state: "trial", ends: null });
    expect(standingOf(lifecycle({ state: "grace", graceUntil: day }))).toEqual({ state: "grace", until: dayStamp(day) });
    expect(standingOf(lifecycle({ state: "past_due", graceUntil: null }))).toEqual({ state: "overdue", until: null });
    expect(standingOf(lifecycle({ state: "active" }))).toEqual({ state: "active" });
    for (const [reason, why] of [
      ["trial_ended", "trialEnded"],
      ["canceled", "canceled"],
      ["unpaid", "unpaid"],
      ["suspended", "suspended"],
      [null, null],
    ] as const)
      expect(standingOf(lifecycle({ state: "closed", closedReason: reason }))).toEqual({ state: "closed", why });
    expect(standingOf(undefined)).toBeNull();
  });

  it("draws the standing, the mailboxes and what is stored, for the account the shell hands in alone", async () => {
    await published();
    const { result } = await filled();
    expect(result.current.status.read()).toMatchObject({
      standing: { state: "trial", ends: null },
      mailboxes: 2,
      storage: en.settings.storageOf.replace("{used}", "3.2 GB").replace("{limit}", "4 GB"),
    });
    cleanup();
    const other = await filled(() => {}, "someone-else");
    expect(other.result.current.status.read()).toBeNull();
  });

  it("has none to draw for an unmetered server or one that names no lifecycle", async () => {
    const { subscriptionStatusOf } = await import("../../app/(product)/mailbox/subscription-door");
    const stored = () => "stored";
    expect(subscriptionStatusOf({ metered: false }, stored, "en")).toBeNull();
    const { lifecycle: _, ...nameless } = open(NEAR);
    expect(subscriptionStatusOf(nameless as never, stored, "en")).toBeNull();
  });
});
