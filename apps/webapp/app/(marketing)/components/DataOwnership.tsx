import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * Where your mail lives — the three ways to run one product, side by side. Three tiers with the SAME four rows (runs
 * on · the copy of your mail · AI · costs), so the relationship is visible before a word is read: the mailbox is the
 * master in all three; what differs is whose machine holds the working copy. Cloud is framed as self-hosting done for
 * you — built from the same open server source, the only private code being billing, which is the one honest clause
 * `same` adds.
 */

/**
 * Material follows the page's grammar: free tiers are lifted panels, managed is the flat tint band (the Get-ohmail
 * split); rows align across cards with `subgrid`, and a browser without it draws each card's rows at their own
 * heights — the old layout, not a broken one. Per-tier honesty, not a global "we never store mail": the fine print
 * keeps Cloud's two disclosures (not end-to-end encrypted; AI goes to a named provider under stated retention).
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
