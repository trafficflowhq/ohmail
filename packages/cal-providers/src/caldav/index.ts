/** CalDAV, read and written: any server that keeps the standards, found from an address, a user and a password. */
export const provider = "caldav" as const;
export { caldavSession, makeReader } from "./reader.js";
export { makeWriter } from "./writer.js";
export { hostsBeside } from "./hosts.js";
