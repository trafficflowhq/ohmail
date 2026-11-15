/** CalDAV, read: any server that keeps the standards, found from an address, a user and a password. */
export const provider = "caldav" as const;
export { makeReader } from "./reader.js";
export { credentialHostsFor } from "./hosts.js";
