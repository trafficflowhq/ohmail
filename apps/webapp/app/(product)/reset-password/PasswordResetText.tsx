import type { ReactNode } from "react";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { loadCatalog } from "../../../i18n/catalog";
import { DEFAULT_LOCALE, localeFromCookieHeader } from "../../shell/locale";

/** Serve the recovery vocabulary on the two documents that use it. */
export async function PasswordResetText({ children }: { children: ReactNode }) {
  const locale = localeFromCookieHeader((await headers()).get("cookie")) ?? DEFAULT_LOCALE;
  const { passwordReset } = await loadCatalog(locale);
  return <NextIntlClientProvider locale={locale} messages={{ passwordReset: passwordReset! }}>{children}</NextIntlClientProvider>;
}
