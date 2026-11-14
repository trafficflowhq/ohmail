import { Fragment, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Menu,
  MenuRule,
  RadioLines,
  Switch,
  type MenuProps,
  type RadioLine,
} from "../../base/index.js";
import "./contact-card.css";

export interface ContactCardProps {
  open: boolean;
  onClose: () => void;
  /** The name that was pressed. Left out: the card comes up from the foot. */
  anchor?: MenuProps["anchor"];
  /** The card's name, said to a screen reader. */
  label: string;
  person: { name: string; address: string };
  copy?: { label: string; onPress?: () => void };
  /** Whose mail the card is about: this address, or everyone at the domain. */
  scope?: {
    label: string;
    options: readonly RadioLine<string>[];
    value: string;
    onChange?: (value: string) => void;
  };
  /** Where that mail is now, as one whole line; `place` is the word in it that is set in ink. */
  now?: { line: string; place: string; all?: { label: string; onPress?: () => void } };
  /** Where their mail goes: the places, one of them taken. A press changes it at once. */
  goes?: {
    label: string;
    places: readonly { value: string; label: string }[];
    value?: string;
    onChange?: (value: string) => void;
  };
  /** The rules that stand: the place, and what the rule is about. */
  rules?: readonly { place: string; note: string }[];
  switches?: readonly { label: string; on: boolean; onChange?: (on: boolean) => void }[];
  /** What another product adds between the switches and the verbs. */
  more?: ReactNode;
  /** The verbs at its foot, as menu items. */
  children?: ReactNode;
}

/** The line with one word of it in ink. The line stays whole: the word is found in it, never glued to it. */
function marked(line: string, word: string): ReactNode {
  const at = word ? line.indexOf(word) : -1;
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <b className="oh-contactcard-mark">{word}</b>
      {line.slice(at + word.length)}
    </>
  );
}

/** Who it is, where their mail goes, and the controls that change it. */
export function ContactCard(props: ContactCardProps) {
  const { open, onClose, anchor, label, person, copy, scope, now, goes, rules, switches, more, children } =
    props;
  const group = useRef<HTMLDivElement | null>(null);
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!goes) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    /* The arrows move the keys only: a place is taken by a press, Enter or Space, since taking one
       moves the sender's mail at once. */
    const radios = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const n = radios.length;
    if (!n) return;
    const at = Math.max(0, radios.indexOf(document.activeElement as HTMLElement));
    radios[(at + step + n) % n]!.focus();
  };
  const taken = goes?.places.some((p) => p.value === goes.value);
  return (
    <Menu open={open} onClose={onClose} anchor={anchor} label={label} kind="card">
      <div className="oh-contactcard-head">
        <Avatar name={person.name} address={person.address} size="l" />
        <span className="oh-contactcard-who">
          <b className="oh-display oh-contactcard-name">{person.name}</b>
          <span className="oh-contactcard-address">{person.address}</span>
        </span>
        {copy ? <Button kind="quiet" size="s" icon="copy" label={copy.label} onPress={copy.onPress} /> : null}
      </div>
      {scope ? (
        <RadioLines
          label={scope.label}
          options={scope.options}
          value={scope.value}
          onChange={scope.onChange}
        />
      ) : null}
      {now ? (
        <p className="oh-text oh-contactcard-now">
          <span className="oh-contactcard-line">{marked(now.line, now.place)}</span>
          {now.all ? (
            <Button kind="quiet" size="s" onPress={now.all.onPress}>
              {now.all.label}
            </Button>
          ) : null}
        </p>
      ) : null}
      {goes ? (
        <>
          <h4 className="oh-text oh-contactcard-title">{goes.label}</h4>
          <div
            ref={group}
            className="oh-contactcard-places"
            role="radiogroup"
            aria-label={goes.label}
            onKeyDown={walk}
          >
            {goes.places.map((place, i) => {
              const checked = place.value === goes.value;
              return (
                <button
                  key={place.value}
                  type="button"
                  className="oh-control oh-contactcard-place"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked || (!taken && i === 0) ? 0 : -1}
                  onClick={() => goes.onChange?.(place.value)}
                >
                  {place.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {rules?.length ? (
        <div className="oh-contactcard-rules">
          {rules.map((rule, i) => (
            <p key={i} className="oh-text oh-contactcard-rule">
              <b className="oh-contactcard-mark">{rule.place}</b>
              <span className="oh-contactcard-about">{rule.note}</span>
            </p>
          ))}
        </div>
      ) : null}
      {switches?.map((line) => (
        <div key={line.label} className="oh-contactcard-row">
          <span aria-hidden="true">{line.label}</span>
          <Switch label={line.label} on={line.on} onChange={line.onChange} />
        </div>
      ))}
      {more}
      {children ? (
        <Fragment>
          <MenuRule />
          {children}
        </Fragment>
      ) : null}
    </Menu>
  );
}
