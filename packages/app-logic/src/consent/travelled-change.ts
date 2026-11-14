/** `change` on the Screening pane's read — see `readProfileChange` on the server. */
export interface TravelledChangeWire {
  state: "asked" | "applied" | "refused";
  holder: string | null;
  refusal: "unreadable" | "other" | null;
}

export type TravelledNote =
  | { kind: "asked" }
  | { kind: "applied" }
  | { kind: "refused"; holder: string | null; refusal: "unreadable" | "other" | null };

export function noteOf(change: TravelledChangeWire | undefined): TravelledNote | null {
  if (!change) return null;
  if (change.state === "asked") return { kind: "asked" };
  if (change.state === "applied") return { kind: "applied" };
  return { kind: "refused", holder: change.holder, refusal: change.refusal };
}

export function standingNote(change: TravelledChangeWire | null | undefined): TravelledNote | null {
  const note = noteOf(change ?? undefined);
  return note?.kind === "applied" ? null : note;
}
