import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { KeyHint } from "../../base/index.js";
import { tagDot } from "../../base/Primitives/hue.js";
import { cssPoint } from "../../base/ui-zoom.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import { animate, motionShape } from "../../motion/motion.js";
import "./rail-entry.css";

export interface RailEntryProps {
  /**
   * `place`: a place of the app. `sub`: a smaller entry under a line (a tag, a folder).
   * `fold`: a line that shuts and opens what is under it. `tool`: a quiet act at the rail's foot.
   */
  kind: "place" | "sub" | "fold" | "tool";
  /** Its name. */
  children: string;
  /** Its sign. A `fold` draws its chevron instead. */
  icon?: IconName;
  /**
   * A host's own sign, where the design's icons hold none for its place: a drawing of 20 by 20 on the icons'
   * grid in the entry's ink (`currentColor`). It stands in the icon's place and is not said.
   */
  sign?: ReactNode;
  /** A tag's dot in place of an icon: the tag's hue on the ring, in degrees. */
  hue?: number;
  /** How many are unread or waiting there. Zero is no count at all. */
  count?: string;
  /** Somebody is waiting: the face that marks such a count draws it hot. */
  countHot?: boolean;
  /** The keys that go there, as they are printed: drawn for the eye, never said with the entry's name. */
  keyHint?: string;
  /** The keys that go there in `aria-keyshortcuts`' own spelling ("/"): said to a screen reader, never drawn. */
  shortcut?: string;
  /** Key hints are switched on: the key is drawn. */
  keyShown?: boolean;
  /** The key also stands at rest in the face that prints keys on its controls. */
  keyStands?: boolean;
  /**
   * Its digit. Handed in while the keys are in the rail: it stands in place of the key, and is said to a screen
   * reader as a key that goes there, beside `shortcut`.
   */
  digit?: string;
  /** The place you are in. */
  current?: boolean;
  /** A line that shuts and opens what is under it: whether that is open. A `fold` always has it; a `sub` may. */
  expanded?: boolean;
  /**
   * What a line that folds says while it is open and nothing is under it ("No tags yet."): a quiet line under
   * the entry that is read, never pressed, and no stop for the keys.
   */
  none?: string;
  /** A `tool` that is working: its sign turns once. */
  busy?: boolean;
  /** How deep a folder lies under its line. */
  depth?: number;
  /** Quieter: a line that adds something ("New tag"). */
  quiet?: boolean;
  /** The keys are on it. */
  cursor?: boolean;
  /** A row is being dragged and this place takes it; `over` while the pointer is on it. */
  drop?: "ready" | "over";
  /**
   * A small word after the name that tells two of one name apart: the folder above it, its mailbox, a find
   * hit's way. It is drawn, and belongs in `label` where the entry is named for a screen reader.
   */
  hint?: string;
  /** Its name for a screen reader where the count belongs to it: "News, 5". */
  label?: string;
  /** The whole name, where the entry may cut it. */
  title?: string;
  onPress?: () => void;
  /** A right click, or the key that opens the context menu: the entry's own menu, where the pointer is. */
  onMenu?: (at: { x: number; y: number }) => void;
}

/** One place: its sign, its name, its count. */
export function RailEntry(props: RailEntryProps) {
  const { kind, children, icon, sign, hue, count, keyHint, digit, current, expanded, depth, onPress } = props;
  const counted = useRef<HTMLSpanElement>(null);
  const before = useRef(count);

  /* A count that changed ticks once. */
  useLayoutEffect(() => {
    const el = counted.current;
    if (el && before.current !== undefined && count !== undefined && before.current !== count) {
      const up = motionShape(el, "--x-settle");
      animate(el, "tick", {
        ease: "--e-out",
        keyframes: [{ transform: "scale(1)" }, { transform: up, offset: 0.4 }, { transform: "scale(1)" }],
      });
    }
    before.current = count;
  }, [count]);

  const style = {
    ...(hue === undefined ? {} : { "--oh-railentry-dot": tagDot(hue) }),
    ...(depth ? { "--oh-railentry-depth": depth } : {}),
  } as CSSProperties;
  const folds = kind === "fold" || expanded !== undefined;
  const { onMenu } = props;
  const menu = onMenu
    ? (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onMenu(cssPoint(event));
      }
    : undefined;

  const entry = (
    <button
      type="button"
      className="oh-railentry"
      data-kind={kind}
      data-quiet={props.quiet ? "" : undefined}
      data-cursor={props.cursor ? "" : undefined}
      data-drop={props.drop}
      aria-current={current ? "page" : undefined}
      aria-expanded={folds ? Boolean(expanded) : undefined}
      aria-busy={props.busy ? true : undefined}
      aria-label={props.label}
      aria-keyshortcuts={[props.shortcut, digit].filter(Boolean).join(" ") || undefined}
      title={props.title}
      style={style}
      onClick={onPress}
      onContextMenu={menu}
    >
      {folds ? (
        <span className="oh-railentry-chevron">
          <Icon name="down" size={16} />
        </span>
      ) : hue !== undefined ? (
        <i className="oh-railentry-dot" />
      ) : sign ? (
        <span className="oh-railentry-sign" aria-hidden="true">
          {sign}
        </span>
      ) : icon ? (
        <span className="oh-railentry-sign">
          <Icon name={icon} size={kind === "sub" ? 16 : 20} />
        </span>
      ) : null}
      <span className="oh-railentry-name">
        {children}
        {props.hint ? <small className="oh-railentry-hint">{props.hint}</small> : null}
      </span>
      {digit ? (
        <KeyHint shown unsaid>
          {digit}
        </KeyHint>
      ) : keyHint && (props.keyShown || props.keyStands) ? (
        <span className="oh-railentry-key" data-stands={props.keyShown ? undefined : ""}>
          <KeyHint shown unsaid>
            {keyHint}
          </KeyHint>
        </span>
      ) : null}
      {count ? (
        <span ref={counted} className="oh-railentry-count" data-hot={props.countHot ? "" : undefined}>
          {count}
        </span>
      ) : null}
    </button>
  );
  if (!(folds && expanded && props.none)) return entry;
  return (
    <>
      {entry}
      <p className="oh-text oh-railnote">{props.none}</p>
    </>
  );
}
