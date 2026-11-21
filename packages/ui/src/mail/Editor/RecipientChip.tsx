import type { KeyboardEventHandler, PointerEventHandler } from "react";
import { Avatar, Button } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./recipients.css";

export interface RecipientPerson {
  id: string;
  name: string;
  /** Left out where the name is all there is: an address typed by hand. */
  address?: string;
  /** The displayed name or address, where the wire form needs decoding or shortening. */
  display?: { name: string; address?: string; accessible: string };
  /** Refused: it stays on its line, marked. Never dropped silently. */
  refused?: boolean;
  /** The way off, said with the name: "Remove Ben Arnold". */
  remove: string;
}

export interface RecipientChipProps {
  person: RecipientPerson;
  locked?: boolean;
  /** The line that says what was refused: a refused person is described by it. */
  said?: string;
  /** It was lifted: its own place gives way while it follows the pointer. */
  lifted?: boolean;
  onPress?: (anchor: HTMLElement) => void;
  onRemove?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}

/** A person on a line: the circle, the name, the address, and a way off. */
export function RecipientChip(props: RecipientChipProps) {
  const { person, locked, said, lifted, onPress, onRemove, onKeyDown, onPointerDown } = props;
  const { name, address } = person.display ?? person;
  return (
    <span
      className="oh-recipients-person"
      data-refused={person.refused ? "" : undefined}
      data-lifted={lifted ? "" : undefined}
    >
      <button
        type="button"
        className="oh-control oh-recipients-who"
        data-person={person.id}
        aria-haspopup="menu"
        aria-label={person.display?.accessible}
        aria-invalid={person.refused || undefined}
        aria-describedby={person.refused ? said : undefined}
        disabled={locked}
        onClick={(event) => onPress?.(event.currentTarget)}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        {person.refused ? (
          <Icon name="warn" size={18} />
        ) : (
          <Avatar name={person.name} address={person.address ?? person.name} size="xs" />
        )}
        <b className="oh-recipients-name">{name}</b>
        {address && address !== name ? <span className="oh-recipients-address">{address}</span> : null}
      </button>
      {locked ? null : (
        <span className="oh-recipients-off">
          <Button kind="quiet" size="s" icon="x" label={person.remove} onPress={onRemove} />
        </span>
      )}
    </span>
  );
}
