import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

const PROVIDERS = [
  "gmail",
  "microsoft",
  "icloud",
  "yahoo",
  "fastmail",
  "gmx",
  "infomaniak",
] as const;

/**
 * The supported-providers strip — the "all your mailboxes" beat: a typographic list (no fake
 * logos, same move as the Platforms row), closed by the umbrella truth and the Microsoft note. That
 * note is deliberately literal: the only adapter in packages/core is the IMAP one (imapflow +
 * nodemailer, password auth); `mailbox_credentials.transport` reserves a 'graph' row and `auth_kind`
 * reserves 'oauth', but neither is implemented — so the note says Microsoft 365 connects over IMAP
 * today and that Graph is roadmap. Nothing here claims native Exchange support.
 */
export function Providers() {
  const t = useTranslations("providers");
  return (
    <section className="l-providers" aria-labelledby="providers-title">
      <Reveal>
        <h2 id="providers-title" className="l-providers-title">
          {t("title")}
        </h2>
        <ul className="l-provider-row">
          {PROVIDERS.map((p) => (
            <li key={p}>{t(p)}</li>
          ))}
        </ul>
        <p className="l-providers-any">{t("any")}</p>
        <p className="l-providers-note">{t("note")}</p>
      </Reveal>
    </section>
  );
}
