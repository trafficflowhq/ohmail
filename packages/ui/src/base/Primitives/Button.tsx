import type { MouseEventHandler, Ref } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./button.css";
import { KeyHint } from "./KeyHint.js";

interface ButtonCommon {
  /** `ink`: the one capsule of a view. `two`: a second button. `quiet`: a word that acts. */
  kind?: "ink" | "two" | "quiet";
  /** `s` small, `l` a decision. Left out: the button's own height. */
  size?: "s" | "l";
  /** The key that runs it, as it is printed. */
  keyHint?: string;
  /** Show the key whatever the face says. */
  keyShown?: boolean;
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

/** A button says a word, or it shows an icon alone and then carries its name. */
export type ButtonProps = ButtonCommon &
  (
    | { children: string; icon?: IconName; label?: string }
    | { icon: IconName; label: string; children?: never }
  );

/** An ink capsule, a second button, or a word that acts. */
export function Button({
  kind = "ink",
  size,
  keyHint,
  keyShown,
  pressed,
  disabled,
  opens,
  expanded,
  type = "button",
  onPress,
  ref,
  icon,
  label,
  children,
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className="oh-control oh-button"
      data-kind={kind}
      data-size={size}
      data-bare={children === undefined ? "" : undefined}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-haspopup={opens}
      aria-expanded={opens ? (expanded ?? false) : undefined}
      disabled={disabled}
      onClick={onPress}
    >
      {icon ? <Icon name={icon} size={20} /> : null}
      {children === undefined ? null : <span>{children}</span>}
      {keyHint ? <KeyHint shown={keyShown}>{keyHint}</KeyHint> : null}
    </button>
  );
}
