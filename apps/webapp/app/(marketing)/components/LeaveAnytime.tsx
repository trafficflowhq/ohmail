import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * Leave anytime — the product's defining promise, given a heading of its own.
 *
 * The hero says it in a clause and the folder showcase proves the folder half of it.
 * This section states the CONSEQUENCE: because the mailbox is the source of truth — the
 * organization is real IMAP folders on the user's server, and the configuration is one
 * small message in the mailbox (`ohmail/_meta`, the portable organizer profile) —
 * changing how you run ohmail is reconnecting a mailbox, and leaving is closing an app.
 *
 * Three exits, one sentence each, in the order a paying customer would take them:
 * Cloud → a server you run, Cloud → the free desktop app, out of ohmail entirely. The
 * footnote under them is what makes the promise credible: it names EXACTLY what travels
 * today (the five things the profile serializes — the same list the public README and
 * the Get-ohmail close carry, held in agreement by a test) and what does not (triage
 * piles, Resurface timers, learned patterns — user decisions with no IMAP representation,
 * which stay with the install they were made on). A promise that hides its edge is the
 * kind of promise the comparison table exists to call out.
 *
 * Typography, not tiles: three terms over hairlines, the Everyday list's register at
 * three-up, between the folder showcase's lifted panel and the comparison table's
 * hairline rows — the trust cluster alternates materials so it reads as a sequence.
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
