import { useState } from "react";
import { createPortal } from "react-dom";
import {
  isoOfDay,
  nowIn,
  parseRRule,
  readerZones,
  dayOfIso,
  weekdayOfDay,
  formatRRule,
  normalizeRepeatPosition,
} from "@ohmail/app-logic/calendar";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { repeatLine } from "./EventActionQuestion.js";
import type { EventDraft } from "./event-draft.js";
import { draftTimes } from "./event-draft.js";
import { repeatFits, repeatPresets, untilForDay, WEEK } from "./repeat.js";
import "./repeat.css";

const frequencies = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

export function RepeatMenu({
  draft,
  anchor,
  repeatShapes,
  choose,
  close,
}: {
  draft: EventDraft;
  anchor: HTMLElement;
  repeatShapes?: readonly string[];
  choose: (value: string | null) => void;
  close: () => void;
}) {
  const t = useText("calendar");
  const locale = useLocale();
  const deviceZone = useTimeZone();
  const zone = draft.zone ?? deviceZone;
  const [custom, setCustom] = useState(false);
  const [refused, setRefused] = useState(false);
  const startTime = draftTimes(draft, zone).times?.start;
  const supports = (value: string) => repeatFits(value, startTime, repeatShapes);
  const presets = repeatPresets(draft.day);
  const start = draft.day.replaceAll("-", "");
  const words = (value: string | null) =>
    value ? repeatLine(value, start, t, locale, zone) : t("repeat.none");
  const save = (value: string | null) => {
    if (value && !supports(value)) {
      setRefused(true);
      return;
    }
    choose(value);
    close();
  };
  const menu = (
    <Menu
      key={custom ? "custom" : "presets"}
      id={custom ? "calendar-custom-repeat" : undefined}
      open
      anchor={anchor}
      up
      label={t(custom ? "repeat.custom" : "edit.repeatLabel")}
      kind={custom ? "card" : "context"}
      onClose={close}
      fit="beside"
    >
      {!repeatShapes?.length ? (
        <>
          <p className="oh-menu-note">{t("repeat.unavailable")}</p>
          {draft.repeat && <MenuItem onPress={() => save(null)}>{words(null)}</MenuItem>}
        </>
      ) : custom ? (
        <CustomRepeat {...{ draft, presets, zone, words, save, start, supports }} />
      ) : (
        <>
          {presets.map((rule) => (
            <MenuItem
              key={rule ?? "none"}
              checked={rule === (draft.repeat ?? null)}
              onPress={() => save(rule)}
            >
              {words(rule)}
            </MenuItem>
          ))}
          {refused && (
            <p role="status" className="oh-menu-note">
              {t("repeat.unsupported")}
            </p>
          )}
          <MenuItem onPress={() => setCustom(true)}>{t("repeat.custom")}</MenuItem>
        </>
      )}
    </Menu>
  );
  return createPortal(menu, anchor.ownerDocument.body);
}

interface WeekdayProps {
  locale: string;
  days: readonly string[];
  day: string;
  toggle: (day: string) => void;
}

function Weekdays({ locale, days, day, toggle }: WeekdayProps) {
  return (
    <div className="cal-repeat-days">
      {WEEK.map((d, index) => {
        const date = Date.UTC(2024, 0, 1 + index);
        const weekday = (width: "long" | "narrow") =>
          new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(date);
        return (
          <button
            type="button"
            key={d}
            aria-label={weekday("long")}
            aria-pressed={days.includes(d)}
            disabled={d === day}
            onClick={() => {
              toggle(d);
            }}
          >
            {weekday("narrow")}
          </button>
        );
      })}
    </div>
  );
}

interface CustomProps {
  draft: EventDraft;
  presets: (string | null)[];
  zone: string;
  words: (rule: string) => string;
  save: (rule: string) => void;
  start: string;
  supports: (value: string) => boolean;
}
function useRepeatFields({ draft, zone, presets, start, supports }: CustomProps) {
  const day = WEEK[weekdayOfDay(dayOfIso(draft.day)!)]!;
  const initial = parseRRule(draft.repeat ?? "");
  // Keep parts the editor hasn't changed, including a provider's week start and relative yearly pattern.
  const [pattern, setPattern] = useState(() =>
    (initial ? formatRRule(normalizeRepeatPosition(initial)) : presets[3]!)
      .split(";")
      .filter((part) => !/^(INTERVAL|UNTIL|COUNT)=/i.test(part))
      .join(";"),
  );
  const current = parseRRule(pattern) ?? parseRRule(presets[3]!)!;
  const freq = current.freq;
  const [interval, setInterval] = useState(String(initial?.interval ?? 1));
  const days = current.byDay.length ? current.byDay.map((d) => d.weekday) : [day];
  const monthly = [presets[5]!, presets[6]!];
  const numbered = "FREQ=MONTHLY;BYDAY=" + Math.ceil(Number(start.slice(6)) / 7) + day;
  if (monthly[1]!.includes("=-1") && !numbered.includes("=5")) monthly.splice(1, 0, numbered);
  const changeFrequency = (f: (typeof frequencies)[number]) => {
    if (f !== freq)
      setPattern(
        f === "DAILY"
          ? presets[1]!
          : f === "WEEKLY"
            ? presets[3]!
            : f === "MONTHLY"
              ? monthly[0]!
              : presets[7]!,
      );
  };
  const [ending, setEnding] = useState(initial?.count ? "after" : initial?.until ? "onDate" : "never");
  const [count, setCount] = useState(String(initial?.count ?? 10));
  const until = initial?.until;
  const initialDay =
    until?.kind === "date"
      ? isoOfDay(until)
      : until?.kind === "instant"
        ? nowIn(until.epochMs, zone, readerZones())
        : null;
  const [end, setEnd] = useState(
    typeof initialDay === "string" ? initialDay : initialDay ? isoOfDay(initialDay.day) : draft.day,
  );
  const [frequency, ...filters] = pattern.split(";");
  const parts = [frequency!];
  if (interval !== "1") parts.push("INTERVAL=" + interval);
  parts.push(...filters);
  if (ending === "after") parts.push("COUNT=" + count);
  if (ending === "onDate") parts.push("UNTIL=" + (untilForDay(end, draft.allDay, draft.from, zone) ?? ""));
  const value = parts.join(";");
  const matchesStart = freq !== "WEEKLY" || days.includes(day);
  const valid = matchesStart && (ending !== "onDate" || end >= draft.day) && supports(value);

  return {
    freq,
    interval,
    setInterval,
    changeFrequency,
    days,
    day,
    filters,
    pattern,
    setPattern,
    monthly,
    ending,
    setEnding,
    end,
    setEnd,
    count,
    setCount,
    valid,
    value,
    matchesStart,
  };
}

function CustomRepeat(props: CustomProps) {
  const t = useText("calendar");
  const locale = useLocale();
  const { draft, words, save } = props;
  const {
    freq,
    interval,
    setInterval,
    changeFrequency,
    days,
    day,
    filters,
    pattern,
    setPattern,
    monthly,
    ending,
    setEnding,
    end,
    setEnd,
    count,
    setCount,
    valid,
    value,
    matchesStart,
  } = useRepeatFields(props);
  return (
    <div className="cal-custom-repeat">
      <div className="cal-repeat-controls">
        <label className="cal-repeat-label">
          {t("repeat.every")}{" "}
          <input
            className="cal-repeat-input"
            type="number"
            min="1"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        </label>
        <div className="cal-repeat-segment">
          {frequencies.map((f) => (
            <button type="button" key={f} aria-pressed={freq === f} onClick={() => changeFrequency(f)}>
              {t("repeat." + f, { count: Number(interval) || 1 })}
            </button>
          ))}
        </div>
      </div>
      {freq === "WEEKLY" && (
        <Weekdays
          {...{ locale, days, day }}
          toggle={(d) => {
            const selected = WEEK.filter((v) => (v === d ? !days.includes(v) : days.includes(v)));
            setPattern(
              [
                "FREQ=WEEKLY",
                "BYDAY=" + selected.join(","),
                ...filters.filter((p) => p.startsWith("WKST=")),
              ].join(";"),
            );
          }}
        />
      )}
      {freq === "MONTHLY" && (
        <div className="cal-repeat-month">
          {monthly.map((choice) => (
            <button
              type="button"
              key={choice}
              aria-pressed={choice === pattern}
              onClick={() => setPattern(choice)}
            >
              {words(choice)}
            </button>
          ))}
        </div>
      )}
      <div className="cal-repeat-controls">
        <label className="cal-repeat-label">
          {t("repeat.ends")}{" "}
          <select className="cal-repeat-input" value={ending} onChange={(e) => setEnding(e.target.value)}>
            {["never", "onDate", "after"].map((k) => (
              <option key={k} value={k}>
                {t("repeat." + k)}
              </option>
            ))}
          </select>
        </label>
        {ending === "onDate" && (
          <input
            className="cal-repeat-input"
            aria-label={t("repeat.onDate")}
            type="date"
            value={end}
            min={draft.day}
            onChange={(e) => setEnd(e.target.value)}
          />
        )}
        {ending === "after" && (
          <input
            className="cal-repeat-input"
            aria-label={t("repeat.times")}
            type="number"
            min="1"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        )}
      </div>
      <p className="cal-repeat-preview" aria-live="polite">
        {valid ? words(value) : !matchesStart ? t("repeat.startDay") : t("repeat.unsupported")}
      </p>
      <div className="cal-repeat-done">
        <Button kind="ink" size="s" disabled={!valid} onPress={() => save(value)}>
          {t("repeat.done")}
        </Button>
      </div>
    </div>
  );
}
