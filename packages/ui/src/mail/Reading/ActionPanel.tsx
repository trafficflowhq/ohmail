import { useLayoutEffect, useRef } from "react";
import { KeyHint } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./action-panel.css";
import { fitPanel } from "./fit-panel.js";

/** One verb of the panel. */
export interface PanelVerb {
  /** Its name in what the panel hands back: a press, and what folded. */
  id: string;
  label: string;
  /**
   * Its name where the sentence says more than the word drawn (the read slot over a conversation: "Mark 2 unread
   * messages as read" beside "Mark read"): what a screen reader says and the pointer's hint reads. Left out: `label`.
   */
  name?: string;
  icon?: IconName;
  /** The key that runs it, as it is printed: in the pointer's hint, and on the verb where key hints are shown. */
  keyHint?: string;
  /** The active binding in aria-keyshortcuts syntax. */
  shortcut?: string;
  /** `ink`: the one capsule of the view. `soft`: one of several answers of one weight. Left out: a word that acts. */
  kind?: "ink" | "soft";
  /** 0 never folds. Otherwise the highest folds behind More first, of equals the later one. Left out: 9. */
  rank?: number;
  /** A verb of the floor: the order in which it gives up its word once nothing is left to fold. */
  wordOrder?: number;
  /** It gives up its word before anything folds. */
  wordFirst?: boolean;
  /** Verbs of one segment stand together; a new segment stands a little apart. */
  segment?: string;
  /** It stands apart whatever its segment: the read slot. */
  apart?: boolean;
  /** A toggle: whether it holds. */
  pressed?: boolean;
  disabled?: boolean;
  /**
   * It rests and still takes a press, which says why it does nothing (Send over a letter too long to send): drawn as
   * a verb that is off, said as one (`aria-disabled`), its press handed on. `disabled` wins over it.
   */
  resting?: boolean;
  /**
   * Refused for now, and why, in a sentence (Send with nothing written: "Write something or attach a file."): drawn and
   * said as `resting`, the sentence its pointer's hint, its press handed on so that it can say the sentence where the
   * person looks. `disabled` wins over it.
   */
  refused?: string;
  /** At work after its press (Send while the letter goes): said busy. */
  busy?: boolean;
  /** The widest label this slot ever shows, so that the panel keeps its width when the label changes. */
  widest?: string;
  /** A count that leads and stays when its word goes: "3", then "selected". The label is the two as one name. */
  counted?: { count: string; word: string };
  /** Its sign is the unread mark: the face that colours that mark draws the icon hot. */
  hotIcon?: boolean;
  /** A press: with the verb's own button, where a menu it opens stands. */
  onPress?: (at: HTMLElement) => void;
}

/** A label in the panel that is no button: "2 of 5". */
export interface PanelNote {
  note: string;
  /** It never folds: what it says is the thing to read. */
  keep?: boolean;
}

export interface ActionPanelProps {
  /** The toolbar's name. */
  label: string;
  items: readonly (PanelVerb | PanelNote)[];
  /**
   * What stands behind the panel. It is drawn only while something is behind it or something folded. It says
   * whether its menu stands open, as every control that opens one: shut where `expanded` is not handed.
   */
  more?: { label: string; behind: boolean; expanded?: boolean; onPress?: (at: HTMLElement) => void };
  /** Key hints are switched on. */
  keysShown?: boolean;
  /** How it stands before it has measured its room: the verbs that are folded, and those that show their icon alone. */
  folded?: readonly string[];
  short?: readonly string[];
  /** The verbs that did not fit, whenever that changes: the app offers them behind More. */
  onFold?: (ids: readonly string[]) => void;
}

const isNote = (item: PanelVerb | PanelNote): item is PanelNote => "note" in item;

/**
 * The verbs of what is open, in one panel at the foot of its column. It never wraps and never clips:
 * short of room, verbs fold behind More by rank, then the floor gives up its words.
 */
export function ActionPanel({ label, items, more, keysShown, folded, short, onFold }: ActionPanelProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const told = useRef("");
  const tell = useRef(onFold);
  tell.current = onFold;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const ids = fitPanel(el);
      if (ids.join("\n") === told.current) return;
      told.current = ids.join("\n");
      tell.current?.(ids);
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [items, more?.behind, keysShown]);

  let segment = "";
  const anyFolded = Boolean(folded?.length);
  return (
    <div ref={wrap} className="oh-actionpanel">
      <div className="oh-actionpanel-bar" role="toolbar" aria-label={label}>
        {items.map((item, index) => {
          if (isNote(item)) {
            return (
              <span
                key={`note-${index}`}
                className="oh-actionpanel-note"
                data-note=""
                data-keep={item.keep ? "" : undefined}
              >
                {item.note}
              </span>
            );
          }
          const apart = (index > 0 && (item.segment ?? "") !== segment) || item.apart;
          segment = item.segment ?? "";
          return (
            <Verb
              key={item.id}
              verb={item}
              apart={Boolean(apart)}
              keysShown={keysShown}
              folded={folded?.includes(item.id)}
              short={short?.includes(item.id)}
            />
          );
        })}
        {more ? (
          <button
            type="button"
            className="oh-control oh-actionpanel-verb"
            data-more=""
            data-behind={more.behind ? "" : undefined}
            data-apart={segment ? "" : undefined}
            hidden={!more.behind && !anyFolded}
            aria-label={more.label}
            title={more.label}
            aria-haspopup="menu"
            aria-expanded={more.expanded ?? false}
            onClick={(event) => more.onPress?.(event.currentTarget)}
          >
            <Icon name="more" size={20} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface VerbProps {
  verb: PanelVerb;
  apart: boolean;
  keysShown?: boolean;
  folded?: boolean;
  short?: boolean;
}

function Verb({ verb, apart, keysShown, folded, short }: VerbProps) {
  return (
    <button
      type="button"
      className="oh-control oh-actionpanel-verb"
      data-id={verb.id}
      data-kind={verb.kind}
      data-rank={verb.rank ?? 9}
      data-word-order={verb.wordOrder}
      data-word-first={verb.wordFirst ? "" : undefined}
      data-segment={verb.segment}
      data-apart={apart ? "" : undefined}
      data-signed={verb.icon ? "" : undefined}
      data-counted={verb.counted ? "" : undefined}
      data-hot-icon={verb.hotIcon ? "" : undefined}
      data-short={short ? "" : undefined}
      hidden={folded}
      aria-label={verb.name ?? verb.label}
      aria-keyshortcuts={verb.shortcut}
      title={
        verb.refused !== undefined && !verb.disabled
          ? verb.refused
          : verb.keyHint
            ? `${verb.name ?? verb.label} · ${verb.keyHint}`
            : (verb.name ?? verb.label)
      }
      aria-pressed={verb.pressed}
      disabled={verb.disabled}
      aria-disabled={(verb.resting || verb.refused !== undefined) && !verb.disabled ? true : undefined}
      aria-busy={verb.busy || undefined}
      onClick={(event) => verb.onPress?.(event.currentTarget)}
    >
      {verb.icon ? <Icon name={verb.icon} size={20} /> : null}
      <span
        className="oh-actionpanel-label"
        data-wide={verb.widest ? "" : undefined}
        /* A count that leads is said, whole, when it changes: how many are picked. */
        aria-live={verb.counted ? "polite" : undefined}
        aria-atomic={verb.counted ? true : undefined}
      >
        {verb.counted ? <b className="oh-actionpanel-count">{verb.counted.count}</b> : null}
        {verb.counted ? (
          <span className="oh-actionpanel-word"> {verb.counted.word}</span>
        ) : verb.widest ? (
          <span>{verb.label}</span>
        ) : (
          verb.label
        )}
        {verb.widest ? (
          <i className="oh-actionpanel-widest" aria-hidden="true">
            {verb.widest}
          </i>
        ) : null}
      </span>
      {verb.keyHint ? <KeyHint shown={keysShown}>{verb.keyHint}</KeyHint> : null}
    </button>
  );
}
