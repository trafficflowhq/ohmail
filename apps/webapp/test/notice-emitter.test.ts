/**
 * The page's emitter: what it draws, in which words, and when it stays quiet. It carries new mail,
 * waiting senders and pairing (scheduled mail waits for its ruling), draws them only while this tab is not the one looked at, leaves new mail to the
 * service worker while no window is visible, and takes back what is listed at sign-out.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import { MemoryMirrorStore, noticeChoicesOf, noticeKindsOf, type Notice, type SyncChange } from "@ohmail/client-engine";
import { NoticeCaller, noticeReadsOf, toldDevicesIn } from "@ohmail/app-logic/notices/use-notices";
import {
  browserNoticePage, noticeWordingOf, subscribeBrowserNoticeOpening, webNoticeEmitter, type NoticePage,
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
  it("carries new mail, waiting senders, pairing and the calendar's kinds but its summary, all of them kinds the table lets a browser draw", () => {
    const { carries, ahead } = webNoticeEmitter(page().p, () => wordingIn("en"));
    expect([...carries]).toEqual([
      "ohbox", "screener", "pairing", "cal_alert", "cal_invitation", "cal_change", "cal_answer", "cal_found",
    ]);
    for (const kind of carries) expect(noticeKindsOf("web")).toContain(kind);
    expect(ahead, "the page rings its alerts by the caller's own book").toBe("none");
  });

  it("draws the calendar's kinds: the event's label as the title, the catalogue's words over numbers as the body", () => {
    const title = { as: "title", text: "Design review" } as const;
    const today = { hour: 14, minute: 0, day: "today" } as const;
    const friday = { hour: 9, minute: 5, day: { month: 11, dom: 20, dow: 5 } } as const;
    const CALENDAR: Notice[] = [
      { kind: "cal_alert", eventId: "e1", label: title, at: today, allDay: false, leadMin: 10, acts: [] },
      { kind: "cal_invitation", eventId: "e1", label: { as: "busy" }, at: today, allDay: false },
      { kind: "cal_change", change: "moved", eventId: "e1", label: title, at: friday, was: today, allDay: false },
      { kind: "cal_change", change: "moved", eventId: "e1", label: { as: "event" }, at: friday, was: null, allDay: false },
      { kind: "cal_change", change: "cancelled", eventId: "e1", label: title, at: { hour: 0, minute: 0, day: "tomorrow" }, allDay: true },
      { kind: "cal_answer", eventId: "e1", label: title, answer: "maybe", count: 2 },
      { kind: "cal_found", count: 3, at: null },
    ];
    const r = page();
    const emitter = webNoticeEmitter(r.p, () => wordingIn("en"));
    for (const notice of CALENDAR) emitter.post(notice);
    expect(r.shown).toEqual([
      { title: "Design review", body: "Starts in 10 minutes." },
      { title: "Busy", body: "Invitation · today, 14:00" },
      { title: "Design review", body: "Now Fri 20 Nov, 09:05 · was today, 14:00" },
      { title: "Event", body: "Now Fri 20 Nov, 09:05" },
      { title: "Design review", body: "Cancelled · tomorrow" },
      { title: "Design review", body: "2 guests said maybe." },
      { title: "Found in your mail", body: "3 possible events." },
    ]);
    expect(r.tags).toEqual([
      "ohmail-cal-alert", "ohmail-cal-invitation", "ohmail-cal-change", "ohmail-cal-change", "ohmail-cal-change",
      "ohmail-cal-answer", "ohmail-cal-found",
    ]);
    const de = page();
    const german = webNoticeEmitter(de.p, () => wordingIn("de"));
    for (const notice of CALENDAR) german.post(notice);
    expect(de.shown.map((s) => s.body)).toEqual([
      "Beginnt in 10 Minuten.", "Einladung · heute, 14:00", "Jetzt Fr., 20. Nov., 09:05 · vorher heute, 14:00",
      "Jetzt Fr., 20. Nov., 09:05", "Abgesagt · morgen", "2 Gäste haben mit Vielleicht geantwortet.", "3 mögliche Termine.",
    ]);
    expect(de.shown.slice(1, 4).map((s) => s.title)).toEqual(["Belegt", "Design review", "Termin"]);
    for (const { body } of [...r.shown, ...de.shown]) expect(body, "the event's title reached a body").not.toContain("Design");
  });

  it("a take-back withdraws a title still waiting for the worker registration", async () => {
    const reg = { showNotification: vi.fn(), getNotifications: vi.fn(async () => []) };
    let release!: (answer: typeof reg) => void;
    const pending = new Promise<typeof reg>(resolve => { release = resolve; });
    const getRegistration = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(reg);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    const old = browserNoticePage.show("Earlier event", "Reminder", "ohmail-cal-alert");
    await browserNoticePage.closeAll();
    release(reg);
    expect(await old).toBe(false);
    expect(reg.showNotification).not.toHaveBeenCalled();
    expect(await browserNoticePage.show("Current event", "Reminder", "ohmail-cal-alert")).toBe(true);
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("a delayed withdrawal leaves a later accepted draw alone (accepted %s)", async accepted => {
    const retained = { tag: "ohmail-cal-alert", timestamp: 0, close: vi.fn() };
    const earlier = { tag: "ohmail-cal-invitation", timestamp: 0, close: vi.fn() };
    const reg = {
      getNotifications: async () => [retained, earlier],
      showNotification: async (_title: string, options: NotificationOptions & { timestamp?: number }) => {
        if (!accepted) throw new Error("refused");
        retained.timestamp = options.timestamp ?? Date.now();
      },
    };
    let release!: (value: typeof reg) => void;
    const original = new Promise<typeof reg>(resolve => { release = resolve; });
    const getRegistration = vi.fn().mockReturnValueOnce(original).mockResolvedValue(reg);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    const close = browserNoticePage.closeAll();
    expect(await browserNoticePage.show("Current event", "Reminder", retained.tag)).toBe(accepted);
    release(reg);
    await close;
    expect(earlier.close).toHaveBeenCalledTimes(1);
    expect(retained.close).toHaveBeenCalledTimes(accepted ? 0 : 1);
  });

  it("closes an older listed event while a newer submission of its kind is still unanswered", async () => {
    const old = { tag: "ohmail-cal-alert", timestamp: 1, close: vi.fn() };
    let submitted!: () => void;
    const received = new Promise<void>(resolve => { submitted = resolve; });
    const reg = {
      getNotifications: async () => [old],
      showNotification: () => { submitted(); return new Promise<void>(() => {}); },
    };
    let release!: (value: typeof reg) => void;
    const pending = new Promise<typeof reg>(resolve => { release = resolve; });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(reg) } });
    const cleanup = browserNoticePage.closeAll();
    void browserNoticePage.show("Current event", "Reminder", old.tag);
    await received;
    release(reg);
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce(), { timeout: 300 });
    await cleanup;
  });

  it("closes an old OS submission that becomes listed after the first withdrawal sweep", async () => {
    const old = { tag: "ohmail-cal-alert", timestamp: 1, close: vi.fn() };
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const listed: typeof old[] = [];
    const reg = {
      getNotifications: async () => listed,
      showNotification: () => {
        entered();
        return new Promise<void>(resolve => { finish = () => { listed.push(old); resolve(); }; });
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const pending = browserNoticePage.show("Earlier event", "Reminder", old.tag);
    await started;
    await browserNoticePage.closeAll();
    expect(old.close).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(old.close).toHaveBeenCalledOnce();
  });

  it("withdraws a late reminder while preserving the later one when the browser exposes no timestamp", async () => {
    const tag = "ohmail-cal-alert";
    const listed: { tag: string; title: string; body: string; data: unknown; close: ReturnType<typeof vi.fn> }[] = [];
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    const reg = {
      getNotifications: async () => listed,
      showNotification: async (title: string, options: { tag: string; body: string; data?: unknown }) => {
        if (first) {
          first = false;
          started();
          await new Promise<void>(resolve => { release = resolve; });
        }
        listed.push({ tag, title, body: options.body, data: options.data, close: vi.fn() });
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const earlier = browserNoticePage.show("Same event", "Same reminder", tag);
    await pending;
    await browserNoticePage.closeAll();
    expect(await browserNoticePage.show("Same event", "Same reminder", tag)).toBe(true);
    release();
    expect(await earlier).toBe(false);
    expect(listed.map(notice => notice.close.mock.calls.length)).toEqual([0, 1]);
    expect(listed.every(notice => Number.isSafeInteger(notice.data))).toBe(true);
  });

  it.each([
    { withdraw: true, oldEligible: false, eligible: true },
    { withdraw: true, oldEligible: false, eligible: false },
    { withdraw: false, oldEligible: false, eligible: true },
    { withdraw: false, oldEligible: true, eligible: true },
    { withdraw: false, oldEligible: false, eligible: false },
  ])("keeps the current reminder when a late submission replaces its tag ($withdraw, $oldEligible, $eligible)", async ({ withdraw, oldEligible, eligible }) => {
    const tag = "ohmail-cal-alert";
    type Drawn = { tag: string; title: string; data: unknown; close(): void };
    const active = new Map<string, Drawn>();
    let began!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let calls = 0;
    let current = true;
    const reg = {
      getNotifications: async () => [...active.values()],
      showNotification: async (title: string, options: { data: unknown }) => {
        if (++calls === 1) {
          began();
          await new Promise<void>(resolve => { finish = resolve; });
        }
        const drawn = { tag, title, data: options.data, close() { if (active.get(tag) === drawn) active.delete(tag); } };
        active.set(tag, drawn);
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    let previous = true;
    const old = browserNoticePage.show("Previous reminder", "Earlier", tag, () => previous);
    await started;
    if (withdraw) await browserNoticePage.closeAll();
    expect(await browserNoticePage.show("Current reminder", "Now", tag, () => current)).toBe(true);
    current = eligible;
    previous = oldEligible;
    finish();
    expect(await old).toBe(false);
    expect(active.get(tag)?.title).toBe(eligible ? "Current reminder" : undefined);
    expect(calls).toBe(eligible ? 3 : 2);
  });

  it.each([true, false])("rechecks a visible later submission when its acknowledgement follows displacement (eligible %s)", async eligible => {
    const tag = "ohmail-cal-alert";
    type Display = { tag: string; title: string; data: unknown; close(): void };
    let active: Display | null = null;
    let oldStarted!: () => void;
    let newStarted!: () => void;
    let finishOld!: () => void;
    let confirmNew!: () => void;
    const first = new Promise<void>(resolve => { oldStarted = resolve; });
    const second = new Promise<void>(resolve => { newStarted = resolve; });
    let count = 0;
    let current = true;
    const reg = {
      getNotifications: async () => active === null ? [] : [active],
      showNotification: async (title: string, options: { data: unknown }) => {
        const order = ++count;
        if (order === 1) { oldStarted(); await new Promise<void>(resolve => { finishOld = resolve; }); }
        const item = { tag, title, data: options.data, close() { if (active === item) active = null; } };
        active = item;
        if (order === 2) { newStarted(); await new Promise<void>(resolve => { confirmNew = resolve; }); }
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const old = browserNoticePage.show("Previous event", "Earlier", tag);
    await first;
    await browserNoticePage.closeAll();
    const fresh = browserNoticePage.show("Current event", "Now", tag, () => current);
    await second;
    finishOld();
    await old;
    expect(count).toBe(2);
    current = eligible;
    confirmNew();
    expect(await fresh).toBe(eligible);
    expect((await reg.getNotifications()).map(item => item.title)).toEqual(eligible ? ["Current event"] : []);
  });

  it.each([{ replace: true, withdraw: true }, { replace: false, withdraw: true }, { replace: true, withdraw: false }, { replace: false, withdraw: false }])("keeps only the later ordinary notice with identical words ($replace, $withdraw)", async ({ replace, withdraw }) => {
    const tag = "ohmail-pairing";
    type Display = { tag: string; title: string; body: string; data?: number; close(): void };
    const shown = new Set<Display>();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const reg = {
      getNotifications: async () => [...shown],
      showNotification: async (title: string, options: { body: string; data?: number }) => {
        if (++calls === 1) {
          entered();
          await new Promise<void>(resolve => { finish = resolve; });
        }
        if (replace) shown.clear();
        const draw = { tag, title, body: options.body, data: options.data, close() { shown.delete(draw); } };
        shown.add(draw);
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const older = browserNoticePage.show("Device paired", "One new device", tag);
    await started;
    if (withdraw) await browserNoticePage.closeAll();
    expect(await browserNoticePage.show("Device paired", "One new device", tag)).toBe(true);
    finish();
    expect(await older).toBe(false);
    expect([...shown].map(draw => typeof draw.data)).toEqual(["number"]);
    expect(calls).toBe(replace ? 3 : 2);
  });

  it("keeps an eligible earlier reminder when the browser refuses its successor", async () => {
    const tag = "ohmail-cal-alert";
    let active: string | null = null;
    let arrived!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const reg = {
      showNotification: async (title: string) => {
        if (title === "Later") throw new Error("refused");
        arrived();
        await new Promise<void>(resolve => { finish = resolve; });
        active = title;
      },
      getNotifications: async () => active === null ? [] : [{ tag, title: active, body: "Reminder", close: () => { active = null; } }],
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const earlier = browserNoticePage.show("Earlier", "Reminder", tag);
    await started;
    expect(await browserNoticePage.show("Later", "Reminder", tag)).toBe(false);
    finish();
    expect(await earlier).toBe(true);
    expect(active).toBe("Earlier");
  });

  it.each([true, false])("keeps an earlier reminder until its later replacement is accepted (accept %s)", async accept => {
    const tag = "ohmail-cal-alert";
    type Shown = { tag: string; title: string; data: number; close(): void };
    const visible = new Set<Shown>();
    const waiting: { accept(): void; refuse(): void }[] = [];
    const reg = {
      getNotifications: async () => [...visible],
      showNotification: (title: string, options: { data: number }) => new Promise<void>((resolve, reject) => {
        const item = { tag, title, data: options.data, close() { visible.delete(item); } };
        waiting.push({ accept() { visible.add(item); resolve(); }, refuse() { reject(new Error("refused")); } });
      }),
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const old = browserNoticePage.show("Previous", "Reminder", tag);
    const later = browserNoticePage.show("Current", "Reminder", tag);
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[0]!.accept();
    expect(await old).toBe(true);
    expect([...visible].map(item => item.title)).toEqual(["Previous"]);
    if (accept) waiting[1]!.accept();
    else waiting[1]!.refuse();
    expect(await later).toBe(accept);
    expect([...visible].map(item => item.title)).toEqual(accept ? ["Current"] : ["Previous"]);
  });

  it("does not retire the worker's current same-tag notice when it closes an earlier plain page submission", async () => {
    const tag = "ohmail-new-mail";
    const title = "New mail";
    const body = "One new message";
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const shown: { title: string; body: string; tag: string; data: unknown; close: ReturnType<typeof vi.fn> }[] = [];
    const add = (data: unknown) => ({ title, body, tag, data, close: vi.fn() });
    const reg = {
      getNotifications: async () => shown,
      showNotification: async (_title: string, options: { data?: number }) => {
        if (options.data === undefined) { started(); await new Promise<void>(resolve => { release = resolve; }); }
        shown.push(add(options.data));
      },
    };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    const old = browserNoticePage.show(title, body, tag);
    await entered;
    await browserNoticePage.closeAll();
    expect(await browserNoticePage.show(title, body, tag)).toBe(true);
    const worker = add({ scope: "/" });
    shown.push(worker);
    release();
    await old;
    expect(shown.map(notice => notice.close.mock.calls.length)).toEqual([0, 0, 1]);
  });

  it("never identifies a structured worker notice by a browser timestamp equal to the earlier page draw", async () => {
    const clock = Date.UTC(2070, 0, 1);
    const now = vi.spyOn(Date, "now").mockReturnValue(clock);
    try {
      const tag = "ohmail-new-mail";
      const title = "New mail";
      const body = "One new message";
      const old = { tag, title, body, timestamp: clock, data: null, close: vi.fn() };
      const worker = { ...old, data: { scope: "/" }, close: vi.fn() };
      let begin!: () => void;
      let finish!: () => void;
      const started = new Promise<void>(resolve => { begin = resolve; });
      const listed: { tag: string; title: string; body: string; timestamp: number; data: unknown; close: () => void }[] = [];
      const reg = {
        getNotifications: async () => listed,
        showNotification: async (_title: string, options: { data?: number }) => {
          if (options.data === undefined) {
            begin();
            await new Promise<void>(resolve => { finish = resolve; });
            listed.push(old);
          } else listed.push({ ...old, data: options.data, close: vi.fn() });
        },
      };
      vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
      const before = browserNoticePage.show(title, body, tag);
      await started;
      expect(await browserNoticePage.show(title, body, tag)).toBe(true);
      listed.push(worker);
      finish();
      expect(await before).toBe(false);
      expect(old.close).toHaveBeenCalledOnce();
      expect(worker.close).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
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

  it("says whether the browser took a notice, so that a device's notice not drawn is told again", async () => {
    const paired: Notice = { kind: "pairing", change: "paired", device: null };
    const answering = (state: { focused?: boolean; visible?: boolean }, answer: () => boolean | Promise<boolean>) =>
      webNoticeEmitter({ ...page(state).p, show: answer }, () => wordingIn("en"));
    expect(await answering({}, () => true).post(paired)).toBe(true);
    expect(await answering({}, async () => true).post(paired)).toBe(true);
    expect(await answering({}, async () => false).post(paired), "the browser refused").toBe(false);
    expect(await answering({ focused: true }, () => true).post(paired), "this tab is the one looked at").toBe(false);
    expect(await answering({ visible: false }, () => true).post({ kind: "ohbox", count: 1 }), "the worker's own").toBe(false);
    expect(await answering({}, () => true).post({ kind: "scheduled", outcome: "sent", count: 1 }), "not carried").toBe(false);
    expect(await answering({}, () => { throw new Error("no"); }).post(paired), "a page that cannot draw").toBe(false);
    expect(await webNoticeEmitter(page().p, () => wordingIn("en")).post(paired), "a page that does not say").toBe(false);

    // The browser's own page: taken once the worker's registration has shown it, and only then.
    const registration = { getNotifications: async () => [], showNotification: vi.fn(async () => undefined) };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => registration } });
    expect(await browserNoticePage.show("Device paired", "A new device can now read your mail.", "ohmail-pairing")).toBe(true);
    registration.showNotification.mockRejectedValueOnce(new Error("not allowed"));
    expect(await browserNoticePage.show("Device paired", "A new device can now read your mail.", "ohmail-pairing")).toBe(false);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => undefined } });
    expect(await browserNoticePage.show("Device paired", "A new device can now read your mail.", "ohmail-pairing"), "no registration stands")
      .toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await browserNoticePage.show("Device paired", "A new device can now read your mail.", "ohmail-pairing"), "a browser without workers")
      .toBe(false);
  });

  it("the shell counts the Devices list as read only while its pane is shown in a window that is looked at", () => {
    /* What the shell hands the caller as `atDevices` advances the numbers this browser has told with no notice
       drawn. Anything wider (Settings alone, a tab behind another window) would count a device as told that
       nobody was told of. Read from the shell's text: no case mounts the whole shell for one line. */
    const ground = existsSync("packages/app/src") ? "packages/app/src" : "../../packages/app/src";
    const notices = readFileSync(resolve(ground, "mail/ground/MailSystemNotices.ts"), "utf8");
    expect(notices).toContain('const devicesShown = route.place === "settings" && route.sub === "devices" && route.stage === null;');
    expect(notices).toContain('atDevices: () => devicesShown && frame?.current?.ownerDocument.hasFocus() === true,');
    expect(notices.split("atDevices:").length - 1, "one place says it").toBe(1);
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

describe("the shell's notices, through the one caller", () => {
  const AT = "2026-11-17T09:00:00.000Z";
  let seq = 0;
  /** The account's settings record as the sync hands it: the three device numbers and nothing of any letter. */
  const settings = (made: number, revoked: number, live: number): SyncChange => ({
    type: "settings", op: "update", id: "acct", seq: ++seq, updatedAt: AT,
    entity: {
      accountId: "acct", dormancyDays: null, folderMailboxesOff: {}, locale: null, updatedAt: AT,
      devices: live, devicesMade: made, devicesRevoked: revoked,
    },
  }) as SyncChange;

  it("draws a device paired to the account, read from the engine's own copy, in the catalogue's words", async () => {
    // The engine's own copy holds the settings record; the copy the rail presents holds none.
    const own = new MemoryMirrorStore();
    await own.load();
    await own.applyChanges([settings(1, 0, 1)]);
    const presented = new MemoryMirrorStore();
    await presented.load();
    const jar = new Map<string, string>();
    const r = page({ focused: false });
    const caller = new NoticeCaller(
      webNoticeEmitter(r.p, () => wordingIn("en")),
      // As the shell builds them: its engine, its host's notifications part, its reader of the stored choices.
      noticeReadsOf({ read: () => own }, { permission: () => "granted" }, {
        choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
        atDevices: () => false,
        told: toldDevicesIn({
          get: (key) => jar.get(key) ?? null,
          set: (key, value) => { jar.set(key, value); return "stored"; },
          remove: (key) => { jar.delete(key); return "stored"; },
        }),
      }),
    );
    caller.settle("scope-a", presented);
    expect(r.shown, "the first settle on this browser tells nothing").toEqual([]);
    await own.applyChanges([settings(2, 0, 2)]);
    caller.settle("scope-a", presented);
    expect(r.tags).toEqual(["ohmail-pairing"]);
    expect(r.shown).toEqual([{ title: "Device paired", body: "A new device can now read your mail." }]);
  });
});

it("resolves a calendar tap once on its drawing page and rejects a foreign worker or retired display", async () => {
  await browserNoticePage.closeAll();
  const controller = {};
  const listening = vi.fn();
  const showNotification = vi.fn(async (_title, _options: NotificationOptions) => undefined);
  vi.stubGlobal("navigator", { serviceWorker: {
    controller,
    getRegistration: async () => ({ showNotification, getNotifications: async () => [] }),
    addEventListener: listening,
    removeEventListener: vi.fn(),
  } });
  const stop = subscribeBrowserNoticeOpening();
  try {
    let owns = true;
    const open = vi.fn(() => owns);
    const emitter = webNoticeEmitter(browserNoticePage, () => wordingIn("en"), () => open);
    const appointment = {
      kind: "cal_invitation", eventId: "appointment", label: { as: "event" },
      at: { hour: 9, minute: 0, day: "today" }, allDay: false,
    } as const;
    const send = (source: unknown) => {
      const posted = vi.fn();
      const handle = showNotification.mock.calls.at(-1)?.[1].data.open;
      listening.mock.calls[0]![1]({
        source, data: { type: "ohmail:notice-open", open: handle }, ports: [{ postMessage: posted }],
      });
      return posted;
    };

    expect(await emitter.post(appointment)).toBe(true);
    const payload = showNotification.mock.calls[0]![1].data;
    expect(Object.keys(payload).sort()).toEqual(["open", "stamp"]);
    expect(send({})).not.toHaveBeenCalled();
    expect(send(controller)).toHaveBeenCalledWith(true);
    expect(send(controller)).toHaveBeenCalledWith(false);
    expect(open).toHaveBeenCalledOnce();

    expect(await emitter.post(appointment)).toBe(true);
    owns = false;
    expect(send(controller)).toHaveBeenCalledWith(false);
    expect(await emitter.post(appointment)).toBe(true);
    await browserNoticePage.closeAll();
    expect(send(controller)).toHaveBeenCalledWith(false);
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
