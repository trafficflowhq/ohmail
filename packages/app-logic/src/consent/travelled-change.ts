/** `change` on the Screening pane's read — see `readProfileChange` on the server. */
export interface TravelledChangeWire {
  state: "asked" | "applied" | "refused";
  holder: string | null;
  refusal: "unreadable" | "other" | null;
}
