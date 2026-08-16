import { useTranslations } from "next-intl";
import { Wordmark } from "./Wordmark";

export function Footer() {
  const t = useTranslations("footer");
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
        <p className="l-footer-copy num">{t("copyright")}</p>
      </div>
    </footer>
  );
}
