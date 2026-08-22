import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * The long tail, said once and quietly.
 *
 * The proof sections above argue: consent, the three piles, in-place organization,
 * gated AI, speed, dark mode. Everything else the app does had nowhere to be said, so a
 * visitor could read the whole page and not learn that it opens PDFs, blocks tracking
 * pixels, or sends an unsubscribe for a newsletter it just screened out. Those are not
 * arguments and should not be argued — they are the answer to "yes, but is it a
 * finished mail app?", and the honest form of that answer is a list.
 *
 * Two former entries left when they became sections of their own: the three piles
 * (`Views`) and dark mail (`DarkMode`). A list item restating a section above it is not
 * the long tail, it is an echo.
 *
 * Typography, not tiles. Six term/description pairs in a flowing multi-column list: no
 * boxes, no icons, no repeated headings. A card grid here would have added six framed
 * objects to a page whose argument is made by three, and would have given the smallest
 * claims on the page the same visual weight as the Screener.
 */
const ITEMS = [
  "attachments",
  // Beside "Attachments" on purpose: one item is what happens to a file arriving, the other
  // what happens to one leaving, and a reader scanning the list meets the pair together.
  "pictures",
  "trackers",
  "later",
  "unsub",
  "write",
  "tags",
] as const;

export function Everyday() {
  const t = useTranslations("everyday");
  return (
    <section className="l-every" aria-labelledby="every-title">
      <Reveal className="l-sec-head">
        <h2 id="every-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>
      <Reveal as="div" className="l-every-wrap" delay={90}>
        <dl className="l-every-list">
          {ITEMS.map((id) => (
            <div className="l-every-item" key={id}>
              <dt>{t(`${id}Term`)}</dt>
              <dd>{t(`${id}Body`)}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  );
}
