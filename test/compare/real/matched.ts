import { intlZones, resolveWall, wall } from "@ohmail/cal-core";
import type { Page } from "@playwright/test";
import type { CalendarConnectionRecord, CalendarEventRecord, CalendarRecord } from "@ohmail/wire";

interface FixtureLetter {
  id: string;
  mailbox: string;
  at: string;
  subject: string;
  preview: string;
  from: { name: string; address: string };
  to?: { name: string; address: string }[];
  body?: string;
  place: string;
  pile?: string | null;
  unread: boolean;
  gone?: boolean;
  tags?: string[];
}
interface FixtureMember {
  from: string;
  at?: string;
  me?: boolean;
  unread: boolean;
}
interface DayEvent {
  id: string;
  title: string;
  calendar: string;
}
interface DayCalendar {
  now(): { date: string; time: string };
  cal: { day(date: string): { allDay: DayEvent[]; timed: { kind: string; e?: DayEvent; s: number; t: number }[] } };
}
interface ReferenceWorld {
  D: {
    tags: { id: string; name: string; hue: string }[];
    account: { displayName: string; signIn: string };
    meta: { now: string; timezone: string };
    triage: { resurface: { items: { title: string; from: string; resurfaces: string }[] } };
  };
  M: { L: Record<string, FixtureLetter>; T: Record<string, FixtureMember[]>; order: string[]; waiting: string[]; backDone?: Record<number, boolean> };
  sender(id: string): { from: { name: string; address: string }; held: { subject: string }[] };
  addr(name: string): string;
  mailboxes(): { id: string; address: string; signature?: string }[];
  ohboxGroups(): Record<"new" | "earlier" | "resurfaced", FixtureLetter[]>;
  counts(): { ohbox: number };
}

/** Only the local reference's fictional inputs cross to the product. No measured DOM value does. */
export function readWorld(page: Page, includeCalendar = false) {
  return page.evaluate((withCalendar) => {
    const world = (window as unknown as { FS: ReferenceWorld }).FS;
    const mailboxes = world.mailboxes().map(({ id, address, signature }) => ({ id, address, signature }));
    const threads = Object.entries(world.ohboxGroups()).flatMap(([section, letters]) =>
      letters.map(({ id, mailbox, at, subject, preview, from }) => ({
        section, letter: { id, mailbox, at, subject, preview, pile: world.M.L[id]!.pile },
        members: world.M.T[id]!.map((m) => ({
          name: m.from, at: m.at, me: m.me, unread: m.unread,
          address: m.me ? world.D.account.signIn : world.addr(m.from) || from.address,
        })),
      })),
    );
    const live = world.M.order.map((id) => world.M.L[id]!).filter((letter) => !letter.gone);
    for (const letter of live) {
      if (letter.place !== "news" && letter.place !== "receipts") continue;
      const { id, mailbox, at, subject, preview, pile, from, unread } = letter;
      threads.push({
        section: letter.place, letter: { id, mailbox, at, subject, preview, pile },
        members: [{ name: from.name, address: from.address, at, me: false, unread }],
      });
    }
    const drafts = live.filter((letter) => letter.place === "drafts").map((letter) => ({
      id: letter.id, mailboxId: letter.mailbox, subject: letter.subject, to: letter.to ?? [],
      body: letter.body ?? letter.preview, at: letter.at,
    }));
    const upcoming = world.D.triage.resurface.items.flatMap((item, index) => {
      if (world.M.backDone?.[index]) return [];
      // The reference stores the reminder separately from mail. Its sender identifies the source mailbox.
      const mail = live.filter((letter) => letter.from.name === item.from);
      if (new Set(mail.map((letter) => letter.mailbox)).size !== 1) {
        throw new Error("The scheduled letter has no unique source mailbox");
      }
      const { from, mailbox } = mail[0]!;
      return [{ id: `upcoming-${index}`, title: item.title, from, mailbox, due: item.resurfaces }];
    });
    let calendar = null;
    if (withCalendar) {
      const source = (window as unknown as { FS: DayCalendar }).FS;
      const { date, time } = source.now();
      const day = source.cal.day(date);
      calendar = {
        now: date + "T" + time + ":00Z",
        events: [
          ...day.allDay.map(({ id, title, calendar }) => ({ id, title, calendar, start: 0, end: 1440, allDay: true })),
          ...day.timed.flatMap((part) => part.kind === "ev" && part.e
            ? [{ id: part.e.id, title: part.e.title, calendar: part.e.calendar, start: part.s, end: part.t, allDay: false }] : []),
        ],
      };
    }
    return {
      tagCatalog: world.D.tags.map(({ id, name, hue }) => ({ id, name, hue })),
      tagged: Object.fromEntries(live.filter((letter) => letter.tags?.length).map((letter) => [letter.id, letter.tags!])),
      calendar, upcoming, zone: world.D.meta.timezone, drafts,
      account: { displayName: world.D.account.displayName, signIn: world.D.account.signIn },
      now: world.D.meta.now,
      mailboxes,
      threads,
      unread: world.counts().ohbox,
      waiting: world.M.waiting.map((id) => {
        const { from, held } = world.sender(id);
        return { id, from, subject: held[0]?.subject ?? "" };
      }),
    };
  }, includeCalendar);
}
export type World = Awaited<ReturnType<typeof readWorld>>;

/** The scheduled fixture supplies a weekday, day, month and local time in its own zone. */
function reminderInstant(label: string, now: string, zone: string): string {
  const [day, clock] = label.split(", ");
  const local = new Date(`${day} ${now.slice(0, 4)} ${clock} GMT`);
  if (!Number.isFinite(local.valueOf())) throw new Error("The reference has an unreadable reminder date");
  const due = resolveWall(wall(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(),
    local.getUTCHours(), local.getUTCMinutes()), zone, intlZones());
  if (due === null) throw new Error("The reference has an unresolved reminder time zone");
  return new Date(due).toISOString();
}

/** Materialize the referenced conversations as ordinary API sync changes for the real client engine. */
export function mailChanges(world: World, accountId: string) {
  let seq = 0;
  const creates: object[] = [];
  const senders = new Set<string>();
  const streamFolders: Record<string, string> = { news: "ohmail/News", receipts: "ohmail/Receipts" };
  const filedStates: Record<string, string> = { answer_later: "reply_later", parked: "set_aside", scheduled: "bubbled_up" };
  const threads: Array<World["threads"][number] & { due?: string }> = [...world.threads];
  for (const item of world.upcoming) {
    threads.push({
      section: "scheduled",
      due: reminderInstant(item.due, world.now, world.zone),
      letter: { id: item.id, mailbox: item.mailbox, subject: item.title, preview: "", at: world.now, pile: "scheduled" },
      members: [{ name: item.from.name, address: item.from.address, at: world.now, me: false, unread: false }],
    });
  }
  for (const { section, letter, members, due } of threads) {
    const folder = streamFolders[section] ?? "INBOX";
    const state = filedStates[letter.pile ?? ""] ?? (section === "resurfaced" ? "resurfaced" : null);
    for (const [index, member] of members.entries()) {
      const id = `letter-${letter.id}-${index}`;
      const date = member.at ?? letter.at;
      const sender = member.address;
      if (folder === "INBOX" && !due) senders.add(sender);
      creates.push({
        type: "message", op: "create", id, seq: ++seq, updatedAt: date,
        entity: {
          id, accountId, mailboxId: letter.mailbox, threadId: letter.id, messageIdHeader: null,
          subject: letter.subject, from: { name: member.name, address: sender }, to: [], cc: [],
          date, arrivedAt: date, folder: member.me ? "Sent" : folder, snippet: letter.preview,
          unread: member.unread, hasAttachments: false, attachmentCount: 0, sensitivity: {},
          labels: index === members.length - 1 ? world.tagged[letter.id] ?? [] : [],
          triage: state && index === members.length - 1
            ? { messageId: id, state, bubbleUpAt: due ?? null, setAt: date, updatedAt: date }
            : null,
          remoteContent: "none", updatedAt: date,
        },
      });
    }
  }
  for (const { id, mailboxId, subject, to, body, at } of world.drafts) {
    creates.push({
      type: "draft", op: "create", id, seq: ++seq, updatedAt: at,
      entity: { id, mailboxId, threadId: null, inReplyToMessageId: null, forwardOfMessageId: null,
        subject, to, cc: [], bcc: [], body, rationale: null, status: "draft", createdAt: at, updatedAt: at },
    });
  }
  // The reference records creation order in its catalogue, without individual timestamps.
  for (const [index, tag] of world.tagCatalog.entries()) {
    const createdAt = new Date(Date.parse(world.now) - (world.tagCatalog.length - index) * 1000).toISOString();
    creates.push({ type: "tag", op: "create", id: tag.id, seq: ++seq, updatedAt: createdAt,
      entity: { ...tag, createdAt, updatedAt: createdAt } });
  }
  for (const address of senders) {
    const id = `route-${seq + 1}`;
    creates.push({ type: "rule", op: "create", id, seq: ++seq, updatedAt: world.now,
      entity: { id, kind: "sender", match: address, destination: "INBOX", enabled: true, createdAt: world.now } });
  }
  if (world.calendar) {
    const { now, events } = world.calendar;
    const midnight = Date.parse(now.slice(0, 10));
    creates.push({ type: "settings", op: "create", id: accountId, seq: ++seq, updatedAt: now,
      entity: { accountId, calendarEnabledAt: now, updatedAt: now } });
    const connection: CalendarConnectionRecord = { id: "local-calendar", label: "Calendar", provider: "caldav",
      status: "active", errorCode: null, grantMailboxId: null, serverHost: null, consentedAt: now,
      lastSyncedAt: now, createdAt: now, updatedAt: now };
    creates.push({ type: "calendar_connection", op: "create", id: connection.id, seq: ++seq, updatedAt: now, entity: connection });
    for (const id of new Set(events.map((event) => event.calendar))) {
      const entity: CalendarRecord = { id, connectionId: "local-calendar", name: id, color: null, access: "owner",
        shown: true, timeZone: "UTC", window: null, defaultAlarms: [], lastSyncedAt: now, errorCode: null, updatedAt: now };
      creates.push({ type: "calendar", op: "create", id, seq: ++seq, updatedAt: now, entity });
    }
    for (const event of events) {
      const stamp = (minute: number) => new Date(midnight + minute * 60_000).toISOString();
      const time = (minute: number) => ({
        kind: event.allDay ? "date" as const : "instant" as const,
        value: event.allDay ? stamp(minute).slice(0, 10).replaceAll("-", "") : stamp(minute).replace(/[-:]/g, "").replace(".000", ""),
      });
      const entity: CalendarEventRecord = { id: event.id, uid: event.id, calendarId: event.calendar, title: event.title,
        notes: null, place: null, callLink: null, start: time(event.start), end: time(event.end), duration: null,
        startsAt: stamp(event.start), endsAt: stamp(event.end), recurrenceId: "", thisAndFuture: false, sequence: 0,
        status: "confirmed", occurrenceAt: null, repeat: null, busy: true, private: false, organizer: null, myAnswer: null,
        heldBack: false, invitees: [], alarms: [], cut: false, writes: [], updatedAt: now };
      creates.push({ type: "calendar_event", op: "create", id: event.id, seq: ++seq, updatedAt: now, entity });
    }
  }
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: String(seq), hasMore: false, serverTime: world.now };
}

/** Physical distance from the painted card's bounds to the content box on each side. */
export function contentInsets([mark, child]: [string, string | null]): string {
  const outer = document.querySelector(`[data-real-measure="${mark}"]`)!;
  const inside = child ? outer.querySelector(child) : outer;
  if (!inside) throw new Error("The settings card did not draw its content");
  const card = outer.getBoundingClientRect();
  const content = inside.getBoundingClientRect();
  const css = getComputedStyle(inside);
  const distances = [
    content.top - card.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop),
    card.right - content.right + parseFloat(css.borderRightWidth) + parseFloat(css.paddingRight),
    card.bottom - content.bottom + parseFloat(css.borderBottomWidth) + parseFloat(css.paddingBottom),
    content.left - card.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft),
  ];
  return distances.map((d) => `${Math.round(d * 10) / 10}px`).join(" ");
}
