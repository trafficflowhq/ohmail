import type { ReactNode } from "react";
import { Tag } from "@ohmail/ui/base";
import { useDoorPlan } from "./DoorStage.js";
import "./line.css";

/** Where a line drawn by a door stands on a page of two columns: above the buttons, or after the material. */
export type LinePlace = "acts" | "after";

/**
 * THE LINE UNDER A PAGE'S SENTENCE, when it holds more than words: the small facts as tags, what matters heavy, what
 * explains it plain, each part on a row of its own where the reference breaks it. The kit's page takes words alone in
 * its line, so a door draws such a line itself where the page's line stands: in the material of a page of one
 * column; on a page whose material stands beside the sentence, above its buttons (`acts`), and after the material
 * where that page is one column on the phone (`after`).
 */
export function DoorLine({ children, place }: { children: ReactNode; place?: LinePlace }): ReactNode {
  return (
    <div className="way-line" data-place={place}>
      {children}
    </div>
  );
}

/**
 * Where a two-column page draws its line: above the buttons, beside the material, until the stage knows the page is
 * one column on the phone; then after the material, where the page's own line would stand.
 */
export function useLinePlace(): LinePlace {
  return useDoorPlan()?.device === "phone" ? "after" : "acts";
}

/** The part of the line that matters. */
export function Heavy({ children }: { children: string }): ReactNode {
  return <span className="way-heavy">{children}</span>;
}

/** The plain part that explains it. */
export function Note({ children }: { children: string }): ReactNode {
  return <span className="way-note">{children}</span>;
}

/** What follows starts a row of its own. */
export function Break(): ReactNode {
  return <i className="way-break" aria-hidden="true" />;
}

/** A small fact, or how long is left: a tag. A catalogue sentence drawn as a tag drops its closing full stop. */
export function Fact({ children }: { children: string }): ReactNode {
  return <Tag>{children.endsWith(".") ? children.slice(0, -1) : children}</Tag>;
}
