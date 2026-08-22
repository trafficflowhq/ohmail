import { useTranslations } from "next-intl";
import { LangSwitch } from "./LangSwitch";
import { Wordmark } from "./Wordmark";

export function Footer() {
  const t = useTranslations("footer");
  /* The switch's own label comes from `settings.languageName`; this namespace supplies the
     landmark's name, so a reader listing the page's regions hears "Sprache" rather than a
     second unnamed navigation. */
  const tSettings = useTranslations("settings");
  return (
    <footer className="l-footer">
      <div className="l-footer-inner">
        <div className="l-footer-brand">
          <Wordmark />
          <p className="l-footer-tag">{t("tagline")}</p>
        </div>
        <p className="l-notrack">
          <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.8l5.2 2v4.1c0 3.2-2.2 5.3-5.2 6.3-3-1-5.2-3.1-5.2-6.3V3.8z" />
            <path d="M5.6 8.2l1.7 1.7 3.1-3.6" />
          </svg>
          {t("noTrackers")}
        </p>
        <nav className="l-footer-nav" aria-label="Legal">
          <a href="/imprint">{t("imprint")}</a>
          <a href="/privacy">{t("privacy")}</a>
          <a href="/subprocessors">{t("subprocessors")}</a>
        </nav>
        {/* The durable half of the language switch. The nav's copy disappears with the rest of
            the bar on a narrow screen; this one is always here, and it is the link a crawler
            following the footer finds. */}
        <nav className="l-footer-nav" aria-label={tSettings("language")}>
          <LangSwitch className="l-footer-lang" />
        </nav>
        <p className="l-footer-copy num">{t("copyright")}</p>
      </div>
    </footer>
  );
}
