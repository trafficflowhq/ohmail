import { parseRRule } from "@ohmail/app-logic/calendar";
import { QuestionBeforeAct } from "@ohmail/ui/calendar";
import { useLocale, useText, type Text } from "../text/index.js";
import { guestNames } from "./event-words.js";
import type { EventActions } from "./use-event-actions.js";

type Rule = NonNullable<ReturnType<typeof parseRRule>>;
type CivilDate = { year: number; month: number; day: number };

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAYS = DAYS.slice(0, 5);

function dateOf({ year, month, day }: CivilDate): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function ordinalName(ordinal: number, t: Text): string {
  const order =
    ["first", "second", "third", "fourth"][ordinal - 1] ??
    (ordinal === -1 ? "last" : ordinal < 0 ? "fromEnd" : "numbered");
  return t("actions.repeat.ordinal", { order, count: Math.abs(ordinal) });
}

function patternLine(rule: Rule, start: CivilDate, t: Text, locale: string): string | null {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  const names = rule.byDay.map((part) => weekday.format(Date.UTC(1970, 0, 5 + DAYS.indexOf(part.weekday))));
  if (
    (rule.freq === "DAILY" || rule.freq === "WEEKLY") &&
    rule.interval === 1 &&
    rule.byDay.length === WEEKDAYS.length &&
    WEEKDAYS.every((name) => rule.byDay.some((part) => part.weekday === name && part.ordinal === 0))
  ) {
    return t("actions.repeat.weekdays");
  }
  if (rule.freq === "DAILY" && rule.interval === 1 && rule.count === null && rule.until === null)
    return t("repeat.everyDay");
  if (rule.freq === "DAILY") return t("actions.repeat.daily", { count: rule.interval });
  if (rule.freq === "WEEKLY") {
    const days = names.length ? names : [weekday.format(dateOf(start))];
    return t("actions.repeat.on", {
      frequency: t("actions.repeat.weekly", { count: rule.interval }),
      days: new Intl.ListFormat(locale).format(days),
    });
  }
  const day = rule.byMonthDay[0] ?? start.day;
  // "The first Tuesday" is said either way a rule can write it: 1TU, or TU with its position apart (BYSETPOS=1).
  const ordinal =
    rule.byDay[0]?.ordinal ||
    (rule.byDay.length === 1 && rule.bySetPos.length === 1 ? rule.bySetPos[0] : undefined);
  if (rule.freq === "MONTHLY") {
    const count = rule.interval;
    return ordinal && names[0]
      ? t("actions.repeat.monthlyWeekday", { count, ordinal: ordinalName(ordinal, t), weekday: names[0] })
      : t("actions.repeat.monthlyDate", { count, day });
  }
  if (rule.freq === "YEARLY") {
    const month = rule.byMonth[0] ?? start.month;
    const stamp = dateOf({ year: 2000, month, day });
    const format = (part: "month" | "date") =>
      new Intl.DateTimeFormat(locale, {
        month: "long",
        ...(part === "date" && { day: "numeric" }),
        timeZone: "UTC",
      }).format(stamp);
    return ordinal && names[0]
      ? t("actions.repeat.yearlyWeekday", {
          count: rule.interval,
          ordinal: ordinalName(ordinal, t),
          weekday: names[0],
          month: format("month"),
        })
      : t("actions.repeat.yearlyDate", { count: rule.interval, date: format("date") });
  }
  return null;
}

export function repeatLine(
  value: string | undefined,
  start: string,
  t: Text,
  locale: string,
  zone = "UTC",
): string {
  const rule = value && parseRRule(value);
  const description =
    rule &&
    patternLine(
      rule,
      {
        year: Number(start.slice(0, 4)),
        month: Number(start.slice(4, 6)),
        day: Number(start.slice(6, 8)),
      },
      t,
      locale,
    );
  if (!rule || !description) return t("actions.repeat.rule", { rule: value ?? "" });
  if (rule.count !== null) return t("actions.repeat.count", { frequency: description, count: rule.count });
  const until = rule.until;
  if (!until) return description;
  const stamp =
    until.kind === "instant" ? new Date(until.epochMs) : dateOf(until.kind === "date" ? until : until.wall);
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: until.kind === "instant" ? zone : "UTC",
  }).format(stamp);
  return t("actions.repeat.until", { frequency: description, date });
}

export function editScopeLine(repeat: string, changed: boolean, first: boolean, t: Text) {
  return changed ? t(first ? "edit.changedFirstScope" : "edit.changedScope", { repeat }) : repeat;
}

export function EventActionQuestion({ actions }: { readonly actions: EventActions }) {
  const t = useText("calendar");
  const locale = useLocale();
  const { question, chooseScope, cancel, confirm } = actions;
  if (!question) return null;
  const { anchor, change, face, guests, scope } = question;
  const whom = guestNames(guests, locale, t, change.kind !== "delete");
  const length = change.kind === "resize-time";
  const when = question.when;
  const prefix =
    question.repeatRule && scope?.kind === "record"
      ? t("edit.allEvents")
      : scope?.kind === "following"
        ? t("edit.following")
        : null;
  const detail =
    change.kind === "delete"
      ? t("actions.tellsDelete", { title: face.title })
      : when
        ? t("edit.now", { when })
        : face.title;
  const options = [
    { id: "occurrence" as const, label: t("edit.thisEvent"), keyHint: "1" },
    { id: "following" as const, label: t("edit.following"), keyHint: "2" },
    { id: "record" as const, label: t("edit.allEvents"), keyHint: "3" },
  ];
  return (
    <QuestionBeforeAct
      open
      anchor={anchor}
      onClose={cancel}
      cancel={t("edit.cancel")}
      {...(scope === null
        ? {
            question:
              change.kind === "delete"
                ? t("actions.deleteTitle", { title: face.title })
                : length && when
                  ? when
                  : t("actions.moveWhen", { when: when ?? face.title }),
            follows: editScopeLine(
              repeatLine(question.repeatRule, question.repeatStart, t, locale),
              change.kind !== "delete" && question.changedOccurrence,
              question.firstOccurrence,
              t,
            ),
            scopes: options
              .filter((option) => question.scopes.includes(option.id))
              .map((option) => ({ ...option, onPress: () => chooseScope(option.id) })),
          }
        : {
            question: t("edit.tell", { guests: whom }),
            follows: prefix ? `${prefix} · ${detail}` : detail,
            answers: [
              {
                id: "send",
                label: t(change.kind === "delete" ? "actions.sendCancellation" : "edit.sendUpdate"),
                keyHint: "↵",
                onPress: confirm,
              },
            ],
          })}
    />
  );
}

export function CalendarRecordScope({
  anchor,
  question,
  occurrence,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  question: string;
  occurrence: boolean;
  onChoose: (scope: "record" | "occurrence") => void;
  onClose: () => void;
}) {
  const t = useText("calendar");
  return (
    <QuestionBeforeAct
      open
      anchor={anchor}
      question={question}
      cancel={t("edit.cancel")}
      onClose={onClose}
      scopes={[
        ...(occurrence
          ? [{ id: "occurrence", label: t("edit.thisEvent"), onPress: () => onChoose("occurrence") }]
          : []),
        { id: "record", label: t("edit.allEvents"), onPress: () => onChoose("record") },
      ]}
    />
  );
}
