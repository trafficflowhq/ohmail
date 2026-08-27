import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * Where your mail lives — the three ways to run one product, side by side.
 *
 * Three tiers with the SAME four rows (runs on · the copy of your mail · AI · costs), so
 * the relationship is visible before a word is read: same posture, different operator.
 * The mailbox is the master in all three (real folders on the user's own server); what
 * differs is whose machine holds the working copy — the user's disk, the user's server,
 * or ours. Cloud is deliberately framed as self-hosting done for you: the hosted service
 * is built from the same open server source (the public README's "Run the server
 * yourself" section says so, and the get-ohmail block repeats it); the only private code
 * is the billing machinery, which is the one honest clause `same` adds.
 *
 * Material follows the page's own grammar: the two free tiers are lifted panels, the
 * managed tier is the flat tint band — the same split the Get-ohmail section draws
 * between the self-run cards and the managed band, so a visitor who has seen one has
 * seen the other. The rows align ACROSS cards with `subgrid` (the cards are grid items
 * that span the shared row tracks); a browser without it just draws each card's rows at
 * their own heights, which is the old layout, not a broken one.
 *
 * Per-tier honesty is the brand, so it is not a global "we never store mail" claim: the
 * fine print under the cards keeps the two disclosures that qualify Cloud — it is not
 * end-to-end encrypted, and its AI goes to a named provider under stated retention.
 */
const TIERS = ["desktop", "self", "cloud"] as const;
const ROWS = ["Runs", "Copy", "Ai", "Cost"] as const;

export function DataOwnership() {
  const t = useTranslations("data");
  return (
    <section className="l-data" aria-labelledby="data-title">
      <Reveal className="l-sec-head">
        <h2 id="data-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>
      <Reveal as="div" className="l-data-grid" delay={90}>
        {TIERS.map((tier) => (
          <article className="l-data-card" data-tier={tier} key={tier} aria-labelledby={`data-${tier}`}>
            <h3 id={`data-${tier}`} className="l-data-term">
              {t(`${tier}Term`)}
              <em className="l-opt">{t(`${tier}Tag`)}</em>
            </h3>
            {ROWS.map((row) => (
              <div className="l-data-row" key={row}>
                <span className="l-data-k">{t(`row${row}`)}</span>
                <p className="l-data-v">{t(`${tier}${row}`)}</p>
              </div>
            ))}
          </article>
        ))}
      </Reveal>
      {/* the sentence the layout is drawn to make visible, said once in words */}
      <Reveal as="p" className="l-data-same" delay={120}>
        {t("same")}
      </Reveal>
      <Reveal as="div" className="l-data-fine" delay={140}>
        <p>{t("honest")}</p>
        <p>{t("aiNote")}</p>
      </Reveal>
    </section>
  );
}
