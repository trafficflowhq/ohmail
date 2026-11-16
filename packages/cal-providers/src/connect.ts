/**
 * `@ohmail/cal-providers/connect`: what a door that takes a calendar's sign-in needs of this
 * package, and nothing that dials. The holder of a value that is never shown, the one text a
 * sign-in is sealed as (the text a pass opens again, and a door opens to read the server a
 * password typed again is sealed for), and the reading of a typed address by its shape. No reader,
 * no request port and no parser of a provider's answer is reachable from here, so a program that
 * only takes a sign-in carries none of them.
 */
export { Secret } from "./secret.js";
export {
  MAX_CREDENTIAL_CHARS,
  parseCredential,
  serializeCredential,
  type CredentialPlace,
  type StoredCredential,
} from "./credentials.js";
export { ICLOUD_CALDAV_START, readTypedAddress, type TypedAddressReading } from "./address.js";
export type { AddressPolicy, ShapeRefusal } from "./request/shape.js";
export { MAX_URL_CHARS } from "./limits.js";
