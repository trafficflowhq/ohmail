"use client";

import { Fragment, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { DotLabel } from "./Wordmark";
import { markTags } from "./Mark";

/* The door paragraph — the hero's third beat is one centred sentence again (the three-statement
   grid read as a spec sheet; the paragraph reads as a person explaining, the page's voice). The
   load-bearing phrases carry a terracotta marker band that sweeps in under them; the element and
   tag map are Mark.tsx, the material is `.l-mk` in landing.css, and WHICH phrases are marked is
   `hero.door` in messages/en.json — a translation re-decides its own emphasis. ONE non-breaking
   space lives in that message, deliberately ("on the mailboxes"): left to the line breaker, 1440
   and 768 both stranded the preposition at the line end — binding the three words moves the break
   to the phrase boundary so the marker's band always ends a line whole. It belongs in the message
   with the sentence: a translation re-rags its own prose. `text-wrap: pretty` handles the rest. */

/**
 * The hero lockup — "oh. consent-first email on your own mailboxes." The mark opens the sentence as a spoken beat
 * rather than standing on its own line, so the h1 reads as one utterance and the terracotta period does the work a
 * comma would do badly. The rag is explicit (one line per `\n` in the message), the same shape at 390px and 1600px:
 * measured at the 76px cut the two lines are 3.6% apart with the longer last, so the lockup widens rather than
 * tapers, and 26% of slack means a wider fallback face cannot force a third line.
 */

/**
 * The breaks live in the message so a translation re-rags without touching this file; the whitespace between spans
 * survives in textContent, so copy-paste and screen readers get one sentence. The former claim is the strapline under
 * the lockup; parked alternates stay translated (`headlineAlt1`/`headlineAlt2`).
 */
export function Hero() {
  const t = useTranslations("hero");
  /* the brand mark: ink letters, terracotta period — the wordmark's own spec */
  const mark = t("mark");
  const lines = t("headline").split("\n");
  /* Render-scoped, so the stagger indices reset on every render
     (StrictMode's double invoke included). */
  const door = t.rich("door", markTags());

  return (
    <section className="l-hero" aria-labelledby="hero-title">
      <h1 id="hero-title" className="l-hero-title l-rise" style={{ "--rise": "1" } as CSSProperties}>
        {lines.map((line, i) => (
          <Fragment key={line}>
            {i > 0 ? " " : null}
            <span className="l-hero-line">
              {i === 0 ? (
                <>
                  <span className="l-hero-mark">
                    {mark.slice(0, -1)}
                    <span className="l-wordmark-dot">{mark.slice(-1)}</span>
                  </span>{" "}
                </>
              ) : null}
              {line}
            </span>
          </Fragment>
        ))}
      </h1>

      <p className="l-hero-strap l-rise" style={{ "--rise": "2" } as CSSProperties}>
        {t("strapline")}
      </p>

      {/* The door (see above). One paragraph, one sentence, four marked
          phrases whose bands arrive after it has risen. */}
      <p className="l-door l-rise" style={{ "--rise": "3" } as CSSProperties}>
        {door}
      </p>

      <div className="l-hero-ctas l-rise" style={{ "--rise": "4.1" } as CSSProperties}>
        {/* Scrolls to pricing; the tier cards there open the signup modal. */}
        <a className="btn primary l-btn-lg" href="#pricing">
          <DotLabel text={t("ctaGet")} />
        </a>
        <a className="btn l-btn-lg" href="#demo">
          {t("ctaDemo")}
        </a>
      </div>

      <p className="l-hero-note l-rise num" style={{ "--rise": "4.8" } as CSSProperties}>
        {t("note")}
      </p>
    </section>
  );
}
