/**
 * AN ADDRESS AS A PLACE OF THE FRAME: no rail entry (the contact card's All mail opens it), its list, and the reader's
 * column beside it. Registered and held by its tests; a host hands it over at its seating.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { AddressList } from "./AddressList.js";

export const addressPlace: PlaceEntry = {
  id: "address",
  body: "address",
  rail: null,
  panes: { kind: "columns", List: AddressList, Reading: "reader" },
};
