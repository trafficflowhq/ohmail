import { Slot } from "../../base/index.js";
import "./list-tail.css";

export interface ListTailProps {
  /** What the line says: "Older mail". */
  children: string;
  /** The one word that can be pressed, and where it leads. */
  way: { label: string; onPress?: () => void };
}

/** The list's end: one quiet line that says where older mail is. */
export function ListTail({ children, way }: ListTailProps) {
  return (
    <p className="oh-text oh-listtail">
      {children} · <Slot onPress={way.onPress}>{way.label}</Slot>
    </p>
  );
}
