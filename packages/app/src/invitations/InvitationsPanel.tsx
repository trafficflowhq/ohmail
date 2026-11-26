/**
 * THE INVITATIONS, a panel beside the view: To answer, Changed, Answered. The row it stands on is the open event, and
 * the calendar goes to its day. An answer goes through the calendar's writes door and nothing else; once our server has
 * taken it, the next invitation that waits opens. Nothing is kept: every version of the mirror is read again.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { SidePanel } from "@ohmail/ui/calendar";
import { GroupHeading, ListHead } from "@ohmail/ui/mail";
import { pressAndHear, type CalendarAct, type CalendarPort } from "@ohmail/app-logic/calendar";
import {
  pressAnswer,
  type AnswerOutcome,
  type InvitationAnswer,
  type InvitationRow,
} from "@ohmail/app-logic/calendar/invitations";
import { useFrame, useReport, useSelectionBar } from "../frame/commands.js";
import type { CalendarPanelProps } from "../frame/contract.js";
import { eventRefString } from "../frame/product.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { PhoneInvitation } from "./PhoneInvitation.js";
import { InvitationItem } from "./InvitationItem.js";
import { useInvitations, type Invitations } from "./use-invitations.js";

export function InvitationsPanel(props: CalendarPanelProps) {
  const { host } = useFrame();
  const t = useText("invitations");
  const port = host.wires.calendar;
  useSelectionBar(props.plan.device === "phone");
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  return <PanelOn port={port} {...props} />;
}

const GROUPS = ["toAnswer", "changed", "answered"] as const;

function PanelOn({
  port,
  route,
  plan,
  onClose,
  compact,
}: CalendarPanelProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("invitations");
  const found = useInvitations(port);
  const all = found === null ? [] : GROUPS.flatMap((g) => found.groups[g]);
  const openIndex = all.findIndex((r) => eventRefString(r.ref) === route.open);

  const show = (row: InvitationRow) =>
    commands.go({ place: route.place, sub: row.ref.day, open: eventRefString(row.ref), words: route.words });
  useInitialInvitation(plan.device, route, openIndex, found?.groups.toAnswer[0] ?? found?.groups.changed[0]);
  const step = (by: number) => {
    const to = all[Math.max(0, Math.min(all.length - 1, openIndex + by))];
    if (to) show(to);
  };

  const { answer, retry, letGo } = useInvitationActions(port, found, show);
  const head = (
    <ListHead
      title={t("title")}
      hot={(found?.groups.waiting ?? 0) > 0}
      aside={<Button kind="quiet" size="s" icon="x" label={t("close")} onPress={onClose} />}
    />
  );
  if (found === null)
    return (
      <SidePanel label={t("title")} head={head}>
        <RefusalLine>{t("noZone")}</RefusalLine>
      </SidePanel>
    );
  const { groups, today, sources } = found;
  const calendarOf = (id: string) => {
    const c = sources.calendars.find((x) => x.id === id);
    return { name: c?.name ?? "", tone: sources.tones.get(id) ?? null };
  };
  if (plan.device === "phone") {
    const row = all[openIndex];
    return (
      <PhoneInvitation
        groups={groups}
        compact={compact}
        row={row}
        today={today}
        previous={openIndex > 0}
        next={openIndex < all.length - 1}
        show={show}
        close={onClose}
        calendar={row ? calendarOf(row.calendarId) : null}
        answer={(value) => {
          if (row) void answer(row, value);
        }}
        retry={retry}
        letGo={letGo}
        onKeys={keysOf(step, onClose)}
      />
    );
  }
  const clear = groups.toAnswer.length === 0 && groups.changed.length === 0;
  return (
    <SidePanel label={t("title")} head={head} arrives="slide">
      {clear ? <Empty mark={t("mark")} label={t("allAnswered", { count: groups.answered.length })} /> : null}
      {/* A list's own keys, while the keyboard is in it: no key is heard outside the panel. */}
      <div role="group" onKeyDown={keysOf(step, onClose)}>
        {GROUPS.map((g) =>
          groups[g].length === 0 ? null : (
            <section key={g} aria-label={t(`group.${g}`)}>
              <GroupHeading count={String(groups[g].length)} hot={g !== "answered" && groups[g].length > 0}>
                {t(`group.${g}`)}
              </GroupHeading>
              <div role="list">
                {groups[g].map((row) => (
                  <div role="listitem" key={eventRefString(row.ref)}>
                    <InvitationItem
                      row={row}
                      open={eventRefString(row.ref) === route.open}
                      today={today}
                      calendar={calendarOf(row.calendarId)}
                      onOpen={() => show(row)}
                      onClose={() => commands.event(null)}
                      onAnswer={(value) => void answer(row, value)}
                      onRetry={retry}
                      onLetGo={letGo}
                    />
                  </div>
                ))}
              </div>
            </section>
          ),
        )}
      </div>
    </SidePanel>
  );
}

/** Inside the panel, j and k (and the arrows) walk the rows, and Escape closes it. */
function keysOf(step: (by: number) => void, close: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "ArrowDown") step(1);
    else if (event.key === "k" || event.key === "ArrowUp") step(-1);
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
  };
}

function useInitialInvitation(
  device: CalendarPanelProps["plan"]["device"],
  route: CalendarPanelProps["route"],
  openIndex: number,
  first: InvitationRow | undefined,
) {
  const { commands } = useFrame();
  const initialized = useRef(false);
  useEffect(() => {
    if (device !== "phone" || initialized.current) return;
    if (openIndex >= 0) initialized.current = true;
    else if (first) {
      initialized.current = true;
      commands.go(
        { place: route.place, sub: first.ref.day, open: eventRefString(first.ref), words: route.words },
        { replace: true },
      );
    }
  }, [commands, first, openIndex, device, route.place, route.words]);
}

function useInvitationActions(
  port: CalendarPort,
  found: Invitations | null,
  show: (row: InvitationRow) => void,
) {
  const { commands } = useFrame();
  const t = useText("invitations");
  const e = useText("event");
  const report = useReport();
  /* The newest reading, for what happens after a press has been answered. */
  const latest = useRef<Invitations | null>(found);
  latest.current = found;
  /* The invitations whose answer is out: a second press waits for the first. */
  const out = useRef(new Set<string>());
  const answer = async (row: InvitationRow, value: InvitationAnswer) => {
    if (out.current.has(row.recordId)) return;
    const was = latest.current?.groups.toAnswer.findIndex((r) => r.recordId === row.recordId) ?? -1;
    out.current.add(row.recordId);
    let outcome: AnswerOutcome;
    try {
      outcome = await pressAnswer(port, row, value);
    } finally {
      out.current.delete(row.recordId);
    }
    if (!outcome.pressed) return commands.event(null);
    if (outcome.verdict?.kind !== "taken") {
      if (outcome.say !== null) report(e(outcome.say));
      return;
    }
    report(t(`answer.${value}`));
    const waiting = (latest.current?.groups.toAnswer ?? []).filter((r) => r.recordId !== row.recordId);
    const next = waiting[Math.max(0, was)] ?? waiting[0];
    if (next) show(next);
    else commands.event(null);
  };
  const word = async (
    act: Extract<CalendarAct, { kind: "calendar_write_retry" | "calendar_write_dismiss" }>,
  ) => {
    const heard = await pressAndHear(port, act);
    if (heard.say !== null) report(e(heard.say));
  };

  const retry = async (row: InvitationRow) => {
    const writeId = row.refusedWriteId;
    if (writeId === null) return;
    if (row.refusal !== "answer_unconfirmed") return word({ kind: "calendar_write_retry", writeId });
    if (
      out.current.has(row.recordId) ||
      !latest.current?.groups.answered.some(
        (current) =>
          current.recordId === row.recordId &&
          current.ref.event === row.ref.event &&
          current.ref.occurrence === row.ref.occurrence &&
          !current.viewOnly &&
          current.refusal === "answer_unconfirmed" &&
          current.refusedWriteId === writeId,
      )
    )
      return;
    out.current.add(row.recordId);
    try {
      await word({ kind: "calendar_write_retry", writeId, resendReply: true });
    } finally {
      out.current.delete(row.recordId);
    }
  };
  const letGo = (writeId: string) => void word({ kind: "calendar_write_dismiss", writeId });
  return { answer, retry, letGo };
}
