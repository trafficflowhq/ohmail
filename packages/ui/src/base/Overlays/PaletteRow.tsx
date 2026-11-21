import { Icon } from "../../icons/Icon.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import "./menu.css";
import type { PaletteCommand } from "./Palette.js";
import "./palette.css";

export interface PaletteRowProps {
  id: string;
  command: PaletteCommand;
  /** The one Enter runs. */
  marked: boolean;
  onRun: (id: string) => void;
}

/** One command of the palette: a menu's line that is an option of the list. The keys stay in the line you type on. */
export function PaletteRow({ id, command, marked, onRun }: PaletteRowProps) {
  return (
    <button
      id={id}
      type="button"
      className="oh-control oh-menu-item"
      role="option"
      aria-selected={marked}
      disabled={command.disabled}
      tabIndex={-1}
      onClick={() => onRun(command.id)}
    >
      <Icon name={command.icon} size={20} />
      <span className="oh-menu-word">{command.label}</span>
      {command.keys?.length ? (
        <span className="oh-palette-keys">
          {command.keys.map((k) => (
            <KeyHint key={k} shown unsaid>
              {k}
            </KeyHint>
          ))}
        </span>
      ) : null}
    </button>
  );
}
