/**
 * The page's emitter: what it draws, in which words, and when it stays quiet. It carries new mail,
 * waiting senders and pairing (scheduled mail waits for its ruling), draws them only while this tab is not the one looked at, leaves new mail to the
 * service worker while no window is visible, and takes back what is listed at sign-out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import { noticeKindsOf, type Notice } from "@ohmail/client-engine";
import {
  browserNoticePage, noticeWordingOf, webNoticeEmitter, type NoticePage,
} from "../app/shell/notice-emitter";
import EN from "../messages/en.json";
import DE from "../messages/de.json";

const MESSAGES = { en: EN, de: DE } as const;

function wordingIn(locale: "en" | "de") {
  const t = createTranslator({ locale, messages: MESSAGES[locale] as Record<string, unknown>, namespace: "frame.systemNotice" });
  return noticeWordingOf((key, values) => (t as (k: string, v?: Record<string, string | number>) => string)(key, values));
}

/** A page that records every notice it was asked to draw and every taking back. */
function page(state: { focused?: boolean; visible?: boolean } = {}) {
  const shown: { title: string; body: string }[] = [];
  const tags: string[] = [];
  let closed = 0;
  const p: NoticePage = {
    focused: () => state.focused ?? false,
    visible: () => state.visible ?? true,
    show: (title, body, tag) => { shown.push({ title, body }); tags.push(tag); },
    closeAll: async () => { closed += 1; },
  };
  return { p, shown, tags, closed: () => closed };
}

const EVERY_MAIL: Notice[] = [
  { kind: "ohbox", count: 1 },
  { kind: "ohbox", count: 4 },
  { kind: "screener", count: 2 },
  { kind: "pairing", change: "paired", device: "phone" },
  { kind: "pairing", change: "revoked", device: null },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe("the page's emitter", () => {
  it("carries new mail, waiting senders and pairing, all of them kinds the table lets a browser draw", () => {
    const { carries } = webNoticeEmitter(page().p, () => wordingIn("en"));
    expect([...carries]).toEqual(["ohbox", "screener", "pairing"]);
    for (const kind of carries) expect(noticeKindsOf("web")).toContain(kind);
  });

  it("draws each kind in the catalogue's own words, in English and in German", () => {
    for (const locale of ["en", "de"] as const) {
      const r = page();
      const emitter = webNoticeEmitter(r.p, () => wordingIn(locale));
      for (const notice of EVERY_MAIL) emitter.post(notice);
      expect(r.shown).toHaveLength(EVERY_MAIL.length);
      for (const { title, body } of r.shown) {
        expect(title.length, locale).toBeGreaterThan(0);
        expect(body.length, locale).toBeGreaterThan(0);
        expect(`${title} ${body}`, "a sentence left a value unfilled").not.toMatch(/[{}#]/);
      }
    }
    const r = page();
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    emitter.post({ kind: "ohbox", count: 4 });
    emitter.post({ kind: "pairing", change: "paired", device: "phone" });
    emitter.post({ kind: "screener", count: 1 });
    const say = createTranslator({ locale: "en", messages: EN as Record<string, unknown>, namespace: "frame.systemNotice" }) as
      (k: string, v?: Record<string, string | number>) => string;
    expect(r.shown).toEqual([
      { title: say("ohboxTitle"), body: say("ohboxBody", { count: 4 }) },
      { title: say("pairedTitle"), body: say("pairedBody", { device: "phone" }) },
      { title: say("screenerTitle"), body: say("screenerBody", { count: 1 }) },
    ]);
    expect(r.shown[0]!.body, "the count reached the sentence").toContain("4");
  });

  it("tags each notice with its kind's own closed word, so two tabs draw one notice of a kind", () => {
    const r = page();
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    for (const notice of EVERY_MAIL) emitter.post(notice);
    expect(r.tags).toEqual([
      "ohmail-new-mail", "ohmail-new-mail", "ohmail-screener", "ohmail-pairing", "ohmail-pairing",
    ]);
  });

  it("draws nothing while this tab is the one looked at", () => {
    const r = page({ focused: true });
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    for (const notice of EVERY_MAIL) emitter.post(notice);
    expect(r.shown).toEqual([]);
  });

  it("leaves new mail to the service worker while no window is visible, and draws the other kinds", () => {
    const r = page({ visible: false });
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    emitter.post({ kind: "ohbox", count: 2 });
    expect(r.shown, "one arrival drawn twice: the page and the worker").toEqual([]);
    emitter.post({ kind: "screener", count: 1 });
    emitter.post({ kind: "pairing", change: "paired", device: null });
    expect(r.shown).toHaveLength(2);
  });

  it("draws nothing for a kind it does not carry, even when handed one", () => {
    const r = page();
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    emitter.post({ kind: "scheduled", outcome: "sent", count: 1 });
    emitter.post({ kind: "scheduled", outcome: "failed", count: 2 });
    emitter.post({ kind: "cal_summary", events: 3, first: null, toAnswer: 1 });
    emitter.post({ kind: "cal_found", count: 1, at: null });
    expect(r.shown).toEqual([]);
  });

  it("never throws: a page that cannot draw takes nothing down", () => {
    const broken: NoticePage = {
      focused: () => { throw new Error("no document"); }, visible: () => true,
      show: () => { throw new Error("no"); }, closeAll: () => { throw new Error("no"); },
    };
    const emitter = webNoticeEmitter(broken, () => wordingIn("en"));
    expect(() => emitter.post({ kind: "ohbox", count: 1 })).not.toThrow();
    expect(() => emitter.takeBack()).not.toThrow();
  });

  it("takes back every notice of this origin still listed", async () => {
    const r = page();
    webNoticeEmitter(r.p, () => wordingIn("en")).takeBack();
    expect(r.closed()).toBe(1);

    // And the browser's page closes each one its worker's registration still lists.
    const listed = [{ close: vi.fn() }, { close: vi.fn() }];
    const registration = { getNotifications: vi.fn(async () => listed), showNotification: vi.fn(async () => undefined) };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => registration } });
    await browserNoticePage.closeAll();
    for (const n of listed) expect(n.close).toHaveBeenCalledTimes(1);
    browserNoticePage.show("New mail", "One new message for you.", "ohmail-new-mail");
    await vi.waitFor(() => expect(registration.showNotification)
      .toHaveBeenCalledWith("New mail", { body: "One new message for you.", tag: "ohmail-new-mail" }));
  });
});
