import { clockTime, dayShort } from "@ohmail/app-logic/calendar";
import { useLocale, useText } from "../text/index.js";
import type { useNewEvent } from "./use-new-event.js";
import { createContext, useContext, type KeyboardEvent, type MouseEvent } from "react";
import { contextTrigger, Menu, MenuItem, MenuRule, type Point } from "@ohmail/ui/base";

type Anchor = { at: Point | Element; opener: HTMLElement };
export type CalendarMenuTarget = Anchor &
  (
    | { kind: "event"; id: string; day?: string; remove?: boolean }
    | { kind: "date"; day: string }
    | { kind: "time"; day: string; from: number; to: number }
  );

export const CalendarMenu = createContext<{
  open: (target: CalendarMenuTarget) => void;
  slot: Extract<CalendarMenuTarget, { kind: "time" }> | null;
} | null>(null);

export function useCalendarMenu() {
  const menu = useContext(CalendarMenu);
  function eventProps<E extends HTMLElement>(event: { id: string; state: string }, day?: string) {
    if (!menu || event.state === "draft" || event.state === "from-mail") return undefined;
    const target = { kind: "event" as const, id: event.id, day };
    return {
      onContextMenu: (press: MouseEvent<E>) => {
        if (!available(press)) return;
        press.stopPropagation();
        const opener = press.currentTarget;
        contextTrigger((at) => menu.open({ ...target, at, opener })).onContextMenu(press);
      },
      onKeyDown: (press: KeyboardEvent<E>) => {
        const opener = press.currentTarget;
        if (
          press.target !== opener ||
          !available(press) ||
          press.repeat ||
          press.altKey ||
          press.ctrlKey ||
          press.metaKey
        )
          return;
        if (!press.shiftKey && (press.key === "Delete" || press.key === "Backspace")) {
          press.preventDefault();
          press.stopPropagation();
          menu.open({ ...target, at: opener, opener, remove: true });
          return;
        }
        contextTrigger((at) => menu.open({ ...target, at, opener })).onKeyDown(press);
        if (press.defaultPrevented) press.stopPropagation();
      },
    };
  }
  return {
    eventProps,
    slot: menu?.slot ?? null,
    time: menu
      ? (day: string, press: MouseEvent<HTMLDivElement>) => {
          if (!available(press) || (press.target as Element).closest("button")) return;
          const opener = press.currentTarget;
          const bounds = opener.getBoundingClientRect();
          if (bounds.height <= 0) return;
          const minute = ((press.clientY - bounds.top) * 1440) / bounds.height;
          const from = Math.max(0, Math.min(1410, Math.floor(minute / 30) * 30));
          contextTrigger((at) =>
            menu.open({ kind: "time", day, from, to: Math.min(1440, from + 60), at, opener }),
          ).onContextMenu(press);
        }
      : undefined,
    timeKey: menu
      ? (day: string, from: number, press: KeyboardEvent<HTMLDivElement>) => {
          if (press.target !== press.currentTarget || !available(press)) return;
          const opener = press.currentTarget;
          const cursor = opener.querySelector(".oh-tg-cursor");
          contextTrigger((at) =>
            menu.open({ kind: "time", day, from, to: Math.min(1440, from + 60), at: cursor ?? at, opener }),
          ).onKeyDown(press);
          if (press.defaultPrevented) press.stopPropagation();
        }
      : undefined,
    date: menu
      ? (day: string, opener: HTMLElement, press: MouseEvent | KeyboardEvent) => {
          if (!available(press)) return;
          const trigger = contextTrigger((at) => menu.open({ kind: "date", day, at, opener }));
          if ("key" in press) trigger.onKeyDown(press);
          else trigger.onContextMenu(press);
          if (press.defaultPrevented) press.stopPropagation();
        }
      : undefined,
  };
}

function available(event: KeyboardEvent | MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.target instanceof Element &&
    !event.target.closest(
      "input, textarea, select, [contenteditable], a[href], [data-drag], [aria-hidden=true]",
    )
  );
}

export function SlotMenu({
  context,
  create,
  onDay,
  close,
  place,
}: {
  context: Exclude<CalendarMenuTarget, { kind: "event" }>;
  create: ReturnType<typeof useNewEvent>;
  onDay: ((day: string) => void) | null;
  close: () => void;
  place: "day" | "week";
}) {
  const t = useText("calendar");
  const locale = useLocale();
  return (
    <Menu
      open
      kind="context"
      anchor={context.at}
      returnFocus={context.opener}
      label={t(context.kind === "date" ? "view.month" : `view.${place}`)}
      onClose={close}
    >
      {create && (
        <MenuItem
          icon="plus"
          label={t("create.title")}
          note={
            context.kind === "time"
              ? t("atTime", {
                  day: dayShort(context.day, locale),
                  time: clockTime(context.from, locale),
                })
              : undefined
          }
          onPress={() => {
            close();
            if (context.kind === "time") create(context.day, context.from, context.to);
            else create(context.day);
          }}
        >
          {t("create.title")}
        </MenuItem>
      )}
      {create && onDay && <MenuRule />}
      {onDay && (
        <MenuItem
          icon="day"
          onPress={() => {
            close();
            onDay(context.day);
          }}
        >
          {t("goToDay")}
        </MenuItem>
      )}
    </Menu>
  );
}
