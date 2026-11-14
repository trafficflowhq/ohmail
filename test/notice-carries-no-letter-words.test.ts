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
 */
interface Arm { readonly name: string; readonly carries: readonly NoticeKind[]; draw(notice: Notice): Drawn }

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
  const before = noticeSampleOf(store, 1);
  await store.applyChanges([
    change("message", "arrived", letter("arrived", "INBOX", { name: LETTER.senderName, address: LETTER.senderAddress })),
    change("message", "waits", letter("waits", "ohmail/Screener", { name: null, address: LETTER.stranger })),
    change("draft", "later", draft("later", "draft", LETTER.reason), "update"),
    change("draft", "kept", draft("kept", "sent", null), "update"),
    change("calendar_event", "shown", event("shown")),
    change("calendar_suggestion", "found", proposal("found")),
  ]);
  return { store, before, after: noticeSampleOf(store, 2) };
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
  const everywhere = (notices: readonly Notice[]): string[] =>
    [...stringsOf(notices), ...ARMS.flatMap((arm) => notices.flatMap((n) => { const d = arm.draw(n); return [d.title, ...d.rest]; })), ...logged];
  const holding = (strings: readonly string[], marker: string): string[] => strings.filter((s) => s.toLowerCase().includes(marker));
  /** Where `arm` drew `notices` wrongly, one line each: none holds the rule. */
  const faults = (arm: Arm, notices: readonly Notice[]): string[] => {
    const out: string[] = [];
    for (const notice of notices) {
      const drawn = arm.draw(notice);
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
    const all = everywhere(notices);
    for (const marker of [...NEVER, TITLE.toLowerCase()]) expect(holding(all, marker), marker).toEqual([]);
    expect(holding(stringsOf(before).concat(stringsOf(after)), "zq"), "the sample itself holds a letter's words").toEqual([]);
  });

  it("calendar: an event's title stands in the title field of the kinds that name an event, and nowhere else", async () => {
    const { store } = await mailWorld();
    const notices = calendarNotices(store, choicesWith(true));
    expect(notices.map((n) => n.kind)).toEqual(["cal_alert", "cal_invitation", "cal_change", "cal_change", "cal_answer", "cal_found", "cal_summary"]);

    for (const marker of NEVER) expect(holding(everywhere(notices), marker), marker).toEqual([]);
    for (const arm of ARMS) expect(faults(arm, notices)).toEqual([]);
    // The rule bites: a surface that draws the title into its body, and one that draws what it does not carry.
    const real = ARMS[0]!;
    const intoTheBody: Arm = { ...real, draw: (n) => { const d = real.draw(n); return { title: "", rest: [...d.rest, d.title] }; } };
    expect(faults(intoTheBody, notices).length).toBeGreaterThan(0);
    expect(faults({ ...real, carries: [] }, notices)).toHaveLength(notices.length);
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
      for (const marker of [...NEVER, TITLE.toLowerCase()]) expect(holding(everywhere(notices), marker), marker).toEqual([]);
    }
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
