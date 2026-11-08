/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
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

let mailboxFacts: Array<Record<string, unknown>> | null = null;
vi.mock("../app/shell/MailStateProvider", () => ({ useMailboxFacts: () => mailboxFacts }));
const rig = vi.hoisted(() => ({ onVerified: null as null | (() => void) }));
vi.mock("../app/(product)/mailbox/StepUpPrompt", () => ({
  StepUpPrompt: (props: { onVerified: () => void }) => {
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
const realFetch = globalThis.fetch;
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
const open = (storage: unknown): Record<string, unknown> => ({
  metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: null, graceUntil: null },
  ...(storage === undefined ? {} : { storage }),
});

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  globalThis.localStorage.clear();
  mailboxFacts = [
    { id: "mb_1", address: "sam@example.com", status: "connected", initialImportCompletedAt: null },
    { id: "mb_2", address: "office@example.com", status: "connected", initialImportCompletedAt: "2026-10-01T00:00:00.000Z" },
  ];
  wire = [];
  changeAnswers = [];
  left = [];
  rig.onVerified = null;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { left.push(this.href); };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(url), "http://localhost").pathname}`;
    wire.push({ line, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (line === "GET /api/account/access") return json(access);
    if (line === "POST /api/account/manage-link/change") return changeAnswers.shift() ?? json({ url: "https://pay.example.com/manage/t" });
    if (line === "GET /api/auth/session") return json({ user: { id: "u1", accountId: "a1", twofaEnrolled: { totp: true } }, scope: "full" });
    return json({});
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  HTMLAnchorElement.prototype.click = realClick;
});

async function mount(which: "card" | "pane", locale: "en" | "de" = "en"): Promise<void> {
  const { account, forgetAccess } = await import("../app/api-client");
  forgetAccess();
  const { CloudStorageNotice } = await import("../app/(product)/mailbox/CloudStorageNotice");
  const { StorageSection } = await import("../app/(product)/mailbox/StorageSection");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(ThemeProvider, { children: h(which === "card" ? CloudStorageNotice : StorageSection) }),
    }));
  });
  await act(async () => { await account.access({ fresh: true }); });
}

const text = (): string => host.textContent ?? "";
const buttons = (): string[] => [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
const press = async (label: string): Promise<void> => {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent === label || x.getAttribute("aria-label") === label);
  expect(b, `no "${label}" button`).toBeTruthy();
  await act(async () => { b!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const sent = (line: string) => wire.filter((w) => w.line === line);

describe("the storage card atop the Ohbox", () => {
  it("near: how full, the figure, what the mail needs after the import, and the choice that keeps all of it", async () => {
    access = open(NEAR);
    await mount("card");
    expect(text()).toContain("Storage 80% full");
    expect(text()).toContain("3.2 GB of 4 GB");
    expect(text()).toContain("Expected about 12.5 GB after the import.");
    expect(text()).toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(buttons()).toEqual(expect.arrayContaining(["Add storage", "Change plan"]));
    expect(host.querySelector("a.scard-why")?.getAttribute("href")).toBe("#/settings/storage");
  });

  it("no price without an offer, and no change buttons where the plan cannot change", async () => {
    access = open({ ...NEAR, offer: undefined });
    await mount("card");
    expect(text()).toContain("Storage 80% full");
    expect(text()).not.toMatch(/\$|€|keeps all/);
    expect(buttons()).not.toEqual(expect.arrayContaining(["Change plan"]));
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    access = open({ ...NEAR, offer: { ...OFFER, canChange: false } });
    await mount("card");
    expect(text()).toContain("Plus + 10 GB keeps all of it, $25/month.");
    expect(buttons().filter((b) => b === "Add storage" || b === "Change plan")).toEqual([]);
  });

  it("a yearly price reads per year in both languages", async () => {
    access = open({ ...NEAR, offer: { ...OFFER, interval: "year", fit: { ...OFFER.fit, amount: 25_000 } } });
    await mount("card");
    expect(text()).toContain("Plus + 10 GB keeps all of it, $250/year.");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount("card", "de");
    expect(text()).toMatch(/250\s\$\/Jahr\./);
  });

  it("full: from which month text is kept and where the rest is; drop: when the plan's own room applies", async () => {
    access = open({ ...NEAR, usedBytes: 4_000_000_000, card: "full", emptiedForSpace: 9_000, keptFrom: "2019-03", importing: false });
    await mount("card");
    expect(text()).toContain("Storage full");
    expect(text()).toContain("Text kept for letters from March 2019 on; older ones stay on your mail server.");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    access = open({ ...NEAR, usedBytes: 3_100_000_000, card: "drop", limitDropsAt: "2026-11-21T12:00:00.000Z" });
    await mount("card");
    expect(text()).toContain("Storage above 2 GB");
    expect(text()).toContain("From November 21, 2026, your plan keeps 2 GB; the oldest letters' text then stays on your mail server.");
  });

  it("no card when the server names none: dismissed there, or nothing to say", async () => {
    access = open({ ...NEAR, card: null });
    await mount("card");
    expect(text()).toBe("");
  });

  it("Dismiss puts it away on the server and hides it at once", async () => {
    access = open(NEAR);
    await mount("card");
    await press("Dismiss");
    expect(sent("PATCH /api/account/storage").map((w) => w.body)).toEqual([{ dismiss: "near" }]);
    expect(host.querySelector("[data-storage-card]")).toBeNull();
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
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(sent("POST /api/account/manage-link/change")).toHaveLength(2);
    expect(left).toEqual(["https://pay.example.com/manage/t"]);
  });
});

describe("Settings → Storage", () => {
  it("names the room by why the cap is what it is", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ limitReason: "trial" }, "used, your trial room of 4 GB"],
      [{ limitReason: "plan", limitBytes: 2_000_000_000, usedBytes: 1_700_000_000, planLimitBytes: null }, "used, your plan's 2 GB"],
      [{ limitReason: "held", limitBytes: 15_000_000_000, planLimitBytes: 5_000_000_000, limitDropsAt: "2026-11-21T12:00:00.000Z" },
        "used, the 15 GB you keep until November 21, 2026"],
    ];
    for (const [over, said] of cases) {
      access = open({ ...NEAR, ...over });
      await mount("pane");
      expect(text()).toContain(said);
      expect(text()).not.toContain("your plan's 4 GB");
      await act(async () => { root.unmount(); });
      root = createRoot(host);
    }
  });

  it("the numbers per mailbox, what the mail needs, what counts and why, the plans with the fitted one marked", async () => {
    access = open(NEAR);
    await mount("pane");
    const rows = [...host.querySelectorAll(".storage-table tbody tr")].map((r) => r.textContent);
    expect(rows).toEqual(["sam@example.com400,0002.6 GB10 GB", "office@example.com100,000600 MB2.5 GB"]);
    expect(text()).toContain("First import running: 128,000 of 500,000 letters. Expected when it finishes: about 12.5 GB.");
    expect(text()).toContain("Only the text of your letters counts. Attachments never do");
    expect(text()).toContain("That database is the costly part of ohmail Cloud");
    expect(text()).toContain("Your trial keeps up to 4 GB. Your plan keeps 2 GB from 14 days after your first payment.");
    expect(host.querySelector(".storage-plan.fitted")?.textContent).toContain("Keeps all your mail");
    expect(host.querySelector(".storage-plan.fitted")?.textContent).toContain("With +10 GB: 15 GB, $25/month");
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
    const sw = host.querySelector<HTMLButtonElement>("[role=switch]")!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => { sw.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(sent("PATCH /api/account/storage").map((w) => w.body)).toEqual([{ mail: false }]);
    expect(host.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false");
  });

  it("German: the room and the numbers in the reader's language", async () => {
    access = open(NEAR);
    await mount("pane", "de");
    expect(text()).toContain("3,2 GB von 4 GB");
    expect(text()).toContain("belegt, die 4 GB deiner Testphase");
  });
});
