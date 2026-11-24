/** A subscription by address: one calendar file at an address a person typed, asked again from time to time and only ever read. */
export const provider = "ics" as const;
export { makeReader } from "./reader.js";
