/**
 * AN ADDRESS AS A PLACE OF THE FRAME: no rail entry (a person's All mail opens it), its list, the reader's column
 * beside it, and its seat above both.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { AddressList } from "./AddressList.js";
import { AddressSeat } from "./Seat.js";

export const addressPlace: PlaceEntry = {
  id: "address",
  body: "address",
  rail: null,
  panes: { kind: "columns", List: AddressList, Reading: "reader", Above: AddressSeat, keepsOpen: true },
};
