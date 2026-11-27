import { useState } from "react";
import { Menu } from "@ohmail/ui/base";
import { COMPOSE_EMOJI } from "@ohmail/app-logic/write/emoji";
import { useText } from "../../text/index.js";
import "./emoji.css";
import type { EditorHandle } from "../ports.js";

/** Both editors insert through their existing caret and undo path. */
export function useEmoji(handle: EditorHandle | null, locked: boolean) {
  const label = useText("write")("marks.emoji");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null && handle !== null && !locked;
  const close = () => setAnchor(null);
  return {
    control: {
      label,
      disabled: locked,
      expanded: open,
      onPress: (at: HTMLElement) => {
        if (!locked && handle !== null) setAnchor(at);
      },
    },
    menu: open ? (
      <Menu open portal label={label} title={label} anchor={anchor} onClose={close} up>
        <div className="write-emoji-grid" role="group" aria-label={label}>
          {COMPOSE_EMOJI.map(([emoji, name]) => (
            <button
              className="write-emoji-button"
              type="button"
              key={name}
              aria-label={name.replace(/_/g, " ")}
              title={`:${name}:`}
              onClick={() => {
                close();
                handle.focus({ preventScroll: true });
                handle.insert({ text: emoji, html: "" }, "atCaret");
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Menu>
    ) : null,
  };
}
