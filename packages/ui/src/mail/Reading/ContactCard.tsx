import { Fragment, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
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
  id?: string;
  onClose: () => void;
  /** The name that was pressed. Left out: the card comes up from the foot. */
  anchor?: MenuProps["anchor"];
  /** The card's name, said to a screen reader. */
  label: string;
  onKey?: MenuProps["onKey"];
  closeWhenFull?: MenuProps["closeWhenFull"];
  person: { name: string; address: string };
  /** The sender check, before the choices it informs. */
  notice?: ReactNode;
  copy?: { label: string; onPress?: () => void };
  /** Whose mail the card is about: this address, or everyone at the domain. */
  scope?: {
    label: string;
    options: readonly RadioLine<string>[];
    value: string;
    onChange?: (value: string) => void;
  };
  /** Where that mail is now, as one whole line; `place` is the word in it that is set in ink. */
  now?: {
    line: string;
    place: string;
    description?: string;
    all?: { label: string; ariaLabel?: string; onPress?: () => void };
  };
  /** Where their mail goes: the places, one of them taken. A press changes it at once. */
  goes?: {
    label: string;
    description?: string;
    focus?: string;
    places: readonly { value: string; label: string; warning?: boolean }[];
    value?: string;
    onChange?: (value: string) => void;
  };
  /** The rules that stand: the place, and what the rule is about. */
  rulesLabel?: string;
  rules?: readonly { place: string; note: string; detail?: string }[];
  switches?: readonly {
    label: string;
    ariaLabel?: string;
    description?: string;
    on: boolean;
    onChange?: (on: boolean) => void;
  }[];
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
  const {
    open,
    id,
    onClose,
    anchor,
    label,
    onKey,
    closeWhenFull,
    person,
    notice,
    copy,
    scope,
    now,
    goes,
    rules,
    rulesLabel,
    switches,
    more,
    children,
  } = props;
  const destination = useRef<HTMLButtonElement>(null);
  return (
    <Menu
      open={open}
      id={id}
      modal={goes !== undefined || closeWhenFull !== undefined}
      onClose={onClose}
      anchor={anchor}
      label={label}
      kind="card"
      onKey={onKey}
      fit="whole"
      initialFocus={goes?.focus === undefined ? undefined : destination}
      closeWhenFull={closeWhenFull}
    >
      <ContactCardHeader
        title={person.name}
        note={person.address}
        lead={<Avatar name={person.name} address={person.address} size="l" />}
        action={
          copy ? <Button kind="quiet" size="s" icon="copy" label={copy.label} onPress={copy.onPress} /> : null
        }
      />
      {notice}
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
          <span className="oh-contactcard-line" title={now.description} aria-description={now.description}>
            {marked(now.line, now.place)}
          </span>
          {now.all ? (
            <Button kind="quiet" size="s" label={now.all.ariaLabel} onPress={now.all.onPress}>
              {now.all.label}
            </Button>
          ) : null}
        </p>
      ) : null}
      {goes ? <ContactDestinations goes={goes} destination={destination} /> : null}
      {rules?.length ? (
        <div className="oh-contactcard-rules" role={rulesLabel ? "group" : undefined} aria-label={rulesLabel}>
          {rules.map((rule, i) => (
            <p key={i} className="oh-text oh-contactcard-rule">
              <b className="oh-contactcard-mark">{rule.place}</b>
              <span className="oh-contactcard-about" title={rule.note}>
                {rule.note}
              </span>
              {rule.detail ? <small>{rule.detail}</small> : null}
            </p>
          ))}
        </div>
      ) : null}
      {switches?.map((line) => (
        <label key={line.label} className="oh-contactcard-row">
          <span aria-hidden="true">{line.label}</span>
          <Switch
            label={line.ariaLabel ?? line.label}
            on={line.on}
            onChange={line.onChange}
            description={line.description}
          />
        </label>
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

/** The same title and secondary line in a contact card or one of its pages. */
export function ContactCardHeader({
  title,
  note,
  lead,
  action,
  heading,
}: {
  title: string;
  note: string;
  lead: ReactNode;
  action?: ReactNode;
  heading?: boolean;
}) {
  const Title = heading ? "h3" : "b";
  return (
    <div className="oh-contactcard-head">
      {lead}
      <div className="oh-contactcard-who">
        <Title className="oh-text oh-display oh-contactcard-name">{title}</Title>
        <span className="oh-contactcard-address">{note}</span>
      </div>
      {action}
    </div>
  );
}

export function ContactDestinations({
  goes,
  destination,
  note,
}: {
  goes: NonNullable<ContactCardProps["goes"]>;
  destination?: RefObject<HTMLButtonElement | null>;
  note?: string;
}) {
  const group = useRef<HTMLDivElement | null>(null);
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
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
    radios[(at + step + n) % n]!.focus({ preventScroll: true });
  };
  const taken = goes.places.some((p) => p.value === goes.value);
  return (
    <>
      <h4 className="oh-text oh-contactcard-title">
        {goes.label}
        {note ? <span role="status">{note}</span> : null}
      </h4>
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
              ref={place.value === goes.focus ? destination : undefined}
              className="oh-control oh-contactcard-place"
              role="radio"
              aria-checked={checked}
              aria-description={goes.description}
              title={goes.description}
              tabIndex={checked || (!taken && i === 0) ? 0 : -1}
              onClick={() => goes.onChange?.(place.value)}
            >
              {place.label}
              {place.warning ? <span aria-hidden="true"> ↗</span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
