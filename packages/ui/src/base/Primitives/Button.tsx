import type { MouseEventHandler, Ref } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./button.css";
import { KeyHint } from "./KeyHint.js";

interface ButtonLook {
  /** `ink`: the one capsule of a view. `two`: a second button. `quiet`: a word that acts. */
  kind?: "ink" | "two" | "quiet";
  /** `s` small, `l` a decision. Left out: the button's own height. */
  size?: "s" | "l";
  /**
   * A mark after the word: the arrow of a control that opens a short menu, or the way off once what it opens
   * has been set. It is drawn, never said: the word and the control's state say what a press does.
   */
  mark?: IconName;
  /** The key that runs it, as it is printed. */
  keyHint?: string;
  title?: string;
  /** Show the key whatever the face says. */
  keyShown?: boolean;
  /** The key that runs it, in `aria-keyshortcuts`' own spelling ("c", "Shift+A"): said to a screen reader, never drawn. */
  shortcut?: string;
}

/** A button that runs something. */
interface ButtonRuns {
  href?: never;
  /** A toggle that is held. Left out: no toggle. */
  pressed?: boolean;
  /** Off. While it works, the app hands in the working label and sets this. */
  disabled?: boolean;
  /**
   * Under way after its own press: it stays where it is, takes no second press and says that it is busy. It is
   * off to a screen reader and to the eye, yet keeps the keys: a button the browser itself turns off can drop
   * the keys of the person who pressed it. A form's submit button stays its submit button while busy and sends
   * nothing: Enter in a field of the form reaches it and is cancelled there.
   */
  busy?: boolean;
  /** What it opens, said to a screen reader, and whether that stands open. */
  opens?: "menu" | "dialog";
  /** Whether what it opens stands open. Without `opens`: what it shows and hides in place, shown or not. */
  expanded?: boolean;
  /** The id of what it shows and hides in place: said to a screen reader as what the control acts on. */
  controls?: string;
  type?: "button" | "submit";
  /**
   * Whether Tab stops on it. False for a button of a group that holds one stop of Tab and moves the keys between
   * its buttons by the arrows. Left out: it is a stop.
   */
  stop?: boolean;
  outside?: never;
  onFollow?: never;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/** A way to another place: a link to its address, drawn as the button, that works before any script runs. */
interface ButtonGoes {
  /** The address it goes to. */
  href: string;
  /**
   * The address is another site's: it opens beside the app, and that site is told nothing of where the person came
   * from and is handed no way back into the app's window. It draws the design's sign for a way that leaves after
   * its word by itself (`go`), unless it is handed another `mark`.
   */
  outside?: boolean;
  /** Record that the person followed the link without taking over its navigation. */
  onFollow?: MouseEventHandler<HTMLAnchorElement>;
  pressed?: never;
  disabled?: never;
  busy?: never;
  opens?: never;
  expanded?: never;
  type?: never;
  stop?: never;
  onPress?: never;
  ref?: Ref<HTMLAnchorElement>;
}

/** A button says a word, or it shows an icon alone and then carries its name. */
export type ButtonProps = ButtonLook &
  (ButtonRuns | ButtonGoes) &
  (
    | { children: string; icon?: IconName; label?: string }
    | { icon: IconName; label: string; children?: never }
  );

/** An ink capsule, a second button, or a word that acts; with an address, a link drawn the same. */
export function Button(props: ButtonProps) {
  const { kind = "ink", size, keyHint, keyShown, shortcut, icon, label, children } = props;
  const mark = props.mark ?? (props.href !== undefined && props.outside ? "go" : undefined);
  const look = {
    className: "oh-control oh-button",
    "data-kind": kind,
    "data-size": size,
    "data-bare": children === undefined ? "" : undefined,
    "data-mark": mark ? "" : undefined,
    "aria-label": label,
    title: props.title ?? label,
    "aria-keyshortcuts": shortcut,
  };
  const inside = (
    <>
      {icon ? <Icon name={icon} size={20} /> : null}
      {children === undefined ? null : <span>{children}</span>}
      {mark ? <Icon name={mark} size={16} className="oh-button-mark" /> : null}
      {keyHint ? (
        <KeyHint shown={keyShown} unsaid>
          {keyHint}
        </KeyHint>
      ) : null}
    </>
  );
  if (props.href !== undefined) {
    return (
      <a
        ref={props.ref}
        href={props.href}
        onClick={props.onFollow}
        target={props.outside ? "_blank" : undefined}
        rel={props.outside ? "noopener noreferrer" : undefined}
        {...look}
      >
        {inside}
      </a>
    );
  }
  const { pressed, disabled, busy, opens, expanded, type = "button", stop, onPress, ref } = props;
  return (
    <button
      ref={ref}
      type={type}
      {...look}
      aria-pressed={pressed}
      aria-haspopup={opens}
      aria-expanded={opens ? (expanded ?? false) : expanded}
      aria-controls={props.controls}
      aria-busy={busy ? true : undefined}
      aria-disabled={busy ? true : undefined}
      disabled={disabled}
      tabIndex={stop === false ? -1 : undefined}
      onClick={busy ? (event) => event.preventDefault() : onPress}
    >
      {inside}
    </button>
  );
}
