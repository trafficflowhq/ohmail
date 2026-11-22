/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_REFUSALS,
  type CatalogueKey,
  type FactorSlot,
  type GatedAsk,
} from "../../../src/account/contract.js";
import type { StorageFigures, StorageModel } from "../../../src/account/storage/model.js";
import { STORAGE_NAMESPACE } from "../../../src/account/storage/namespace.js";
import { storageFactsStates, storageStates } from "../../../src/account/storage/states.js";
import { StoragePane } from "../../../src/account/storage/StoragePane.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-storage.de.json" with { type: "json" };
import ownEn from "../../../messages/account-storage.en.json" with { type: "json" };
import doorsDe from "../../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../../messages/doors.en.json" with { type: "json" };
import settingsDe from "../../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
/** The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };

afterEach(cleanup);

const EN: Messages = { ...settingsEn, ...accountEn, ...doorsEn, ...ownEn };
const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: EN,
  de: fillOver(EN, { ...settingsDe, ...accountDe, ...doorsDe, ...ownDe }),
};
/** The amounts the pictures show: the test's own, never the app's. */
const AMOUNTS = {
  plan: { solo: "$9/month", plus: "$15/month", pro: "$29/month" },
  addon: "$5/month",
} as const;
const STATES = storageStates(AMOUNTS);

/**
 * A sentence by its key, filled by the catalogue's own formatter, its emphasis read as plain words: a case names a
 * sentence by its key and values, never by its English words.
 */
function said(
  at: CatalogueKey | string,
  values: Record<string, string | number> = {},
  lang: "en" | "de" = "en",
) {
  const { namespace, key } = typeof at === "string" ? { namespace: "settings", key: at } : at;
  if (typeof (WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key] !== "string")
    throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  const t = createTranslator({
    locale: lang,
    messages: WORDS[lang] as Parameters<typeof createTranslator>[0]["messages"],
    namespace: namespace as never,
    timeZone: "Europe/Zurich",
  });
  const b = (chunks: string | string[]) => (Array.isArray(chunks) ? chunks.join("") : chunks);
  return t.markup(key as never, { ...values, b } as never);
}
const text = () => document.body.textContent ?? "";
const seen = (words: string) => text().includes(words);

const NO_FACTOR: FactorSlot = () => null;
function drawn(
  model: StorageModel,
  {
    body = "pane",
    factor = NO_FACTOR,
    lang = "en",
  }: { body?: "pane" | "facts"; factor?: FactorSlot; lang?: "en" | "de" } = {},
) {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <StoragePane model={model} body={body} factor={factor} />
    </TextProvider>,
  );
}
const withFigures = (
  over: Partial<StorageFigures>,
  model: StorageModel = STATES.rest.model,
): StorageModel => ({
  ...model,
  figures: { ...model.figures!, ...over },
});
const line = (name: string) => screen.getByRole("group", { name });

describe("what is stored, and why the limit is what it is", () => {
  it("draws nothing where the access answer carries no storage block", () => {
    const { container } = drawn(STATES.noBlock.model);
    expect(container.textContent).toBe("");
  });

  it("says used of the limit and the room left in words; a tag from 80 percent, and full at the limit", () => {
    drawn(STATES.rest.model);
    expect(seen("235 MB")).toBe(true);
    expect(seen(said("storageFigureTrial", { limit: "5 GB" }))).toBe(true);
    cleanup();
    drawn(STATES.near.model);
    expect(seen("4.6 GB")).toBe(true);
    expect(seen(said("storageTagPercent", { percent: 92 }))).toBe(true);
    cleanup();
    drawn(STATES.full.model);
    expect(seen("5 GB")).toBe(true);
    expect(seen(said("storageTagFull"))).toBe(true);
  });

  it("names the room by its reason: the plan's, and one kept until a day", () => {
    drawn(STATES.heldUntil.model);
    expect(seen(said("storageFigureHeld", { date: "November 26, 2026" }))).toBe(true);
    cleanup();
    drawn(STATES.heldUndated.model);
    expect(seen(said("storageFigureOf", { limit: "5 GB" }))).toBe(true);
  });

  it("gives each mailbox its three figures, each named by its column, and the total the same way", () => {
    drawn(STATES.rest.model);
    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(
      ["storageColMailbox", "storageColLetters", "storageColKept", "storageColExpected"].map((key) =>
        said(key),
      ),
    );
    const cells = table
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(cells).toContainEqual(["mila@lichtgrat.example", "7,912", "198 MB", "198 MB"]);
    expect(cells.at(-1)).toEqual([said("storageTotal"), "9,406", "235 MB", "235 MB"]);
  });

  it("draws no mailbox lines where the answer names no mailbox", () => {
    drawn(withFigures({ rows: [], total: null }));
    expect(screen.queryByRole("group", { name: said("storageTotal") })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says what the mail needs, the measured or the default average, and that not all is counted yet", () => {
    drawn(STATES.incomplete.model);
    expect(seen(said("storageNeedsAverage", { count: 9_406, size: "235 MB", average: "25 KB" }))).toBe(true);
    expect(seen(said("storageIncomplete"))).toBe(true);
    cleanup();
    drawn(STATES.unmeasured.model);
    expect(seen(said("storageAverageDefault", { size: "25 KB" }))).toBe(false);
    expect(seen(said("storageIncomplete"))).toBe(false);
  });

  it("says a first import with its count while it runs", () => {
    drawn(STATES.near.model);
    expect(
      seen(
        said("storageImportProgress", {
          stored: 184_000,
          expected: 244_000,
          size: "6.1 GB",
          average: "25 KB",
        }),
      ),
    ).toBe(true);
    expect(seen(said("storageNeeds", { letters: 244_000, size: "6.1 GB" }))).toBe(false);
  });

  it("says from which month text is kept, or how many were emptied, and that the refill runs", () => {
    drawn(STATES.full.model);
    expect(line(said("storageKeptFromLabel")).textContent).toContain("March 2021");
    expect(seen(said("storageRefill"))).toBe(true);
    cleanup();
    drawn(withFigures({ kept: { kind: "some", count: 312, refills: false } }, STATES.full.model));
    expect(seen(said("storageKeptSome", { count: 312 }))).toBe(true);
    expect(seen(said("storageRefill"))).toBe(false);
  });

  it("says what counts, why it is limited, and the plan in its three forms", () => {
    drawn(STATES.rest.model);
    expect(line(said("storageWhatCountsHead")).textContent).toContain(said("storageCountsText"));
    expect(line(said("storageAttachments")).textContent).toContain(said("storageNeverCounted"));
    expect(line(said("storageNamedPlanKeeps", { plan: "Plus" })).textContent).toContain("5 GB");
    fireEvent.click(screen.getByRole("button", { name: said("storageWhatCountsHead") }));
    for (const key of ["storageInfoCounts", "storageInfoPurpose", "storageInfoOriginals"]) {
      expect(seen(said(key))).toBe(true);
    }
    cleanup();
    drawn(STATES.trialRoom.model);
    expect(line(said("storageYourPlanKeeps")).textContent).toContain("2 GB");
    cleanup();
    drawn(STATES.heldUntil.model);
    expect(line(said("storageYouKeep")).textContent).toContain(
      said("storageLimitUntil", { limit: "5 GB", date: "November 26, 2026" }),
    );
    expect(line(said("storageYourPlanKeeps")).textContent).toContain(
      said("storageFromThen", { limit: "2 GB" }),
    );
    cleanup();
    drawn(withFigures({ plan: { kind: "keeps", limit: "5 GB", plan: null } }));
    expect(line(said("storageYourPlanKeeps")).textContent).toContain("5 GB");
  });
});

describe("the plans", () => {
  it("lists each plan with its room, letters and mailboxes, marks the person's own and the one that keeps all", () => {
    drawn(STATES.near.model);
    expect(screen.getByRole("heading", { name: said("storagePlansHead") })).toBeTruthy();
    expect(line("Plus").textContent).toContain(said("storageTagYours"));
    expect(line("Pro").textContent).toContain(said("storageTagFits"));
    expect(line("Solo").textContent).toContain("2 GB");
    expect(seen(said("storageLetters", { count: 80_000 }))).toBe(true);
    expect(seen(said("storagePlanFacts", { count: 400_000, mailboxes: 10 }).split(" · ")[1]!)).toBe(true);
    expect(line(said("storageAddonName")).textContent).toContain(said("storageTagAddon"));
    expect(line(said("storageAddonName")).textContent).toContain(said("storageAddonEach"));
    expect(seen(said("storageAddonMax", { count: 4 }))).toBe(false);
  });

  it("shows plan and add-on prices on the linked-out Storage pane", () => {
    drawn(STATES.rest.model);
    for (const amount of [...Object.values(AMOUNTS.plan), AMOUNTS.addon])
      expect(seen(amount), amount).toBe(true);
    cleanup();
    drawn(STATES.rest.model, { body: "facts" });
    expect(text()).not.toMatch(/\$/);
  });

  it("draws a price that is not there as no figure, never zero, and keeps its line", () => {
    drawn(storageStates(null).rest.model);
    expect(text()).not.toMatch(/\$|€/);
    for (const plan of ["Solo", "Plus", "Pro"]) expect(line(plan)).toBeTruthy();
    expect(line(said("storageAddonName"))).toBeTruthy();
  });

  it("keeps fit and price copy off both storage views", () => {
    const fit = { extra: "+10 GB", room: "15 GB", price: "$20/month" };
    const lines = STATES.near.model.figures!.plans!.lines.map((plan) =>
      plan.plan === "pro" ? { ...plan, fit } : plan,
    );
    const model = withFigures({ plans: { ...STATES.near.model.figures!.plans!, lines } }, STATES.near.model);
    drawn(model);
    expect(seen(said("storageFitWith", fit))).toBe(false);
    cleanup();
    drawn(model, { body: "facts" });
    expect(seen(said("storageFitWithStore", fit))).toBe(false);
    expect(seen("$20")).toBe(false);
  });
});

describe("the change of plan", () => {
  const verbs = () => screen.queryAllByRole("button", { name: /^(Change plan|Add storage)$/ });

  it("offers Change plan and Add storage where the build links out and the program offered a change", () => {
    const model = { ...STATES.rest.model, change: vi.fn() };
    drawn(model);
    fireEvent.click(screen.getByRole("button", { name: said("storageChangePlan") }));
    fireEvent.click(screen.getByRole("button", { name: said("storageAddStorage") }));
    expect(model.change).toHaveBeenCalledTimes(2);
    expect(seen(said("storageOpensPage"))).toBe(false);
  });

  it("offers Add storage only where an add-on is offered, and no verb where no change is offered", () => {
    const plans = STATES.rest.model.figures!.plans!;
    drawn(withFigures({ plans: { ...plans, addon: null } }));
    expect(screen.queryByRole("button", { name: said("storageAddStorage") })).toBeNull();
    expect(screen.getByRole("button", { name: said("storageChangePlan") })).toBeTruthy();
    cleanup();
    drawn(withFigures({ plans: { ...plans, mayChange: false } }));
    expect(verbs()).toEqual([]);
  });

  it("turns both verbs off while the change is on its way or waits for the factor", () => {
    drawn(STATES.changing.model);
    for (const name of ["storageChangePlan", "storageAddStorage"])
      expect((screen.getByRole("button", { name: said(name) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no verb and no figure where the build may not link out, and says where the plan is managed", () => {
    drawn(storageFactsStates().near.model, { body: "facts" });
    expect(verbs()).toEqual([]);
    expect(seen(said("storageManageAtSite"))).toBe(true);
    cleanup();
    drawn(STATES.rest.model);
    expect(seen(said("storageManageAtSite"))).toBe(false);
  });

  it("says each refusal in the sentence the contract names for its word", () => {
    for (const [state, word] of [
      ["refused", "failed"],
      ["refusedAgain", "sign_in"],
      ["unverified", "unverified"],
    ] as const) {
      drawn(STATES[state].model);
      expect(seen(said(ACCOUNT_REFUSALS.storage[word])), word).toBe(true);
      expect(seen(said({ namespace: STORAGE_NAMESPACE, key: "notOpened" }))).toBe(true);
      cleanup();
    }
    drawn({ ...STATES.rest.model, refusal: { word: "said", said: "The shell's own sentence." } });
    expect(seen("The shell's own sentence.")).toBe(true);
  });

  it("never says a second refusal as a way back in", () => {
    drawn(STATES.refusedAgain.model);
    expect(seen(said({ namespace: "devices", key: "stepUpExpired" }))).toBe(false);
  });

  it("says that nothing ran when a factor landed after Cancel", () => {
    drawn(STATES.nothingRan.model);
    expect(seen(said({ namespace: "devices", key: "stepUpCancelledNothingRan" }))).toBe(true);
    cleanup();
    drawn({ ...STATES.refused.model, nothingRan: true });
    expect(seen(said({ namespace: "devices", key: "stepUpCancelledNothingRan" }))).toBe(true);
    expect(seen(said(ACCOUNT_REFUSALS.storage.failed))).toBe(true);
  });

  it("hands the factor's dialog its ask while the factor is asked, and draws none otherwise", () => {
    const factor = vi.fn((_ask: GatedAsk) => <p>the dialog</p>);
    drawn(STATES.asked.model, { factor });
    expect(factor).toHaveBeenCalledWith(STATES.asked.model.ask);
    expect(seen("the dialog")).toBe(true);
    cleanup();
    factor.mockClear();
    drawn(STATES.rest.model, { factor });
    expect(factor).not.toHaveBeenCalled();
  });
});

describe("the storage mails' switch", () => {
  const sw = () => within(line(said("storageMail"))).getByRole("switch");

  it("is named, shows its side, and writes the other side on a press", () => {
    const model = { ...STATES.rest.model, setMail: vi.fn() };
    drawn(model);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw());
    expect(model.setMail).toHaveBeenCalledWith(false);
    expect(line(said("storageMail")).textContent).toContain(said("storageMailSub"));
  });

  it("is off while a write is on its way, and says a refused write", () => {
    drawn(STATES.mailWriting.model);
    expect((sw() as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    drawn(STATES.mailRefused.model);
    expect(seen(said("storageMailFailed"))).toBe(true);
    expect(seen(said("notSaved"))).toBe(true);
  });

  it("stands where the build may not link out too", () => {
    drawn(storageFactsStates().near.model, { body: "facts" });
    expect(sw()).toBeTruthy();
  });
});

describe("every state", () => {
  const all = [
    ...Object.values(STATES).map((state) => ({ state, body: "pane" as const })),
    ...Object.values(storageFactsStates()).map((state) => ({ state, body: "facts" as const })),
  ];

  it("holds no form, no named control, no handler written into the page, no test id and no link", () => {
    for (const { state, body } of all) {
      const { container } = drawn(state.model, { body });
      expect(container.querySelectorAll("form, input, a[href], [name], [data-testid]")).toHaveLength(0);
      const written = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((name) => name.startsWith("on")),
      );
      expect(written).toEqual([]);
      cleanup();
    }
  });

  it("reads German where the catalogue is German", () => {
    drawn(STATES.refused.model, { lang: "de" });
    expect(screen.getByRole("heading", { name: said("storagePlansHead", {}, "de") })).toBeTruthy();
    expect(seen(said({ namespace: STORAGE_NAMESPACE, key: "notOpened" }, {}, "de"))).toBe(true);
    expect(seen(said(ACCOUNT_REFUSALS.storage.failed, {}, "de"))).toBe(true);
  });
});

describe("no price is written into the app", () => {
  it("holds no digit beside a currency's sign or code in this pane's words", () => {
    const amount = /[$€£¥]\s?\d|\d\s?[$€£¥]|\b(?:USD|EUR|CHF|GBP)\s?\d|\d\s?(?:USD|EUR|CHF|GBP)\b/i;
    for (const [lang, words] of [
      ["en", ownEn],
      ["de", ownDe],
    ] as const) {
      for (const [key, sentence] of Object.entries(words.accountStorage))
        expect(sentence, `${lang} ${key}`).not.toMatch(amount);
    }
  });
});

describe("the states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = [...Object.values(STATES), ...Object.values(storageFactsStates())].flatMap((state) =>
    state.address === null ? [] : [state.address],
  );

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the pane on a computer, and leave the phone's and the window's to theirs", () => {
    const pictured = [...registered].filter(
      (key) => /(^|&)sec=storage(&|$)/.test(key) && !/device=phone|keeps=nobrowser|door=/.test(key),
    );
    expect([...addresses].sort()).toEqual(pictured.sort());
  });
});
