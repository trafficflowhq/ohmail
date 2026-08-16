"use client";

import { Fragment, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { DotLabel } from "./Wordmark";
import { markTags } from "./Mark";

/* ── the door paragraph ───────────────────────────────────────────────
   The hero's third beat is one centred sentence again — the composition
   this page shipped with, restored on the user's call. The three-statement
   grid that replaced it read as a spec sheet; the paragraph reads as a
   person explaining what the product does, which is the voice the rest of
   the page is written in.

   The load-bearing phrases carry a terracotta marker band that sweeps in
   under them. Three things make that work rather than decorate, and all
   three live outside this file: the element and the tag map are in
   Mark.tsx, the material and the sweep are `.l-mk` in landing.css, and
   which phrases are marked is `hero.door` in messages/en.json — so a
   translation re-decides its own emphasis without touching a component.

   ONE non-breaking space lives in that message, and it is deliberate:
   "on the mailboxes". Left to the line breaker, 1440 and 768 both
   broke it as "…real folders on / the mailboxes you already own" — the
   marked phrase followed by a stranded preposition at the line end, which
   is the one rag fault a sentence this size cannot hide. Binding the
   three words moves the break to the phrase boundary instead, so the
   marker's band always ends a line whole. It is a typographic decision
   about THIS English sentence and it belongs in the message with the
   sentence: a translation re-rags its own prose, and deleting the
   character is how you undo it. `text-wrap: pretty` handles the rest. */

/**
 * The hero lockup — "oh. consent-first email on your own mailboxes."
 *
 * The mark no longer stands on its own line. It opens the sentence as a
 * spoken beat: "oh." then, without a break, the claim — so the h1 reads as
 * one utterance and the terracotta period does the work a comma would
 * otherwise do badly ("oh.," stutters).
 *
 * The rag is explicit (one line per "\n" in the message), not left to the
 * line breaker, so the shape is the same at 390px and at 1600px. Measured
 * at the 76px display cut: "oh. consent-first email" is 723.2px and "on
 * your own mailboxes." is 750.5px — 3.6% apart, with the longer line last,
 * so the lockup reads as a widening statement rather than a taper. The
 * long line needs 750.5 of the 1016px measure, which is 26% of slack: a
 * wider fallback face (Segoe UI, ~6%) cannot force a third line. The breaks
 * live in the message so a translation can re-rag without touching this
 * file; the whitespace between the spans is dropped for layout (block
 * children of a block box) but survives in textContent, so copy-paste and
 * screen readers get one sentence.
 *
 * The former claim is not gone — it is the strapline under the lockup, set
 * small and lowercase, where it reads as the promise rather than the pitch.
 *
 * Parked alternates, still translated in messages/en.json:
 *   "headlineAlt1" — the longer "on the mailboxes you already own." rag
 *   "headlineAlt2" — the previous claim, if it ever wants the h1 back
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
