/**
 * THE CURATED BRAND DICTIONARY the sender check compares a claimed identity against.
 *
 * A `.ts` module and not the `brands.json` the brief named: `tsconfig.base.json` sets no
 * `resolveJsonModule`, so a JSON import would not compile in this package OR in the four graphs
 * that build core from source, and turning that option on repo-wide is a compiler change for a
 * data file. The shape is the same; `as const satisfies` makes a malformed row a compile error.
 *
 * WHAT A ROW MEANS AND WHAT IT COSTS. `domains` is the set of REGISTRABLE domains this brand
 * sends its own mail from, taken from the brand's own site and mail (never a guess). An
 * INCOMPLETE row is the failure mode worth naming: a brand that also mails from a bulk sender's
 * own domain, absent here, reads as an impersonation of itself — and what that costs is one
 * SUGGESTION saying "spam" on a row a person still decides for themselves. Nothing is filed, no
 * rule is written, no mail moves. A row is therefore added only for a brand whose sending domains
 * are known, and `sender-check.ts` carries three further escapes: the sender domain containing
 * the brand's own token, a snippet-only mention, and the softer `brand_mismatch` class.
 */

export interface Brand {
  /** The display name the reason sentence uses. */
  name: string;
  /** Lower-case tokens that COUNT as naming this brand. `name` is matched too; no duplicates. */
  aliases: string[];
  /** The registrable domains this brand's own mail comes from. Lower-case, never empty. */
  domains: string[];
}

/**
 * The commonly impersonated CH/DE/EU set — telcos, banks, hosters, parcel, payment, tax and
 * government — plus the global platforms whose name is the one most often borrowed. Ordered by
 * sector, not importance; the check reads the whole list.
 */
export const BRANDS: readonly Brand[] = [
  // ── Telecoms ──
  { name: "Swisscom", aliases: ["swisscom"], domains: ["swisscom.ch", "swisscom.com", "bluewin.ch"] },
  { name: "Sunrise", aliases: ["sunrise"], domains: ["sunrise.ch", "sunrise.net"] },
  { name: "Salt", aliases: ["salt mobile"], domains: ["salt.ch"] },
  { name: "Telekom", aliases: ["telekom", "deutsche telekom", "t-mobile"], domains: ["telekom.de", "t-online.de", "telekom.com", "t-mobile.com"] },
  { name: "Vodafone", aliases: ["vodafone"], domains: ["vodafone.de", "vodafone.com", "vodafone.co.uk"] },
  { name: "O2", aliases: ["o2 telefonica", "telefonica"], domains: ["o2online.de", "telefonica.de"] },
  { name: "1&1", aliases: ["1und1", "1&1"], domains: ["1und1.de", "1and1.com"] },
  { name: "Orange", aliases: ["orange"], domains: ["orange.fr", "orange.com"] },
  { name: "A1", aliases: ["a1 telekom"], domains: ["a1.net"] },

  // ── Hosting, domains and cloud ──
  { name: "Metanet", aliases: ["metanet"], domains: ["metanet.ch"] },
  { name: "Hostpoint", aliases: ["hostpoint"], domains: ["hostpoint.ch"] },
  { name: "Infomaniak", aliases: ["infomaniak"], domains: ["infomaniak.com", "infomaniak.ch"] },
  { name: "Cyon", aliases: ["cyon"], domains: ["cyon.ch"] },
  { name: "Hostinger", aliases: ["hostinger"], domains: ["hostinger.com"] },
  { name: "IONOS", aliases: ["ionos"], domains: ["ionos.de", "ionos.com"] },
  { name: "Strato", aliases: ["strato"], domains: ["strato.de"] },
  { name: "Hetzner", aliases: ["hetzner"], domains: ["hetzner.com", "hetzner.de"] },
  { name: "GoDaddy", aliases: ["godaddy"], domains: ["godaddy.com"] },
  { name: "Namecheap", aliases: ["namecheap"], domains: ["namecheap.com"] },
  { name: "OVH", aliases: ["ovh", "ovhcloud"], domains: ["ovh.com", "ovh.net", "ovhcloud.com"] },
  { name: "Gandi", aliases: ["gandi"], domains: ["gandi.net"] },
  { name: "SWITCH", aliases: ["switch.ch"], domains: ["switch.ch"] },
  { name: "Cloudflare", aliases: ["cloudflare"], domains: ["cloudflare.com"] },

  // ── Banks, cards and payment ──
  { name: "UBS", aliases: ["ubs"], domains: ["ubs.com"] },
  { name: "PostFinance", aliases: ["postfinance"], domains: ["postfinance.ch"] },
  { name: "Raiffeisen", aliases: ["raiffeisen"], domains: ["raiffeisen.ch", "raiffeisen.de"] },
  { name: "Migros Bank", aliases: ["migros bank", "migrosbank"], domains: ["migrosbank.ch"] },
  { name: "ZKB", aliases: ["zürcher kantonalbank", "zuercher kantonalbank"], domains: ["zkb.ch"] },
  { name: "Credit Suisse", aliases: ["credit suisse"], domains: ["credit-suisse.com"] },
  { name: "Deutsche Bank", aliases: ["deutsche bank"], domains: ["db.com", "deutsche-bank.de"] },
  { name: "Commerzbank", aliases: ["commerzbank"], domains: ["commerzbank.de"] },
  { name: "Sparkasse", aliases: ["sparkasse"], domains: ["sparkasse.de"] },
  { name: "ING", aliases: ["ing-diba", "ing diba"], domains: ["ing.de", "ing.com"] },
  { name: "Revolut", aliases: ["revolut"], domains: ["revolut.com"] },
  { name: "N26", aliases: ["n26"], domains: ["n26.com"] },
  { name: "PayPal", aliases: ["paypal"], domains: ["paypal.com", "paypal.ch", "paypal.de"] },
  { name: "Stripe", aliases: ["stripe"], domains: ["stripe.com"] },
  { name: "Klarna", aliases: ["klarna"], domains: ["klarna.com"] },
  { name: "TWINT", aliases: ["twint"], domains: ["twint.ch"] },
  { name: "Visa", aliases: ["visa"], domains: ["visa.com", "visa.ch"] },
  { name: "Mastercard", aliases: ["mastercard"], domains: ["mastercard.com"] },
  { name: "American Express", aliases: ["american express", "amex"], domains: ["americanexpress.com", "aexp.com"] },
  { name: "Viseca", aliases: ["viseca"], domains: ["viseca.ch"] },

  // ── Parcel and post ──
  { name: "Die Post", aliases: ["schweizerische post", "die post", "swiss post"], domains: ["post.ch"] },
  { name: "DHL", aliases: ["dhl"], domains: ["dhl.com", "dhl.de"] },
  { name: "Deutsche Post", aliases: ["deutsche post"], domains: ["deutschepost.de"] },
  { name: "DPD", aliases: ["dpd"], domains: ["dpd.com", "dpd.de", "dpd.ch"] },
  { name: "GLS", aliases: ["gls"], domains: ["gls-group.com", "gls-group.eu"] },
  { name: "Hermes", aliases: ["hermes versand"], domains: ["myhermes.de", "hermesworld.com"] },
  { name: "UPS", aliases: ["ups"], domains: ["ups.com"] },
  { name: "FedEx", aliases: ["fedex"], domains: ["fedex.com"] },

  // ── Tax, government and health ──
  { name: "ESTV", aliases: ["estv", "eidgenössische steuerverwaltung"], domains: ["admin.ch"] },
  { name: "AHV", aliases: ["ahv", "ahv/iv"], domains: ["ahv-iv.ch", "admin.ch"] },
  { name: "SUVA", aliases: ["suva"], domains: ["suva.ch"] },
  { name: "ELSTER", aliases: ["elster"], domains: ["elster.de"] },
  { name: "Bundeszentralamt für Steuern", aliases: ["bundeszentralamt für steuern", "finanzamt"], domains: ["bzst.de", "bund.de"] },
  { name: "CSS", aliases: ["css versicherung"], domains: ["css.ch"] },
  { name: "Helsana", aliases: ["helsana"], domains: ["helsana.ch"] },

  // ── Platforms and shops ──
  { name: "Microsoft", aliases: ["microsoft", "office 365", "microsoft 365"], domains: ["microsoft.com", "office.com", "microsoftonline.com", "outlook.com"] },
  { name: "Apple", aliases: ["apple", "icloud"], domains: ["apple.com", "icloud.com"] },
  { name: "Google", aliases: ["google"], domains: ["google.com", "youtube.com"] },
  { name: "Amazon", aliases: ["amazon"], domains: ["amazon.com", "amazon.de", "amazon.co.uk"] },
  { name: "Netflix", aliases: ["netflix"], domains: ["netflix.com"] },
  { name: "Spotify", aliases: ["spotify"], domains: ["spotify.com"] },
  { name: "Meta", aliases: ["facebook", "instagram", "whatsapp"], domains: ["facebook.com", "facebookmail.com", "instagram.com", "meta.com", "whatsapp.com"] },
  { name: "LinkedIn", aliases: ["linkedin"], domains: ["linkedin.com"] },
  { name: "Digitec Galaxus", aliases: ["digitec", "galaxus"], domains: ["digitec.ch", "galaxus.ch"] },
  { name: "Migros", aliases: ["migros"], domains: ["migros.ch"] },
  { name: "Coop", aliases: ["coop"], domains: ["coop.ch"] },
  { name: "SBB", aliases: ["sbb", "sbb cff ffs"], domains: ["sbb.ch"] },
  { name: "Deutsche Bahn", aliases: ["deutsche bahn", "db bahn"], domains: ["bahn.de", "deutschebahn.com"] },
  { name: "Booking.com", aliases: ["booking.com"], domains: ["booking.com"] },
  { name: "DocuSign", aliases: ["docusign"], domains: ["docusign.com", "docusign.net"] },
  { name: "Dropbox", aliases: ["dropbox"], domains: ["dropbox.com", "dropboxmail.com"] },
];
