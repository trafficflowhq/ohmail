import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * The long tail, said once and quietly. The proof sections argue; everything else the app does had
 * nowhere to be said, so a visitor could read the whole page and not learn it opens PDFs, blocks
 * tracking pixels, or sends an unsubscribe for a newsletter it just screened out — the answer to
 * "yes, but is it a finished mail app?", and the honest form of that answer is a list. Two former
 * entries left when they became sections of their own (the three piles, dark mail): a list item
 * restating a section is an echo. Typography, not tiles: six term/description pairs in a flowing
 * multi-column list — a card grid would give the smallest claims the same weight as the Screener.
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
  // Beside "Tags" on purpose: tags reach across mailboxes, folders are the ones you already
  // keep — real IMAP folders, opt-in, per mailbox, with create/rename/delete. The sentence
  // names the one surface that does not have them yet (the standalone desktop app).
  "folders",
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
