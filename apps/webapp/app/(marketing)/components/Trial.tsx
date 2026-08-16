"use client";

import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { markTags } from "./Mark";

/**
 * The trial band — the page's one change of surface.
 *
 * It used to be a 12.5px line beneath the tier cards, which put the
 * strongest thing we can offer a stranger ("try it, we are not asking for
 * a card") AFTER they had already decided about the price. It now stands
 * on its own immediately before the pricing section, so the risk is taken
 * off the table one screen BEFORE the number is asked for.
 *
 * Three sentences, in the order a sceptic needs them: what you get, what
 * the one limit is, and what happens if you do nothing. Every term here
 * is the vetted one — 14 days, no card, rules-only, managed AI actions
 * begin with the subscription. Nothing is
 * softened for the sake of the headline; the whole point of putting it
 * this large is that it survives being read closely.
 *
 * ## Why the caveat is IN the band
 *
 * The headline makes the strongest present-tense offer on the page, and
 * for a while the only thing qualifying it ("nothing on this page is for
 * sale or download yet: both tiers open with the beta") sat a full screen
 * lower, in the pricing sub. A reader who took the offer at the band and
 * clicked through to sign up met the qualification after they had already
 * believed the offer — which is the shape of a bait, however unintended.
 * `when` is that qualification, moved to the one place it cannot be
 * missed: the line directly under the headline, before the lede that
 * describes what the trial contains. The lede then reads in the future it
 * actually belongs to ("when it does…"), and the pricing sub keeps its
 * own copy for the reader who scrolls straight past this band.
 */
export function Trial() {
  const t = useTranslations("trial");
  return (
    <section className="l-trial" aria-labelledby="trial-title">
      <Reveal className="l-trial-inner">
        {/* Two lines, ragged in the message rather than by the line breaker:
            a 20-character statement, then an 8-character punchline. The
            taper is the point — "No card." lands harder on a line of its
            own than buried at the end of a long one, and the fixed rag lets
            the type run a size above every section heading on the page
            without any risk of a wrap at 390px. The space between the
            spans is dropped for layout (they are blocks) but survives in
            textContent, so a screen reader and a copy-paste both get one
            sentence: "Fourteen days, free. No card." */}
        <h2 id="trial-title" className="l-trial-title">
          <span className="l-trial-line">{t.rich("titleA", markTags())}</span>{" "}
          <span className="l-trial-line">{t("titleB")}</span>
        </h2>
        {/* The qualification, tucked under the headline rather than after
            the lede: it has to be read as part of the offer, not as a
            footnote to it. */}
        <p className="l-trial-when">{t("when")}</p>
        <p className="l-trial-lede">{t("lede")}</p>
        <p className="l-trial-terms">{t("terms")}</p>
      </Reveal>
    </section>
  );
}
