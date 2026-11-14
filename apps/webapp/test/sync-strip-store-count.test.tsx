/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { deriveMailState, seedGrowth, type MailState, type MailboxFacts, type StoreRefusals } from "@ohmail/app-logic/mail-state/mail-state";
import { mailboxErrorKey } from "@ohmail/app-logic/mail-state/mailbox-error-key";
import { setActiveCatalog } from "../app/shell/locale";

/**
 * A COPY THAT COULD NOT STORE THE ACCOUNT'S ROWS SAYS HOW MANY (CLOUD-QUARANTINE-STRIP-COUNT-AND-
 * CAP-STATE). The Cloud-paired desktop's overlay carries `storeRefusals` beside `errorCode:
 * "storage"`; ONE chooser picks the sentence and ONE figure function spells the count, for the
 * strip, web Settings and the desktop pane. Past what "Sync now" retries the sentence says so, and
 * a floor is said as "more than". Absent, the count-less sentence stands. en and de both rendered.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null,
  continuesAtFolder: null, settled: true, owed: false,
};
let current: MailState = QUIET;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", () => ({ useMailState: () => ({ state: current, freshness: { state: "unknown" as const, asOf: null }, refresh: () => {} }) }));

const EXACT: StoreRefusals = { count: 612, retrying: 612, exact: true };
const CAPPED: StoreRefusals = { count: 612, retrying: 500, exact: true };
const FLOOR: StoreRefusals = { count: 10_500, retrying: 500, exact: false };
const ONE: StoreRefusals = { count: 1, retrying: 1, exact: true };
const failing = (r?: StoreRefusals): MailState => ({
  ...QUIET, key: "mailboxError", errorCode: "storage", address: "me@example.test", ...(r ? { storeRefusals: r } : {}),
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  setActiveCatalog("en", null);
});

async function stripText(state: MailState, lang: "en" | "de"): Promise<string> {
  current = state;
  setActiveCatalog(lang, null);
  const { TodaysNotice: SyncBar } = await import("./_todays-notice.js"); // the strip's state, said in the frame's notice
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: lang, messages: lang === "en" ? en : de, timeZone: "UTC", now: new Date("2026-09-29T08:00:00.000Z"),
      children: h(SyncBar, null),
    }));
  });
  return host.textContent ?? "";
}

describe("the one chooser", () => {
  it("picks the counted sentence, the capped one, and the count-less one", () => {
    const fig = (r: StoreRefusals) => String(r.count);
    expect(mailboxErrorKey("storage", null, EXACT, fig).key).toBe("err_storage_count");
    expect(mailboxErrorKey("storage", null, CAPPED, fig).key).toBe("err_storage_capped");
    expect(mailboxErrorKey("storage", null, FLOOR, fig).key).toBe("err_storage_capped");
    expect(mailboxErrorKey("storage", null, undefined, fig)).toEqual({ key: "err_storage" });
    // CONTROL: a count on another failure class is not a storage sentence.
    expect(mailboxErrorKey("connect", null, EXACT, fig)).toEqual({ key: "err_connect" });
  });

  it("the ladder carries the count from the mailbox onto the strip's arm", () => {
    const now = Date.parse("2026-09-29T08:00:00.000Z");
    const m: MailboxFacts = {
      id: "mb1", address: "me@example.test", status: "error", errorCode: "storage", disabledReason: null,
      syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: new Date(now - 30_000).toISOString(),
      initialImportCompletedAt: new Date(now - 60_000).toISOString(), createdAt: new Date(now - 120_000).toISOString(),
      storeRefusals: CAPPED,
    };
    const state = deriveMailState({
      sync: { phase: "idle" } as never, failureStreak: 0, mailboxes: [m], mirrored: 10, pulled: 10,
      growth: seedGrowth(10), freshness: { state: "current", asOf: new Date(now).toISOString() },
      engineFreshness: { state: "current", asOf: new Date(now).toISOString() }, now, demo: false, scope: null,
    });
    expect(state.key).toBe("mailboxError");
    expect(state.storeRefusals).toEqual(CAPPED);
  });
});

describe("the strip says the count, in both languages", () => {
  it("en: every refusal retried, one refusal, past the retry, and a floor", async () => {
    expect(await stripText(failing(EXACT), "en")).toContain("could not store 612 items from your account on this computer. This one is on us.");
    expect(await stripText(failing(ONE), "en")).toContain("could not store one item from your account");
    expect(await stripText(failing(CAPPED), "en")).toContain("could not store 612 items from your account on this computer, more than Sync now can retry.");
    expect(await stripText(failing(FLOOR), "en")).toContain("could not store more than 10,500 items");
  });

  it("de: the same four", async () => {
    expect(await stripText(failing(EXACT), "de")).toContain("konnte 612 Einträge deines Accounts auf diesem Computer nicht speichern. Das liegt an uns.");
    expect(await stripText(failing(ONE), "de")).toContain("konnte einen Eintrag deines Accounts");
    expect(await stripText(failing(CAPPED), "de")).toContain("mehr als „Jetzt synchronisieren“ erneut versuchen kann");
    expect(await stripText(failing(FLOOR), "de")).toContain("konnte mehr als 10.500 Einträge");
  });

  it("CONTROL: with no count stated the count-less sentence stands", async () => {
    expect(await stripText(failing(), "en")).toContain((en.mailboxes as Record<string, string>).err_storage);
  });
});

describe("a copy this computer cannot store into says so, and what to do", () => {
  const frozen: MailState = { ...failing(), errorDetail: "MIRROR_STORE_REFUSED" };
  /* The strip's link is the notice's act: its words, and where a press on it leads. */
  const act0 = (): HTMLButtonElement | undefined => host!.querySelector<HTMLButtonElement>("[role='status'][data-place] button") ?? undefined;
  const leadsTo = async (): Promise<string | undefined> => {
    const press = act0();
    if (!press) return undefined;
    window.location.hash = "";
    await act(async () => { press.click(); });
    return window.location.hash;
  };
  it("en and de: the storage sentence, and the link writes to us", async () => {
    expect(await stripText(frozen, "en")).toContain((en.mailboxes as Record<string, string>).err_storage);
    expect(act0()?.textContent).toBe(en.help.write);
    expect(await leadsTo()).toBe("#/settings/help");
    expect(await stripText(frozen, "de")).toContain((de.mailboxes as Record<string, string>).err_storage);
    expect(act0()?.textContent).toBe(de.help.write);
  });

  it("CONTROL: a counted storage failure keeps the Mailboxes link", async () => {
    await stripText(failing(EXACT), "en");
    expect(await leadsTo()).toBe("#/settings/mailboxes");
  });
});
