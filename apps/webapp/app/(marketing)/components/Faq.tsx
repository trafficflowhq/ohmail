import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { FAQ_ANSWERS, FAQ_QUESTIONS, faqAnswerAnchor } from "../faq-anchors";

/**
 * Native <details> — keyboard accessible, zero JS. The hairline rules
 * between items are one of Blanc's few deliberate hairlines (like the
 * Receipts table): a list, not a stack of cards.
 */
export function Faq() {
  const t = useTranslations("faq");
  return (
    <section className="l-faq" id="faq" aria-labelledby="faq-title">
      <Reveal>
        <h2 id="faq-title" className="l-h2">
          {t("title")}
        </h2>
      </Reveal>
      <Reveal as="div" className="l-faq-list" delay={80}>
        {FAQ_QUESTIONS.map((q, i) => {
          /* ONE variable for the answer, used for both the id and the lookup, so a link into
             this section cannot land on a different answer than the one it names: move the
             item and both move together. `faq-anchors.ts` owns the derivation. */
          const answer = FAQ_ANSWERS[i]!;
          return (
            <details className="l-qa" key={q} name="faq">
              <summary>
                {t(q)}
                <svg className="ic l-qa-mark" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3.2v9.6M3.2 8h9.6" />
                </svg>
              </summary>
              <p id={faqAnswerAnchor(answer)}>{t(answer)}</p>
            </details>
          );
        })}
      </Reveal>
    </section>
  );
}
