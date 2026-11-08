/** @vitest-environment jsdom */
/**
 * STORAGE ON THE PHONE, RENDERED: the Ohbox card and the Storage screen draw the numbers and, on the
 * store face, no amount, no purchase press and no link (no `Linking` call, whatever is pressed);
 * Dismiss is the server's to keep; Load it now shows an emptied letter's text for this view and
 * writes nothing anywhere: one GET, and nothing else asked of the server or the device.
 */
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derivePosture } from "../src/ui/posture/derive";
import { mount } from "./_rendered-dom";

const live = vi.hoisted(() => ({
  openURL: vi.fn(async () => undefined),
  session: null as unknown,
  sql: vi.fn(),
}));
vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Linking: { openURL: live.openURL },
  ActivityIndicator: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => derivePosture({ width: 412, height: 892, platform: "android", folds: [], hasFold: false }),
  useAppWindow: () => ({ width: 412, height: 892 }),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }), radius: new Proxy({}, { get: () => 8 }),
    space: new Proxy({}, { get: () => 8 }), type: new Proxy({}, { get: () => ({}) }),
    lift: () => ({}), textCap: 2, textKey: 1, reduceMotion: true,
  }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/state/world", () => ({ useLiveSession: () => live.session }));
/* The device store's one SQL door: the emptied letter must never reach it. */
vi.mock("../src/engine/sql-queue", () => ({ serialSqlExecutor: live.sql }));

const { readAccess, resetAccessFeedForTests } = await import("../src/net/account");
const { resetAccessLockForTests } = await import("../src/net/access-lock");
const { StorageNotice } = await import("../src/ui/StorageNotice");
const { StoragePane } = await import("../src/ui/StoragePane");
const { EmptiedLetter } = await import("../src/ui/EmptiedLetter");
const { accessOf } = await import("../src/net/account");

const GB = 1_000_000_000;
const STORAGE = {
  usedBytes: 3.2 * GB, limitBytes: 4 * GB, emptiedForSpace: 0, firstEmptiedAt: null, keptFrom: null,
  withheldOnArrival: 0, upgrade: "plan", emptyingNow: false, planLimitBytes: 2 * GB, limitDropsAt: null,
  limitReason: "trial", importing: true, card: "near", mail: true,
  estimate: { expectedBytes: 12.5 * GB, expectedLetters: 500_000, storedLetters: 128_000, avgLetterBytes: 25_000, avgMeasured: true, complete: true, at: null },
  mailboxes: [{ id: "mb-1", usedBytes: 3.2 * GB, letters: 128_000, expectedLetters: 500_000, expectedBytes: 12.5 * GB, importing: true }],
  offer: {
    currency: "usd", interval: "month",
    plans: [{ plan: "solo", mailboxes: 2, roomBytes: 2 * GB, amount: 900 }, { plan: "plus", mailboxes: 5, roomBytes: 5 * GB, amount: 1500 }],
    addon: { unitBytes: 10 * GB, amount: 1000, maxUnits: 10 },
    current: { plan: "solo", addonUnits: 0, roomBytes: 2 * GB, roomFrom: "now" },
    fit: { plan: "plus", addonUnits: 1, roomBytes: 15 * GB, amount: 2500, keepsAll: true },
    canChange: true, reason: null,
  },
};
const ANSWER = { metered: true, access: "open", lifecycle: { state: "trialing", closedReason: null }, storage: STORAGE };
const PRICE = /[$€£]|\b(usd|eur)\b|\/month|per month|\b(9|15|25|10)\.00\b/i;

/** A paired Cloud session answering per route, recording every request. */
function door(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const s = {
    standalone: false, ownerKey: "owner-1",
    profile: { id: "pairing-1", origin: "https://cloud.test", apiBase: null, flavor: "managed" },
    fetch: async (url: string, init: RequestInit) => {
      const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
      asked.push(key);
      return answers[key]?.() ?? new Response("no", { status: 404 });
    },
  };
  return { s: s as never, asked };
}
const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Every press on screen, pressed. */
const pressAll = (el: HTMLElement) => act(() => { for (const b of [...el.querySelectorAll('[data-role="button"]')]) (b as HTMLElement).click(); });
const roles = (el: HTMLElement, role: string) => [...el.querySelectorAll(`[data-role="${role}"]`)].map((n) => n.textContent);

let open: { el: HTMLElement; unmount(): void } | null = null;
beforeEach(() => {
  resetAccessLockForTests();
  resetAccessFeedForTests();
  live.openURL.mockClear();
});
afterEach(() => { open?.unmount(); open = null; });

describe("the card atop the Ohbox, store face", () => {
  it("draws the numbers and the fitted plan, no amount, no press but Dismiss, no link", async () => {
    const { s } = door({ "GET /account/access": json(ANSWER) });
    await readAccess(s);
    open = mount(createElement(StorageNotice, { session: s }));
    const text = open.el.textContent ?? "";
    expect(text).toContain("Storage is 80% full");
    expect(text).toContain("3.2 GB of your trial room of 4 GB used. Expected about 12.5 GB when the import finishes.");
    expect(text).toContain("Plus + 10 GB storage keeps all your mail: 15 GB.");
    expect(text).toContain("Manage your plan at ohmail.app");
    expect(text).not.toMatch(PRICE);
    expect(roles(open.el, "button")).toEqual(["Dismiss"]);
    expect(roles(open.el, "link")).toEqual([]);
  });

  it("pressing everything on it opens nothing; Dismiss is sent to the server and the card goes", async () => {
    const { s, asked } = door({ "GET /account/access": json(ANSWER), "PATCH /account/storage": json({ dismissed: "near" }) });
    await readAccess(s);
    open = mount(createElement(StorageNotice, { session: s }));
    pressAll(open.el);
    await settle();
    expect(live.openURL).not.toHaveBeenCalled();
    expect(asked).toEqual(["GET /account/access", "PATCH /account/storage"]);
    expect(open.el.textContent).toBe("");
  });

  it("an older server at the cap, which sends no card: Storage is full with the numbers; Dismiss asks it nothing", async () => {
    const older = { usedBytes: 4 * GB, limitBytes: 4 * GB, emptiedForSpace: 286_000, emptyingNow: true, keptFrom: "2019-03" };
    const { s, asked } = door({ "GET /account/access": json({ ...ANSWER, storage: older }) });
    await readAccess(s);
    open = mount(createElement(StorageNotice, { session: s }));
    const text = open.el.textContent ?? "";
    expect(text).toContain("Storage is full");
    expect(text).toContain("4 GB of your plan's 4 GB used.");
    expect(roles(open.el, "button")).toEqual(["Dismiss"]);
    pressAll(open.el);
    await settle();
    expect(asked).toEqual(["GET /account/access"]);
    expect(open.el.textContent).toBe("");
  });

  it("stands atop the Ohbox only, and only when the server decided a card", async () => {
    const { s } = door({ "GET /account/access": json(ANSWER) });
    await readAccess(s);
    open = mount(createElement(StorageNotice, { session: s, ohbox: false }));
    expect(open.el.textContent).toBe("");
    open.unmount();
    resetAccessFeedForTests();
    const none = door({ "GET /account/access": json({ ...ANSWER, storage: { ...STORAGE, card: null } }) });
    await readAccess(none.s);
    open = mount(createElement(StorageNotice, { session: none.s }));
    expect(open.el.textContent).toBe("");
  });
});

describe("the Storage screen's body, store face", () => {
  it("draws used of the cap, the mailbox, the estimate, the plans with GB and letters; no amount, no link", () => {
    const facts = accessOf(ANSWER)!.storage!;
    open = mount(createElement(StoragePane, {
      facts, labelOf: () => "sam@example.com", manage: createElement("span", null, "PRESS"), distribution: "store",
    }));
    const text = open.el.textContent ?? "";
    for (const said of [
      "3.2 GB of 4 GB", "80%", "used, your trial room", "sam@example.com", "3.2 GB kept · 12.5 GB expected",
      "Expected when the import finishes: about 12.5 GB, 500,000 letters.",
      "Solo · your plan", "2 GB · about 80,000 letters", "Plus + 10 GB storage", "Keeps all your mail",
      "Manage your plan at ohmail.app", "Only the text of your letters counts.",
    ]) expect(text, said).toContain(said);
    expect(text).not.toContain("PRESS");
    expect(text).not.toMatch(PRICE);
    expect(roles(open.el, "button")).toEqual([]);
    expect(roles(open.el, "link")).toEqual([]);
  });

  it("a sideload build draws its press in the line's place", () => {
    const facts = accessOf(ANSWER)!.storage!;
    open = mount(createElement(StoragePane, {
      facts, labelOf: () => "", manage: createElement("span", null, "PRESS"), distribution: "sideload",
    }));
    expect(open.el.textContent).toContain("PRESS");
    expect(open.el.textContent).not.toContain("Manage your plan at ohmail.app");
  });
});

describe("an emptied letter", () => {
  it("Load it now shows the text for this view: one GET, nothing written, nothing else asked", async () => {
    const { s, asked } = door({ "GET /messages/m-1/live-body": json({ text: "Hi Sam, the plans are attached.", html: null }) });
    live.session = s;
    const shown: string[] = [];
    const settings = vi.fn();
    open = mount(createElement(EmptiedLetter, { messageId: "m-1", removed: false, onLoaded: (t: string) => shown.push(t), onSettings: settings }));
    expect(open.el.textContent).toContain("This letter's text isn't kept on Cloud because your storage is full.");
    expect(roles(open.el, "button")).toEqual(["Load it now", "Storage settings"]);
    act(() => (open!.el.querySelector('[data-role="button"]') as HTMLElement).click());
    await settle();
    expect(shown).toEqual(["Hi Sam, the plans are attached."]);
    expect(asked).toEqual(["GET /messages/m-1/live-body"]);
    expect(open.el.textContent).toContain("Loaded from your mail server for this view. Not stored on Cloud.");
    expect(live.sql).not.toHaveBeenCalled();
    expect(live.openURL).not.toHaveBeenCalled();
  });

  it("a refusal is said by name; a mailbox ohmail no longer reads gets no Load it now", async () => {
    const { s } = door({ "GET /messages/m-1/live-body": json({ error: { code: "letter_gone" } }, 410) });
    live.session = s;
    open = mount(createElement(EmptiedLetter, { messageId: "m-1", removed: false, onLoaded: () => undefined, onSettings: () => undefined }));
    act(() => (open!.el.querySelector('[data-role="button"]') as HTMLElement).click());
    await settle();
    expect(open.el.textContent).toContain("Your mail server no longer holds this letter where ohmail last saw it.");
    open.unmount();
    open = mount(createElement(EmptiedLetter, { messageId: "m-1", removed: true, onLoaded: () => undefined, onSettings: () => undefined }));
    expect(roles(open.el, "button")).toEqual(["Storage settings"]);
    expect(open.el.textContent).toContain("ohmail no longer reads this mailbox");
  });
});
