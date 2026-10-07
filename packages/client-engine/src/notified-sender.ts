import type { EmailAddress } from "./types.js";

/**
 * THE NAME A CARD OR A NOTIFICATION SHOWS FOR A SENDER, in one place: the display name, else the
 * address, and "(Not {brand})" beside it when the identity fact marks the sender — a single line
 * naming a company the address does not belong to never carries the claim alone. `not` is the
 * surface's own chip phrase, so the words stay in each surface's catalogue.
 */
export function notifiedSenderName(
  m: { from: EmailAddress; senderCheck?: { brand: string } | null; checked?: { brand: string } },
  not: (brand: string) => string,
): string {
  const name = m.from.name || m.from.address;
  const brand = m.senderCheck?.brand ?? m.checked?.brand;
  return brand ? `${name} (${not(brand)})` : name;
}
