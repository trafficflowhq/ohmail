/**
 * THE INVITATIONS, a panel beside the view: To answer, Changed, Answered. The row it stands on is the open event, and
 * the calendar goes to its day. An answer goes through the calendar's writes door and nothing else; once our server has
 * taken it, the next invitation that waits opens. Nothing is kept: every version of the mirror is read again.
 */
import { useRef, type KeyboardEvent } from "react";
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { SidePanel } from "@ohmail/ui/calendar";
import { GroupHeading, ListHead } from "@ohmail/ui/mail";
import { pressAndHear, type CalendarPort } from "@ohmail/app-logic/calendar";
import {
  pressAnswer,
  type AnswerOutcome,
  type InvitationAnswer,
  type InvitationRow,
} from "@ohmail/app-logic/calendar/invitations";
import { useFrame, useReport } from "../frame/commands.js";
import type { CalendarPanelProps } from "../frame/contract.js";
import { eventRefString } from "../frame/product.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { InvitationItem } from "./InvitationItem.js";
import { useInvitations, type Invitations } from "./use-invitations.js";

export function InvitationsPanel(props: CalendarPanelProps) {
  const { host } = useFrame();
  const t = useText("invitations");
  const port = host.wires.calendar;
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  return <PanelOn port={port} {...props} />;
}

const GROUPS = ["toAnswer", "changed", "answered"] as const;

function PanelOn({ port, route, onClose }: CalendarPanelProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("invitations");
  const e = useText("event");
  const report = useReport();
  const found = useInvitations(port);
  /* The newest reading, for what happens after a press has been answered. */
  const latest = useRef<Invitations | null>(found);
  latest.current = found;
  /* The invitations whose answer is out: a second press waits for the first. */
  const out = useRef(new Set<string>());
  const all = found === null ? [] : GROUPS.flatMap((g) => found.groups[g]);
  const openIndex = all.findIndex((r) => eventRefString(r.ref) === route.open);

  const show = (row: InvitationRow) =>
    commands.go({ place: route.place, sub: row.ref.day, open: eventRefString(row.ref), words: route.words });
  const step = (by: number) => {
    const to = all[Math.max(0, Math.min(all.length - 1, openIndex + by))];
    if (to) show(to);
  };

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
  const word = async (act: { kind: "calendar_write_retry" | "calendar_write_dismiss"; writeId: string }) => {
    const heard = await pressAndHear(port, act);
    if (heard.say !== null) report(e(heard.say));
  };

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
                      onRetry={(writeId) => void word({ kind: "calendar_write_retry", writeId })}
                      onLetGo={(writeId) => void word({ kind: "calendar_write_dismiss", writeId })}
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
