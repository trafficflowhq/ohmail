import { useId, useLayoutEffect, useState } from "react";
import { Menu } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./blocked-images.css";

export interface BlockedImagesProps {
  /** What was kept out of the letter, in two words: "Tracker blocked", "Images blocked". */
  caption: string;
  /** The one sentence a press opens. */
  sentence: string;
  describe?: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** What was kept out of a letter, said as one chip in the message's head; the sentence only when asked. */
export function BlockedImages({ caption, sentence, describe, open, onOpen, onClose }: BlockedImagesProps) {
  const description = useId();
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!describe || !chip) return;
    const doc = chip.ownerDocument;
    // The description is addressable by the chip without becoming part of the reader’s body.
    const note = doc.createElement("span");
    note.id = description;
    note.setAttribute("role", "tooltip");
    note.hidden = true;
    note.textContent = sentence;
    doc.body.append(note);
    return () => note.remove();
  }, [chip, describe, description, sentence]);
  return (
    <>
      <button
        ref={setChip}
        type="button"
        className="oh-control oh-blocked"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={describe && chip ? description : undefined}
        onClick={onOpen}
      >
        <Icon name="shield" size={16} />
        <span>{caption}</span>
      </button>
      <Menu
        open={open && chip !== null}
        onClose={onClose}
        anchor={chip ?? undefined}
        label={caption}
        kind="card"
        right
      >
        <p className="oh-text oh-blocked-said" role="note">
          {sentence}
        </p>
      </Menu>
    </>
  );
}
