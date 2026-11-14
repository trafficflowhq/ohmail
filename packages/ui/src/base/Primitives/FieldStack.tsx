import type { ReactNode } from "react";
import "./field-stack.css";

export interface FieldStackProps {
  /** A form's fields, in the order they are filled: fields, pairs of them, a switch with its name. */
  children: ReactNode;
}

/**
 * A form's fields, one under the other at the design's step, no wider than a field is read at. It is placement and
 * nothing a screen reader hears: every field keeps its own label, and the form that holds the stack names itself.
 */
export function FieldStack({ children }: FieldStackProps) {
  return <div className="oh-fieldstack">{children}</div>;
}

export interface FieldPairProps {
  /** Two fields that are read as one: the long one, then the short one that belongs to it (a server, its port). */
  children: ReactNode;
}

/** A field with a short one beside it on the same line: a server's name and its port. */
export function FieldPair({ children }: FieldPairProps) {
  return <div className="oh-fieldpair">{children}</div>;
}
