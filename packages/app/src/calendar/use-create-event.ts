import { useRef, useState, type RefObject } from "react";
import {
  isoOfDay,
  nowIn,
  pressAndHear,
  readerZones,
  sentenceOf,
  viewOnlyOf,
  type CalendarAct,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { wayOfConnection } from "@ohmail/app-logic/calendar/setup";
import { useFrame, useReport } from "../frame/commands.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import type { NewEventDraft } from "./DraftFields.js";
import { useRefusedDraft } from "./draft-undo.js";
import { fieldsOfDraft } from "./event-draft.js";
import { closeEventDraft, fadeRejectedEvent } from "./event-save-motion.js";
import { eventWhen, guestNames } from "./event-words.js";
import { repeatRefusal } from "./repeat.js";

export function useCreateEvent(port: CalendarPort, card: RefObject<HTMLDivElement | null>) {
  const { host, commands, route } = useFrame();
  const e = useText("event");
  const t = useText("calendar");
  const zone = useTimeZone();
  const finish = useFinishCreatedEvent(port, card, zone);
  const request = useRef<symbol | null>(null);
  const committed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const create = async (draft: NewEventDraft, target?: CalendarRecord, replaceWriteId?: string) => {
    if (request.current || !target) return;
    const actual = host.engine.store.get<CalendarRecord>("calendar", target.id);
    const connection =
      actual && host.engine.store.get<CalendarConnectionRecord>("calendar_connection", actual.connectionId);
    if (!actual?.shown || viewOnlyOf(actual, connection)) {
      setFailure(e("refusal.readOnly"));
      return;
    }
    const dav = connection?.provider === "caldav";
    if (dav && actual.autoSchedule !== true && draft.invitees?.length) {
      setFailure(e("fault.inviteesUnsupported"));
      return;
    }
    const event = fieldsOfDraft(draft, actual, draft.zone ?? zone);
    if (!event) return;
    const badRule = repeatRefusal(event.repeat, event.start, connection?.repeatShapes, t);
    if (badRule) {
      setFailure(badRule);
      return;
    }
    if (event.callLink && connection?.provider !== "caldav") {
      setFailure(e("fault.notAllowed"));
      return;
    }
    if (connection?.provider === "microsoft" && (draft.alarms?.length ?? 0) > 1) {
      setFailure(e("fault.notAllowed"));
      return;
    }
    const ticket = Symbol();
    request.current = ticket;
    setBusy(true);
    try {
      const act = {
        kind: "calendar_event_create",
        eventId: port.newId(),
        calendarId: actual.id,
        ...(event.repeat && { repeatSelected: true }),
        event: {
          ...event,
          invitees: (draft.invitees ?? []).flatMap(({ address, name, role }) =>
            role === "required" || role === "optional" ? [{ address, name, role }] : [],
          ),
        },
      } satisfies CalendarAct;
      const result = await finish(
        act,
        draft,
        { dav, iCloud: connection !== undefined && wayOfConnection(connection) === "icloud", replaceWriteId },
        () => request.current === ticket,
        () => {
          committed.current = true;
        },
      );
      if (request.current === ticket && result) setFailure(result);
    } catch {
      if (request.current === ticket) setFailure(e("refusal.unknown"));
    } finally {
      if (request.current === ticket) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const close = () => {
    if (!request.current) commands.go({ place: route.place, sub: route.sub }, { history: "dismiss-dialog" });
  };
  return { create, close, request, committed, busy, failure, setFailure };
}

function useFinishCreatedEvent(port: CalendarPort, card: RefObject<HTMLDivElement | null>, zone: string) {
  const { commands, route } = useFrame();
  const recover = useRefusedDraft(port);
  const t = useText("calendar");
  const e = useText("event");
  const locale = useLocale();
  const report = useReport();
  return async (
    act: Extract<CalendarAct, { kind: "calendar_event_create" }>,
    draft: NewEventDraft,
    options: { dav: boolean; iCloud: boolean; replaceWriteId?: string },
    active: () => boolean,
    commit: () => void,
  ) => {
    const finish = () => {
      commit();
      closeEventDraft(card.current, act.eventId);
      const now = nowIn(Date.now(), zone, readerZones());
      const staysOnToday = route.sub === null && now !== null && isoOfDay(now.day) === draft.day;
      commands.go({ place: "week", sub: staysOnToday ? null : draft.day }, { replace: true });
    };
    const dismissReplaced = () => {
      if (options.replaceWriteId) {
        void pressAndHear(port, { kind: "calendar_write_dismiss", writeId: options.replaceWriteId }).then(
          ({ verdict, say }) => {
            if (verdict?.kind === "refused" && say) report(e(say));
          },
          () => report(e("refusal.unknown")),
        );
      }
    };
    const reportAdded = () => {
      const guests = (draft.invitees ?? []).map(({ name, address }) => name || address);
      report(
        guests.length && !options.iCloud
          ? e("taken.invitationAudience", { guests: guestNames(guests, locale, t) })
          : (eventWhen(act.event, zone, readerZones(), locale) ?? e("taken.create")),
      );
    };
    if (!port.watchCreate) {
      const heard = await pressAndHear(port, act);
      if (!active()) return null;
      if (heard.verdict?.kind === "refused") return e(heard.say!);
      if (heard.verdict?.kind === "taken") {
        dismissReplaced();
        reportAdded();
      } else if (heard.say) report(e(heard.say));
      finish();
      return null;
    }

    const { key } = await port.press(act);
    // A CalDAV create stays in its editor until the first device flush can rule out a local refusal.
    // Provider settlement of a queued write still happens in the background.
    if (options.dav) await port.flush();
    if (!active()) return null;
    const immediate = port.verdict(key);
    const hasProviderDraft =
      immediate?.kind === "refused" &&
      options.dav &&
      port
        .events()
        .some(
          ({ record }) => record.id === act.eventId && record.writes.some(({ key: mark }) => mark === key),
        );
    if (immediate?.kind === "refused" && !hasProviderDraft) return e(sentenceOf(act, immediate)!);
    const view = card.current?.closest<HTMLElement>(".cal-body-view") ?? null;
    finish();
    let refused = false;
    port.watchCreate(
      act.eventId,
      key,
      (verdict, writeId) => {
        refused = true;
        if (!options.dav) fadeRejectedEvent(view, act.eventId);
        recover({ kind: "new", draft, calendar: act.calendarId }, act, verdict, writeId, options.dav);
      },
      options.replaceWriteId ? dismissReplaced : undefined,
    );
    const afterFlush = () => {
      const result = port.verdict(key);
      if (!refused && result?.kind === "taken" && (!options.iCloud || result.write?.state !== "pending"))
        reportAdded();
    };
    if (options.dav) afterFlush();
    else void port.flush().then(afterFlush, () => {});
    return null;
  };
}
