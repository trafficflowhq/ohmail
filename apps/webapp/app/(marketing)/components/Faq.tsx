import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

const QUESTIONS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"] as const;

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
        {QUESTIONS.map((q, i) => (
          <details className="l-qa" key={q} name="faq">
            <summary>
              {t(q)}
              <svg className="ic l-qa-mark" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3.2v9.6M3.2 8h9.6" />
              </svg>
            </summary>
            <p>{t(`a${i + 1}`)}</p>
          </details>
        ))}
      </Reveal>
    </section>
  );
}
