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
  /** What it opens, said to a screen reader, and whether that stands open. */
  opens?: "menu" | "dialog";
  expanded?: boolean;
  type?: "button" | "submit";
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/** A way to another place: a link to its address, drawn as the button, that works before any script runs. */
interface ButtonGoes {
  /** The address it goes to. */
  href: string;
  pressed?: never;
  disabled?: never;
  opens?: never;
  expanded?: never;
  type?: never;
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
  const { kind = "ink", size, mark, keyHint, keyShown, shortcut, icon, label, children } = props;
  const look = {
    className: "oh-control oh-button",
    "data-kind": kind,
    "data-size": size,
    "data-bare": children === undefined ? "" : undefined,
    "data-mark": mark ? "" : undefined,
    "aria-label": label,
    title: label,
    "aria-keyshortcuts": shortcut,
  };
  const inside = (
    <>
      {icon ? <Icon name={icon} size={20} /> : null}
      {children === undefined ? null : <span>{children}</span>}
      {mark ? <Icon name={mark} size={16} className="oh-button-mark" /> : null}
      {keyHint ? <KeyHint shown={keyShown}>{keyHint}</KeyHint> : null}
    </>
  );
  if (props.href !== undefined) {
    return (
      <a ref={props.ref} href={props.href} {...look}>
        {inside}
      </a>
    );
  }
  const { pressed, disabled, opens, expanded, type = "button", onPress, ref } = props;
  return (
    <button
      ref={ref}
      type={type}
      {...look}
      aria-pressed={pressed}
      aria-haspopup={opens}
      aria-expanded={opens ? (expanded ?? false) : undefined}
      disabled={disabled}
      onClick={onPress}
    >
      {inside}
    </button>
  );
}
