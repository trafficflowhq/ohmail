import { useLayoutEffect, useRef, useState } from "react";
import {
  clockTime,
  dayShort,
  daySpanOf,
  eventTimeOf,
  type CalendarPort,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { CalendarProposalAct, InvitationProposalTimes, MessageDTO } from "@ohmail/wire";
import { EventCard } from "@ohmail/ui/calendar";
import { ActionPanel } from "@ohmail/ui/mail";
import { useFrame, useReport } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { canProposeRecord, eventOwned } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { calendarInterval } from "./event-words.js";
import { changedTimes, type EventChange } from "./event-time-change.js";

export const PROPOSAL_DRAFT = "proposal-draft";
type Counter = Extract<CalendarProposalAct, { kind: "calendar_event_propose" }>;
type ProposalRequest = { face: CalendarEventFace; act: Counter };
type ProposalCard = { outgoing: InvitationProposalTimes | null; incoming: MessageDTO | null };

const addressOf = (address?: string | null) => address?.trim().toLowerCase() ?? "";
const receivedFrom = (letter: MessageDTO, address: string) => addressOf(letter.from.address) === address;
const sameTimes = (a: InvitationProposalTimes, b: InvitationProposalTimes) =>
  a.start.kind === b.start.kind && a.start.value === b.start.value && a.end.value === b.end.value;

function projectProposal(
  face: CalendarEventFace,
  record: ReturnType<CalendarPort["events"]>[number]["record"] | undefined,
  own: readonly string[] | null,
  letters: readonly MessageDTO[],
  pending: readonly { act: CalendarProposalAct }[],
): ProposalCard {
  const organizer = addressOf(record?.organizer?.address);
  if (!record || !organizer || !own || face.viewOnly || face.state === "off")
    return { outgoing: null, incoming: null };
  const occurrence = face.ref.occurrence ?? "";
  const matches = (letter: MessageDTO) => {
    const item = letter.invitation;
    return (
      item?.uid === record.uid &&
      item.sequence === record.sequence &&
      item.recurrenceId === occurrence &&
      addressOf(item.organizer) === organizer
    );
  };
  const proposals = letters.filter(matches);
  const acted = pending.filter(
    ({ act }) => act.recordId === record.id && act.occurrence === occurrence && act.base === record.updatedAt,
  );
  const counters = proposals.filter(
    ({ invitation }) => invitation?.method === "COUNTER" && invitation.proposal,
  );
  const rejected = (counter: MessageDTO) => {
    const proposal = counter.invitation!.proposal!;
    return proposals
      .slice(0, proposals.indexOf(counter))
      .some(
        (letter) =>
          letter.invitation?.method === "DECLINECOUNTER" &&
          receivedFrom(letter, organizer) &&
          addressOf(letter.invitation.proposal?.attendee ?? letter.invitation.invitedAddress) ===
            addressOf(proposal.attendee) &&
          (!letter.invitation.proposal || sameTimes(letter.invitation.proposal, proposal)),
      );
  };
  const sentProposal = acted
    .map(({ act }) => act)
    .reverse()
    .find((act): act is Counter => act.kind === "calendar_event_propose");
  if (!eventOwned(record, own)) {
    const fromHere = counters.find((letter) => {
      const proposal = letter.invitation!.proposal!;
      return (
        own.some((address) => addressOf(address) === addressOf(proposal.attendee)) &&
        receivedFrom(letter, addressOf(proposal.attendee))
      );
    });
    const outgoing =
      fromHere && rejected(fromHere) ? null : (sentProposal ?? fromHere?.invitation?.proposal ?? null);
    return { outgoing, incoming: null };
  }
  const incoming = counters.find((letter) => {
    const proposal = letter.invitation!.proposal!;
    const guest = addressOf(proposal.attendee);
    return (
      guest !== organizer &&
      receivedFrom(letter, guest) &&
      record.invitees.some(({ address }) => addressOf(address) === guest) &&
      !rejected(letter) &&
      !acted.some(({ act }) => act.kind === "calendar_proposal_keep" && act.messageId === letter.id)
    );
  });
  return { outgoing: null, incoming: incoming ?? null };
}

export function useEventProposals(port: CalendarPort, zones: ZoneSource) {
  const { host, route, commands } = useFrame();
  const own = useCalendarOwnAddresses();
  const zone = useTimeZone();
  const locale = useLocale();
  const t = useText("calendar");
  const report = useReport();
  const page = fragmentOf(route);
  const [request, setRequest] = useState<ProposalRequest | null>(null);
  const { pending, hold, sending } = useProposalMail(port);
  useLayoutEffect(() => setRequest(null), [page, port, host.engine, zone]);

  const recordOf = (face: CalendarEventFace) =>
    port.events().find(({ record }) => record.id === face.recordId)?.record;
  const targetOf = (face: CalendarEventFace) => {
    const record = recordOf(face);
    return !face.viewOnly && port.holdProposal && record && canProposeRecord(record, own) ? record : null;
  };
  const baseOf = (face: CalendarEventFace) => {
    const record = targetOf(face);
    return record ? record.updatedAt : undefined;
  };
  const start = (face: CalendarEventFace, change: EventChange, base?: string) => {
    const record = targetOf(face);
    if (!record || request || sending.current) return;
    if (base !== undefined && base !== record.updatedAt) {
      report(t("proposal.changed"));
      return;
    }
    const times = changedTimes(change, face, zone, zones);
    if (times)
      setRequest({
        face,
        act: {
          kind: "calendar_event_propose",
          recordId: record.id,
          base: record.updatedAt,
          occurrence: face.ref.occurrence ?? "",
          ...times,
        },
      });
  };
  const open = (face: CalendarEventFace) =>
    start(face, {
      kind: "time",
      days: face.start.kind === "date" ? 1 : 0,
      minutes: face.start.kind === "date" ? 0 : 60,
    });
  const live = request && baseOf(request.face) === request.act.base ? request : null;
  const draft = live ? proposalFace(live, zone, zones) : null;
  const adjust = (change: EventChange) => {
    if (!live || !draft) return;
    const times = changedTimes(change, draft, zone, zones);
    if (times) setRequest({ ...live, act: { ...live.act, ...times } });
  };

  return {
    baseOf,
    canKeep: Boolean(port.holdProposal),
    start,
    open,
    draft,
    adjust,
    card: (face: CalendarEventFace, letters: readonly MessageDTO[]) =>
      projectProposal(face, recordOf(face), own, letters, pending()),
    ...proposalWords(zone, zones, locale, t),
    preview: (face: CalendarEventFace | undefined, letters: readonly MessageDTO[]) => {
      if (draft || !face) return draft;
      const { outgoing, incoming } = projectProposal(face, recordOf(face), own, letters, pending());
      const times = outgoing ?? incoming?.invitation?.proposal;
      const preview = times && proposalFace({ face, act: times }, zone, zones);
      return preview ? { ...preview, timeEditable: false } : null;
    },
    keep: (face: CalendarEventFace, messageId: string) => {
      const record = recordOf(face);
      if (record)
        void hold({
          kind: "calendar_proposal_keep",
          recordId: record.id,
          base: record.updatedAt,
          occurrence: face.ref.occurrence ?? "",
          messageId,
        });
    },
    cancel: () => setRequest(null),
    confirm: () => {
      if (!live) return;
      setRequest(null);
      void hold(live.act);
      if (route.open !== live.face.id) commands.event(live.face.ref);
    },
  };
}

function useProposalMail(port: CalendarPort) {
  const { host } = useFrame();
  const t = useText("calendar");
  const report = useReport();
  const [sent, setSent] = useState<readonly { key: string; act: CalendarProposalAct }[]>([]);
  const sending = useRef(false);
  const lifetime = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    const id = Symbol();
    lifetime.current = id;
    setSent([]);
    sending.current = false;
    return () => {
      lifetime.current = null;
    };
  }, [port, host.engine]);

  const pending = () => [
    ...(port.pendingProposals?.() ?? []),
    ...sent.filter(({ key }) => port.verdict(key)?.kind !== "refused"),
  ];
  const hold = async (act: CalendarProposalAct) => {
    if (!port.holdProposal || sending.current) return;
    const id = lifetime.current;
    sending.current = true;
    try {
      const receipt = await port.holdProposal(act, UNDO_MS);
      if (lifetime.current !== id) return;
      setSent((items) => [...items, { key: receipt.key, act }]);
      const undo = async () => {
        if (lifetime.current !== id) return;
        try {
          const undone = await receipt.undo();
          if (lifetime.current !== id) return;
          if (undone) setSent((items) => items.filter(({ key }) => key !== receipt.key));
          report(t(undone ? "proposal.undone" : "proposal.undoLate"));
        } catch {
          if (lifetime.current === id) report(t("proposal.failed"));
        }
      };
      const remaining = receipt.remainingMs();
      report(
        t("proposal.sending"),
        remaining > 0
          ? {
              action: t("proposal.undo"),
              duration: remaining,
              actionDeadline: receipt.deadline,
              onAction: () => void undo(),
            }
          : undefined,
      );
    } catch {
      if (lifetime.current === id) report(t("proposal.failed"));
    } finally {
      if (lifetime.current === id) sending.current = false;
    }
  };

  return { pending, hold, sending };
}

function proposalWords(zone: string, zones: ZoneSource, locale: string, t: ReturnType<typeof useText>) {
  const when = (face: CalendarEventFace, times: InvitationProposalTimes, today: string) => {
    const interval = proposalFace({ face, act: times }, zone, zones);
    return interval ? calendarInterval(interval, zone, zones, today, locale, t) : null;
  };
  return {
    when,
    currentTime: (face: CalendarEventFace) => {
      const span = daySpanOf(face, zone, zones);
      return span?.startMinute == null ? dayShort(face.ref.day, locale) : clockTime(span.startMinute, locale);
    },
    shortWhen: (face: CalendarEventFace, times: InvitationProposalTimes, today: string) => {
      const preview = proposalFace({ face, act: times }, zone, zones);
      const span = preview && daySpanOf(preview, zone, zones);
      if (span && span.first === face.ref.day && span.startMinute !== null)
        return clockTime(span.startMinute, locale);
      return when(face, times, today);
    },
  };
}

function proposalFace(
  { face, act }: { face: CalendarEventFace; act: InvitationProposalTimes },
  zone: string,
  zones: ZoneSource,
): CalendarEventFace | null {
  const start = eventTimeOf(act.start);
  const end = eventTimeOf(act.end);
  if (!start || !end) return null;
  const span = daySpanOf({ start, end }, zone, zones);
  if (!span) return null;
  return {
    ...face,
    id: PROPOSAL_DRAFT,
    ref: { ...face.ref, event: PROPOSAL_DRAFT, day: span.first },
    start,
    end,
    state: "draft",
    waits: false,
    status: null,
    repeats: null,
    timeEditable: true,
    second: null,
  };
}

export function ProposalQuestion({
  proposal,
  today,
  zones,
}: {
  proposal: ReturnType<typeof useEventProposals>;
  today: string;
  zones: ZoneSource;
}) {
  const { plan } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const locale = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  const face = proposal.draft;
  const open = face !== null;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = panel.current?.ownerDocument.activeElement;
    panel.current?.querySelector("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  if (!face) return null;
  const when = calendarInterval(face, zone, zones, today, locale, t);
  const verbs = (
    <ActionPanel
      label={t("proposal.question")}
      items={[
        ...(plan.device === "phone" ? [] : [{ note: t("proposal.questionWhen", { when }), keep: true }]),
        {
          id: "confirm",
          label: t("proposal.confirm"),
          icon: "check",
          kind: "ink",
          rank: 0,
          keyHint: "↵",
          onPress: proposal.confirm,
        },
        {
          id: "cancel",
          label: t("edit.cancel"),
          icon: "x",
          rank: 0,
          keyHint: "Esc",
          onPress: proposal.cancel,
        },
      ]}
    />
  );
  return (
    <div
      ref={panel}
      className="cal-event-panel"
      data-proposal=""
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          proposal.cancel();
        } else if (event.shiftKey && event.key.startsWith("Arrow")) {
          const days = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          const minutes = face.start.kind === "date" || days ? 0 : event.key === "ArrowUp" ? -15 : 15;
          if (days || minutes) proposal.adjust({ kind: "time", days, minutes });
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {plan.device === "phone" ? (
        <EventCard
          frame="sheet"
          title={face.title}
          tone={face.tone}
          when={when}
          close={{ label: t("edit.cancel"), onPress: proposal.cancel }}
          foot={
            <>
              <p className="oh-text cal-proposal-question">{t("proposal.question")}</p>
              {verbs}
            </>
          }
        />
      ) : (
        verbs
      )}
    </div>
  );
}
