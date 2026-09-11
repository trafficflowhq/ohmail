"use client";

import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { markTags } from "./Mark";

/**
 * The trial band — the page's one change of surface. It used to be a 12.5px line beneath the tier cards, which put
 * the strongest thing we can offer a stranger ("try it, we are not asking for a card") AFTER they had decided about
 * the price; it now stands immediately before the pricing section. Three sentences in the order a sceptic needs them:
 * what you get, the one limit, what happens if you do nothing — every term the vetted one (14 days, no card,
 * rules-only, managed AI actions begin with the subscription).
 */

/**
 * The caveat is IN the band: the qualification used to sit a full screen lower, so a reader who took the offer met it
 * after they had believed it — the shape of a bait, however unintended; `when` is that qualification, directly under
 * the headline, and the pricing sub keeps its own copy for the reader who scrolls straight past.
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
        {/* The band sells the managed tier's trial; this line keeps the free ways in
            view at the same moment — the desktop app and the same server on your own
            hardware need neither a trial nor a card. It points at the section that
            owns those options rather than restating them. */}
        <p className="l-trial-self">
          <a href="#get">{t("selfhost")}</a>
        </p>
      </Reveal>
    </section>
  );
}
