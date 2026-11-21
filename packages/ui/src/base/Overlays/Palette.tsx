import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { IconName } from "../../icons/Icon.js";
import { Empty } from "../Feedback/Empty.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import "./menu.css";
import { Overlay } from "./Overlay.js";
import "./palette.css";
import { PaletteRow } from "./PaletteRow.js";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  /** The keys that run it without the palette, each as it is printed: a chord is several. */
  keys?: readonly string[];
  disabled?: boolean;
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  /** Its name, and the name of the line you type on. */
  label: string;
  inputLabel: string;
  placeholder: string;
  /** What is typed. The app narrows the commands to it. */
  query: string;
  onQuery: (query: string) => void;
  commands: readonly PaletteCommand[];
  onRun: (id: string) => void;
  /** What stands there when nothing matches. */
  empty: string;
  /** The palette's own key, at the end of the line. Not on touch. */
  keyHint?: string;
  /** What the keys do, under the list: the keys and one word each. Not on touch. */
  foot?: readonly { keys: readonly string[]; label: string }[];
  /** A key the app answers while it stands open, as its own key that shuts it. True: taken. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
}

/**
 * Every command, on one line you type on. The arrows move through the list while the keys stay in
 * the line; Enter runs the one that is marked; Esc and a press beside it close it.
 */
export function Palette(props: PaletteProps) {
  const {
    open,
    onClose,
    label,
    inputLabel,
    placeholder,
    query,
    onQuery,
    commands,
    onRun,
    empty,
    keyHint,
    foot,
    onKey,
  } = props;
  const list = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const [marked, setMarked] = useState(0);
  const at = Math.max(0, Math.min(commands.length - 1, marked));
  useLayoutEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !row) return;
    /* The marked row is kept in sight; the list moves by no more than it must. */
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [at, commands]);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onKey?.(e)) return true;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (commands.length)
        setMarked((at + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
      return true;
    }
    if (e.key !== "Enter") return false;
    e.preventDefault();
    const command = commands[at];
    if (command && !command.disabled) onRun(command.id);
    return true;
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={label}
      className="oh-palette"
      scrimMotion="together"
      place="top"
      first={(box) => box.querySelector<HTMLElement>("input")}
      onKey={keys}
    >
      <div className="oh-palette-head">
        <input
          className="oh-control oh-display oh-palette-input"
          type="text"
          role="combobox"
          aria-label={inputLabel}
          aria-expanded="true"
          aria-controls={id}
          aria-activedescendant={commands.length ? `${id}-${at}` : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setMarked(0);
            onQuery(e.currentTarget.value);
          }}
        />
        {keyHint ? <KeyHint shown>{keyHint}</KeyHint> : null}
      </div>
      <div ref={list} id={id} className="oh-palette-list" role="listbox" aria-label={label}>
        {commands.length ? (
          commands.map((c, i) => (
            <PaletteRow key={c.id} id={`${id}-${i}`} command={c} marked={i === at} onRun={onRun} />
          ))
        ) : (
          <Empty label={empty} />
        )}
      </div>
      {foot?.length ? (
        <footer className="oh-palette-foot">
          {foot.map((f) => (
            <span key={f.label} className="oh-palette-hint">
              {f.keys.map((k) => (
                <KeyHint key={k} shown>
                  {k}
                </KeyHint>
              ))}
              {f.label}
            </span>
          ))}
        </footer>
      ) : null}
    </Overlay>
  );
}
