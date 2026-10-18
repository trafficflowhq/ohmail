import type { EmailAddress } from "./types.js";

/**
 * THE NAME A CARD OR A NOTIFICATION SHOWS FOR A SENDER, in one place: the display name, else the
 * address, and "(Not {brand})" beside it when the identity fact marks the sender — a single line
 * naming a company the address does not belong to never carries the claim alone. `not` is the
 * surface's own chip phrase, so the words stay in each surface's catalogue. An `unverified` line is
 * the brand's own address, which no denial fits.
 */
export function notifiedSenderName(
  m: {
    from: EmailAddress;
    senderCheck?: { reason?: string; brand: string } | null;
    checked?: { reason?: string; brand: string };
  },
  not: (brand: string) => string,
): string {
  const name = m.from.name || m.from.address;
  const claim = (c: { reason?: string; brand: string } | null | undefined): string | undefined =>
    c != null && c.reason !== "unverified" ? c.brand : undefined;
  const brand = claim(m.senderCheck) ?? claim(m.checked);
  return brand ? `${name} (${not(brand)})` : name;
}
