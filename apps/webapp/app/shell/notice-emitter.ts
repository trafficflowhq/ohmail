/**
 * THE BROWSER'S NOTICES, DRAWN BY THE PAGE. The one caller (`use-notices`) hands this emitter what
 * the gate answered; it draws it through the service worker's registration, in the app's own words
 * from the catalogue, and decides nothing about whether a kind is wanted.
 *
 * Every kind it carries is drawn while this tab lives and is not the one being looked at. New mail
 * is drawn only while the tab is visible as well: with no window visible the service worker draws
 * its own fixed "New mail" on the wake, so the page stays quiet then and one arrival is never drawn
 * twice (`public/sw.js`, unchanged).
 *
 * A notice is closed words and numbers: the title and the body are the catalogue's sentences over
 * a count or a closed word, composed by `noticeFields`, and a tag that is its kind's own closed word.
 * A numeric display stamp lets the page withdraw a previous submission even in browsers that hide
 * its timestamp. A calendar notice can carry an opaque handle for the opening act in this page.
 */
import {
  cleanNoticeText, leadWords, noticeFields,
  type CalendarSummaryDetails, type Clock, type MailNoticeDetails, type Notice, type NoticeFacts, type NoticeKind, type NoticeTaken, type NoticeWording,
} from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";

/** What the emitter asks of the page and its browser. */
export interface NoticePage {
  /** This tab is the one being looked at. */
  focused(): boolean;
  /** This tab is on screen, though perhaps not in front. */
  visible(): boolean;
  /**
   * Draw one notice through the worker's registration, over any listed with the same tag, and say
   * whether the browser took it: no registration, or a browser that refused, is `false`. Never throws.
   */
  show(
    title: string, body: string, tag: string, current?: () => boolean, open?: () => boolean,
  ): NoticeTaken | void;
  /** Close every notice of this origin still listed; settles once they are closed. Never rejects. */
  closeAll(strict?: boolean): Promise<void>;
}

/** A sentence of the catalogue's `frame.systemNotice` group, with its values. */
export type NoticeSay = (key: string, values?: Record<string, string | number>) => string;

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * A start as a notice says it, in the catalogue's words: today, tomorrow or a date with its weekday, and the clock's
 * hour and minute unless the event lasts whole days. Written from the clock's numbers alone.
 */
function whenOf(say: NoticeSay, at: Clock, allDay: boolean): string {
  const time = `${two(at.hour)}:${two(at.minute)}`;
  if (at.day === "today") return allDay ? say("dayToday") : say("whenToday", { time });
  if (at.day === "tomorrow") return allDay ? say("dayTomorrow") : say("whenTomorrow", { time });
  const { dow, dom, month } = at.day;
  return allDay ? say("dayDate", { dow, dom, month }) : say("whenDate", { dow, dom, month, time });
}

/** How long until an alert's start, in the catalogue's words (`leadWords`); nothing for a lead that is none. */
function leadOf(say: NoticeSay, leadMin: number, allDay: boolean): string {
  const lead = leadWords(leadMin, allDay);
  if (lead === null) return "";
  switch (lead.as) {
    case "now":
      return say("alertNow");
    case "today":
      return say("alertToday");
    case "tomorrow":
      return say("alertTomorrow");
    case "minutes":
      return say("alertMinutes", { count: lead.count });
    case "hours":
      return say("alertHours", { count: lead.count });
    case "days":
      return say(allDay ? "alertAllDays" : "alertDays", { count: lead.count });
    case "weeks":
      return say(allDay ? "alertAllWeeks" : "alertWeeks", { count: lead.count });
  }
}

/**
 * The words of this surface: the catalogue's sentences over a notice's numbers and closed words. A calendar notice
 * that names an event has the event's label for its title (`noticeFields` puts it there); its body never holds it.
 */
export function noticeWordingOf(say: NoticeSay): NoticeWording {
  const words = (facts: NoticeFacts): { title: string; body: string } => {
    switch (facts.kind) {
      case "ohbox":
        return { title: say("ohboxTitle"), body: say("ohboxBody", { count: facts.count }) };
      case "screener":
        return { title: say("screenerTitle"), body: say("screenerBody", { count: facts.count }) };
      case "scheduled":
        return facts.outcome === "sent"
          ? { title: say("sentTitle"), body: say("sentBody", { count: facts.count }) }
          : { title: say("failedTitle"), body: say("failedBody", { count: facts.count }) };
      case "pairing": {
        const device = facts.device ?? "unknown";
        return facts.change === "paired"
          ? { title: say("pairedTitle"), body: say("pairedBody", { device }) }
          : { title: say("revokedTitle"), body: say("revokedBody", { device }) };
      }
      case "cal_alert":
        return { title: "", body: leadOf(say, facts.leadMin, facts.allDay) };
      case "cal_invitation":
        return { title: "", body: say("invitationBody", { when: whenOf(say, facts.at, facts.allDay) }) };
      case "cal_change": {
        const when = whenOf(say, facts.at, facts.allDay);
        if (facts.change === "cancelled") return { title: "", body: say("cancelledBody", { when }) };
        return facts.was === null
          ? { title: "", body: say("movedBodyNoWas", { when }) }
          : { title: "", body: say("movedBody", { when, was: whenOf(say, facts.was, facts.allDay) }) };
      }
      case "cal_answer":
        return { title: "", body: say("answeredBody", { answer: facts.answer, count: facts.count }) };
      case "cal_found":
        return { title: say("foundTitle"), body: say("foundBody", { count: facts.count }) };
      default:
        // The day's summary: this surface carries none, and draws nothing for it.
        return { title: "", body: "" };
    }
  };
  return {
    title: (facts) => words(facts).title,
    body: (facts) => words(facts).body,
    label: (as) => say(as === "busy" ? "alertBusy" : "alertEvent"),
    summary({ agenda, zone }, count) {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
      const lines = agenda.map(({ label, startMs, allDay }) => {
        const at = allDay ? say("summaryAllDay") : time.format(startMs);
        const name = label.as === "title" ? cleanNoticeText(label.text) : say(label.as === "busy" ? "alertBusy" : "alertEvent");
        return name ? say("summaryLine", { at, name }) : at;
      });
      if (count > lines.length) lines.push(say("summaryMore", { count: count - lines.length }));
      return { title: say("summaryTitle"), body: lines.join("\n") || say("summaryEmpty") };
    },
  };
}

/**
 * The kinds the page draws. Not `scheduled` yet: the copy cannot tell a scheduled message that went
 * out from one cancelled and discarded elsewhere, and "went out" must not be said of one that did
 * not. It joins once the copy keeps its own mark of a sent draft. The calendar's alerts are rung by
 * the one caller's own book while the page lives (this surface sets nothing ahead); its summary is
 * the phone's.
 */
const CARRIES: readonly NoticeKind[] = [
  "ohbox", "screener", "pairing", "cal_alert", "cal_invitation", "cal_change", "cal_answer", "cal_found",
];

/**
 * One tag per kind, so two tabs of one account draw one notice of a kind, the second over the
 * first. Closed words, never an id of a person, a letter or an event. New mail's is the worker's own.
 */
const TAGS: Partial<Readonly<Record<NoticeKind, string>>> = {
  ohbox: "ohmail-new-mail",
  screener: "ohmail-screener",
  scheduled: "ohmail-scheduled",
  pairing: "ohmail-pairing",
  cal_alert: "ohmail-cal-alert",
  cal_invitation: "ohmail-cal-invitation",
  cal_change: "ohmail-cal-change",
  cal_answer: "ohmail-cal-answer",
  cal_found: "ohmail-cal-found",
  cal_summary: "ohmail-cal-summary",
};

/**
 * The page's emitter over `page`, in the words `wording` gives at the moment a notice is drawn (the
 * person's language may change while the tab lives).
 */
export function webNoticeEmitter(
  page: NoticePage,
  wording: () => NoticeWording,
  opening?: (notice: Notice, letter?: string) => (() => boolean) | undefined,
  summaries = false,
): HostNoticeEmitter {
  const carries = summaries ? [...CARRIES, "cal_summary" as const] : CARRIES;
  return {
    carries,
    showsMailDetails: true,
    async lockSummary(key, run) {
      if (navigator.locks) await navigator.locks.request(key, run);
      else await run();
    },
    acts: [],
    ahead: "none",
    post(notice: Notice, current?: () => boolean, letter?: string, details?: MailNoticeDetails, summary?: CalendarSummaryDetails): NoticeTaken {
      try {
        if (!carries.includes(notice.kind)) return false;
        if (notice.kind === "cal_summary") {
          const lines = summary && wording().summary?.(summary, notice.events);
          return lines ? page.show(lines.title, lines.body, TAGS.cal_summary!, current) ?? false : false;
        }
        if (page.focused()) return false;
        if (notice.kind === "ohbox" && !page.visible()) return false;
        const tag = TAGS[notice.kind];
        if (tag === undefined) return false;
        const generic = noticeFields(notice, wording());
        const sender = notice.kind === "ohbox" && notice.count === 1 ? cleanNoticeText(details?.sender ?? "") : null;
        const subject = sender === null ? null : cleanNoticeText(details?.subject ?? "");
        const { title, body } = sender && subject ? { title: sender, body: subject } : generic;
        if (title === "") return false;
        return page.show(
          title, body, tag,
          () => !page.focused() && (notice.kind !== "ohbox" || page.visible()) && (current?.() ?? true),
          opening?.(notice, letter),
        ) ?? false;
      } catch {
        /* A notice that could not be drawn takes nothing down. */
        return false;
      }
    },
    takeBack(): void {
      try {
        void page.closeAll();
      } catch {
        /* Nothing to close, or a browser that will not say. */
      }
    },
  };
}

/** The page as this browser has it. Every call is guarded: a browser without workers or notices draws nothing. */
interface NoticeGeneration {
  cutoff: number;
  accepted: Set<string>;
  latest: Map<string, BrowserSubmission>;
  held: Map<string, HeldDisplays>;
}
interface HeldDisplays {
  stamps: Set<number>;
  plain?: { title: string; body: string };
}
interface BrowserSubmission {
  stamp: number;
  dated: boolean;
  accepted: boolean;
  displaced: boolean;
  restore?: () => Promise<boolean>;
  opening?: { handle: string; run: () => boolean };
}

function newGeneration(cutoff: number): NoticeGeneration {
  return { cutoff, accepted: new Set(), latest: new Map(), held: new Map() };
}

let generation = newGeneration(0);
let sweeping: NoticeGeneration | null = null;
let lastDisplayTime = 0;
const pending = new Map<string, number>();

function track(counts: Map<string, number>, tag: string, delta: number): void {
  const count = (counts.get(tag) ?? 0) + delta;
  if (count > 0) counts.set(tag, count);
  else counts.delete(tag);
}

function markerOf(notice: Notification): number | null {
  // WebKit and Firefox return the submitted data even where no display timestamp is readable.
  // Only our content-free numeric marker can identify one submission of a shared closed tag.
  const marker = typeof notice.data?.open === "string" ? notice.data.stamp : notice.data;
  return typeof marker === "number" && Number.isSafeInteger(marker) && marker > 0 ? marker : null;
}

function stampOf(notice: Notification): number | null {
  return markerOf(notice) ?? ("timestamp" in notice && typeof notice.timestamp === "number" ? notice.timestamp : null);
}

/** A worker can independently assign the very same timestamp to a structured notification. */
function pageStampOf(notice: Notification): number | null {
  return notice.data == null ? stampOf(notice) : markerOf(notice);
}

function closeEarlier(listed: readonly Notification[], seat: NoticeGeneration): void {
  for (const notice of listed) {
    const stamp = stampOf(notice);
    if (stamp !== null && stamp > seat.cutoff) continue;
    // Legacy origin notifications can lack the marker and share a rounded browser timestamp.
    if ((stamp === null || (markerOf(notice) === null && stamp === seat.cutoff)) && seat.accepted.has(notice.tag)) continue;
    notice.close();
  }
}

/** Retire only a positively identified earlier display that remained valid while this draw was unanswered. */
function retireHeld(seat: NoticeGeneration, tag: string, listed: readonly Notification[]): void {
  const held = seat.held.get(tag);
  if (!held) return;
  for (const notice of listed) {
    if (notice.tag !== tag) continue;
    const marked = markerOf(notice);
    if (marked !== null) {
      if (held.stamps.has(marked)) notice.close();
    } else if (notice.data == null && held.plain && notice.title === held.plain.title && notice.body === held.plain.body) {
      notice.close();
    }
  }
  seat.held.delete(tag);
}

/** Reconcile the actual list after a late submission. Some centers keep both reminders;
 * others physically replace the one already shown for this tag. */
async function withdrawLate(
  reg: ServiceWorkerRegistration, tag: string, old: BrowserSubmission, owner: NoticeGeneration,
  title: string, body: string, current?: () => boolean,
): Promise<boolean> {
  const listed = await reg.getNotifications({ tag });
  const seat = generation;
  const latest = seat.latest.get(tag);
  // An isolated ordinary mail notice predates the overlap and has the browser's plain options.
  // A later overlapping draw has a marker, even when its kind and all visible words are identical.
  const own = listed.filter(notice => (old.dated && pageStampOf(notice) === old.stamp) ||
    (notice.data == null && (!old.dated || stampOf(notice) === null) &&
     notice.tag === tag && notice.title === title && notice.body === body));
  const oldListed = own.length > 0;
  const latestListed = latest && listed.some(notice => pageStampOf(notice) === latest.stamp);
  const retain = owner === seat && latest !== undefined && latest !== old && !latest.accepted &&
    !latestListed && oldListed && (current?.() ?? true);
  if (retain) {
    const held: HeldDisplays = seat.held.get(tag) ?? { stamps: new Set() };
    if (old.dated) held.stamps.add(old.stamp);
    else held.plain = { title, body };
    seat.held.set(tag, held);
  } else {
    for (const notice of own) notice.close();
  }
  if (owner !== seat) {
    // The explicit take-back closed everything then present. A later page callback has
    // no ownership over a structured notification that the worker posted independently.
    const others = listed.filter(notice => !own.includes(notice) && (notice.data == null || markerOf(notice) !== null));
    closeEarlier(others, seat);
  }
  if (latest && latest.stamp > old.stamp && oldListed && !latestListed) {
    latest.displaced = true;
    // If the browser is still deciding on the new draw, its own successful receipt checks the list.
    if (latest.restore) await latest.restore();
  }
  return retain;
}

async function showBrowser(
  title: string, body: string, tag: string, current?: () => boolean, open?: () => boolean, replacing?: number,
): Promise<boolean> {
  const seat = generation;
  try {
    const reg = await registration();
    if (reg === undefined || seat !== generation || current?.() === false) return false;
    if (replacing !== undefined && seat.latest.get(tag)?.stamp !== replacing) return false;
    const dated = open !== undefined || tag.startsWith("ohmail-cal-") || sweeping !== null || pending.has(tag);
    const stamp = Math.max(Date.now(), lastDisplayTime + 1, seat.cutoff + 1);
    lastDisplayTime = stamp;
    const item: BrowserSubmission = { stamp, dated, accepted: false, displaced: false };
    if (open && typeof crypto.randomUUID === "function") item.opening = { handle: crypto.randomUUID(), run: open };
    seat.latest.set(tag, item);
    const data = item.opening ? { stamp, open: item.opening.handle } : stamp;
    const options = dated ? { body, tag, timestamp: stamp, data } : { body, tag };
    track(pending, tag, 1);
    try {
      await reg.showNotification(title, options);
      if (seat !== generation || seat.latest.get(tag) !== item || (dated && current?.() === false)) {
        return await withdrawLate(reg, tag, item, seat, title, body, current);
      }
      if (item.displaced || seat.held.has(tag)) {
        const listed = await reg.getNotifications({ tag });
        if (seat !== generation || seat.latest.get(tag) !== item || current?.() === false) {
          await withdrawLate(reg, tag, item, seat, title, body, current);
          return false;
        }
        const isListed = listed.some(notice => pageStampOf(notice) === stamp);
        if (item.displaced && !isListed) return await showBrowser(title, body, tag, current, open, stamp);
        if (isListed) retireHeld(seat, tag, listed);
      }
      item.accepted = true;
      seat.accepted.add(tag);
      if ((pending.get(tag) ?? 0) > 1) {
        // Only an overlapping earlier operation can require the accepted display again.
        item.restore = () => showBrowser(title, body, tag, current, open, stamp);
      }
      return true;
    } finally {
      track(pending, tag, -1);
      if (!pending.has(tag)) {
        const latest = generation.latest.get(tag);
        if (latest) delete latest.restore;
        generation.held.delete(tag);
      }
    }
  } catch { return false; }
}

/** Listen in the mounted product page. The host's opening act rechecks its session. */
export function subscribeBrowserNoticeOpening(
  openWake?: (owner: string, family: string) => boolean,
): () => void {
  const worker = navigator.serviceWorker;
  if (!worker?.addEventListener) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    if (!worker.controller || event.source !== worker.controller || event.data?.type !== "ohmail:notice-open") return;
    const port = event.ports[0];
    if (!port) return;
    const { wake } = event.data;
    if (wake !== undefined) {
      try {
        port.postMessage(typeof wake?.owner === "string" && typeof wake.family === "string" &&
          openWake?.(wake.owner, wake.family) === true);
      } catch { port.postMessage(false); }
      return;
    }
    const shown = [...generation.latest.values()].find(({ opening }) => opening && opening.handle === event.data.open);
    const opening = shown?.opening;
    if (shown && opening) delete shown.opening;
    try { port.postMessage(opening?.run() === true); }
    catch { port.postMessage(false); }
  };
  worker.addEventListener("message", onMessage);
  return () => worker.removeEventListener("message", onMessage);
}

export const browserNoticePage: NoticePage = {
  focused: () => typeof document !== "undefined" && document.hasFocus(),
  visible: () => typeof document !== "undefined" && document.visibilityState === "visible",
  show: showBrowser,
  async closeAll(strict = false) {
    const seat = newGeneration(Math.max(Date.now(), lastDisplayTime));
    generation.latest.clear();
    generation.held.clear();
    generation = seat;
    sweeping = seat;
    try {
      const listed = await (await registration())?.getNotifications();
      if (seat === generation) closeEarlier(listed ?? [], seat);
    } catch (err) {
      if (strict) throw err;
    } finally { if (sweeping === seat) sweeping = null; }
  },
};

/** The worker's registration for this page, if one stands. The page registers none here: the wake does. */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration();
}
