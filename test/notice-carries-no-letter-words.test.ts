/**
 * A NOTICE NEVER SHOWS A LETTER'S SENDER, SUBJECT OR WORDS. A notice is read on a locked screen by
 * whoever stands there, and it stays listed until somebody dismisses it.
 *
 * A letter and an event are planted with a marker of their own in every field. Every switch is on,
 * a device's old stored choice to show sender and subject among them. The planted world goes
 * through the copy's own sample, the gate and the makers, and then through each surface's way of
 * drawing: every string of every notice, of every call and of every log line is walked. A letter's
 * markers stand nowhere. An event's title stands in the title field of the kinds that name an event
 * and nowhere else, and not at all while titles are hidden, the event is private or its invitation
 * is held back. What a letter only seems to propose is never titled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, NOTICE_KINDS, alertNotice, answeredNotice, cancelledNotice, decideNotices, foundNotice,
  invitationNotice, mayPost, movedNotice, noticeChoicesOf, noticeFields, noticeSampleOf, summaryNotice,
  type Clock, type Notice, type NoticeChoices, type NoticeKind, type NoticeSample, type SyncChange,
} from "@ohmail/client-engine";
import type { CalendarEventRecord, CalendarSuggestionRecord } from "@ohmail/wire";
import EN from "../apps/webapp/messages/en.json" with { type: "json" };
import { noticeWordingOf, webNoticeEmitter } from "../apps/webapp/app/shell/notice-emitter.js";
import { desktopNoticeEmitter } from "../apps/desktop/src/notice-emitter.js";
import { phoneNoticeEmitter } from "../apps/mobile/web/src/notice-emitter.js";
import { noticeKindsHere } from "../apps/mobile/src/notices/notice-door.js";
import { pageOver, phone } from "../apps/mobile/test/helpers/notice-phone.js";

/**
 * The page's words: each sentence of the catalogue as it ships, unformatted, with every value it was
 * handed written beside it, so whatever reached a sentence is in the strings the arm walks.
 */
const SYSTEM_NOTICE: Record<string, string> = EN.frame.systemNotice;
const WEB_WORDS = noticeWordingOf((key, values) => `${SYSTEM_NOTICE[key] ?? key} ${JSON.stringify(values ?? {})}`);

/** The letter's own markers, one for each field a notice could have copied. */
const LETTER = {
  senderName: "Zqsendername Muhr", senderAddress: "zqsenderaddress@example.org", subject: "Zqsubject Thursday",
  body: "Zqbody see you then", file: "zqfile-invoice.pdf", reason: "Zqreason no connection",
  device: "Zqdevice the hall's phone", stranger: "zqstranger@example.org",
  proposal: "Zqproposal Winternacht", proposalWords: "Zqwords doors at seven",
};
/** The event's markers. Only the title's may ever be seen, and only where an event is named. */
const TITLE = "Zqtitle";
const EVENT = {
  title: `${TITLE} Catalogue weekly`, notes: "Zqnotes bring the proofs", place: "Zqplace main hall",
  organizer: "Zqorganizer Wyss", organizerAddress: "zqorganizer@example.org", invitee: "Zqinvitee Frei",
  inviteeAddress: "zqinvitee@example.org", link: "https://calls.example/zqlink",
};
const NEVER = [...Object.values(LETTER), ...Object.values(EVENT).filter((word) => !word.startsWith(TITLE))]
  .map((word) => word.split(" ")[0]!.toLowerCase());

/** What one surface's platform was handed for a notice: the title field, and every other string of every call. */
interface Drawn { readonly title: string; readonly rest: readonly string[] }
/**
 * One surface's way from a notice to its platform, over a platform that records. `carries` is its
 * emitter's own list: a kind outside it must draw nothing at all (an empty title and no other string).
 * A way that crosses to another side (the phone's bridge) answers once what crossed has been drawn.
 */
interface Arm { readonly name: string; readonly carries: readonly NoticeKind[]; draw(notice: Notice): Drawn | Promise<Drawn> }

/** The kinds a phone that draws says it draws: Android's mail app with its poster. */
const PHONE_DRAWS = noticeKindsHere(phone().deps);

/** Every string in `value`, its keys among them. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value instanceof Map) for (const [k, v] of value) { stringsOf(k, out); stringsOf(v, out); }
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) { out.push(k); stringsOf(v, out); }
  return out;
}

/**
 * THE SURFACES. Each row draws a notice the way its emitter does, on a platform that records what
 * it was handed. A surface's emitter adds its row here, and the cases below hold it like the rest.
 */
const ARMS: readonly Arm[] = [
  {
    name: "the fields, under words that record what they were handed",
    carries: NOTICE_KINDS,
    draw(notice) {
      const handed: string[] = [];
      const fields = noticeFields(notice, {
        title: (facts) => { stringsOf(facts, handed); return `title of ${facts.kind}`; },
        body: (facts) => { stringsOf(facts, handed); return `body of ${facts.kind}`; },
        label: (as) => `the word for ${as}`,
      });
      return { title: fields.title, rest: [fields.body, ...handed] };
    },
  },
  {
    // The page: its real emitter, over a page that records every notice it is asked to draw.
    name: "web",
    carries: webNoticeEmitter({ focused: () => false, visible: () => true, show: () => {}, closeAll: async () => {} }, () => WEB_WORDS).carries,
    draw(notice) {
      const shown: string[][] = [];
      webNoticeEmitter(
        { focused: () => false, visible: () => true, show: (title, body, tag) => { shown.push([title, body, tag]); }, closeAll: async () => {} },
        () => WEB_WORDS,
      ).post(notice);
      if (shown.length === 0) return { title: "", rest: [] };
      return { title: shown[0]![0]!, rest: [...shown[0]!.slice(1), ...shown.slice(1).flat()] };
    },
  },
  {
    // The desktop's window: its real emitter, over a shell that records what crosses to it. The
    // shell writes the words (`notice.rs`): an event's label, where one crosses, is its title field.
    name: "desktop",
    carries: desktopNoticeEmitter({ focused: () => false, post: async () => {} }).carries,
    draw(notice) {
      const crossed: unknown[] = [];
      desktopNoticeEmitter({ focused: () => false, post: async (n) => { crossed.push(n); } }).post(notice);
      if (crossed.length === 0) return { title: "", rest: [] };
      const { label, ...rest } = crossed[0] as { label?: { as: string; text?: string } };
      const title = label?.as === "title" ? label.text ?? "" : "";
      return { title, rest: [...stringsOf(rest), ...(label ? stringsOf({ as: label.as }) : []), ...stringsOf(crossed.slice(1))] };
    },
  },
  {
    // The phone: the page's real emitter over the real bridge, the guard and the act's native end, with a
    // poster that records what it is handed. Native writes every word a phone's notice shows, so it has no
    // title field a letter's words could enter: every argument of every post it was handed is walked.
    name: "android",
    carries: (() => {
      const emitter = phoneNoticeEmitter(pageOver(phone().deps), PHONE_DRAWS);
      return emitter === "none" ? [] : emitter.carries;
    })(),
    async draw(notice) {
      const made = phone();
      const emitter = phoneNoticeEmitter(pageOver(made.deps), PHONE_DRAWS);
      if (emitter === "none") return { title: "", rest: [] };
      emitter.post(notice);
      await new Promise((done) => setTimeout(done, 0));
      return { title: "", rest: made.posts.flatMap((args) => args.map((arg) => String(arg))) };
    },
  },
];

const AT = "2026-11-10T09:24:00.000Z";
let seq = 0;
const change = (type: string, id: string, entity: unknown, op: "create" | "update" = "create"): SyncChange =>
  ({ type, op, id, seq: ++seq, updatedAt: AT, entity }) as SyncChange;

const letter = (id: string, folder: string, from: { name: string | null; address: string }) => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: LETTER.subject, from, to: [], cc: [],
  date: AT, folder, snippet: LETTER.body, unread: true, hasAttachments: true, attachmentCount: 1,
  attachments: [{ id: "att", filename: LETTER.file }],
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: AT,
});

const draft = (id: string, status: string, sendError: string | null) => ({
  id, mailboxId: "mb", threadId: null, inReplyToMessageId: null, forwardOfMessageId: null, forwardParts: null,
  subject: LETTER.subject, body: LETTER.body, html: null, to: [{ name: LETTER.senderName, address: LETTER.senderAddress }],
  cc: [], bcc: [], rationale: null, status, sendAt: status === "scheduled" ? AT : null, sendError, createdAt: AT, updatedAt: AT,
});

const event = (id: string, over: Partial<CalendarEventRecord> = {}): CalendarEventRecord => ({
  id, calendarId: "cal-1", uid: `${id}@example.test`, recurrenceId: "", thisAndFuture: false, sequence: 0, status: "confirmed",
  title: EVENT.title, notes: EVENT.notes, place: EVENT.place, callLink: EVENT.link,
  start: { kind: "instant", value: "20261110T140000Z" }, end: { kind: "instant", value: "20261110T150000Z" }, duration: null,
  startsAt: "2026-11-10T14:00:00.000Z", endsAt: "2026-11-10T15:00:00.000Z", occurrenceAt: null, repeat: null, busy: true, private: false,
  organizer: { address: EVENT.organizerAddress, name: EVENT.organizer }, myAnswer: "none", heldBack: false,
  invitees: [{ address: EVENT.inviteeAddress, name: EVENT.invitee, role: "required", answer: "accepted" }],
  alarms: [], cut: false, writes: [], updatedAt: AT, ...over,
});

const proposal = (id: string): CalendarSuggestionRecord => ({
  id, messageId: "arrived", mailboxId: "mb", evidence: "ticket",
  proposed: { title: LETTER.proposal, start: { kind: "instant", value: "20261121T193000Z" }, end: null, place: EVENT.place },
  sourceWords: LETTER.proposalWords, createdAt: AT, updatedAt: AT,
});

/** A device's stored records with every switch on, the old one that showed sender and subject among them. */
const STORED_MAIL = { master: true, ohbox: true, screener: true, scheduled: true, pairing: true, showSenderAndSubject: true };
const storedCalendar = (showTitles: boolean) => ({
  cal_alert: true, cal_invitation: true, cal_change: true, cal_answer: true, cal_found: true, cal_summary: true, showTitles, widgetTitles: true,
});
const choicesWith = (showTitles: boolean): NoticeChoices => noticeChoicesOf(STORED_MAIL, storedCalendar(showTitles), { ohcalPhone: true });

const TWO: Clock = { hour: 14, minute: 0, day: "today" };
const ELEVEN: Clock = { hour: 11, minute: 0, day: { month: 11, dom: 20, dow: 5 } };

/** The planted world before and after the letters arrive, as the copy's own sample reads it. */
async function mailWorld(): Promise<{ store: MemoryMirrorStore; before: NoticeSample; after: NoticeSample }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([change("draft", "later", draft("later", "scheduled", null)), change("draft", "kept", draft("kept", "scheduled", null))]);
  const before = noticeSampleOf(store, { made: 1, revoked: 0, live: 1 });
  await store.applyChanges([
    change("message", "arrived", letter("arrived", "INBOX", { name: LETTER.senderName, address: LETTER.senderAddress })),
    change("message", "waits", letter("waits", "ohmail/Screener", { name: null, address: LETTER.stranger })),
    change("draft", "later", draft("later", "draft", LETTER.reason), "update"),
    change("draft", "kept", draft("kept", "sent", null), "update"),
    change("calendar_event", "shown", event("shown")),
    change("calendar_suggestion", "found", proposal("found")),
  ]);
  return { store, before, after: noticeSampleOf(store, { made: 2, revoked: 0, live: 2 }) };
}

/**
 * The letter's words under every name a sample has ever carried them by, as a producer that read
 * the letters would hand them over, and the old choice beside the new ones.
 */
const carried = {
  latestSender: LETTER.senderName, latestSubject: LETTER.subject, sender: LETTER.senderAddress, subject: LETTER.subject,
  snippet: LETTER.body, scheduledOutcomes: [{ id: "later", outcome: "failed", reason: LETTER.reason, subject: LETTER.subject }],
  pairingEvents: [{ id: "p1", kind: "paired", device: LETTER.device }],
};

/** Every calendar notice the planted records make, under `choices`. A maker's `null` is no notice. */
function calendarNotices(store: MemoryMirrorStore, choices: NoticeChoices, over: Partial<CalendarEventRecord> = {}): Notice[] {
  const show = choices.showTitles;
  const e = { ...store.get<CalendarEventRecord>("calendar_event", "shown")!, ...over };
  const made = [
    alertNotice(e, show, { at: TWO, allDay: false, leadMin: 10, acts: ["join", "again"] }),
    invitationNotice(e, show, { at: ELEVEN, allDay: false }),
    movedNotice(e, show, { at: ELEVEN, was: TWO, allDay: false }),
    cancelledNotice(e, show, { at: TWO, allDay: false }),
    answeredNotice(e, show, "yes", 2),
    foundNotice(store.list<CalendarSuggestionRecord>("calendar_suggestion"), ELEVEN),
    summaryNotice({ events: 4, first: TWO, toAnswer: 3 }),
  ];
  return made.filter((n): n is Notice => n !== null && mayPost(n, choices, "granted", NOTICE_KINDS));
}

/** The kinds that name an event: only their title field may hold its title. */
const NAMES_AN_EVENT: readonly string[] = ["cal_alert", "cal_invitation", "cal_change", "cal_answer"];

describe("a notice carries no letter's words", () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...said: unknown[]) => { stringsOf(said, logged); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Every string a notice put anywhere: itself, what each surface drew, and what was logged. */
  const everywhere = async (notices: readonly Notice[]): Promise<string[]> => {
    const drawn: string[] = [];
    for (const arm of ARMS) for (const n of notices) { const d = await arm.draw(n); drawn.push(d.title, ...d.rest); }
    return [...stringsOf(notices), ...drawn, ...logged];
  };
  const holding = (strings: readonly string[], marker: string): string[] => strings.filter((s) => s.toLowerCase().includes(marker));
  /** Where `arm` drew `notices` wrongly, one line each: none holds the rule. */
  const faults = async (arm: Arm, notices: readonly Notice[]): Promise<string[]> => {
    const out: string[] = [];
    for (const notice of notices) {
      const drawn = await arm.draw(notice);
      if (!arm.carries.includes(notice.kind)) {
        if (drawn.title !== "" || drawn.rest.length > 0) out.push(`${arm.name} drew ${notice.kind}, which it does not carry`);
        continue;
      }
      if (holding(drawn.rest, TITLE.toLowerCase()).length > 0) out.push(`${arm.name}: ${notice.kind} holds the title outside its title field`);
      if (drawn.title.includes(TITLE) !== NAMES_AN_EVENT.includes(notice.kind)) out.push(`${arm.name}: the title field of ${notice.kind}`);
    }
    return out;
  };

  it("mail: the sample and the gate hand on counts and closed words, whatever the letters and the stored choices hold", async () => {
    const { before, after } = await mailWorld();
    const choices = { ...choicesWith(true), showSenderAndSubject: true } as NoticeChoices;
    const notices = decideNotices(before, { ...after, ...carried } as NoticeSample, choices, "granted", NOTICE_KINDS);

    // The planted world rang: a green case here is not a silent one.
    expect(notices).toEqual([
      { kind: "ohbox", count: 1 },
      { kind: "screener", count: 1 },
      { kind: "scheduled", outcome: "sent", count: 1 },
      { kind: "scheduled", outcome: "failed", count: 1 },
      { kind: "pairing", change: "paired", device: null },
    ]);
    const all = await everywhere(notices);
    for (const marker of [...NEVER, TITLE.toLowerCase()]) expect(holding(all, marker), marker).toEqual([]);
    expect(holding(stringsOf(before).concat(stringsOf(after)), "zq"), "the sample itself holds a letter's words").toEqual([]);
  });

  it("calendar: an event's title stands in the title field of the kinds that name an event, and nowhere else", async () => {
    const { store } = await mailWorld();
    const notices = calendarNotices(store, choicesWith(true));
    expect(notices.map((n) => n.kind)).toEqual(["cal_alert", "cal_invitation", "cal_change", "cal_change", "cal_answer", "cal_found", "cal_summary"]);

    const all = await everywhere(notices);
    for (const marker of NEVER) expect(holding(all, marker), marker).toEqual([]);
    for (const arm of ARMS) expect(await faults(arm, notices), arm.name).toEqual([]);
    // The rule bites: a surface that draws the title into its body, and one that draws what it does not carry.
    const real = ARMS[0]!;
    const intoTheBody: Arm = { ...real, draw: async (n) => { const d = await real.draw(n); return { title: "", rest: [...d.rest, d.title] }; } };
    expect((await faults(intoTheBody, notices)).length).toBeGreaterThan(0);
    expect(await faults({ ...real, carries: [] }, notices)).toHaveLength(notices.length);
    // In the notice itself the title stands in its label and nowhere else.
    for (const notice of notices) {
      const { label, ...rest } = notice as Notice & { label?: unknown };
      expect(holding(stringsOf(rest), TITLE.toLowerCase()), notice.kind).toEqual([]);
      expect(holding(stringsOf(label), TITLE.toLowerCase()).length, notice.kind).toBe(NAMES_AN_EVENT.includes(notice.kind) ? 1 : 0);
    }
  });

  it("calendar: no title at all while titles are hidden, the event is private, or its invitation is held back", async () => {
    const { store } = await mailWorld();
    const hidden = calendarNotices(store, choicesWith(false));
    const isPrivate = calendarNotices(store, choicesWith(true), { private: true });
    const heldBack = calendarNotices(store, choicesWith(true), { heldBack: true });

    expect(hidden).toHaveLength(7);
    expect(isPrivate).toHaveLength(7);
    // A held-back invitation makes no notice of its own; what names no event still rings.
    expect(heldBack.map((n) => n.kind)).toEqual(["cal_found", "cal_summary"]);
    for (const notices of [hidden, isPrivate, heldBack]) {
      const all = await everywhere(notices);
      for (const marker of [...NEVER, TITLE.toLowerCase()]) expect(holding(all, marker), marker).toEqual([]);
    }
  });

  it("the phone: a letter's word where a closed word belongs reaches no poster, and a well-formed notice still does", async () => {
    // The page's emitter copies a notice's own members by name, so a word put in one of them
    // crosses the bridge. Native's guard is the last reader before the poster, and the only thing
    // between a member's value and what a locked screen shows: it refuses the act whole.
    const made = phone();
    const emitter = phoneNoticeEmitter(pageOver(made.deps), PHONE_DRAWS);
    if (emitter === "none") throw new Error("the phone draws no kind here: the case would measure nothing");
    const crossed = async (): Promise<void> => { await new Promise((done) => setTimeout(done, 0)); };
    const wordy = [
      { kind: "pairing", change: "paired", device: LETTER.device },
      { kind: "pairing", change: LETTER.subject, device: null },
      { kind: "ohbox", count: LETTER.subject },
      { kind: "screener", count: LETTER.senderAddress },
    ];
    for (const notice of wordy) emitter.post(notice as unknown as Notice);
    await crossed();
    expect(made.posts, "a notice that is no closed record reached the poster").toEqual([]);

    // The same page, bridge and guard hand a well-formed notice on: a way that draws nothing is not what passed.
    emitter.post({ kind: "pairing", change: "paired", device: "phone" });
    await crossed();
    expect(made.posts).toHaveLength(1);
    const handed = stringsOf(made.posts);
    expect(handed).toContain("paired");
    for (const marker of NEVER) expect(holding(handed, marker), marker).toEqual([]);
  });

  it("a switch that is off, a master that is off and a surface that does not carry a kind draw nothing", async () => {
    const { store, before, after } = await mailWorld();
    const on = choicesWith(true);
    expect(decideNotices(before, after, { ...on, master: false }, "granted", NOTICE_KINDS)).toEqual([]);
    expect(decideNotices(before, after, on, "denied", NOTICE_KINDS)).toEqual([]);
    expect(decideNotices(before, after, on, "granted", [])).toEqual([]);
    expect(decideNotices(before, after, { ...on, ohbox: false, pairing: false }, "granted", NOTICE_KINDS).map((n) => n.kind))
      .toEqual(["screener", "scheduled", "scheduled"]);
    expect(calendarNotices(store, { ...on, master: false })).toEqual([]);
    expect(calendarNotices(store, { ...on, cal_found: false, cal_alert: false }).map((n) => n.kind))
      .toEqual(["cal_invitation", "cal_change", "cal_change", "cal_answer", "cal_summary"]);
  });
});
