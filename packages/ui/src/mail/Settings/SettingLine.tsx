import { useId, type MouseEvent, type ReactNode } from "react";
import { Switch, Tag } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import { SettingNote } from "./SettingNote.js";
import "./setting-line.css";

export interface SettingLineProps {
  /** The setting's name: the line is a group of that name. With a switch it is the switch's name too. */
  label: string;
  /** The id of a native form control that takes focus when its label is pressed. */
  htmlFor?: string;
  /** A sign before the name. */
  icon?: IconName;
  /** What leads the name instead of a sign: a mailbox's circle. */
  lead?: ReactNode;
  /** A word after the name: "This device". */
  tag?: string;
  /** The (i) after a word that needs saying once. */
  info?: ReactNode;
  /** Explanatory copy that sits beneath the line. */
  description?: string;
  /** The id of a note that describes this setting. */
  describedBy?: string;
  /** The setting's value as text, at the right. */
  value?: string;
  /** Expose the value in the accessibility tree without announcing each update. */
  valueStatus?: boolean;
  /** A figure that ends the line, after its value: a plan's price. */
  figure?: string;
  /** On or off, at once: the line draws its switch, and a press anywhere on the line turns it. */
  toggle?: { on: boolean; onChange?: (on: boolean) => void };
  /** A press anywhere on the line beside its control: what the control does (a slot opens its menu). */
  onPress?: () => void;
  /** Use the visible label as the button for a line whose primary action is `onPress`. */
  activateLabel?: boolean;
  /** Nothing on it can be changed now: its switch is disabled, a press on the line does nothing, the line is dimmed. A control handed in is disabled by its owner. */
  off?: boolean;
  /** It hangs on the line above it: set in. */
  sub?: boolean;
  /**
   * Under a finger, where the line is narrow. `under`: the control goes under the name. `detail`: the
   * name and the word that acts keep one line, the value goes under the name.
   */
  narrow?: "under" | "detail";
  /** The control, after the value: a segmented control, a slot, a word that acts. */
  children?: ReactNode;
}

/** What keeps its own press: a control, a field's label, and a card or menu the line holds (it opens in place). */
const CONTROL = "button, a, input, select, textarea, label, .oh-over";

/**
 * A setting: its name at the left, its value and its one control at the right. No rule between lines; the line's
 * height is the rhythm. To a screen reader it is a group named by its label alone.
 */
export function SettingLine(props: SettingLineProps) {
  const {
    label,
    htmlFor,
    icon,
    lead,
    tag,
    info,
    description,
    describedBy,
    value,
    valueStatus,
    figure,
    toggle,
    onPress,
    activateLabel,
    off,
    sub,
    narrow,
    children,
  } = props;
  const labelId = useId();
  const descriptionId = description ? `${labelId}-description` : undefined;
  const notes = [describedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const labelPress = activateLabel && !toggle ? onPress : undefined;
  const pressable = Boolean(toggle || onPress);
  const press = pressable
    ? (event: MouseEvent<HTMLDivElement>) => {
        if (off) return;
        const hit = (event.target as Element).closest(CONTROL);
        if (hit && event.currentTarget.contains(hit)) return;
        if (toggle) toggle.onChange?.(!toggle.on);
        else onPress?.();
      }
    : undefined;
  const row = (
    <div
      className="oh-settingline"
      role="group"
      aria-labelledby={labelId}
      aria-describedby={notes}
      data-press={pressable ? "" : undefined}
      data-switch={toggle ? "" : undefined}
      data-off={off ? "" : undefined}
      data-sub={sub ? "" : undefined}
      data-narrow={narrow}
      onClick={press}
    >
      <span className="oh-settingline-name">
        {lead}
        {icon ? <Icon name={icon} size={20} /> : null}
        {labelPress ? (
          <button
            type="button"
            className="oh-settingline-label"
            id={labelId}
            disabled={off}
            onClick={labelPress}
          >
            {label}
          </button>
        ) : htmlFor ? (
          <label className="oh-settingline-label" id={labelId} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="oh-settingline-label" id={labelId}>
            {label}
          </span>
        )}
        {tag ? <Tag>{tag}</Tag> : null}
        {info}
      </span>
      <span className="oh-settingline-value">
        {value ? (
          <span
            className="oh-settingline-text"
            role={valueStatus ? "status" : undefined}
            aria-live={valueStatus ? "off" : undefined}
          >
            {value}
          </span>
        ) : null}
        {figure ? <b className="oh-settingline-figure">{figure}</b> : null}
        {children}
        {toggle ? <Switch label={label} on={toggle.on} onChange={toggle.onChange} disabled={off} /> : null}
      </span>
    </div>
  );
  return description ? (
    <>
      {row}
      <SettingNote id={descriptionId}>{description}</SettingNote>
    </>
  ) : (
    row
  );
}
