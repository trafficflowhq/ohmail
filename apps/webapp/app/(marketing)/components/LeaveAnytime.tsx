import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * Leave anytime — the product's defining promise, given a heading of its own. This section states the CONSEQUENCE:
 * because the organization is real IMAP folders and the configuration is one small message in the mailbox
 * (`ohmail/_meta`, the portable organizer profile), changing how you run ohmail is reconnecting a mailbox, and
 * leaving is closing an app. Three exits, one sentence each, in the order a paying customer would take them.
 */

/**
 * The footnote is what makes the promise credible: it names EXACTLY what travels today (the five things the profile
 * serializes — the same list the README and the Get-ohmail close carry, held in agreement by a test) and what does
 * not (triage piles, Resurface timers, learned patterns — decisions with no IMAP representation). Typography, not
 * tiles: three terms over hairlines, the Everyday register at three-up.
 */
const EXITS = ["fromCloud", "toDesktop", "out"] as const;

export function LeaveAnytime() {
  const t = useTranslations("leave");
  return (
    <section className="l-leave" id="leave" aria-labelledby="leave-title">
      <Reveal className="l-sec-head">
        <h2 id="leave-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>
      <Reveal as="div" className="l-leave-wrap" delay={90}>
        <dl className="l-leave-list">
          {EXITS.map((id) => (
            <div className="l-leave-item" key={id}>
              <dt>{t(`${id}Term`)}</dt>
              <dd>{t(`${id}Body`)}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
      <Reveal as="p" className="l-leave-foot" delay={140}>
        {t("note")}
      </Reveal>
    </section>
  );
}
