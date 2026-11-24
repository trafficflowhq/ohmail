/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installConfirmEnv, refresh204, rememberOwner, scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";
import * as React from "react";
import { getByRole, queryByRole, within } from "@testing-library/react";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { createRoot, type Root } from "react-dom/client";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { formatStoragePrice } from "../app/shell/storage-state";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE STORAGE CARD ATOP THE OHBOX AND SETTINGS → STORAGE, on the browser. Which card is due is the
 * server's word; the card says how full, what the mail needs and the one choice that keeps all of it,
 * with its price only from the program's offer. The room is named by why the cap is what it is: the
 * trial's room, the plan's, or the room kept until a date. Change plan and Add storage mint the page
 * that may change the plan, and a missing second factor is asked for in place, then the press runs again.
 */

const rig = vi.hoisted(() => ({ onVerified: null as null | (() => void) }));
vi.mock("../app/(product)/mailbox/StepUp", () => ({
  StepUp: (props: { onVerified: () => void }) => {
    rig.onVerified = props.onVerified;
    return null;
  },
}));

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let access: Record<string, unknown> = { metered: false };
let wire: Array<{ line: string; body: unknown }> = [];
let changeAnswers: Response[] = [];
let left: string[] = [];
const realClick = HTMLAnchorElement.prototype.click;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OFFER = {
  currency: "usd", interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2_000_000_000, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5_000_000_000, amount: 1500 },
    { plan: "pro", mailboxes: 10, roomBytes: 10_000_000_000, amount: 2900 },
  ],
  addon: { unitBytes: 10_000_000_000, amount: 1000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 2_000_000_000, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2500, keepsAll: true },
  canChange: true, reason: null,
};
const NEAR = {
  usedBytes: 3_200_000_000, limitBytes: 4_000_000_000, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null,
  withheldOnArrival: 0, emptyingNow: false, planLimitBytes: 2_000_000_000, limitDropsAt: null,
  limitReason: "trial", importing: true, card: "near", mail: true,
  estimate: { expectedBytes: 12_500_000_000, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000,
    avgMeasured: false, complete: true, at: "2026-11-07T08:00:00.000Z" },
  mailboxes: [
    { id: "mb_1", usedBytes: 2_600_000_000, letters: 400_000, expectedLetters: 400_000, expectedBytes: 10_000_000_000, importing: true },
    { id: "mb_2", usedBytes: 600_000_000, letters: 100_000, expectedLetters: 100_000, expectedBytes: 2_500_000_000, importing: false },
  ],
  offer: OFFER,
};
const mailboxFacts = [
  { id: "mb_1", address: "sam@example.com", status: "connected", initialImportCompletedAt: null },
  { id: "mb_2", address: "office@example.com", status: "connected", initialImportCompletedAt: "2026-10-01T00:00:00.000Z" },
] as const;
const open = (storage: unknown): Record<string, unknown> => ({
  metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: null, graceUntil: null },
  ...(storage === undefined ? {} : { storage }),
});

beforeEach(async () => {
  const { bindApiOwner, forgetAccess } = await import("../app/api-client");
  bindApiOwner(null);
  forgetAccess();
  resetSessionTruthForTests();
  resetStorageOwnerForTest();
  installConfirmEnv();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  globalThis.localStorage.clear();
  wire = [];
  changeAnswers = [];
  left = [];
  rig.onVerified = null;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { left.push(this.href); };
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(url), "http://localhost").pathname}`;
    wire.push({ line, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (line === "GET /api/account/access") return json(access);
    if (line === "POST /api/account/manage-link/change") return changeAnswers.shift() ?? json({ url: "https://pay.example.com/manage/t" });
    if (line === "GET /api/mailboxes") return json({ items: mailboxFacts });
    return fetch(url, init);
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  await teardownConfirmEnv();
  HTMLAnchorElement.prototype.click = realClick;
});

async function mount(which: "card" | "pane", locale: "en" | "de" = "en"): Promise<void> {
  const { account, forgetAccess } = await import("../app/api-client");
  forgetAccess();
  const { CloudShell } = await import("../app/(product)/mailbox/CloudShell");
  const { THEME_DOOR } = await import("../app/shell/face-mirror");
  rememberOwner();
  history.replaceState(null, "", which === "pane" ? "#/settings/storage" : "#/ohbox");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(ThemeProvider, {
        storage: THEME_DOOR,
        children: h(CloudShell, { demo: false }),
      }),
    }));
  });
  await tick(2_500);
  await act(async () => { await account.access({ fresh: true }); });
  if (which === "pane") {
    await tick(1_000);
    expect(getByRole(host, "heading", { name: (locale === "en" ? en : de).settings.storage })).toBeTruthy();
  }
}

const card = (locale: "en" | "de" = "en"): HTMLElement | null =>
  queryByRole(host, "region", { name: (locale === "en" ? en : de).settings.storage });
const cardText = (locale?: "en" | "de"): string => card(locale)?.textContent ?? "";
const cardButtons = (): string[] => within(card()!).queryAllByRole("button").map((button) => button.textContent ?? "");

const text = (): string => host.textContent ?? "";
const buttons = (): string[] => [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
const press = async (label: string): Promise<void> => {
  const button = within(card()!).getByRole("button", { name: label });
  await act(async () => { button.click(); });
  await tick(0);
};
const sent = (line: string) => wire.filter((w) => w.line === line);

describe("the storage card atop the Ohbox", () => {
  it("near: how full, the figure, what the mail needs after the import, and the choice that keeps all of it", async () => {
    access = open(NEAR);
    await mount("card");
    expect(cardText()).toContain("Storage 80% full");
    expect(cardText()).not.toContain("3.2 GB of 4 GB");
    expect(cardText()).toContain("12.5 GB after the import.");
    expect(cardText()).not.toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(cardButtons()).toEqual(expect.arrayContaining(["Add storage", "Change plan"]));
    expect(within(card()!).getByRole("link", { name: en.settings.storage }).getAttribute("href")).toBe("#/settings/storage");
  });

  it("no price without an offer, and no change buttons where the plan cannot change", async () => {
    access = open({ ...NEAR, offer: undefined });
    await mount("card");
    expect(cardText()).toContain("Storage 80% full");
    expect(cardText()).not.toMatch(/\$|€|keeps all/);
    expect(cardButtons()).not.toEqual(expect.arrayContaining(["Change plan"]));
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    access = open({ ...NEAR, offer: { ...OFFER, canChange: false } });
    await mount("card");
    expect(cardText()).not.toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(cardButtons().filter((b) => b === "Add storage" || b === "Change plan")).toEqual([]);
  });

  it("a yearly price reads per year in both languages", async () => {
    access = open({ ...NEAR, offer: { ...OFFER, interval: "year", fit: { ...OFFER.fit, amount: 25_000 } } });
    await mount("card");
    expect(cardText()).not.toContain("Plus + 10 GB keeps all of it, $250/year.");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount("card", "de");
    expect(cardText("de")).not.toMatch(/250\s\$\/Jahr\./);
  });

  it("full: from which month text is kept and where the rest is; drop: when the plan's own room applies", async () => {
    access = open({ ...NEAR, usedBytes: 4_000_000_000, card: "full", emptiedForSpace: 9_000, keptFrom: "2019-03", importing: false });
    await mount("card");
    expect(cardText()).toContain("Storage full");
    expect(cardText()).toContain("Text kept from March 2019.");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    access = open({ ...NEAR, usedBytes: 3_100_000_000, card: "drop", limitDropsAt: "2026-11-21T12:00:00.000Z" });
    await mount("card");
    expect(cardText()).toContain("Storage above 2 GB");
    expect(cardText()).toContain("From November 21, 2026, your plan keeps 2 GB; the oldest letters' text then stays on your mail server.");
  });

  it("no card when the server names none: dismissed there, or nothing to say", async () => {
    access = open({ ...NEAR, card: null });
    await mount("card");
    expect(card()).toBeNull();
  });

  it("Dismiss puts it away on the server and hides it at once", async () => {
    access = open(NEAR);
    await mount("card");
    await press("Not now");
    expect(sent("PATCH /api/account/storage").map((w) => w.body)).toEqual([{ dismiss: "near" }]);
    expect(card()).toBeNull();
  });

  it("Change plan leaves for the page that may change the plan", async () => {
    access = open(NEAR);
    await mount("card");
    await press("Change plan");
    expect(sent("POST /api/account/manage-link/change")).toHaveLength(1);
    expect(left).toEqual(["https://pay.example.com/manage/t"]);
  });

  it("a missing second factor is asked for, and the press runs once more after it", async () => {
    access = open(NEAR);
    changeAnswers = [json({ error: { code: "step_up_required", message: "recent two-factor authentication required" } }, 403)];
    await mount("card");
    await press("Add storage");
    expect(left).toEqual([]);
    expect(rig.onVerified, "no step-up prompt").not.toBeNull();
    await act(async () => { rig.onVerified!(); });
    await tick(0);
    expect(sent("POST /api/account/manage-link/change")).toHaveLength(2);
    expect(left).toEqual(["https://pay.example.com/manage/t"]);
  });
});

describe("Settings → Storage", () => {
  it("names the room by why the cap is what it is", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ limitReason: "trial" }, "of 4 GB · trial"],
      [{ limitReason: "plan", limitBytes: 2_000_000_000, usedBytes: 1_700_000_000, planLimitBytes: null }, "of 2 GB"],
      [{ limitReason: "held", limitBytes: 15_000_000_000, planLimitBytes: 5_000_000_000, limitDropsAt: "2026-11-21T12:00:00.000Z" },
        "kept until November 21, 2026"],
    ];
    const { account } = await import("../app/api-client");
    access = open({ ...NEAR, ...cases[0]![0] });
    await mount("pane");
    for (const [over, said] of cases) {
      await tick(5_000);
      access = open({ ...NEAR, ...over });
      await act(async () => { await account.access({ fresh: true }); });
      expect(text()).toContain(said);
      expect(text()).not.toContain("your plan's 4 GB");
    }
  });

  it("the numbers per mailbox, what the mail needs, what counts and why, the plans with the fitted one marked", async () => {
    access = open(NEAR);
    await mount("pane");
    const table = within(getByRole(host, "table", { name: en.settings.mailboxes }));
    const figures = table.getAllByRole("row").map((row) =>
      within(row).queryAllByRole("cell").map((cell) => cell.textContent?.replace(/\s+/gu, " ").trim()),
    );
    expect(figures).toContainEqual([mailboxFacts[0].address, (400_000).toLocaleString("en-US"), "2.6 GB", "10 GB"]);
    expect(figures).toContainEqual([mailboxFacts[1].address, (100_000).toLocaleString("en-US"), "600 MB", "2.5 GB"]);
    const imported = (128_000).toLocaleString("en-US");
    const total = (500_000).toLocaleString("en-US");
    expect(text()).toContain(`First import running: ${imported} of ${total} messages. Expected: about 12.5 GB`);
    expect(text()).toContain(`${en.settings.storageWhatCountsHead}${en.settings.storageCountsText}`);
    expect(text()).toContain(`${en.settings.storageAttachments}${en.settings.storageNeverCounted}`);
    expect(text()).toContain(`${en.settings.storageYourPlanKeeps}2 GB`);
    await act(async () => { getByRole(host, "button", { name: en.settings.storageWhatCountsHead }).click(); });
    expect(text()).toContain(en.settings.storageInfoCounts);
    expect(text()).toContain(en.settings.storageInfoPurpose);
    expect(text()).toContain(en.settings.storageInfoOriginals);
    expect(text()).toContain(`Plus${en.settings.storageTagFits}`);
    const translate = createTranslator({ locale: "en", messages: en, namespace: "settings" });
    const monthlyPrice = (amount: number, currency: string) =>
      translate("storagePriceMonth", { price: formatStoragePrice(amount, currency, "en") });
    const plus = OFFER.plans.find(({ plan }) => plan === "plus")!;
    expect(getByRole(host, "group", {
      name: translate("storagePlanName", { plan: "plus" }),
      description: monthlyPrice(plus.amount, OFFER.currency),
    })).toBeTruthy();
    expect(getByRole(host, "group", {
      name: translate("storageAddonName"),
      description: monthlyPrice(OFFER.addon.amount, OFFER.currency),
    })).toBeTruthy();

    const { account, accessStorage } = await import("../app/api-client");
    const { storageFiguresOf } = await import("../app/(product)/mailbox/storage-door");
    const facts = accessStorage(await account.access({ fresh: true }));
    expect(facts).not.toBeNull();
    const fitted = storageFiguresOf(facts!, {
      locale: "en",
      roster: mailboxFacts,
      price: (amount, offer) => monthlyPrice(amount, offer.currency),
    }).plans?.lines.find((plan) => plan.tag === "keepsAll");
    expect(fitted).toMatchObject({ plan: "plus", fit: { extra: "+10 GB", room: "15 GB", price: "$25/month" } });
    expect(buttons()).toEqual(expect.arrayContaining(["Change plan", "Add storage"]));
  });

  it("no price and no change buttons without an offer", async () => {
    access = open({ ...NEAR, offer: undefined });
    await mount("pane");
    expect(text()).toContain("3.2 GB of 4 GB");
    expect(text()).not.toMatch(/\$|€/);
    expect(buttons()).not.toEqual(expect.arrayContaining(["Change plan"]));
  });

  it("the storage mails switch writes the choice", async () => {
    access = open(NEAR);
    await mount("pane");
    const sw = getByRole(host, "switch", { name: en.settings.storageMail });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => { sw.click(); });
    await tick(0);
    expect(sent("PATCH /api/account/storage").map((w) => w.body)).toEqual([{ mail: false }]);
    expect(getByRole(host, "switch", { name: en.settings.storageMail }).getAttribute("aria-checked")).toBe("false");
  });

  it("German: the room and the numbers in the reader's language", async () => {
    access = open(NEAR);
    await mount("pane", "de");
    expect(text()).toContain("3,2 GB von 4 GB");
    expect(text()).toContain("von 4 GB · Testphase");
  });
});
