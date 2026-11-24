/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountBodies } from "../../../src/account/bodies.js";
import { ACCOUNT_REFUSALS, type CatalogueKey } from "../../../src/account/contract.js";
import type {
  Standing,
  SubscriptionDoor,
  SubscriptionModel,
} from "../../../src/account/subscription/model.js";
import { SUBSCRIPTION_NAMESPACE } from "../../../src/account/subscription/namespace.js";
import { subscriptionStates } from "../../../src/account/subscription/states.js";
import { SubscriptionPane } from "../../../src/account/subscription/SubscriptionPane.js";
import { useSubscription } from "../../../src/account/subscription/use-subscription.js";
import type { HostContract } from "../../../src/host/index.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import { hostOf, SETTINGS } from "../../settings/frame/hosts.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-subscription.de.json" with { type: "json" };
import ownEn from "../../../messages/account-subscription.en.json" with { type: "json" };
import settingsDe from "../../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
/** The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import { fakeSubscriptionDoor, READS, TRIAL } from "./fake-door.js";

afterEach(cleanup);

const EN: Messages = { ...settingsEn, ...accountEn, ...ownEn };
const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: EN,
  de: fillOver(EN, { ...settingsDe, ...accountDe, ...ownDe }),
};
/** The card the pictures draw: the test's own amounts, never the app's. */
const STATES = subscriptionStates(READS.card.value);
const TODAY = subscriptionStates();

/** A sentence by its key, filled by the catalogue's own formatter: a case names a sentence by its key and values. */
function said(
  at: CatalogueKey | string,
  values: Record<string, string | number> = {},
  lang: "en" | "de" = "en",
) {
  const { namespace, key } = typeof at === "string" ? { namespace: SUBSCRIPTION_NAMESPACE, key: at } : at;
  if (typeof (WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key] !== "string")
    throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  const t = createTranslator({
    locale: lang,
    messages: WORDS[lang] as Parameters<typeof createTranslator>[0]["messages"],
    namespace: namespace as never,
    timeZone: "Europe/Zurich",
  });
  return t(key as never, values as never);
}
const settings = (key: string, values: Record<string, string | number> = {}, lang: "en" | "de" = "en") =>
  said({ namespace: "settings", key }, values, lang);
const text = () => document.body.textContent ?? "";
const seen = (words: string) => text().includes(words);
const line = (name: string) => screen.getByRole("group", { name });

function drawn(
  model: SubscriptionModel,
  {
    toStorage = null as (() => void) | null,
    lang = "en" as "en" | "de",
    addStorage,
  }: {
    toStorage?: (() => void) | null;
    lang?: "en" | "de";
    addStorage?: () => void;
  } = {},
) {
  const storage = { addStorage: addStorage && { press: addStorage, busy: false } };
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <SubscriptionPane model={model} toStorage={toStorage} {...storage} />
    </TextProvider>,
  );
}
const withStanding = (
  standing: Standing,
  model: SubscriptionModel = TODAY.trial.model,
): SubscriptionModel => ({
  ...model,
  status: { ...TRIAL, standing },
});

it("opens the offered storage purchase directly from Subscription", () => {
  const addStorage = vi.fn();
  drawn(withStanding({ state: "active" }), { addStorage });
  expect(addStorage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add storage" }));
  expect(addStorage).toHaveBeenCalledOnce();
});

describe("where the account stands, from the access answer alone", () => {
  it("says the standing as a word, the day it turns, the mailboxes and what is stored, and no figure of money", () => {
    drawn(TODAY.trial.model);
    expect(screen.getByRole("heading", { name: settings("storagePlanHead") })).toBeTruthy();
    expect(seen(said("trial"))).toBe(true);
    expect(line(said("trialEnds")).textContent).toContain("Nov 18, 2026");
    expect(line(settings("mailboxes")).textContent).toContain(said("mailboxesUpTo", { count: 5 }));
    expect(line(settings("storage")).textContent).toContain("235 MB of 5 GB");
    expect(screen.queryByRole("heading", { name: settings("storagePlansHead") })).toBeNull();
    expect(text()).not.toMatch(/[$€£]/);
  });

  it("says each standing in its own word", () => {
    const words: [Standing, string][] = [
      [{ state: "trial", ends: null }, "trial"],
      [{ state: "grace", until: null }, "trialEnded"],
      [{ state: "overdue", until: null }, "overdue"],
      [{ state: "active" }, "active"],
      [{ state: "closed", why: "trialEnded" }, "trialEnded"],
      [{ state: "closed", why: "canceled" }, "canceled"],
      [{ state: "closed", why: "unpaid" }, "unpaid"],
      [{ state: "closed", why: "suspended" }, "suspended"],
      [{ state: "closed", why: null }, "closed"],
    ];
    for (const [standing, word] of words) {
      drawn(withStanding(standing));
      expect(seen(said(word)), word).toBe(true);
      cleanup();
    }
  });

  it("says the day a trial ends and the day a grace runs out, and no day it does not know", () => {
    drawn(withStanding({ state: "grace", until: "Nov 24, 2026" }));
    expect(seen(said("organizingUntil", { date: "Nov 24, 2026" }))).toBe(true);
    cleanup();
    drawn(withStanding({ state: "trial", ends: null }));
    const before = (WORDS.en.accountLifecycle as Record<string, string>).trialEnds!.split("{date}")[0]!;
    expect(before.length).toBeGreaterThan(5);
    expect(seen(before)).toBe(false);
  });

  it("wants the person where a payment failed, with the day to fix it by, or without one", () => {
    drawn(TODAY.overdue.model);
    expect(seen(said("paymentFailed"))).toBe(true);
    expect(seen(said("organizingUntil", { date: "Nov 24, 2026" }))).toBe(true);
    cleanup();
    drawn(TODAY.incomplete.model);
    expect(seen(said("paymentFailedUndated"))).toBe(true);
  });

  it("offers the way to Storage from the storage line where the place has one", () => {
    const toStorage = vi.fn();
    drawn(TODAY.trial.model, { toStorage });
    fireEvent.click(within(line(settings("storage"))).getByRole("button", { name: said("openStorage") }));
    expect(toStorage).toHaveBeenCalledTimes(1);
    cleanup();
    drawn(TODAY.trial.model);
    expect(within(line(settings("storage"))).queryByRole("button", { name: said("openStorage") })).toBeNull();
  });

  it("draws the press alone before the standing has answered", () => {
    drawn(TODAY.window.model);
    expect(screen.queryAllByRole("heading")).toEqual([]);
    expect(screen.getByRole("button", { name: settings("subscriptionManage") })).toBeTruthy();
  });
});

describe("the press that opens the account page", () => {
  const manage = () => screen.getByRole("button", { name: settings("subscriptionManage") });

  it("stands on the Subscription line and hands the door no plan", () => {
    const model = { ...TODAY.trial.model, manage: vi.fn() };
    drawn(model);
    expect(within(line(settings("paymentInvoices"))).getByRole("button")).toBe(manage());
    fireEvent.click(manage());
    expect(model.manage).toHaveBeenCalledWith();
  });

  it("is off while the address is made, and says a press that could not open the page", () => {
    drawn(TODAY.opening.model);
    expect((manage() as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    drawn(TODAY.manageFailed.model);
    expect(seen(said(ACCOUNT_REFUSALS.subscription.failed))).toBe(true);
    expect(seen(said("notOpened"))).toBe(true);
    expect((manage() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the plans, where the server answers them", () => {
  const plansHeading = () => screen.queryByRole("heading", { name: settings("storagePlansHead") });

  it("draws nothing while they are asked, where the host has no read, where nothing is for sale or no answer came", () => {
    for (const state of [TODAY.plansAsked, TODAY.trial, TODAY.notForSale, TODAY.unanswered]) {
      drawn(state.model);
      expect(plansHeading()).toBeNull();
      expect(text()).not.toMatch(/[$€£]/);
      cleanup();
    }
  });

  it("says a read that failed with Try again, and the press stays", () => {
    const model = { ...TODAY.plansUnavailable.model, retryPlans: vi.fn() };
    drawn(model);
    expect(plansHeading()).toBeTruthy();
    expect(seen(said(ACCOUNT_REFUSALS.subscription.plans_unavailable))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: said("retry") }));
    expect(model.retryPlans).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: settings("subscriptionManage") })).toBeTruthy();
  });

  it("draws every plan with its facts and its price for the interval chosen, marks the person's own, and the add-on", () => {
    const model = { ...STATES.trial.model, choose: vi.fn() };
    drawn(model);
    expect(screen.getByRole("heading", { name: "Plus" })).toBeTruthy();
    const plus = screen.getByRole("radio", { name: /^Plus/ });
    expect(plus.textContent).toContain(settings("storageTagYours"));
    expect(plus.textContent).toContain("$15");
    expect(seen(said("planFacts", { mailboxes: 10, credits: 4_000, storage: "10 GB" }))).toBe(true);
    expect(seen(settings("storageTagAddon"))).toBe(false);
    expect(seen(settings("storageAddonMax", { count: 4 }))).toBe(false);
    const interval = screen.getByRole("group", { name: said("billing") });
    fireEvent.click(within(interval).getByRole("button", { name: said("yearly") }));
    expect(model.choose).toHaveBeenCalledWith("year");
  });

  it("subscribes to the plan and interval selected after a trial ends", () => {
    const manage = vi.fn();
    const model = withStanding({ state: "grace", until: null }, STATES.trial.model);
    if (model.plans.at !== "read") throw new Error("the state holds the read");
    drawn({ ...model, plans: { ...model.plans, interval: "year" }, manage });
    fireEvent.click(screen.getByRole("radio", { name: /^Pro/ }));
    fireEvent.click(screen.getByRole("button", { name: said("subscribeTo", { plan: "pro" }) }));
    expect(manage).toHaveBeenCalledWith({ plan: "pro", interval: "year" });
  });

  it("draws a price that is not there as no figure, never zero and never the other interval's, and keeps its line", () => {
    const plans = STATES.trial.model.plans;
    if (plans.at !== "read") throw new Error("the card's state holds the read");
    drawn({ ...STATES.trial.model, plans: { ...plans, interval: "year" } });
    expect(screen.getByRole("radio", { name: /^Pro/ }).textContent).not.toMatch(/\$|€|£/);
    expect(screen.getByRole("radio", { name: /^Solo/ }).textContent).toContain("$90");
    expect(seen("$29")).toBe(false);
    expect(text()).not.toMatch(/\$0\b/);
  });

  it("offers the verb that pays where it is owed: Subscribe to the plan, Fix payment, or none", () => {
    const manage = vi.fn();
    drawn({ ...STATES.trial.model, manage });
    fireEvent.click(screen.getByRole("button", { name: said("subscribeTo", { plan: "plus" }) }));
    expect(manage).toHaveBeenLastCalledWith({ plan: "plus", interval: "month" });
    cleanup();
    drawn({ ...STATES.overdue.model, manage });
    fireEvent.click(screen.getByRole("button", { name: said("fixPayment") }));
    expect(manage).toHaveBeenLastCalledWith();
    cleanup();
    drawn({ ...STATES.noPlan.model, manage });
    expect(screen.getByRole("heading", { name: said("noPlan") })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: said("subscribe") }));
    expect(manage).toHaveBeenLastCalledWith({ interval: "month" });
    cleanup();
    // The press carries the interval the prices are shown for: by the year where the year was chosen.
    const byYear = (model: SubscriptionModel): SubscriptionModel => {
      if (model.plans.at !== "read") throw new Error("the state holds the read");
      return { ...model, plans: { ...model.plans, interval: "year" }, manage };
    };
    drawn(byYear(STATES.trial.model));
    fireEvent.click(screen.getByRole("button", { name: said("subscribeTo", { plan: "plus" }) }));
    expect(manage).toHaveBeenLastCalledWith({ plan: "plus", interval: "year" });
    cleanup();
    drawn(byYear(STATES.noPlan.model));
    fireEvent.click(screen.getByRole("button", { name: said("subscribe") }));
    expect(manage).toHaveBeenLastCalledWith({ interval: "year" });
    cleanup();
    for (const state of [STATES.active, STATES.canceled]) {
      drawn(state.model);
      for (const name of [said("subscribe"), said("subscribeTo", { plan: "plus" }), said("fixPayment")])
        expect(screen.queryByRole("button", { name }), name).toBeNull();
      cleanup();
    }
  });
});

describe("a build that may not link out", () => {
  /** The shell's registration, as every host writes it: the body by the capability's answer and nothing else. */
  function Registered({ host, door }: { host: HostContract; door: SubscriptionDoor }) {
    return accountBodies(host).billing === "pane" ? <Body door={door} /> : null;
  }
  function Body({ door }: { door: SubscriptionDoor }) {
    return <SubscriptionPane model={useSubscription(door)} toStorage={null} />;
  }

  it("asks no price, opens no page and draws no figure", () => {
    for (const [name, setting] of Object.entries(SETTINGS)) {
      for (const prices of ["data", "none"] as const) {
        const host = hostOf({ ...setting, features: [...setting.features, "subscription"] });
        const door = fakeSubscriptionDoor({ plans: [READS.card], manages: ["left"] });
        render(
          <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
            <Registered host={{ ...host, capabilities: { ...host.capabilities, prices } }} door={door} />
          </TextProvider>,
        );
        expect(door.reads(), `${name} ${prices}`).toBe(0);
        expect(door.picks()).toEqual([]);
        expect(text()).toBe("");
        cleanup();
      }
    }
  });
});

describe("no price is written into the app", () => {
  const AMOUNT = /[$€£¥]\s?\d|\d\s?[$€£¥]|\b(?:USD|EUR|CHF|GBP)\s?\d|\d\s?(?:USD|EUR|CHF|GBP)\b/i;

  it("holds no digit beside a currency's sign or code in this pane's words", () => {
    for (const [lang, words] of [
      ["en", ownEn],
      ["de", ownDe],
    ] as const) {
      for (const [key, sentence] of Object.entries(words.accountSubscription))
        expect(sentence, `${lang} ${key}`).not.toMatch(AMOUNT);
    }
  });

  it("would see one", () => {
    expect("Then $15 a month").toMatch(AMOUNT);
    expect("dann 15 € im Monat").toMatch(AMOUNT);
    expect("CHF 9").toMatch(AMOUNT);
  });
});

describe("every state", () => {
  const all = [...Object.values(STATES), ...Object.values(TODAY)];

  it("holds no form, no named control, no handler written into the page, no test id and no link", () => {
    for (const state of all) {
      const { container } = drawn(state.model, { toStorage: () => {} });
      expect(container.querySelectorAll("form, input, a[href], [name], [data-testid]")).toHaveLength(0);
      const written = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((name) => name.startsWith("on")),
      );
      expect(written).toEqual([]);
      cleanup();
    }
  });

  it("reads German where the catalogue is German", () => {
    drawn(STATES.overdue.model, { lang: "de" });
    expect(seen(said("overdue", {}, "de"))).toBe(true);
    expect(seen(said("fixPayment", {}, "de"))).toBe(true);
    expect(screen.getByRole("heading", { name: settings("storagePlansHead", {}, "de") })).toBeTruthy();
  });
});

describe("the states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(STATES).flatMap((state) => (state.address === null ? [] : [state.address]));

  it("each address is a state the comparison registers, once, and the same with or without the card", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(Object.values(TODAY).map((state) => state.address)).toEqual(
      Object.values(STATES).map((s) => s.address),
    );
  });

  it("cover every picture of the pane but the balance no read says and the window's own link", () => {
    const pictured = [...registered].filter(
      (key) =>
        /(^|&)sec=subscription(&|$)/.test(key) && !/device=phone|state=credits|state=managelink/.test(key),
    );
    expect([...addresses].sort()).toEqual(pictured.sort());
  });
});
