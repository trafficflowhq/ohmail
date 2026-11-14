import { addressHash } from "./routing";

export {
  ADDRESS_DIRECTIONS,
  DEFAULT_ADDRESS_DIRECTION,
  messagesWith,
  useAddressView,
  type AddressArchive,
  type AddressCounts,
  type AddressCoverage,
  type AddressDirection,
  type AddressHit,
  type AddressView,
} from "@ohmail/app-logic/address";

/**
 * The href for one address — every control that prints an address navigates through this. A
 * delegation to the router's own {@link addressHash}, deliberately not a second `encodeURIComponent`
 * call: the router owns the hash format, and three spellings that agree today can drift invisibly —
 * `normalizedHash` would rewrite the bar on every render of a link that was already right. The case
 * is not folded: matching is `lower()`-insensitive at both doors, and the address as the sender wrote
 * it is the one worth putting in a link somebody may read.
 */
export function addressHref(address: string): string {
  return addressHash(address);
}
