import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/** term → optional qualifier → body → the note that keeps it honest */
const ROWS = [
  { id: "desktop", tag: null, note: "desktopNote" },
  { id: "cloud", tag: "cloudOptional", note: "cloudNote" },
  { id: "ai", tag: "aiOptional", note: null },
] as const;

/**
 * Per-tier data honesty, in one sculpted Blanc panel: Desktop never
 * touches our servers; Cloud stores encrypted on EU servers only to
 * serve your devices; AI is optional, no-training, and structurally
 * never sees sensitive mail. Deliberately NOT a global "we never store
 * mail" claim — per-tier truth is the brand.
 *
 * Two of the three rows carry an "(optional)" tag, and the two that need
 * it carry a plain-words note: Desktop-only is a complete product, not a
 * trial; and Cloud exists for one physical reason — a phone cannot hold a
 * connection to your mailbox open all day, so something has to stay awake.
 */
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
      <Reveal as="div" className="l-data-panel" delay={90}>
        <dl className="l-data-list">
          {ROWS.map((r) => (
            <div className="l-data-row" key={r.id}>
              <dt>
                {t(`${r.id}Term`)}
                {r.tag ? <em className="l-opt">{t(r.tag)}</em> : null}
              </dt>
              <dd>
                {t(`${r.id}Body`)}
                {r.note ? <span className="l-data-note">{t(r.note)}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  );
}
