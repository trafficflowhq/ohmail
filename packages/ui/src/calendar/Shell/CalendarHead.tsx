import type { MouseEventHandler, ReactNode, Ref } from "react";
import { Button } from "../../base/Primitives/Button.js";
import { Dot } from "../../base/Primitives/Dot.js";
import type { IconName } from "../../icons/Icon.js";
import "./calendar-head.css";

interface Way {
  label: string;
  disabled?: boolean;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

export interface CalendarHeadProps {
  /** The span on screen, or the place's name. */
  title: string;
  /** The same in fewer letters, for a head short of room. */
  shortTitle?: string;
  /** The span holds today, or something in the place waits: the title ends in the hot dot. */
  hot: boolean;
  /** A span of days is the way to a date: what the title's press does, said in full. */
  goTo?: Way;
  /** A second, smaller word after the title. */
  sub?: string;
  /** The week's number beside the date. With `onPress` it is the way to its week; without, it says where you are. */
  week?: {
    word: string;
    short: string;
    number: number;
    label: string;
    onPress?: MouseEventHandler<HTMLButtonElement>;
  };
  /** The span before and after. Left out in a place that is no span. */
  before?: Way;
  after?: Way;
  today?: Way & { keyHint?: string };
  /** The view is not on today: on the phone Today then stands in the title line. */
  away?: boolean;
  /** The views: a view switch. */
  views?: ReactNode;
  search?: Way;
  /** The Agenda's control, and whether its panel stands. */
  agenda?: Way & { on: boolean };
  /** What waits for an answer: a doorbell. */
  bell?: ReactNode;
  more?: Way & { open?: boolean };
  /** The way between the two products, where the phone has it in its title line. */
  switcher?: ReactNode;
}

function tool(
  part: string,
  icon: IconName,
  way: Way | undefined,
  extra: { pressed?: boolean; opens?: "menu"; expanded?: boolean } = {},
) {
  if (!way) return null;
  return (
    <span className="oh-calhead-part" data-part={part}>
      <Button
        ref={way.ref}
        kind="quiet"
        icon={icon}
        label={way.label}
        disabled={way.disabled}
        onPress={way.onPress}
        {...extra}
      />
    </span>
  );
}

/**
 * One head for every view: the title, the two arrows, Today, the views, Search, the Agenda's
 * control, the bell, More. It sheds by its own width, in a fixed order, and the app decides nothing
 * about that. A key is a hint the app's own registry answers; the head only draws it.
 */
export function CalendarHead(p: CalendarHeadProps) {
  const words =
    p.shortTitle && p.shortTitle !== p.title ? (
      <>
        <span className="oh-calhead-full">{p.title}</span>
        <span className="oh-calhead-short" aria-hidden>
          {p.shortTitle}
        </span>
      </>
    ) : (
      p.title
    );
  const dot = <Dot kind={p.hot ? "hot" : "ink"} />;
  const week = p.week ? (
    <>
      <span className="oh-calhead-wword">{p.week.word}</span>
      <span className="oh-calhead-wshort">{p.week.short}</span>
      {p.week.number}
    </>
  ) : null;
  return (
    <header className="oh-calhead" data-away={p.away ? "" : undefined} data-week={p.week ? "" : undefined}>
      {p.switcher}
      <h1 className="oh-text oh-display oh-calhead-title">
        {p.goTo ? (
          <button
            ref={p.goTo.ref}
            type="button"
            className="oh-control oh-calhead-goto"
            aria-label={p.goTo.label}
            title={p.goTo.label}
            onClick={p.goTo.onPress}
          >
            {words}
            {dot}
          </button>
        ) : (
          <>
            {words}
            {dot}
          </>
        )}
        {p.sub ? <small className="oh-calhead-sub">{p.sub}</small> : null}
      </h1>
      {p.week && p.week.onPress ? (
        <button
          type="button"
          className="oh-control oh-calhead-week"
          data-way=""
          aria-label={p.week.label}
          title={p.week.label}
          onClick={p.week.onPress}
        >
          {week}
        </button>
      ) : p.week ? (
        <span className="oh-calhead-week" aria-label={p.week.label}>
          {week}
        </span>
      ) : null}
      {tool("before", "back", p.before)}
      {tool("after", "fwd", p.after)}
      {p.today ? (
        <span className="oh-calhead-part" data-part="today">
          <Button
            kind="two"
            size="s"
            keyHint={p.today.keyHint}
            disabled={p.today.disabled}
            onPress={p.today.onPress}
          >
            {p.today.label}
          </Button>
        </span>
      ) : null}
      <span className="oh-calhead-gap" />
      {p.views}
      {tool("search", "search", p.search)}
      {tool("agenda", "agenda", p.agenda, { pressed: p.agenda?.on })}
      {p.bell}
      {tool("more", "more", p.more, { opens: "menu", expanded: p.more?.open })}
    </header>
  );
}
