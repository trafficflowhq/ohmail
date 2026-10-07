/**
 * THE CURATED BRAND DICTIONARY the identity fact compares a claimed name against. A `.ts` module
 * and not JSON: nothing here sets `resolveJsonModule`. `domains` is the set of REGISTRABLE domains
 * a brand sends its OWN mail from, from the brand's own site, never a guess; a shared provider's
 * domain owns nothing whichever row lists it (`rule-order.ts#isSharedProviderDomain`). An
 * INCOMPLETE row is the failure mode worth naming: the brand's own mail from a domain absent here
 * waits at the Screener with a sentence and is let through with one press. Nothing is filed to
 * Quarantine and no rule is written. Kept by hand and never learned: a row lands with its own
 * domains, its case and a false-positive control for every gate needle that is also a word.
 */

export interface Brand {
  /** The display name the reason sentence uses. */
  name: string;
  /** Lower-case tokens that COUNT as naming this brand. `name` is matched too; no duplicates. */
  aliases: string[];
  /** The registrable domains this brand's own mail comes from. Lower-case, never empty. */
  domains: string[];
  /**
   * The needles that count for the identity fact (`sender-check.ts#claimedIdentity`), 5+ letters
   * each. A row without `gate` or `gateShort` is advice only: it caps a suggestion, it holds nothing.
   */
  gate?: readonly string[];
  /** Needles under 5 letters: they claim the brand only beside a service word ("UBS Sicherheit"). */
  gateShort?: readonly string[];
  /**
   * Needles claimed only as their exact tokens or fused, followed by a non-letter, never by
   * skeleton or inside a word: "Post CH" and "PostCH", never "Post Christian" or "Postcheck".
   */
  gateToken?: readonly string[];
}

/**
 * The commonly impersonated CH/DE/EU set — telcos, banks, hosters, parcel, payment, tax and
 * government — plus the global platforms whose name is the one most often borrowed. Ordered by
 * sector, not importance; the check reads the whole list.
 */
export const BRANDS: readonly Brand[] = [
  // ── Telecoms ──
  { name: "Swisscom", aliases: ["swisscom"], domains: ["swisscom.ch", "swisscom.com", "bluewin.ch"], gate: ["swisscom"] },
  { name: "Sunrise", aliases: ["sunrise"], domains: ["sunrise.ch", "sunrise.net"] },
  { name: "Salt", aliases: ["salt mobile"], domains: ["salt.ch"], gate: ["salt mobile"], gateShort: ["salt"] },
  { name: "Telekom", aliases: ["telekom", "deutsche telekom", "t-mobile"], domains: ["telekom.de", "t-online.de", "telekom.com", "t-mobile.com"], gate: ["telekom", "deutsche telekom", "t-mobile"] },
  { name: "Vodafone", aliases: ["vodafone"], domains: ["vodafone.de", "vodafone.com", "vodafone.co.uk"], gate: ["vodafone"] },
  { name: "O2", aliases: ["o2 telefonica", "telefonica"], domains: ["telefonica.de"], gate: ["o2 telefonica", "telefonica"], gateShort: ["o2"] },
  { name: "1&1", aliases: ["1und1", "1&1"], domains: ["1und1.de", "1and1.com"], gateShort: ["1&1"] },
  { name: "Orange", aliases: ["orange"], domains: ["orange.fr", "orange.com"] },
  { name: "A1", aliases: ["a1 telekom"], domains: ["a1.net"], gate: ["a1 telekom"], gateShort: ["a1"] },

  // ── Hosting, domains and cloud ──
  { name: "Metanet", aliases: ["metanet"], domains: ["metanet.ch"], gate: ["metanet"] },
  { name: "Hostpoint", aliases: ["hostpoint"], domains: ["hostpoint.ch"], gate: ["hostpoint"] },
  { name: "Infomaniak", aliases: ["infomaniak"], domains: ["infomaniak.com", "infomaniak.ch"], gate: ["infomaniak"] },
  { name: "Cyon", aliases: ["cyon"], domains: ["cyon.ch"] },
  { name: "Hostinger", aliases: ["hostinger"], domains: ["hostinger.com"], gate: ["hostinger"] },
  { name: "IONOS", aliases: ["ionos"], domains: ["ionos.de", "ionos.com"], gate: ["ionos"] },
  { name: "Strato", aliases: ["strato"], domains: ["strato.de"], gate: ["strato"] },
  { name: "Hetzner", aliases: ["hetzner"], domains: ["hetzner.com", "hetzner.de"], gate: ["hetzner"] },
  { name: "GoDaddy", aliases: ["godaddy"], domains: ["godaddy.com"], gate: ["godaddy"] },
  { name: "Namecheap", aliases: ["namecheap"], domains: ["namecheap.com"], gate: ["namecheap"] },
  { name: "OVH", aliases: ["ovh", "ovhcloud"], domains: ["ovh.com", "ovh.net", "ovhcloud.com"], gate: ["ovhcloud"], gateShort: ["ovh"] },
  { name: "Gandi", aliases: ["gandi"], domains: ["gandi.net"], gate: ["gandi"] },
  { name: "SWITCH", aliases: ["switch.ch"], domains: ["switch.ch"], gate: ["switch.ch"] },
  { name: "Cloudflare", aliases: ["cloudflare"], domains: ["cloudflare.com"], gate: ["cloudflare"] },

  // ── Banks, cards and payment ──
  { name: "UBS", aliases: ["ubs"], domains: ["ubs.com"], gateShort: ["ubs"] },
  { name: "PostFinance", aliases: ["postfinance"], domains: ["postfinance.ch"], gate: ["postfinance"] },
  { name: "Raiffeisen", aliases: ["raiffeisen"], domains: ["raiffeisen.ch", "raiffeisen.de"], gate: ["raiffeisen"] },
  { name: "Migros Bank", aliases: ["migros bank", "migrosbank"], domains: ["migrosbank.ch"], gate: ["migros bank", "migrosbank"] },
  { name: "ZKB", aliases: ["zürcher kantonalbank", "zuercher kantonalbank"], domains: ["zkb.ch"], gate: ["zürcher kantonalbank", "zuercher kantonalbank"], gateShort: ["zkb"] },
  { name: "Credit Suisse", aliases: ["credit suisse"], domains: ["credit-suisse.com"], gate: ["credit suisse"] },
  { name: "Deutsche Bank", aliases: ["deutsche bank"], domains: ["db.com", "deutsche-bank.de"], gate: ["deutsche bank"] },
  { name: "Commerzbank", aliases: ["commerzbank"], domains: ["commerzbank.de"], gate: ["commerzbank"] },
  { name: "Sparkasse", aliases: ["sparkasse"], domains: ["sparkasse.de"], gate: ["sparkasse"] },
  { name: "ING", aliases: ["ing-diba", "ing diba"], domains: ["ing.de", "ing.com"], gate: ["ing-diba", "ing diba"], gateShort: ["ing"] },
  { name: "Revolut", aliases: ["revolut"], domains: ["revolut.com"], gate: ["revolut"] },
  { name: "N26", aliases: ["n26"], domains: ["n26.com"], gateShort: ["n26"] },
  { name: "PayPal", aliases: ["paypal"], domains: ["paypal.com", "paypal.ch", "paypal.de"], gate: ["paypal"] },
  { name: "Stripe", aliases: ["stripe"], domains: ["stripe.com"] },
  { name: "Klarna", aliases: ["klarna"], domains: ["klarna.com"], gate: ["klarna"] },
  { name: "TWINT", aliases: ["twint"], domains: ["twint.ch"], gate: ["twint"] },
  { name: "Visa", aliases: ["visa"], domains: ["visa.com", "visa.ch"], gateShort: ["visa"] },
  { name: "Mastercard", aliases: ["mastercard"], domains: ["mastercard.com"], gate: ["mastercard"] },
  { name: "American Express", aliases: ["american express", "amex"], domains: ["americanexpress.com", "aexp.com"], gate: ["american express"] },
  { name: "Viseca", aliases: ["viseca"], domains: ["viseca.ch"], gate: ["viseca"] },

  // ── Parcel and post ──
  { name: "Die Post", aliases: ["schweizerische post", "die post", "swiss post", "post ch"], domains: ["post.ch"], gate: ["die post", "schweizerische post", "swiss post"], gateToken: ["post ch"] },
  { name: "DHL", aliases: ["dhl"], domains: ["dhl.com", "dhl.de"], gateShort: ["dhl"] },
  { name: "Deutsche Post", aliases: ["deutsche post"], domains: ["deutschepost.de"], gate: ["deutsche post"] },
  { name: "DPD", aliases: ["dpd"], domains: ["dpd.com", "dpd.de", "dpd.ch"], gateShort: ["dpd"] },
  { name: "GLS", aliases: ["gls"], domains: ["gls-group.com", "gls-group.eu"], gateShort: ["gls"] },
  { name: "Hermes", aliases: ["hermes versand"], domains: ["myhermes.de", "hermesworld.com"], gate: ["hermes versand"] },
  { name: "UPS", aliases: ["ups"], domains: ["ups.com"], gateShort: ["ups"] },
  { name: "FedEx", aliases: ["fedex"], domains: ["fedex.com"], gate: ["fedex"] },

  // ── Tax, government and health ──
  { name: "ESTV", aliases: ["estv", "eidgenössische steuerverwaltung"], domains: ["admin.ch"], gate: ["eidgenössische steuerverwaltung"], gateShort: ["estv"] },
  { name: "AHV", aliases: ["ahv", "ahv/iv"], domains: ["ahv-iv.ch", "admin.ch"], gate: ["ahv/iv"], gateShort: ["ahv"] },
  { name: "SUVA", aliases: ["suva"], domains: ["suva.ch"], gateShort: ["suva"] },
  { name: "ELSTER", aliases: ["elster"], domains: ["elster.de"], gate: ["elster"] },
  { name: "Bundeszentralamt für Steuern", aliases: ["bundeszentralamt für steuern", "finanzamt"], domains: ["bzst.de", "bund.de"], gate: ["bundeszentralamt für steuern"] },
  { name: "CSS", aliases: ["css versicherung"], domains: ["css.ch"], gate: ["css versicherung"], gateShort: ["css"] },
  { name: "Helsana", aliases: ["helsana"], domains: ["helsana.ch"], gate: ["helsana"] },

  // ── Platforms and shops ──
  { name: "Microsoft", aliases: ["microsoft", "office 365", "microsoft 365"], domains: ["microsoft.com", "office.com", "microsoftonline.com", "outlook.com"], gate: ["microsoft", "office 365", "microsoft 365"] },
  { name: "Apple", aliases: ["apple", "icloud", "apple support", "apple id"], domains: ["apple.com", "icloud.com"], gate: ["icloud", "apple support", "apple id"] },
  { name: "Google", aliases: ["google"], domains: ["google.com", "youtube.com"], gate: ["google"] },
  { name: "Amazon", aliases: ["amazon"], domains: ["amazon.com", "amazon.de", "amazon.co.uk"], gate: ["amazon"] },
  { name: "Netflix", aliases: ["netflix"], domains: ["netflix.com"], gate: ["netflix"] },
  { name: "Spotify", aliases: ["spotify"], domains: ["spotify.com"], gate: ["spotify"] },
  { name: "Meta", aliases: ["facebook", "instagram", "whatsapp"], domains: ["facebook.com", "facebookmail.com", "instagram.com", "meta.com", "whatsapp.com"], gate: ["facebook", "instagram", "whatsapp"], gateShort: ["meta"] },
  { name: "LinkedIn", aliases: ["linkedin"], domains: ["linkedin.com"], gate: ["linkedin"] },
  { name: "Digitec Galaxus", aliases: ["digitec", "galaxus"], domains: ["digitec.ch", "galaxus.ch"], gate: ["digitec galaxus", "digitec", "galaxus"] },
  { name: "Migros", aliases: ["migros"], domains: ["migros.ch"], gate: ["migros"] },
  { name: "Coop", aliases: ["coop"], domains: ["coop.ch"], gateShort: ["coop"] },
  { name: "SBB", aliases: ["sbb", "sbb cff ffs"], domains: ["sbb.ch"], gate: ["sbb cff ffs"], gateShort: ["sbb"] },
  { name: "Deutsche Bahn", aliases: ["deutsche bahn", "db bahn"], domains: ["bahn.de", "deutschebahn.com"], gate: ["deutsche bahn", "db bahn"] },
  { name: "Booking.com", aliases: ["booking.com"], domains: ["booking.com"], gate: ["booking.com"] },
  { name: "DocuSign", aliases: ["docusign"], domains: ["docusign.com", "docusign.net"], gate: ["docusign"] },
  { name: "Dropbox", aliases: ["dropbox"], domains: ["dropbox.com", "dropboxmail.com"], gate: ["dropbox"] },
];
