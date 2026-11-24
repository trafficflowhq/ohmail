import { useRef, useState, type KeyboardEventHandler } from "react";
import { Button, Dot, Empty, Menu, MenuGroup, MenuItem, RefusalLine, Slot, Tag } from "@ohmail/ui/base";
import { CalendarSquare, SidePanel, type CalendarTone } from "@ohmail/ui/calendar";
import { ActionPanel } from "@ohmail/ui/mail";
import type { CalendarPanelProps } from "../frame/contract.js";
import type {
  InvitationAnswer,
  InvitationGroups,
  InvitationRow,
} from "@ohmail/app-logic/calendar/invitations";
import { useLocale, useText } from "../text/index.js";
import { AnswerChoices } from "./AnswerChoices.js";
import { InvitationRefusal } from "./InvitationItem.js";
import { whenOf } from "./words.js";
import "./phone-invitation.css";

const GROUPS = ["toAnswer", "changed", "answered"] as const;

type PhoneInvitationProps = {
  groups: InvitationGroups;
  compact?: CalendarPanelProps["compact"];
  row: InvitationRow | undefined;
  today: string;
  previous: boolean;
  next: boolean;
  show(row: InvitationRow): void;
  close(): void;
  calendar: { name: string; tone: CalendarTone } | null;
  answer(value: InvitationAnswer): void;
  retry(id: string): void;
  letGo(id: string): void;
  onKeys: KeyboardEventHandler<HTMLDivElement>;
};

export function PhoneInvitation({
  groups,
  compact,
  row,
  today,
  previous,
  next,
  show,
  close,
  calendar,
  answer,
  retry,
  letGo,
  onKeys,
}: PhoneInvitationProps) {
  const t = useText("invitations");
  const [list, setList] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const rows = GROUPS.flatMap((group) => groups[group]);
  const index = row ? rows.indexOf(row) : -1;
  const group = GROUPS.find((key) => row && groups[key].includes(row));
  const label =
    group && row
      ? t("position", {
          group: t(`group.${group}`),
          index: groups[group].indexOf(row) + 1,
          count: groups[group].length,
        })
      : t("title");
  const step = (direction: number) => {
    const item = rows[index + direction];
    if (item) show(item);
  };
  return (
    <div role="dialog" aria-label={t("title")} className="cal-invitation-sheet" onKeyDown={onKeys}>
      <SidePanel
        label={t("title")}
        head={
          <>
            <i className="cal-invitation-grab" aria-hidden="true" />
            <header className="cal-invitation-head">
              <span className="cal-invitation-picker">
                <Button
                  kind="quiet"
                  size="s"
                  mark="down"
                  opens="menu"
                  expanded={list}
                  ref={anchor}
                  disabled={rows.length === 0}
                  onPress={() => setList(true)}
                >
                  {label}
                </Button>
                {group === "toAnswer" ? <Dot kind="hot" /> : null}
              </span>
              <div className="cal-invitation-nav">
                <Button
                  kind="quiet"
                  size="s"
                  icon="back"
                  label={t("previous")}
                  disabled={!previous}
                  onPress={() => step(-1)}
                />
                <Button
                  kind="quiet"
                  size="s"
                  icon="fwd"
                  label={t("next")}
                  disabled={!next}
                  onPress={() => step(1)}
                />
                <Button kind="quiet" size="s" icon="x" label={t("close")} onPress={close} />
              </div>
            </header>
          </>
        }
      >
        {row ? (
          <InvitationContent {...{ row, today, calendar, answer, retry, letGo, compact }} />
        ) : (
          <Empty mark={t("mark")} label={t("allAnswered", { count: groups.answered.length })} />
        )}
      </SidePanel>
      <Menu open={list} label={t("title")} anchor={anchor} onClose={() => setList(false)}>
        {GROUPS.map((key) =>
          groups[key].length ? (
            <MenuGroup key={key} title={t(`group.${key}`)}>
              {groups[key].map((item) => (
                <MenuItem
                  key={item.recordId}
                  checked={item === row}
                  onPress={() => {
                    setList(false);
                    show(item);
                  }}
                >
                  {item.title}
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null,
        )}
      </Menu>
    </div>
  );
}

function InvitationContent({
  row,
  today,
  calendar,
  answer,
  retry,
  letGo,
  compact,
}: Pick<PhoneInvitationProps, "today" | "calendar" | "answer" | "retry" | "letGo" | "compact"> & {
  row: InvitationRow;
}) {
  const t = useText("invitations");
  const event = useText("event");
  const locale = useLocale();
  return (
    <div className="cal-invitation-content">
      <h2 className="cal-invitation-title">{row.title}</h2>
      <p className="cal-invitation-detail">{whenOf(row.when, row.day, today, locale, t)}</p>
      {row.organizer || row.place ? (
        <p className="cal-invitation-detail">{[row.organizer, row.place].filter(Boolean).join(" · ")}</p>
      ) : null}
      <div className="cal-invitation-facts">
        {row.cancelled ? <Tag>{t("cancelled")}</Tag> : null}
        {compact?.tags.map(({ text, tone }, index) => (
          <span key={index} className="oh-tag">
            <CalendarSquare tone={tone} />
            {text}
          </span>
        ))}
        {calendar?.name ? (
          <span className="cal-invitation-calendar">
            <CalendarSquare tone={calendar.tone} />
            <InvitationCalendar name={calendar.name} move={compact?.move} />
          </span>
        ) : null}
      </div>
      {row.waiting !== null ? (
        <p className="cal-invitation-detail" role="status">
          {event(`waiting.${row.waiting}`)}
        </p>
      ) : null}
      {row.viewOnly ? (
        <RefusalLine>{event(row.connectionStopped ? "refusal.connection" : "refusal.readOnly")}</RefusalLine>
      ) : null}
      {row.cancelled || row.viewOnly ? null : (
        <AnswerChoices answer={row.answer} fill onAnswer={answer} propose={compact?.propose} />
      )}
      <InvitationRefusal row={row} onRetry={retry} onLetGo={letGo} />
      {compact?.write ? <ActionPanel label={compact.write.label} items={[compact.write]} /> : null}
    </div>
  );
}

function InvitationCalendar({
  name,
  move,
}: {
  name: string;
  move: NonNullable<PhoneInvitationProps["compact"]>["move"];
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!move) return name;
  return (
    <>
      <Slot ref={anchor} label={move.label} expanded={open} onPress={() => setOpen(true)}>
        {name}
      </Slot>
      <Menu label={move.label} anchor={anchor} open={open} onClose={() => setOpen(false)}>
        {move.destinations.map(({ id, name }) => (
          <MenuItem
            key={id}
            onPress={() => {
              setOpen(false);
              if (anchor.current) move.pick(id, anchor.current);
            }}
          >
            {name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
