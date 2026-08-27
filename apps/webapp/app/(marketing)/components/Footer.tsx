import { useTranslations } from "next-intl";
import { LangSwitch } from "./LangSwitch";
import { Wordmark } from "./Wordmark";

/**
 * The footer's sign-off is the promise the whole page argues — the mailbox is the source
 * of truth, so leaving costs nothing — set as a statement rather than a badge. The line
 * it replaced ("No analytics. No trackers.") was true of this site and stays true (the
 * no-third-party guard proves the marketing surface loads nothing off-origin), but it is
 * a fact about the website, not the product's reason to exist; it keeps a quiet second
 * line, scoped to what it can prove: this site.
 */
export function Footer() {
  const t = useTranslations("footer");
  return (
    <footer className="l-footer">
      <div className="l-footer-inner">
        <div className="l-footer-brand">
          <Wordmark />
          <p className="l-footer-tag">{t("tagline")}</p>
        </div>
        <div className="l-footer-promise">
          <p className="l-footer-usp">{t("promise")}</p>
          <p className="l-footer-quiet">
            <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.8l5.2 2v4.1c0 3.2-2.2 5.3-5.2 6.3-3-1-5.2-3.1-5.2-6.3V3.8z" />
              <path d="M5.6 8.2l1.7 1.7 3.1-3.6" />
            </svg>
            {t("noTrackers")}
          </p>
        </div>
        <nav className="l-footer-nav" aria-label={t("legalNav")}>
          <a href="/imprint">{t("imprint")}</a>
          <a href="/privacy">{t("privacy")}</a>
          <a href="/subprocessors">{t("subprocessors")}</a>
        </nav>
        {/* The durable half of the language switch. The bar's copy disappears with the rest of
            the header on a narrow screen; this one is always here, and it is the link a crawler
            following the footer finds.

            The `<nav>` is the switch's own, not the footer's: the control withdraws for a
            browser that has a session (its `/` href opens the app, not the English landing),
            and a named landmark left standing around nothing is a region a screen-reader
            reader can enter and find empty. Both go or neither does. */}
        <LangSwitch className="l-footer-lang" landmarkClassName="l-footer-nav" />
        <p className="l-footer-copy num">{t("copyright")}</p>
      </div>
    </footer>
  );
}
