import { Avatar } from "./Avatar.js";
import "./avatar.css";

export interface FacesProps {
  /** The people shown, in order. */
  people: readonly { name: string; address: string }[];
  /** How many more there are, as it is printed: "+2". */
  more?: string;
}

/** A few circles, overlapping: the people waiting at the door, the voices of a conversation. */
export function Faces({ people, more }: FacesProps) {
  if (!people.length) return null;
  return (
    <i className="oh-faces" aria-hidden="true">
      {people.map((p) => (
        <Avatar key={p.address} name={p.name} address={p.address} size="xs" />
      ))}
      {more ? <b className="oh-faces-more">{more}</b> : null}
    </i>
  );
}
