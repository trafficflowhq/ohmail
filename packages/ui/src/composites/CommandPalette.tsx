import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Kbd } from "../primitives/Kbd.js";
import { TextField } from "../primitives/TextField.js";
import "./palette.css";

export interface Command {
  id: string;
  label: string;
  /** Key sequence hints shown right-aligned. */
  keys?: string[];
  icon?: IconName;
  /**
   * This command has nothing to act on right now — shown, dimmed, inert.
   * The same word the keyboard registry uses (`keymap.tsx`'s `disabled`)
   * and the same treatment the `?` sheet gives one: the row stays listed
   * so the command remains discoverable, and says it cannot act instead
   * of running to no effect. Listing rather than hiding — a palette whose
   * contents change with the cursor cannot be learned. Enter and click do
   * nothing, not even close the sheet: closing would read as "that worked".
   */
  disabled?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /**
   * EVERY WORD, FROM THE HOST — none of these default any more.
   *
   * They used to: `placeholder`, `emptyHint` and `ariaLabel` carried English defaults, and the
   * three foot hints ("navigate", "run", "close") were literals in the markup. The webapp passed
   * the first two and not the third, so a German palette announced itself as "Command palette"
   * and footed itself in English. A composite has no catalogue; a default in one is an English
   * string nobody can see is wrong until they read the app in another language.
   */
  placeholder: string;
  emptyHint: ReactNode;
  ariaLabel: string;
  /** The foot: the word beside ↑↓, beside ↵, and beside esc. */
  footNavigate: string;
  footRun: string;
  footClose: string;
}

/**
 * The ⌘K palette: filter, arrow-key navigation, Enter runs, Escape and
 * scrim close. Pair with useCommandPalette() for the global binding.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder,
  emptyHint,
  ariaLabel,
  footNavigate,
  footRun,
  footClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const items = commands.filter((c) => c.label.toLowerCase().includes(q));
  const selIdx = Math.min(sel, Math.max(0, items.length - 1));

  const run = (c: Command) => {
    /* Before `onClose()`, deliberately: a disabled row that closed the palette would look
       exactly like one that had acted. */
    if (c.disabled) return;
    onClose();
    c.run();
  };

  return (
    <>
      <div className="pal-bg" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <TextField
          ref={inputRef}
          shape="line"
          type="text"
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(Math.min(selIdx + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(Math.max(selIdx - 1, 0));
            } else if (e.key === "Enter" && items[selIdx]) {
              run(items[selIdx]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="pal-list" role="listbox">
          {items.length ? (
            items.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === selIdx}
                aria-disabled={c.disabled ? true : undefined}
                className={[i === selIdx ? "sel" : "", c.disabled ? "off" : ""]
                  .filter(Boolean)
                  .join(" ") || undefined}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(c)}
              >
                <Icon name={c.icon ?? "spark"} size={13} />
                {c.label}
                <span className="keys">
                  {c.keys?.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))
          ) : (
            <li className="none">{emptyHint}</li>
          )}
        </ul>
        <div className="pal-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {footNavigate}
          </span>
          <span>
            <Kbd>↵</Kbd> {footRun}
          </span>
          <span>
            <Kbd>esc</Kbd> {footClose}
          </span>
        </div>
      </div>
    </>
  );
}
