/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE NOTICE THAT OHMAIL EMPTIED LETTER TEXT FOR SPACE, and the Settings line beside the plan. Shown
 * once per browser and account while `GET /account/access` reports emptied letters; put away, it
 * stays away across a reload. Trial and paid accounts are told different ways to keep more text, and
 * neither is promised the emptied text back.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let access: Record<string, unknown> = { metered: false };
const realFetch = globalThis.fetch;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const EMPTIED = {
  usedBytes: 1_868_000_000, limitBytes: 2_000_000_000, emptiedForSpace: 80_000,
  firstEmptiedAt: "2026-10-20T03:00:00.000Z", keptFrom: "2019-04", withheldOnArrival: 0,
};
const open = (storage: unknown, state = "trialing"): Record<string, unknown> => ({
  metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state, closedReason: null, trialEndsAt: null, graceUntil: null },
  ...(storage === undefined ? {} : { storage }),
});

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  globalThis.localStorage.clear();
  globalThis.fetch = (async (url: RequestInfo | URL) =>
    (String(url).includes("/account/access") ? json(access) : json({}))) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  globalThis.fetch = realFetch;
  globalThis.localStorage.clear();
});

async function mount(which: "notice" | "settings", locale: "en" | "de" = "en"): Promise<void> {
  const { account, forgetAccess } = await import("../app/api-client");
  forgetAccess();
  const { CloudStorageNotice } = await import("../app/(product)/mailbox/CloudStorageNotice");
  const { SubscriptionSection } = await import("../app/(product)/mailbox/SubscriptionSection");
  const child = which === "notice" ? h(CloudStorageNotice) : h(SubscriptionSection, { onNowhere: () => {} });
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, children: h(ThemeProvider, { children: child }),
    }));
  });
  await act(async () => { await account.access({ fresh: true }); });
}

const text = (): string => host.textContent ?? "";

describe("the emptied-text notice", () => {
  it("says what happened, how many, from which month, that the letters are complete on the server", async () => {
    access = open(EMPTIED);
    await mount("notice");
    expect(text()).toContain("To stay within your plan's 2 GB, ohmail no longer stores the text of your 80,000 oldest letters.");
    expect(text()).toContain("Text is kept for letters from April 2019 on.");
    expect(text()).toContain("stay complete in your mailbox on your mail server");
    expect(text()).toContain("Manage subscription");
  });

  it("letters that arrived while the storage was full are counted apart, never as the oldest", async () => {
    access = open({ ...EMPTIED, withheldOnArrival: 12 });
    await mount("notice");
    expect(text()).toContain("ohmail no longer stores the text of your 79,988 oldest letters.");
    expect(text()).toContain(
      "Text is kept for letters from April 2019 on, apart from 12 letters that arrived while your storage was full.");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    // No month recorded, and every emptied letter arrived while the storage was full.
    access = open({ ...EMPTIED, emptiedForSpace: 1, withheldOnArrival: 1, keptFrom: null });
    await mount("notice");
    expect(text()).toContain("One letter that arrived while your storage was full is stored without its text.");
    expect(text()).not.toContain("oldest");
    expect(text()).toContain("stay complete in your mailbox on your mail server");
  });

  it("a trial is offered a bigger plan, a paid account the plan or the add-on, and neither the text back", async () => {
    access = open(EMPTIED, "trialing");
    await mount("notice");
    const trial = text();
    expect(trial).toContain("A bigger plan keeps more text from now on.");
    expect(trial).not.toContain("add-on");
    expect(trial).toContain("does not bring back text");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    access = open(EMPTIED, "active");
    await mount("notice");
    expect(text()).toContain("A bigger plan or the storage add-on keeps more text from now on.");
    expect(text()).toContain("does not bring back text");
  });

  it("after an upgrade, below the new cap, it says what happened then and offers nothing", async () => {
    access = open({ ...EMPTIED, limitBytes: 10_000_000_000 }, "active");
    await mount("notice");
    expect(text()).toContain(
      "To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(text()).not.toContain("10 GB");
    expect(text()).not.toMatch(/bigger plan|add-on/);
    expect(text()).toContain("stay complete in your mailbox on your mail server");
  });

  it("past due or in grace, no add-on and no plan is offered", async () => {
    for (const state of ["past_due", "grace"]) {
      access = open(EMPTIED, state);
      await mount("notice");
      expect(text(), state).toContain("ohmail no longer stores the text of your 80,000 oldest letters.");
      expect(text(), state).not.toMatch(/bigger plan|add-on/);
      await act(async () => { root.unmount(); });
      root = createRoot(host);
    }
  });

  it("put away, it stays away after a reload", async () => {
    access = open(EMPTIED);
    await mount("notice");
    const dismiss = [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss");
    await act(async () => { dismiss!.click(); });
    expect(host.querySelector("[data-storage-notice]")).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount("notice");
    expect(host.querySelector("[data-storage-notice]")).toBeNull();
  });

  it("draws nothing without a block, with nothing emptied, or on an unmetered host", async () => {
    for (const a of [open(undefined), open({ ...EMPTIED, emptiedForSpace: 0 }), { metered: false }, open(EMPTIED)]) {
      access = a;
      await mount("notice");
      // The last arm is the control: the same mount does draw for a block with emptied letters.
      expect(host.querySelector("[data-storage-notice]") !== null).toBe(a.storage === EMPTIED);
    }
  });

  it("speaks German too", async () => {
    access = open(EMPTIED, "active");
    await mount("notice", "de");
    expect(text()).toContain("Für Nachrichten ab April 2019 bleibt der Text gespeichert.");
    expect(text()).toContain("Bereits entfernten Text bringt das nicht zurück.");
  });
});

describe("the storage line in Settings", () => {
  it("shows the numbers and how many letters' text is not stored, never that mail stops", async () => {
    access = open(EMPTIED, "active");
    await mount("settings");
    expect(text()).toContain("1.9 GB of 2 GB");
    expect(text()).toContain("the text of your 80,000 oldest letters is not stored here");
    expect(text()).toContain("Text is kept for letters from April 2019 on.");
    expect(text()).not.toMatch(/stops? (storing new|arriving)|declin/i);
  });

  it("counts the letters that arrived while the storage was full apart from the oldest", async () => {
    access = open({ ...EMPTIED, withheldOnArrival: 3 }, "active");
    await mount("settings");
    expect(text()).toContain("the text of your 79,997 oldest letters is not stored here");
    expect(text()).toContain(
      "Text is kept for letters from April 2019 on, apart from 3 letters that arrived while your storage was full.");
  });

  it("after an upgrade, below the new cap, says the text was emptied under the plan at the time", async () => {
    access = open({ ...EMPTIED, limitBytes: 10_000_000_000 }, "active");
    await mount("settings");
    expect(text()).toContain("1.9 GB of 10 GB");
    expect(text()).toContain(
      "To stay within your plan's storage at the time, ohmail stopped storing the text of your 80,000 oldest letters.");
    expect(text()).not.toContain("is not stored here");
  });

  it("has no storage line without a block", async () => {
    access = open(undefined, "active");
    await mount("settings");
    expect(text()).not.toContain("Storage");
  });
});
