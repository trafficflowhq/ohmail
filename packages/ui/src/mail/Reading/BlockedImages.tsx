import { useRef } from "react";
import { Menu } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./blocked-images.css";

export interface BlockedImagesProps {
  /** What was kept out of the letter, in two words: "Tracker blocked", "Images blocked". */
  caption: string;
  /** The one sentence a press opens. */
  sentence: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** What was kept out of a letter, said as one chip in the message's head; the sentence only when asked. */
export function BlockedImages({ caption, sentence, open, onOpen, onClose }: BlockedImagesProps) {
  const chip = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={chip}
        type="button"
        className="oh-control oh-blocked"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      >
        <Icon name="shield" size={16} />
        <span>{caption}</span>
      </button>
      <Menu open={open} onClose={onClose} anchor={chip} label={caption} kind="card" right>
        <p className="oh-text oh-blocked-said" role="note">
          {sentence}
        </p>
      </Menu>
    </>
  );
}
